/**
 * Kumari bridge — the brain and the hands.
 *
 * One Node process that:
 *   - serves the holographic interface (the prebuilt `dist/` folder), so the
 *     whole assistant lives at one address: http://localhost:8787
 *   - runs the conversation over a WebSocket (any LLM: Gemini, Claude, ChatGPT,
 *     Groq or a local Ollama model — see providers/)
 *   - answers instantly to simple commands, controls the laptop, remembers you
 *   - proxies remote images/pages so the interface never talks to the open web
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { existsSync, readFileSync, realpathSync, createReadStream, statSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from 'node:path'

import { config, ROOT, ENV_FILE, ENV_FOUND } from './config.mjs'
import { createBrain } from './providers/index.mjs'
import { createMemory } from './memory.mjs'
import { createScheduler, createNotes } from './tools/life.mjs'
import { createSession } from './agent.mjs'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

const PORT = config.port
const DIST = join(ROOT, 'dist')

process.on('unhandledRejection', (err) => {
  console.error('[kumari] unhandled rejection:', err)
})
process.on('uncaughtException', (err) => {
  console.error('[kumari] uncaught exception:', err)
})

// ---------------------------------------------------------------------------
// Who may talk to the bridge: only pages served by this machine.
// ---------------------------------------------------------------------------

const EXTRA_ORIGINS = new Set(
  (process.env.KUMARI_ALLOWED_ORIGINS ?? process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const isDevPort = (port) => (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return false
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) return false
  const port = Number(url.port || 80)
  return port === PORT || isDevPort(port)
}

// ---------------------------------------------------------------------------
// Speech keys (ElevenLabs is optional; without it the browser speaks)
// ---------------------------------------------------------------------------

const elevenKey = () => config.elevenKey || null
const VOICE_ID = config.elevenVoice

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const memory = createMemory({ dataDir: config.dataDir, maxTurns: config.maxHistoryTurns })
const notes = createNotes({ notesDir: config.notesDir })
const brain = await createBrain(config)

/** Open browser sockets, for reminders that fire when nobody asked anything. */
const sockets = new Set()
const missed = []
const scheduler = createScheduler({
  dataDir: config.dataDir,
  onFire: (item) => {
    const frame = JSON.stringify({ type: 'say', text: item.text, kind: item.kind })
    const live = [...sockets].filter((s) => s.readyState === s.OPEN)
    if (!live.length) missed.push(item)
    for (const s of live) s.send(frame)
  },
})
scheduler.start()

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.KUMARI_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[kumari] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[kumari] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: eleven,
        stt: eleven,
        name: config.assistantName,
        user: config.userName,
        sttLang: config.sttLang,
        brain: brain.describe(),
        providers: brain.ids(),
        configured: brain.configured,
      }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res)
  res.writeHead(404, cors)
  res.end()
}


// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(req, res) {
  if (!existsSync(join(DIST, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(
      'The interface has not been built yet.\nRun `npm run build` once, or use `npm run dev` for development.',
    )
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    res.writeHead(400)
    return res.end()
  }
  let file = normalize(join(DIST, pathname === '/' ? 'index.html' : pathname))
  // Stay inside dist/, whatever the URL says.
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file')
  } catch {
    // Single-page app: unknown paths without an extension get the shell.
    if (extname(pathname)) {
      res.writeHead(404)
      return res.end()
    }
    file = join(DIST, 'index.html')
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const immutable = file.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
}


const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[kumari] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') return done(false, 403, 'Forbidden')
    if (!originAllowed(origin)) {
      console.warn(`[kumari] rejected websocket from origin ${origin ?? '(none)'} — set KUMARI_ALLOWED_ORIGINS to permit it`)
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[kumari] Port ${PORT} is already in use. Kumari may already be running — ` +
        `open http://localhost:${PORT}. Otherwise set KUMARI_PORT in .env to another number.\n`,
    )
  } else {
    console.error('[kumari] server error:', err)
  }
  process.exit(1)
})

wss.on('connection', (socket) => {
  console.log('[kumari] browser connected')
  sockets.add(socket)

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(msg))
      } catch {
        /* socket died under the write */
      }
    }
  }

  // Replies to requests the bridge made of the browser (the camera).
  const waiting = new Map()
  let asks = 0
  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) return reject(new Error('the interface is not connected'))
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  const session = createSession({
    config, memory, brain, scheduler, notes, send, ask,
    log: (m) => config.debug && console.log(`[kumari] ${m}`),
  })

  send({
    type: 'ready',
    servers: ['Brain', 'Memory', 'Laptop', 'Web'],
    name: config.assistantName,
    user: config.userName,
    sttLang: config.sttLang,
    brain: brain.describe(),
    configured: brain.configured,
  })

  // Reminders that came due while no page was open.
  while (missed.length) {
    const item = missed.shift()
    send({ type: 'say', text: item.text, kind: item.kind })
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'ask' && typeof msg.text === 'string') {
      session.ask(msg.text, typeof msg.id === 'string' ? msg.id : null)
    } else if (msg.type === 'interrupt') {
      session.interrupt()
    } else if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }
  })

  socket.on('close', () => {
    console.log('[kumari] browser disconnected')
    sockets.delete(socket)
    session.close()
    for (const slot of waiting.values()) clearTimeout(slot.timer)
    waiting.clear()
  })
})

// Heartbeat: drop sockets that vanished without a close frame (sleep, wifi).
setInterval(() => {
  for (const s of sockets) {
    if (s.isAlive === false) {
      s.terminate()
      sockets.delete(s)
      continue
    }
    s.isAlive = false
    try {
      s.ping()
    } catch {
      /* terminated next round */
    }
  }
}, 30_000).unref()
wss.on('connection', (s) => {
  s.isAlive = true
  s.on('pong', () => {
    s.isAlive = true
  })
})

server.listen(PORT, config.host, async () => {
  console.log('')
  console.log(`  ${config.assistantName} is ready.`)
  console.log(`  Open  http://localhost:${PORT}  in Chrome or Edge.`)
  console.log('')
  if (!existsSync(join(DIST, 'index.html'))) {
    console.log('  (interface not built — run `npm run build` once)')
  }
  console.log(`  settings: ${ENV_FOUND ? ENV_FILE : 'no .env file found at ' + ENV_FILE}`)
  const mask = (k) => (k ? `found (${k.slice(0, 4)}…${k.slice(-3)}, ${k.length} characters)` : 'not found')
  console.log(`  Gemini key: ${mask(config.keys.gemini)}`)
  if (!brain.configured) {
    console.log('  No AI model configured. Add GEMINI_API_KEY to .env (free: https://aistudio.google.com/apikey).')
    console.log('  Until then she can still open apps, tell the time and remember things.')
  } else {
    const report = await brain.selfTest()
    for (const r of report) {
      console.log(
        r.ok
          ? `  ✓ ${r.id} ready (${r.model})`
          : `  ✗ ${r.id}: ${r.reason}`,
      )
    }
    if (!report.some((r) => r.ok)) {
      console.log('  None of the configured AI providers answered. Check the key and the internet connection.')
    }
  }
  console.log(`  speech: ${elevenKey() ? 'ElevenLabs' : 'browser voice'}  ·  data: ${config.dataDir}`)
})

const shutdown = () => {
  scheduler.stop()
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
