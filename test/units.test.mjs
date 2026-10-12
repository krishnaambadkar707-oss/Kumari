import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchLocal } from '../bridge/intents.mjs'
import { createMemory } from '../bridge/memory.mjs'
import { parseDuckDuckGo, extractPage, parseRss, describeWeather } from '../bridge/tools/web.mjs'
import { parseDuration, describeWhen } from '../bridge/tools/life.mjs'
import { rankGeminiModels, thinkingOptions } from '../bridge/providers/gemini.mjs'
import { tool, cleanSchema } from '../bridge/tooling.mjs'
import { z } from 'zod'
import { sseEvents } from '../bridge/providers/common.mjs'
import { realKey, loadDotenv } from '../bridge/config.mjs'
import { writeFileSync } from 'node:fs'

const mem = () => createMemory({ dataDir: mkdtempSync(join(tmpdir(), 'km-')) })
const env = (hasBrain = true) => ({ memory: mem(), hasBrain })

test('fast path: open known apps in English, Hinglish and Devanagari', () => {
  for (const t of ['open chrome', 'Open Chrome please', 'chrome kholo', 'क्रोम खोलो', 'launch chrome', 'youtube khol do', 'ओपन यूट्यूब']) {
    assert.equal(matchLocal(t, env())?.tool, 'open_app', t)
  }
})
test('fast path leaves unknowns and questions to the model', () => {
  for (const t of ['open the pod bay doors', 'what is the capital of France', 'tell me a joke', 'open sesame now']) {
    assert.equal(matchLocal(t, env()), null, t)
  }
})
test('fast path: unknown app is attempted when no model exists', () => {
  assert.equal(matchLocal('open vlc', env(false))?.tool, 'open_app')
  assert.equal(matchLocal('open vlc', env(true)), null)
})
test('fast path: volume, time, screenshot, battery', () => {
  assert.equal(matchLocal('volume up', env()).tool, 'media_control')
  assert.equal(matchLocal('आवाज़ कम करो', env()).tool, 'media_control')
  assert.equal(matchLocal('mute', env()).tool, 'media_control')
  assert.equal(matchLocal('time kya hai', env()).tool, 'clock')
  assert.equal(matchLocal('take a screenshot', env()).tool, 'screenshot')
  assert.equal(matchLocal('battery kitni hai', env()).tool, 'system_status')
})
test('"note this down" is not hijacked by memory; "remember that" is', () => {
  assert.equal(matchLocal('please note this down', env()), null)
  assert.ok(matchLocal('remember that my exam is on Monday', env()))
  assert.ok(matchLocal('yaad rakho ki mera birthday 5 may ko hai', env()))
})
test('memory: add, dedupe, forget, persists', async () => {
  const m = mem()
  assert.equal(m.addFact('exam on monday').added, true)
  assert.equal(m.addFact('Exam on  Monday').added, false)
  assert.match(m.factsBlock(), /exam on monday/)
  assert.equal(m.removeFacts('exam'), 1)
  assert.equal(m.facts().length, 0)
  m.appendTurn('assistant', 'stray'); m.appendTurn('user', 'hi'); m.appendTurn('assistant', 'hello')
  assert.deepEqual(m.historyMessages().map((x) => x.role), ['user', 'assistant'])
})
test('duration parsing', () => {
  assert.equal(parseDuration('5 minutes'), 300)
  assert.equal(parseDuration('1 hour 30 minutes'), 5400)
  assert.equal(parseDuration('45 seconds'), 45)
  assert.equal(parseDuration('10'), 600)
  assert.equal(parseDuration('soon'), 0)
  assert.match(describeWhen(Date.now() + 300_000), /minutes/)
})
test('duckduckgo parser unwraps redirect links and skips ads', () => {
  const html = `
  <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; Title</a>
  <a class="result__snippet" href="x">A <b>snippet</b> here</a></div>
  <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
  <div class="result"><a class="result__a" href="https://second.org/">Second</a><a class="result__snippet">Two</a></div>`
  const r = parseDuckDuckGo(html)
  assert.equal(r.length, 2)
  assert.equal(r[0].url, 'https://example.com/a?x=1')
  assert.equal(r[0].title, 'Example & Title')
  assert.equal(r[0].snippet, 'A snippet here')
})
test('page extraction keeps article text and images, drops chrome', () => {
  const html = `<html><head><title>Big News</title><meta property="og:image" content="/og.jpg"></head><body>
  <nav>Home About Contact us today for more links here</nav><article><p>${'This is a long and meaningful sentence about the story. '.repeat(3)}</p><img src="/pic.jpg"><img src="/logo.svg"></article><footer>Copyright footer text that is long enough to count</footer><script>x()</script></body></html>`
  const p = extractPage(html, 'https://news.test/a/b')
  assert.equal(p.title, 'Big News')
  assert.match(p.text, /meaningful sentence/)
  assert.doesNotMatch(p.text, /Copyright|Contact/)
  assert.deepEqual(p.images, ['https://news.test/og.jpg', 'https://news.test/pic.jpg'])
})
test('rss parser', () => {
  const xml = `<rss><channel><item><title><![CDATA[Cricket: India win &amp; series]]></title><link>https://n/1</link><source url="x">The Hindu</source><pubDate>Sun, 11 Oct 2026</pubDate></item></channel></rss>`
  const [i] = parseRss(xml)
  assert.equal(i.title, 'Cricket: India win & series'); assert.equal(i.source, 'The Hindu')
  assert.equal(describeWeather(63), 'rain')
})
test('gemini model ranking prefers newest flash, skips image/tts/lite-when-better', () => {
  const m = (n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })
  const r = rankGeminiModels([m('gemini-2.5-flash'), m('gemini-3.8-flash'), m('gemini-3.8-flash-image'), m('gemini-3.8-pro'), m('gemini-3.1-flash-lite'), m('gemini-3.8-flash-tts'), m('gemma-3-27b')])
  assert.equal(r[0], 'gemini-3.8-flash')
  assert.ok(!r.some((x) => /image|tts|gemma/.test(x)))
  assert.deepEqual(thinkingOptions('gemini-2.5-flash'), [{ thinkingBudget: 0 }, null])
})
test('tool schemas: unions collapse, records become JSON strings, handler parses them back', async () => {
  let got
  const t = tool('x', 'd', { n: z.union([z.number(), z.string()]).optional().catch(undefined), o: z.record(z.string(), z.string()).optional().catch(undefined), k: z.enum(['a', 'b']) }, async (a) => { got = a; return { content: [] } })
  assert.equal(t.parameters.properties.n.type, 'string')
  assert.equal(t.parameters.properties.o.type, 'string')
  assert.deepEqual(t.parameters.required, ['k'])
  await t.run({ n: '7', o: '{"a":"b"}', k: 'a' })
  assert.deepEqual(got.o, { a: 'b' })
  assert.ok(!JSON.stringify(t.parameters).includes('additionalProperties'))
})
test('SSE parser handles split chunks, CRLF and multiline data', async () => {
  const enc = new TextEncoder()
  const parts = ['data: {"a"', ':1}\r\n\r\nevent: x\r\ndata: l1\r\ndata: l2\r\n\r\n: c\n\ndata: tail']
  const body = new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close() } })
  const out = []; for await (const e of sseEvents(body)) out.push(e)
  assert.deepEqual(out.map((e) => [e.event, e.data]), [['message', '{"a":1}'], ['x', 'l1\nl2'], ['message', 'tail']])
})
test('.env: BOM, CRLF, quotes, comments; placeholder keys ignored', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ke-')), '.env')
  writeFileSync(f, '\uFEFF# c\r\nA=1\r\nB="two words"  # note\r\nexport C=3\r\nGEMINI_API_KEY=your-gemini-key-here\r\n')
  const t = {}; loadDotenv(f, t)
  assert.deepEqual([t.A, t.B, t.C], ['1', 'two words', '3'])
  assert.equal(realKey(t.GEMINI_API_KEY), '')
  assert.equal(realKey('AIzaSyD-realLookingKey_1234567890'), 'AIzaSyD-realLookingKey_1234567890')
})

test('.env: a later line beats an earlier placeholder; empty real env does not block the file', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ke2-')), '.env')
  writeFileSync(f, 'GEMINI_API_KEY=your-gemini-key-here\r\nGEMINI_API_KEY=AIzaSyD-realLookingKey_1234567890\r\nX="\u201cquoted\u201d"\r\n')
  const t = { GEMINI_API_KEY: '' }; loadDotenv(f, t)
  assert.equal(t.GEMINI_API_KEY, 'AIzaSyD-realLookingKey_1234567890')
  const u = { GEMINI_API_KEY: 'from-shell-key-123456' }; loadDotenv(f, u)
  assert.equal(u.GEMINI_API_KEY, 'from-shell-key-123456')
})
