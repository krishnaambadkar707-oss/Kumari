/**
 * The brain selector.
 *
 * Builds an ordered chain of providers from whatever is configured, then
 * `stream()` walks it: if the first provider is down, out of quota or has a bad
 * key, the next one answers instead — before a single word has been spoken, so
 * the user never hears a half answer followed by a different voice of thought.
 *
 * Order for `auto`: Gemini (free) → Groq (free) → Claude → ChatGPT → Ollama
 * (local, offline). Name a provider in KUMARI_LLM_PROVIDER to put it first.
 */

import { ProviderError } from './common.mjs'
import { createGemini } from './gemini.mjs'
import { createAnthropic } from './anthropic.mjs'
import { createOpenAiCompatible, listOllamaModels, pickOllamaModel } from './openai.mjs'

const AUTO_ORDER = ['gemini', 'groq', 'anthropic', 'openai', 'ollama']
const COOLDOWN_MS = { quota: 60_000, network: 15_000, server: 20_000, model: 120_000 }

export async function createBrain(config) {
  /** @type {{ id: string, adapter: any, dead: string|null, until: number }[]} */
  const entries = []

  const makers = {
    gemini: () =>
      config.keys.gemini && createGemini({ apiKey: config.keys.gemini, model: config.models.gemini }),
    anthropic: () =>
      config.keys.anthropic &&
      createAnthropic({ apiKey: config.keys.anthropic, model: config.models.anthropic }),
    openai: () =>
      config.keys.openai &&
      createOpenAiCompatible({
        label: 'ChatGPT',
        baseUrl: config.openaiBaseUrl,
        apiKey: config.keys.openai,
        model: config.models.openai,
      }),
    groq: () =>
      config.keys.groq &&
      createOpenAiCompatible({
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: config.keys.groq,
        model: config.models.groq,
      }),
  }

  const wanted =
    config.provider === 'auto' || !AUTO_ORDER.includes(config.provider)
      ? AUTO_ORDER
      : [config.provider, ...AUTO_ORDER.filter((p) => p !== config.provider)]

  let ollamaModels = null
  for (const id of wanted) {
    if (id === 'ollama') {
      ollamaModels = await listOllamaModels(config.ollamaHost)
      const model = pickOllamaModel(ollamaModels, config.models.ollama)
      if (model) {
        entries.push({
          id,
          dead: null,
          until: 0,
          adapter: createOpenAiCompatible({
            label: 'Ollama',
            baseUrl: `${config.ollamaHost.replace(/\/+$/, '')}/v1`,
            apiKey: '',
            model,
            local: true,
          }),
        })
      }
      continue
    }
    const adapter = makers[id]?.()
    if (adapter) entries.push({ id, adapter, dead: null, until: 0 })
  }

  const usable = () =>
    entries.filter((e) => !e.dead && Date.now() >= e.until)

  return {
    entries,
    /** True when at least one provider is configured at all. */
    get configured() {
      return entries.length > 0
    },
    /** Short label for the HUD / health endpoint. */
    describe() {
      const live = usable()[0] ?? entries[0]
      return live ? `${live.id} · ${live.adapter.model}` : 'offline'
    },
    ids() {
      return entries.map((e) => e.id)
    },

    /**
     * Stream one model response, failing over down the chain.
     * `onText` is wrapped so that once any text has gone out we stop failing over.
     */
    async stream(args) {
      if (!entries.length) {
        throw new ProviderError('No AI model is configured yet.', { kind: 'auth' })
      }
      let spoke = false
      const onText = (t) => {
        spoke = true
        args.onText?.(t)
      }

      let lastError = null
      const candidates = usable().length ? usable() : entries.filter((e) => !e.dead)
      for (const entry of candidates) {
        if (args.signal?.aborted) throw new ProviderError('aborted', { kind: 'aborted' })
        try {
          const result = await entry.adapter.stream({ ...args, onText })
          entry.until = 0
          return { ...result, provider: entry.id, model: entry.adapter.model }
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err
          if (err.kind === 'aborted') throw err
          lastError = err
          if (config.debug) console.log(`[kumari] ${entry.id} failed (${err.kind}): ${err.message} ${err.detail}`)

          if (err.kind === 'auth') entry.dead = err.message
          else entry.until = Date.now() + (COOLDOWN_MS[err.kind] ?? 10_000)

          // Mid-answer failures must not be papered over by a second voice.
          if (spoke || !err.retryable) throw err
          console.log(`[kumari] ${entry.id} unavailable (${err.kind}) — trying the next provider`)
        }
      }
      throw lastError ?? new ProviderError('No AI model answered.', { kind: 'unknown' })
    },

    /** Startup self-test. Logs a clear line per provider; never throws. */
    async selfTest() {
      const report = []
      for (const entry of entries) {
        try {
          const model = await entry.adapter.check?.(AbortSignal.timeout(12_000))
          report.push({ id: entry.id, ok: true, model: model ?? entry.adapter.model })
        } catch (err) {
          if (err instanceof ProviderError && err.kind === 'auth') entry.dead = err.message
          report.push({
            id: entry.id,
            ok: false,
            reason: err instanceof ProviderError ? err.message : String(err?.message ?? err),
          })
        }
      }
      return report
    },
  }
}
