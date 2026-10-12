// One command to run everything: `npm start` (or double-click Start Kumari.bat).
//   1. checks Node, installs runtime dependencies if missing
//   2. creates .env from the template on first run
//   3. starts the bridge, waits until it answers, opens the browser
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const win = process.platform === 'win32'

const major = Number(process.versions.node.split('.')[0])
if (major < 20) {
  console.error(`\nKumari needs Node.js 20 or newer (you have ${process.versions.node}).\nInstall the LTS version from https://nodejs.org and run this again.\n`)
  process.exit(1)
}

if (!existsSync(join(root, 'node_modules', 'ws'))) {
  console.log('First run: installing dependencies (about 20 seconds)...')
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: win })
  if (r.status !== 0) {
    console.error('\nnpm install failed. Check your internet connection and try again.')
    process.exit(1)
  }
}

if (!existsSync(join(root, '.env')) && existsSync(join(root, '.env.example'))) {
  copyFileSync(join(root, '.env.example'), join(root, '.env'))
  console.log('Created .env — open it and paste a free Gemini key (https://aistudio.google.com/apikey).\n')
}

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('The interface (dist folder) is missing. Re-extract the project, or run: npm install && npm run build')
  process.exit(1)
}

const port = Number(process.env.KUMARI_PORT) || (() => {
  try {
    const m = /^\s*KUMARI_PORT\s*=\s*(\d+)/m.exec(readFileSync(join(root, '.env'), 'utf8'))
    return m ? Number(m[1]) : 8787
  } catch { return 8787 }
})()

const child = spawn(process.execPath, ['bridge/server.mjs'], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill())

async function openBrowser() {
  const url = `http://localhost:${port}`
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${url}/health`)
      if (r.ok) break
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  // Chrome and Edge have the speech recognition Kumari needs; Firefox does not.
  const attempts = win
    ? [['cmd', ['/c', 'start', '""', 'chrome', url]], ['cmd', ['/c', 'start', '""', 'msedge', url]], ['cmd', ['/c', 'start', '""', url]]]
    : process.platform === 'darwin'
      ? [['open', ['-a', 'Google Chrome', url]], ['open', [url]]]
      : [['google-chrome', [url]], ['xdg-open', [url]]]
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsVerbatimArguments: win })
    if (!r.error && r.status === 0) return
  }
  console.log(`Open ${url} in Chrome or Edge.`)
}
if (!process.argv.includes('--no-open')) openBrowser()
