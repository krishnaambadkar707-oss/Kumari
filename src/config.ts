/**
 * Kumari interface configuration.
 *
 * The app is served by the bridge itself, so almost nothing needs setting.
 * Optional overrides go in `.env.local` (development) as VITE_* variables;
 * everything about the AI model, language and keys lives in the project's
 * `.env`, read by the bridge.
 */

function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(`[kumari] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`)
  return fallback
}

function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[kumari] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/** Kept so the speech modules read the same way they always did. */
export const BACKEND = 'bridge' as const

/**
 * Where the bridge lives. When the page is served by the bridge (the normal
 * case) it is simply wherever the page came from; under `npm run dev` the page
 * is on Vite's port, so it falls back to the default bridge port.
 */
const sameOrigin =
  typeof location !== 'undefined' && !import.meta.env.DEV
    ? `ws://${location.host}`
    : undefined
export const BRIDGE_WS_URL =
  str(import.meta.env.VITE_BRIDGE_URL) ?? sameOrigin ?? 'ws://localhost:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')

/** Force the ElevenLabs voice on from the browser side (the bridge decides availability). */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * 'system' is the browser's own voice: instant, offline, and the default.
 * 'kokoro' is an optional in-browser neural voice (English only).
 */
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['kokoro', 'system'] as const,
  'system',
)

/** Kokoro's female voices suit Kumari. */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel', 'af_heart', 'af_bella', 'bf_emma'] as const,
  'af_heart',
)

export const env = {
  elevenKey: str(import.meta.env.VITE_ELEVENLABS_API_KEY) ?? '',
  elevenVoiceId:
    str(import.meta.env.VITE_ELEVENLABS_VOICE_ID) ?? 'EXAVITQu4vr4xnSDxMaL',
  porcupineKey: str(import.meta.env.VITE_PICOVOICE_ACCESS_KEY) ?? '',
}

/**
 * 'speech' listens for the name with the browser's SpeechRecognition
 * (Chrome/Edge, zero setup). 'porcupine' is an optional offline engine that
 * needs a free Picovoice key.
 */
export const WAKE_ENGINE: 'speech' | 'porcupine' = env.porcupineKey ? 'porcupine' : 'speech'
