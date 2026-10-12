/**
 * One conversation session per browser connection.
 *
 * Turn flow:
 *   1. Instant local commands (intents.mjs) answer without any model.
 *   2. Otherwise the text goes to the model with the tools; the model may call
 *      tools several times; its words stream to the browser as they arrive so
 *      speech starts on the first sentence.
 *   3. Only the user's text and the final spoken answer are kept in history —
 *      tool traffic is not, which keeps the context small and cheap.
 *
 * Interrupts (barge-in) abort the in-flight request and the tool loop; nothing
 * further is sent for the abandoned question.
 */

import { buildSystemPrompt } from './persona.mjs'
import { buildTools, SILENT_TOOLS } from './tools/index.mjs'
import { matchLocal } from './intents.mjs'
import { ProviderError } from './providers/common.mjs'

const MAX_STEPS = 6
const TOOL_TIMEOUT_MS = 30_000

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })

/** Flatten an MCP-style result into text plus images the providers can take. */
function flattenResult(res) {
  const parts = Array.isArray(res?.content) ? res.content : []
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim()
  const images = parts
    .filter((p) => p.type === 'image' && p.data)
    .map((p) => ({ mime: p.mimeType ?? 'image/jpeg', data: p.data }))
  return { text, images, isError: res?.isError === true }
}

/** Words the user hears when the model path fails. Plain sentences. */
function friendlyError(err, configured) {
  if (!configured) {
    return 'I have no AI model set up yet. Add a free Gemini key to the dot env file and I can answer anything. I can still open apps, tell the time, and remember things.'
  }
  if (err instanceof ProviderError) return err.message
  return 'Something went wrong while I was thinking. Please try again.'
}

export function createSession(deps) {
  const { config, memory, brain, scheduler, notes, send, ask, log = () => {} } = deps

  let answering = null
  let controller = null
  let busy = false
  let closed = false

  const sendTurn = (msg) => send({ ...msg, ask: answering })

  const tools = buildTools({ config, memory, scheduler, notes, send, ask })
  const toolByName = new Map(tools.map((t) => [t.name, t]))
  const toolSpecs = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))

  /** Run one tool call safely; never throws. */
  async function runTool(call) {
    const t = toolByName.get(call.name)
    if (!t) {
      return { id: call.id, name: call.name, text: `There is no tool called ${call.name}.`, isError: true, images: [] }
    }
    if (!SILENT_TOOLS.has(call.name)) sendTurn({ type: 'tool', name: call.name })
    try {
      const out = flattenResult(await withTimeout(t.run(call.args), TOOL_TIMEOUT_MS, call.name))
      log(`tool ${call.name} -> ${out.isError ? 'error' : 'ok'}`)
      return { id: call.id, name: call.name, ...out }
    } catch (err) {
      log(`tool ${call.name} threw: ${err?.message ?? err}`)
      return {
        id: call.id, name: call.name, images: [], isError: true,
        text: `The ${call.name} action failed: ${err?.message ?? 'unknown error'}.`,
      }
    }
  }

  /** The fast path. Returns true if it handled the turn. */
  async function tryLocal(text) {
    const hit = matchLocal(text, { memory, hasBrain: brain.configured })
    if (!hit) return false
    sendTurn({ type: 'tool', name: hit.tool })
    let out
    try {
      out = await hit.run()
    } catch (err) {
      out = { ok: false, say: `That did not work. ${err?.message ?? ''}`.trim() }
    }
    if (out.file) {
      send({
        type: 'blade',
        blade: {
          id: `s${Date.now().toString(36)}`, title: 'SCREENSHOT', kind: 'image',
          url: out.file, size: 'wide', hold: 'turn',
        },
      })
    }
    const say = out.say || 'Done.'
    sendTurn({ type: 'text', delta: say })
    sendTurn({ type: 'done', text: say })
    memory.appendTurn('user', text)
    memory.appendTurn('assistant', say)
    return true
  }

  async function turn(text, id) {
    answering = id
    busy = true
    controller = new AbortController()
    const { signal } = controller
    try {
      if (await tryLocal(text)) return

      if (!brain.configured) {
        const say = friendlyError(null, false)
        sendTurn({ type: 'text', delta: say })
        sendTurn({ type: 'done', text: say })
        return
      }

      const system = buildSystemPrompt({ config, memory })
      const messages = [...memory.historyMessages(), { role: 'user', text }]
      let spoken = ''

      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) return
        const result = await brain.stream({
          system,
          messages,
          tools: toolSpecs,
          signal,
          maxTokens: config.maxTokens,
          onText: (delta) => {
            if (signal.aborted) return
            spoken += delta
            sendTurn({ type: 'text', delta })
          },
        })
        if (signal.aborted) return

        if (!result.calls.length) {
          if (!spoken.trim()) {
            const say = 'I have nothing to add to that.'
            spoken = say
            sendTurn({ type: 'text', delta: say })
          }
          break
        }

        messages.push({ role: 'assistant', text: result.text, calls: result.calls, raw: result.raw })
        const results = []
        for (const call of result.calls) {
          if (signal.aborted) return
          results.push(await runTool(call))
        }
        messages.push({ role: 'tool', results })
        // A model sometimes narrates before a tool call; separate it from the
        // answer that follows so the two do not run together when spoken.
        if (spoken && !/\s$/.test(spoken)) {
          spoken += ' '
          sendTurn({ type: 'text', delta: ' ' })
        }
        if (step === MAX_STEPS - 1) {
          const say = ' I could not finish that.'
          spoken += say
          sendTurn({ type: 'text', delta: say })
        }
      }

      if (signal.aborted) return
      sendTurn({ type: 'done', text: spoken.trim() })
      memory.appendTurn('user', text)
      memory.appendTurn('assistant', spoken.trim())
    } catch (err) {
      if (signal.aborted || (err instanceof ProviderError && err.kind === 'aborted')) return
      console.error('[kumari] turn failed:', err instanceof ProviderError ? `${err.kind}: ${err.message} ${err.detail}` : err)
      sendTurn({ type: 'error', message: friendlyError(err, brain.configured) })
    } finally {
      if (answering === id) busy = false
    }
  }

  return {
    /** Start answering. A newer question replaces any turn still running. */
    ask(text, id) {
      if (closed) return
      controller?.abort()
      void turn(String(text).slice(0, 4000), id)
    },
    interrupt() {
      controller?.abort()
    },
    get busy() {
      return busy
    },
    close() {
      closed = true
      controller?.abort()
    },
  }
}
