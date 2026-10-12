/**
 * OpenAI-compatible chat completions.
 *
 * One adapter, several backends: ChatGPT (api.openai.com), Groq, OpenRouter,
 * LM Studio, and Ollama running on this laptop — they all speak the same
 * streaming protocol. Only the base URL, key and model differ.
 */

import {
  ProviderError, postJson, sseEvents, safeJson, newCallId,
} from './common.mjs'

function toOpenAiTools(tools) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.parameters?.type ? t.parameters : { type: 'object', properties: {} },
    },
  }))
}

const dataUrl = (img) => `data:${img.mime ?? 'image/jpeg'};base64,${img.data}`

function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images?.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: m.text || '...' },
            ...m.images.map((i) => ({ type: 'image_url', image_url: { url: dataUrl(i) } })),
          ],
        })
      } else {
        out.push({ role: 'user', content: m.text || '...' })
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null }
      if (m.calls?.length) {
        msg.tool_calls = m.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }))
      }
      if (!msg.content && !msg.tool_calls) msg.content = '...'
      out.push(msg)
    } else if (m.role === 'tool') {
      const pictures = []
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.text || (r.isError ? 'error' : 'ok') })
        for (const img of r.images ?? []) pictures.push(img)
      }
      // Tool messages are text-only in this protocol, so frames follow as a
      // user message.
      if (pictures.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Image returned by the tool:' },
            ...pictures.map((i) => ({ type: 'image_url', image_url: { url: dataUrl(i) } })),
          ],
        })
      }
    }
  }
  return out
}

export function createOpenAiCompatible({ label, baseUrl, apiKey, model, local = false, extraHeaders = {} }) {
  const base = baseUrl.replace(/\/+$/, '')
  const isOpenAi = /api\.openai\.com/.test(base)
  // Models that refused `tools`, learned at runtime (small local models).
  let toolsOk = true

  async function once({ system, messages, tools, signal, onText, maxTokens }) {
    const body = {
      model,
      messages: toOpenAiMessages(system, messages),
      stream: true,
    }
    if (isOpenAi) body.max_completion_tokens = maxTokens
    else body.max_tokens = maxTokens
    if (!isOpenAi) body.temperature = 0.8

    const oaTools = toolsOk ? toOpenAiTools(tools) : undefined
    if (oaTools) body.tools = oaTools

    const headers = { ...extraHeaders }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const { res, done } = await postJson(label, `${base}/chat/completions`, {
      headers,
      body,
      signal,
      // A cold local model can take a long time to load its first token.
      timeoutMs: local ? 180_000 : 60_000,
    })

    let text = ''
    const acc = new Map() // index -> { id, name, args }
    try {
      for await (const ev of sseEvents(res.body, signal)) {
        if (ev.data === '[DONE]') break
        let j
        try {
          j = JSON.parse(ev.data)
        } catch {
          continue
        }
        if (j.error) {
          throw new ProviderError(`${label}: ${j.error.message ?? 'stream error'}`, {
            kind: 'server', retryable: true,
          })
        }
        const delta = j.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content
          onText?.(delta.content)
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0
          const cur = acc.get(i) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          acc.set(i, cur)
        }
      }
    } finally {
      done()
    }

    const calls = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id || newCallId(), name: c.name, args: safeJson(c.args) }))
      .filter((c) => c.name)
    return { text, calls }
  }

  return {
    name: label.toLowerCase(),
    get model() {
      return model
    },
    async stream(args) {
      const maxTokens = args.maxTokens ?? 1024
      try {
        return await once({ ...args, maxTokens })
      } catch (err) {
        // Some small local models reject the `tools` field. Chat still works
        // without it, so degrade instead of failing the whole turn.
        if (
          err instanceof ProviderError &&
          err.kind === 'bad_request' &&
          toolsOk &&
          args.tools?.length &&
          /tool|function/i.test(err.detail + err.message)
        ) {
          toolsOk = false
          console.log(`[kumari] ${label} model "${model}" does not support tools — chatting without them`)
          return once({ ...args, maxTokens })
        }
        throw err
      }
    },
    async check(signal) {
      const res = await fetch(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal,
      }).catch(() => null)
      if (!res) {
        throw new ProviderError(`I cannot reach ${label}.`, { kind: 'network', retryable: true })
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`The ${label} API key was refused.`, { kind: 'auth', retryable: true })
      }
      return model
    },
  }
}

/** Ask a running Ollama which models are installed (null if it is not running). */
export async function listOllamaModels(host, signal) {
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, {
      signal: signal ?? AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const j = await res.json()
    return (j.models ?? []).map((m) => m.name)
  } catch {
    return null
  }
}

/** Prefer models that are good at tool calling and multilingual replies. */
export function pickOllamaModel(installed, preferred) {
  if (!installed?.length) return null
  if (preferred && installed.includes(preferred)) return preferred
  const ranking = [/qwen3/i, /qwen2\.5/i, /llama3\.[123]/i, /gemma3/i, /mistral/i, /phi/i]
  for (const re of ranking) {
    const hit = installed.find((n) => re.test(n) && !/embed/i.test(n))
    if (hit) return hit
  }
  return installed.find((n) => !/embed/i.test(n)) ?? installed[0]
}
