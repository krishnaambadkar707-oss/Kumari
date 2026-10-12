// A fake Gemini / OpenAI / Anthropic server that speaks each real streaming
// format, so the adapters and the tool loop can be tested without keys.
import http from 'node:http'

export function startMock(port = 0) {
  const log = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url, 'http://x')
    const json = body ? JSON.parse(body) : {}
    log.push({ method: req.method, path: url.pathname, body: json, headers: req.headers })
    const sse = (events) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const tick = () => {
        if (i >= events.length) return res.end()
        res.write(events[i++])
        setTimeout(tick, 5)
      }
      tick()
    }

    // ---------------- Gemini ----------------
    if (url.pathname === '/v1beta/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
      ] }))
    }
    const g = /^\/v1beta\/models\/([^:]+):streamGenerateContent$/.exec(url.pathname)
    if (g) {
      if (g[1] !== 'gemini-3.8-flash') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `models/${g[1]} is not found for API version v1beta` } }))
      }
      if (req.headers['x-goog-api-key'] !== 'test-gemini-key-123456') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }))
      }
      const last = json.contents.at(-1)
      const userText = last.parts.find((p) => p.text)?.text ?? ''
      const fr = last.parts.find((p) => p.functionResponse)
      const chunk = (parts, extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...extra }] })}\r\n\r\n`
      if (fr) {
        return sse([chunk([{ text: 'Noted, ' }]), chunk([{ text: 'it is saved.' }], { finishReason: 'STOP' })])
      }
      if (/jot|note/i.test(userText)) {
        return sse([chunk([{ text: 'On it. ' }]), chunk([{ functionCall: { name: 'notes', args: { action: 'add', text: 'milk and eggs' } }, thoughtSignature: 'SIG123' }], { finishReason: 'STOP' })])
      }
      return sse([chunk([{ text: 'Hello ' }]), chunk([{ text: 'there, ' }]), chunk([{ text: 'Krishna.' }], { finishReason: 'STOP' })])
    }

    // ---------------- OpenAI-compatible ----------------
    if (url.pathname === '/v1/chat/completions') {
      const msgs = json.messages
      const last = msgs.at(-1)
      const d = (delta, fin = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: fin }] })}\n\n`
      if (last.role === 'tool') return sse([d({ content: 'All ' }), d({ content: 'done.' }, 'stop'), 'data: [DONE]\n\n'])
      if (/jot|note/i.test(String(last.content))) {
        return sse([
          d({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'notes', arguments: '{"action":"add",' } }] }),
          d({ tool_calls: [{ index: 0, function: { arguments: '"text":"buy tea"}' } }] }, 'tool_calls'),
          'data: [DONE]\n\n',
        ])
      }
      return sse([d({ content: 'Hi from ' }), d({ content: 'openai.' }, 'stop'), 'data: [DONE]\n\n'])
    }
    if (url.pathname === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}') }

    // ---------------- Anthropic ----------------
    if (url.pathname === '/v1/messages') {
      const last = json.messages.at(-1)
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
      const hasResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')
      if (hasResult) return sse([ev('message_start', { message: {} }), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Claude ' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'finished.' } }), ev('message_stop', {})])
      const text = Array.isArray(last.content) ? last.content.map((b) => b.text ?? '').join('') : last.content
      if (/jot|note/i.test(text)) {
        return sse([ev('message_start', { message: {} }), ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'notes' } }), ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"action":"add",' } }), ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"text":"call mom"}' } }), ev('message_stop', {})])
      }
      return sse([ev('message_start', { message: {} }), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello from ' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Claude.' } }), ev('message_stop', {})])
    }

    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, port: server.address().port, close: () => server.close() })))
}
