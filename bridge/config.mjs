/**
 * Kumari configuration.
 *
 * Settings come from a `.env` file in the project folder (created for you by
 * the first launch) or from real environment variables. The variable names from
 * the original Python Kumari are honoured, so an existing `.env` keeps working.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ENV_FILE = join(ROOT, '.env')

/**
 * Minimal .env reader: BOM, CRLF, quotes, `export`, trailing comments.
 *
 * - If a name appears twice in the file, the LAST one wins (so a key pasted
 *   below the placeholder line is the one used).
 * - A real environment variable wins over the file, unless it is empty — an
 *   empty variable left in Windows must not silently hide the key in .env.
 */
export function loadDotenv(path = ENV_FILE, target = process.env) {
  if (!existsSync(path)) return false
  let text = readFileSync(path, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const fromFile = {}
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    const quoted = /^(["'\u201c\u2018])(.*?)["'\u201d\u2019](?:\s+#.*)?$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '')
    if (key) fromFile[key] = value.trim()
  }
  for (const [key, value] of Object.entries(fromFile)) {
    if (target[key] === undefined || String(target[key]).trim() === '') target[key] = value
  }
  return true
}

/** A key still holding the template's placeholder text is not a key. */
export function realKey(value) {
  const v = String(value ?? '').trim()
  if (v.length < 12) return ''
  if (/your|here|paste|xxxx|changeme|example|<.*>/i.test(v)) return ''
  return v
}

const int = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const flag = (v, d = false) => {
  if (v === undefined || v === '') return d
  return /^(1|true|yes|on)$/i.test(String(v).trim())
}

export function readConfig(env = process.env) {
  const provider = String(env.KUMARI_LLM_PROVIDER ?? env.KUMARI_PROVIDER ?? 'auto').toLowerCase().trim()

  return {
    root: ROOT,
    dataDir: env.KUMARI_DATA_DIR ? resolve(env.KUMARI_DATA_DIR) : join(ROOT, 'data'),
    notesDir: env.KUMARI_NOTES_DIR
      ? resolve(env.KUMARI_NOTES_DIR)
      : join(homedir(), 'Documents', 'Kumari'),

    assistantName: (env.KUMARI_NAME ?? 'Kumari').trim() || 'Kumari',
    userName: (env.KUMARI_USER_NAME ?? '').trim(),
    city: (env.KUMARI_CITY ?? '').trim(),

    port: int(env.KUMARI_PORT ?? env.JARVIS_BRIDGE_PORT, 8787),
    host: '127.0.0.1',

    provider,
    keys: {
      gemini: realKey(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
      anthropic: realKey(env.ANTHROPIC_API_KEY),
      openai: realKey(env.OPENAI_API_KEY),
      groq: realKey(env.GROQ_API_KEY),
    },
    models: {
      gemini: (env.KUMARI_GEMINI_MODEL ?? 'auto').trim() || 'auto',
      anthropic: (env.KUMARI_ANTHROPIC_MODEL ?? 'claude-sonnet-5-5').trim(),
      openai: (env.KUMARI_OPENAI_MODEL ?? 'gpt-4o-mini').trim(),
      groq: (env.KUMARI_GROQ_MODEL ?? 'llama-3.3-70b-versatile').trim(),
      ollama: (env.KUMARI_OLLAMA_MODEL ?? '').trim(),
    },
    ollamaHost: (env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/^(?!https?:\/\/)/, 'http://'),
    openaiBaseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').trim(),

    /** Language the microphone listens for. hi-IN also understands Hinglish well. */
    sttLang: (env.KUMARI_STT_LANG ?? 'hi-IN').trim(),
    /** auto = mirror whichever language the user spoke. */
    replyLang: (env.KUMARI_LANGUAGE ?? 'auto').toLowerCase().trim(),

    // Optional voices / speech
    elevenKey: realKey(env.ELEVENLABS_API_KEY),
    elevenVoice: env.JARVIS_VOICE_ID ?? env.KUMARI_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL',

    maxTokens: int(env.KUMARI_MAX_TOKENS, 1024),
    maxHistoryTurns: int(env.KUMARI_HISTORY_TURNS, 24),

    /**
     * Power actions (shutdown, restart, sleep) are always confirmed out loud
     * first. This extra switch turns them off entirely.
     */
    allowPower: flag(env.KUMARI_ALLOW_POWER, true),
    debug: flag(env.KUMARI_DEBUG, false),
  }
}

loadDotenv()
export const config = readConfig()
export const ENV_FOUND = existsSync(ENV_FILE)
