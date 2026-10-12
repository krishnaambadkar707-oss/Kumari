import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startMock } from './mock-llm.mjs'

const PORT = 18787
let mock, proc, dataDir, notesDir

function startBridge(env) {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['bridge/server.mjs'], { env: { ...process.env, KUMARI_PORT: String(PORT), KUMARI_DATA_DIR: dataDir, KUMARI_NOTES_DIR: notesDir, ...env }, cwd: new URL('..', import.meta.url).pathname })
    let out = ''
    proc.stdout.on('data', (d) => { out += d; if (/ready \(|No AI model|None of the configured/.test(out)) resolve(out) })
    proc.stderr.on('data', (d) => { out += d })
    setTimeout(() => reject(new Error('bridge did not start: ' + out)), 8000)
  })
}
const stopBridge = () => new Promise((r) => { if (!proc || proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', () => r()); proc.kill() })

function turn(text, id = 't1') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: `http://localhost:${PORT}` })
    const frames = []
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString()); frames.push(f)
      if (f.type === 'ready') ws.send(JSON.stringify({ type: 'ask', id, text }))
      if ((f.type === 'done' || f.type === 'error') && f.ask === id) { ws.close(); resolve(frames) }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('timeout; frames=' + JSON.stringify(frames))), 8000)
  })
}
const textOf = (frames) => frames.filter((f) => f.type === 'text').map((f) => f.delta).join('')

before(async () => {
  mock = await startMock()
  dataDir = mkdtempSync(join(tmpdir(), 'kdata-'))
  notesDir = mkdtempSync(join(tmpdir(), 'knotes-'))
})
after(async () => { await stopBridge(); mock.close() })

test('no key: fast path still works, model path explains itself', async () => {
  await startBridge({ GEMINI_API_KEY: '', OLLAMA_HOST: 'http://127.0.0.1:1' })
  let f = await turn('what time is it')
  assert.match(textOf(f), /It is \d/)
  f = await turn('remember that my viva is on the tenth')
  assert.match(textOf(f), /remember that my viva is on the tenth/)
  f = await turn('tell me a joke')
  assert.match(textOf(f), /no AI model/i)
  const facts = JSON.parse(readFileSync(join(dataDir, 'facts_memory.json'), 'utf8'))
  assert.equal(facts[0].text, 'my viva is on the tenth')
  await stopBridge()
})

test('wrong origin is refused', async () => {
  await startBridge({ GEMINI_API_KEY: '' , OLLAMA_HOST: 'http://127.0.0.1:1'})
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'http://evil.example' })
    ws.on('error', () => resolve()); ws.on('open', () => { assert.fail('should not open') })
  })
  await stopBridge()
})

test('gemini: discovers model, streams, calls tool, replays thought signature', async () => {
  await startBridge({ GEMINI_API_KEY: 'test-gemini-key-123456', GEMINI_BASE_URL: `http://127.0.0.1:${mock.port}/v1beta`, KUMARI_LLM_PROVIDER: 'gemini', OLLAMA_HOST: 'http://127.0.0.1:1' })
  let f = await turn('hello')
  assert.equal(textOf(f).trim(), 'Hello there, Krishna.')
  mock.log.length = 0
  f = await turn('jot down milk and eggs')
  assert.match(textOf(f), /On it\.\s*Noted, it is saved\./)
  assert.ok(f.some((x) => x.type === 'tool' && x.name === 'notes'))
  const second = mock.log.filter((l) => l.path.includes('streamGenerateContent')).at(-1).body
  const modelTurn = second.contents.findLast((c) => c.role === 'model')
  assert.ok(modelTurn.parts.some((p) => p.thoughtSignature === 'SIG123'), 'signature echoed')
  assert.match(readFileSync(join(notesDir, 'notes.md'), 'utf8'), /milk and eggs/)
  // tool schema must be gemini-clean
  const decls = second.tools[0].functionDeclarations
  assert.ok(decls.length > 20)
  assert.ok(!JSON.stringify(decls).includes('additionalProperties'))
  await stopBridge()
})

test('gemini: bad key gives a clear spoken error', async () => {
  await startBridge({ GEMINI_API_KEY: 'wrong-key-wrong-key-1', GEMINI_BASE_URL: `http://127.0.0.1:${mock.port}/v1beta`, KUMARI_LLM_PROVIDER: 'gemini', OLLAMA_HOST: 'http://127.0.0.1:1' })
  const f = await turn('hello')
  assert.equal(f.at(-1).type, 'error')
  assert.match(f.at(-1).message, /key/i)
  await stopBridge()
})

test('openai-compatible: streaming + tool call + follow-up', async () => {
  await startBridge({ OPENAI_API_KEY: 'sk-test-test-test-test', OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`, KUMARI_LLM_PROVIDER: 'openai', GEMINI_API_KEY: '', OLLAMA_HOST: 'http://127.0.0.1:1' })
  let f = await turn('hi')
  assert.equal(textOf(f), 'Hi from openai.')
  f = await turn('please note this down')
  assert.equal(textOf(f).trim(), 'All done.')
  assert.match(readFileSync(join(notesDir, 'notes.md'), 'utf8'), /buy tea/)
  await stopBridge()
})

test('anthropic: streaming + tool_use + tool_result', async () => {
  await startBridge({ ANTHROPIC_API_KEY: 'sk-ant-test-test-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, KUMARI_LLM_PROVIDER: 'anthropic', GEMINI_API_KEY: '', OLLAMA_HOST: 'http://127.0.0.1:1' })
  let f = await turn('hi')
  assert.equal(textOf(f), 'Hello from Claude.')
  f = await turn('jot this')
  assert.equal(textOf(f).trim(), 'Claude finished.')
  assert.match(readFileSync(join(notesDir, 'notes.md'), 'utf8'), /call mom/)
  await stopBridge()
})

test('failover: dead gemini key falls through to the next provider', async () => {
  await startBridge({ GEMINI_API_KEY: 'wrong-key-wrong-key-1', GEMINI_BASE_URL: `http://127.0.0.1:${mock.port}/v1beta`, OPENAI_API_KEY: 'sk-test-test-test-test', OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`, OLLAMA_HOST: 'http://127.0.0.1:1' })
  const f = await turn('hi')
  assert.equal(textOf(f), 'Hi from openai.')
  await stopBridge()
})
