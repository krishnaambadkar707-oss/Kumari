/**
 * Shared pieces for the provider adapters.
 *
 * Every adapter speaks one neutral conversation format so the agent loop never
 * cares which model is behind it:
 *
 *   { role: 'user',      text, images?: [{ mime, data }] }
 *   { role: 'assistant', text, calls?: [{ id, name, args }], raw? }
 *   { role: 'tool',      results: [{ id, name, text, images?, isError? }] }
 *
 * and every adapter exposes:
 *
 *   stream({ system, messages, tools, signal, onText }) -> { text, calls, raw }
 */

export class ProviderError extends Error {
  /**
   * @param {string} message  Plain sentence, safe to speak aloud.
   * @param {object} [info]
   * @param {number} [info.status]    HTTP status, when there was one.
   * @param {'auth'|'quota'|'model'|'network'|'bad_request'|'server'|'aborted'|'unknown'} [info.kind]
   * @param {boolean} [info.retryable]  Worth trying the next provider.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = info.status
    this.kind = info.kind ?? 'unknown'
    this.retryable = info.retryable ?? false
    this.detail = info.detail ?? ''
  }
}

/** Turn an HTTP failure into something the user can act on. */
export function classifyHttpError(provider, status, bodyText) {
  let detail = ''
  try {
    const j = JSON.parse(bodyText)
    detail = j?.error?.message ?? j?.message ?? j?.error ?? ''
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
  } catch {
    detail = String(bodyText ?? '').slice(0, 300)
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 400)

  if (status === 401 || status === 403 || /api key not valid|invalid api key|invalid x-api-key|permission denied/i.test(detail)) {
    return new ProviderError(
      `The ${provider} API key was refused. Check the key in the .env file.`,
      { status, kind: 'auth', retryable: true, detail },
    )
  }
  if (status === 429 || /quota|rate limit|resource exhausted|too many requests/i.test(detail)) {
    return new ProviderError(
      `${provider} says the free quota or rate limit has been reached. Try again in a minute.`,
      { status, kind: 'quota', retryable: true, detail },
    )
  }
  if (status === 404 || /model.*(not found|does not exist|not supported)|is not found for api/i.test(detail)) {
    return new ProviderError(
      `${provider} does not recognise that model name.`,
      { status, kind: 'model', retryable: true, detail },
    )
  }
  if (status >= 500) {
    return new ProviderError(`${provider} is having trouble right now.`, {
      status, kind: 'server', retryable: true, detail,
    })
  }
  return new ProviderError(`${provider} rejected the request. ${detail}`.trim(), {
    status, kind: 'bad_request', retryable: false, detail,
  })
}

/** fetch that turns network failures into ProviderErrors and honours abort. */
export async function postJson(provider, url, { headers, body, signal, timeoutMs = 60_000 }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  // Only the time to first byte is bounded here; once streaming starts the
  // timer is cleared by the caller via the returned `done()`.
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted) throw new ProviderError('aborted', { kind: 'aborted' })
    const why = String(err?.cause?.code ?? err?.message ?? err)
    if (why === 'timeout' || /timeout/i.test(why)) {
      throw new ProviderError(`${provider} took too long to answer.`, {
        kind: 'network', retryable: true, detail: why,
      })
    }
    throw new ProviderError(
      `I cannot reach ${provider}. Check the internet connection.`,
      { kind: 'network', retryable: true, detail: why },
    )
  }
  clearTimeout(timer)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    signal?.removeEventListener('abort', onAbort)
    throw classifyHttpError(provider, res.status, text)
  }
  return {
    res,
    done: () => signal?.removeEventListener('abort', onAbort),
  }
}

/**
 * Parse a Server-Sent-Events body into { event, data } objects.
 * Tolerates \r\n, multi-line data, comments and a missing final blank line.
 */
export async function* sseEvents(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      let chunk
      try {
        chunk = await reader.read()
      } catch (err) {
        if (signal?.aborted) return
        throw new ProviderError('The connection dropped mid-answer.', {
          kind: 'network', retryable: false, detail: String(err?.message ?? err),
        })
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      let idx
      // Normalise line endings so the blank-line splitter is simple.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const ev = parseBlock(raw)
        if (ev) yield ev
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const ev = parseBlock(buffer.replace(/\r\n/g, '\n'))
      if (ev) yield ev
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

function parseBlock(block) {
  let event = 'message'
  const data = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return null
  return { event, data: data.join('\n') }
}

/** JSON.parse that returns {} instead of throwing, for streamed tool arguments. */
export function safeJson(text) {
  if (!text || !String(text).trim()) return {}
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

let callSeq = 0
export const newCallId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`
