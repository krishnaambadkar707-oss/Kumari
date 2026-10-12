/**
 * Google Gemini — the free-tier default.
 *
 * Talks to the REST streaming endpoint directly (no SDK to install). It is built
 * around one lesson: Google retires models often. The original Kumari shipped
 * with `gemini-2.0-flash`, which Google shut down on 1 June 2026, and the 2.5
 * family follows in October 2026. A hard-coded model name is therefore a bug
 * waiting to happen, so this adapter:
 *
 *   - reads the live model list and picks the newest suitable Flash model;
 *   - keeps a ranked list of alternatives and steps down it when a model is
 *     missing or its free quota is exhausted;
 *   - echoes Gemini's opaque `thoughtSignature` back on tool calls, which the
 *     3.x models require;
 *   - turns thinking down to keep a voice assistant quick, and retries without
 *     that field if a particular model refuses it.
 */

import {
  ProviderError, postJson, sseEvents, newCallId,
} from './common.mjs'

const BASE =
  process.env.GEMINI_BASE_URL?.replace(/\/+$/, '') ??
  'https://generativelanguage.googleapis.com/v1beta'

/** Used only when the live list cannot be read. Newest first. */
export const STATIC_FALLBACKS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
]

/** Gemini's schema dialect is a subset of OpenAPI. Strip what it refuses. */
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (['$schema', 'additionalProperties', 'default', 'title'].includes(k)) continue
    if (k === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]),
      )
    } else if (k === 'items') {
      out.items = geminiSchema(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function toGeminiTools(tools) {
  if (!tools?.length) return undefined
  return [
    {
      functionDeclarations: tools.map((t) => {
        const decl = { name: t.name, description: t.description || t.name }
        const params = geminiSchema(t.parameters)
        // A function with no arguments must omit `parameters` entirely.
        if (params?.properties && Object.keys(params.properties).length) {
          decl.parameters = params
        }
        return decl
      }),
    },
  ]
}

const imagePart = (img) => ({
  inlineData: { mimeType: img.mime ?? 'image/jpeg', data: img.data },
})

export function toGeminiContents(messages) {
  const contents = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = []
      if (m.text) parts.push({ text: m.text })
      for (const img of m.images ?? []) parts.push(imagePart(img))
      if (!parts.length) parts.push({ text: '...' })
      contents.push({ role: 'user', parts })
    } else if (m.role === 'assistant') {
      // Replay exactly what the model produced, signatures and all.
      if (Array.isArray(m.raw) && m.raw.length) {
        contents.push({ role: 'model', parts: m.raw })
      } else {
        const parts = []
        if (m.text) parts.push({ text: m.text })
        for (const c of m.calls ?? []) {
          parts.push({ functionCall: { name: c.name, args: c.args ?? {} } })
        }
        if (!parts.length) parts.push({ text: '...' })
        contents.push({ role: 'model', parts })
      }
    } else if (m.role === 'tool') {
      const parts = []
      const extra = []
      for (const r of m.results) {
        parts.push({
          functionResponse: {
            name: r.name,
            response: r.isError ? { error: r.text } : { result: r.text },
          },
        })
        for (const img of r.images ?? []) extra.push(imagePart(img))
      }
      // Gemini cannot carry pictures inside a function response, so any image
      // (a camera frame) rides along in the same user turn.
      contents.push({ role: 'user', parts: [...parts, ...extra] })
    }
  }
  return contents
}

/** Which thinking settings to try for a model, most preferred first. */
export function thinkingOptions(model) {
  if (/gemini-3/.test(model)) {
    return [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null]
  }
  if (/gemini-2\.5/.test(model)) return [{ thinkingBudget: 0 }, null]
  return [null]
}

export function createGemini({ apiKey, model }) {
  const configured = model && model !== 'auto' ? model : null
  /** Ranked model names; `cursor` is the one in use. */
  let ranked = [...new Set([configured, ...STATIC_FALLBACKS].filter(Boolean))]
  let cursor = 0
  let listed = false
  /** Thinking setting that worked, per model. */
  const thinkingChoice = new Map()

  const active = () => ranked[cursor]

  async function listModels(signal) {
    const res = await fetch(`${BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: signal ?? AbortSignal.timeout(8000),
    }).catch(() => null)
    if (!res) return null
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ProviderError('The Gemini API key was refused. Check the key in the .env file.', {
        status: res.status, kind: 'auth', retryable: true,
      })
    }
    if (!res.ok) return null
    const j = await res.json().catch(() => ({}))
    return j.models ?? []
  }

  /** Read the live list once and rebuild the ranking from it. */
  async function refreshRanking(signal) {
    if (listed) return
    listed = true
    const models = await listModels(signal).catch((e) => {
      if (e instanceof ProviderError && e.kind === 'auth') throw e
      return null
    })
    if (!models?.length) return
    const live = rankGeminiModels(models)
    if (!live.length) return
    const wanted = configured && live.includes(configured) ? [configured] : []
    ranked = [...new Set([...wanted, ...live, ...STATIC_FALLBACKS.filter((m) => live.includes(m))])]
    cursor = 0
    console.log(`[kumari] gemini model: ${active()}  (alternatives: ${ranked.slice(1, 4).join(', ') || 'none'})`)
  }

  async function once({ system, messages, tools, signal, onText, maxTokens }, thinking) {
    const generationConfig = { maxOutputTokens: maxTokens, temperature: 0.8 }
    if (thinking) generationConfig.thinkingConfig = thinking

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig,
    }
    const fnTools = toGeminiTools(tools)
    if (fnTools) {
      body.tools = fnTools
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
    }

    const { res, done } = await postJson(
      'Gemini',
      `${BASE}/models/${encodeURIComponent(active())}:streamGenerateContent?alt=sse`,
      { headers: { 'x-goog-api-key': apiKey }, body, signal },
    )

    let text = ''
    const raw = []
    const calls = []
    let finish = ''
    let blocked = ''
    try {
      for await (const ev of sseEvents(res.body, signal)) {
        let j
        try {
          j = JSON.parse(ev.data)
        } catch {
          continue
        }
        if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason
        const cand = j.candidates?.[0]
        if (!cand) continue
        if (cand.finishReason) finish = cand.finishReason
        for (const part of cand.content?.parts ?? []) {
          if (part.thought === true) continue // never speak a thought summary
          if (typeof part.text === 'string') {
            if (part.text) {
              text += part.text
              onText?.(part.text)
            }
            const last = raw[raw.length - 1]
            if (
              last && typeof last.text === 'string' &&
              !last.thoughtSignature && !part.thoughtSignature
            ) {
              last.text += part.text
            } else {
              raw.push({ ...part })
            }
          } else if (part.functionCall) {
            calls.push({
              id: part.functionCall.id ?? newCallId(),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            })
            raw.push({ ...part })
          } else {
            raw.push({ ...part })
          }
        }
      }
    } finally {
      done()
    }

    if (!text && !calls.length && (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT')) {
      text = 'I am not able to help with that one.'
      onText?.(text)
    }
    return { text, calls, raw: raw.length ? raw : undefined }
  }

  return {
    name: 'gemini',
    get model() {
      return active()
    },
    async stream(args) {
      const maxTokens = args.maxTokens ?? 1024
      await refreshRanking(args.signal)

      let lastError = null
      // Walk the ranked models; within each, negotiate the thinking setting.
      for (let step = 0; step < Math.min(ranked.length, 4); step++) {
        const model = active()
        const options = thinkingChoice.has(model)
          ? [thinkingChoice.get(model)]
          : thinkingOptions(model)

        lastError = null
        for (let i = 0; i < options.length; i++) {
          try {
            const result = await once({ ...args, maxTokens }, options[i])
            thinkingChoice.set(model, options[i])
            return result
          } catch (err) {
            if (!(err instanceof ProviderError)) throw err
            lastError = err
            const thinkingRefused =
              err.kind === 'bad_request' && /thinking/i.test(`${err.detail} ${err.message}`)
            if (thinkingRefused && i < options.length - 1) continue
            break
          }
        }

        // Missing model or exhausted quota: try the next candidate. Anything
        // else (bad key, no internet, aborted) will not be fixed by another
        // model, so surface it.
        if (
          lastError &&
          (lastError.kind === 'model' || lastError.kind === 'quota') &&
          cursor < ranked.length - 1
        ) {
          console.log(
            `[kumari] gemini "${model}" ${lastError.kind === 'model' ? 'unavailable' : 'over quota'} — trying "${ranked[cursor + 1]}"`,
          )
          cursor += 1
          continue
        }
        throw lastError
      }
      throw lastError ?? new ProviderError('Gemini kept failing. Try again in a moment.', {
        kind: 'server', retryable: true,
      })
    },
    /** Reachability + key check used by the startup self-test. */
    async check(signal) {
      const models = await listModels(signal)
      if (models === null) {
        throw new ProviderError('I cannot reach Gemini. Check the internet connection.', {
          kind: 'network', retryable: true,
        })
      }
      await refreshRanking(signal)
      return active()
    },
  }
}

/** Models that can chat, newest-and-fastest first. */
export function rankGeminiModels(models) {
  const usable = models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''))

  const bad = /(image|tts|audio|live|embed|robot|computer|vision|learnlm|gemma|aqa|imagen|veo|lyria|deep-research|customtools|exp|antigravity|native)/i
  const candidates = usable.filter((n) => /^gemini-/.test(n) && !bad.test(n))

  const version = (n) => {
    const m = /^gemini-(\d+(?:\.\d+)?)/.exec(n)
    return m ? parseFloat(m[1]) : 0
  }
  const score = (n) => {
    let s = version(n) * 100
    if (/flash/.test(n)) s += 30
    else if (/pro/.test(n)) s -= 25 // slow and tightly rate-limited for voice
    if (/lite/.test(n)) s -= 12
    if (/preview|-0\d{2}$/.test(n)) s -= 8
    return s
  }
  return candidates.sort((a, b) => score(b) - score(a))
}

/** Best single model, honouring a preferred one. */
export function pickGeminiModel(models, preferred) {
  const ranked = rankGeminiModels(models)
  if (preferred && ranked.includes(preferred)) return preferred
  return ranked[0] ?? null
}
