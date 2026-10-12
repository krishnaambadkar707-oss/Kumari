/**
 * Anthropic Claude over the Messages API, streamed.
 *
 * This talks to api.anthropic.com with a plain API key from console.anthropic.com
 * — unlike the original JARVIS, no Claude Code subscription is involved.
 */

import {
  ProviderError, postJson, sseEvents, safeJson, newCallId,
} from './common.mjs'

const BASE = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://api.anthropic.com'

function toAnthropicTools(tools) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.name,
    description: t.description || t.name,
    input_schema: t.parameters?.type ? t.parameters : { type: 'object', properties: {} },
  }))
}

const imageBlock = (img) => ({
  type: 'image',
  source: { type: 'base64', media_type: img.mime ?? 'image/jpeg', data: img.data },
})

function toAnthropicMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content = []
      for (const img of m.images ?? []) content.push(imageBlock(img))
      content.push({ type: 'text', text: m.text || '...' })
      out.push({ role: 'user', content })
    } else if (m.role === 'assistant') {
      const content = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const c of m.calls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })
      }
      if (!content.length) content.push({ type: 'text', text: '...' })
      out.push({ role: 'assistant', content })
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          is_error: r.isError === true ? true : undefined,
          content: [
            { type: 'text', text: r.text || (r.isError ? 'error' : 'ok') },
            ...(r.images ?? []).map(imageBlock),
          ],
        })),
      })
    }
  }
  return out
}

export function createAnthropic({ apiKey, model }) {
  return {
    name: 'anthropic',
    get model() {
      return model
    },
    async stream({ system, messages, tools, signal, onText, maxTokens = 1024 }) {
      const body = {
        model,
        max_tokens: maxTokens,
        system,
        messages: toAnthropicMessages(messages),
        stream: true,
      }
      const at = toAnthropicTools(tools)
      if (at) body.tools = at

      const { res, done } = await postJson('Claude', `${BASE}/v1/messages`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body,
        signal,
      })

      let text = ''
      const blocks = new Map() // index -> { type, id, name, json }
      try {
        for await (const ev of sseEvents(res.body, signal)) {
          let j
          try {
            j = JSON.parse(ev.data)
          } catch {
            continue
          }
          if (j.type === 'error') {
            throw new ProviderError(`Claude: ${j.error?.message ?? 'stream error'}`, {
              kind: j.error?.type === 'overloaded_error' ? 'server' : 'unknown',
              retryable: true,
            })
          }
          if (j.type === 'content_block_start') {
            const b = j.content_block ?? {}
            blocks.set(j.index, { type: b.type, id: b.id, name: b.name, json: '' })
            if (b.type === 'text' && b.text) {
              text += b.text
              onText?.(b.text)
            }
          } else if (j.type === 'content_block_delta') {
            const d = j.delta ?? {}
            if (d.type === 'text_delta' && d.text) {
              text += d.text
              onText?.(d.text)
            } else if (d.type === 'input_json_delta') {
              const b = blocks.get(j.index)
              if (b) b.json += d.partial_json ?? ''
            }
          }
        }
      } finally {
        done()
      }

      const calls = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => b)
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id || newCallId(), name: b.name, args: safeJson(b.json) }))
      return { text, calls }
    },
    async check(signal) {
      // A one-token ping verifies key, model name and connectivity together.
      const { res, done } = await postJson('Claude', `${BASE}/v1/messages`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        signal,
        timeoutMs: 15_000,
      })
      await res.text().catch(() => '')
      done()
      return model
    },
  }
}
