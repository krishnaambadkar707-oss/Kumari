/**
 * Laptop control: the "hands" Kumari had in app_launcher.py, rebuilt to be
 * safer and to work from both the fast local path and the model's tool calls.
 *
 * Design rules that keep this reliable:
 *   - Nothing here builds a shell string out of user text. Windows uses
 *     `cmd /c start "" <target>` with the target passed as one argument, and
 *     PowerShell receives fixed scripts, never interpolated speech.
 *   - Every action returns a plain sentence that is fine to speak aloud.
 *   - Web addresses are only ever http(s); nothing else is handed to the OS.
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir, platform, cpus, totalmem, freemem, uptime, hostname } from 'node:os'
import { join } from 'node:path'

const OS = platform() // 'win32' | 'darwin' | 'linux'
export const IS_WINDOWS = OS === 'win32'

/** Fire-and-forget launch that can never throw into the caller. */
function detach(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...opts,
      })
      child.once('error', (err) => resolve({ ok: false, error: err }))
      child.unref()
      // `error` for a missing binary is emitted on the next tick.
      setTimeout(() => resolve({ ok: true }), 120)
    } catch (error) {
      resolve({ ok: false, error })
    }
  })
}

function run(cmd, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error }),
    )
  })
}

const powershell = (script, timeoutMs) =>
  run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeoutMs,
  )

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/**
 * Spoken name -> what to launch. Windows entries are either an executable that
 * Windows can resolve (App Paths / PATH), or a URI scheme.
 */
const WINDOWS_APPS = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  calc: 'calc.exe',
  'file explorer': 'explorer.exe',
  explorer: 'explorer.exe',
  files: 'explorer.exe',
  chrome: 'chrome',
  'google chrome': 'chrome',
  edge: 'msedge',
  'microsoft edge': 'msedge',
  firefox: 'firefox',
  'vs code': 'code',
  vscode: 'code',
  'visual studio code': 'code',
  word: 'winword',
  'microsoft word': 'winword',
  excel: 'excel',
  powerpoint: 'powerpnt',
  outlook: 'outlook',
  'task manager': 'taskmgr.exe',
  cmd: 'cmd.exe',
  'command prompt': 'cmd.exe',
  powershell: 'powershell.exe',
  terminal: 'wt.exe',
  paint: 'mspaint.exe',
  settings: 'ms-settings:',
  'control panel': 'control.exe',
  camera: 'microsoft.windows.camera:',
  clock: 'ms-clock:',
  store: 'ms-windows-store:',
  spotify: 'spotify:',
  discord: 'discord:',
  whatsapp: 'whatsapp:',
  telegram: 'tg:',
  zoom: 'zoommtg:',
  teams: 'msteams:',
  steam: 'steam:',
  snipping: 'ms-screenclip:',
  'snipping tool': 'ms-screenclip:',
  'screen recorder': 'ms-screenclip:',
  'sticky notes': 'ms-stickynotes:',
}

const MAC_APPS = {
  notes: 'Notes', calculator: 'Calculator', calc: 'Calculator', finder: 'Finder',
  chrome: 'Google Chrome', 'google chrome': 'Google Chrome', safari: 'Safari',
  firefox: 'Firefox', 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code',
  terminal: 'Terminal', spotify: 'Spotify', discord: 'Discord', settings: 'System Settings',
  word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint',
  whatsapp: 'WhatsApp', zoom: 'zoom.us', slack: 'Slack',
}

const LINUX_APPS = {
  calculator: 'gnome-calculator', calc: 'gnome-calculator', files: 'nautilus',
  chrome: 'google-chrome', 'google chrome': 'google-chrome', firefox: 'firefox',
  'vs code': 'code', vscode: 'code', terminal: 'gnome-terminal', spotify: 'spotify',
  discord: 'discord', settings: 'gnome-control-center',
}

export const WEBSITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  whatsapp: 'https://web.whatsapp.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
  calendar: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com',
  wikipedia: 'https://www.wikipedia.org',
  stackoverflow: 'https://stackoverflow.com',
  'stack overflow': 'https://stackoverflow.com',
  kaggle: 'https://www.kaggle.com',
  colab: 'https://colab.research.google.com',
  'google colab': 'https://colab.research.google.com',
  hotstar: 'https://www.hotstar.com',
  spotify: 'https://open.spotify.com',
  'prime video': 'https://www.primevideo.com',
  'canva': 'https://www.canva.com',
  'notion': 'https://www.notion.so',
}

const appTable = () => (IS_WINDOWS ? WINDOWS_APPS : OS === 'darwin' ? MAC_APPS : LINUX_APPS)

/** Normalise a spoken app name (strip articles, "app", punctuation). */
export function cleanName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[,!?।"“”']/g, ' ')
    .replace(/\.+\s*$/, '')
    .replace(/\b(the|a|an|my|app|application|please|for me|now|ko|kholo|khol do|kar do)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Is this something we can launch confidently without asking the model? */
export function knownTarget(name) {
  const n = cleanName(name)
  if (!n) return null
  if (appTable()[n]) return { kind: 'app', name: n }
  if (WEBSITES[n]) return { kind: 'site', name: n }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(n) && !/\s/.test(n)) return { kind: 'domain', name: n }
  return null
}

/** Only http(s) ever reaches the browser. */
export function safeUrl(input) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

export async function openUrl(url) {
  const safe = safeUrl(url)
  if (!safe) return { ok: false, say: 'That address does not look right.' }
  let r
  if (IS_WINDOWS) {
    // `start` is a cmd built-in. The empty "" is the window title; the URL is
    // quoted as one argument so `&` in a query string is safe.
    r = await detach('cmd.exe', ['/c', 'start', '""', `"${safe}"`], {
      windowsVerbatimArguments: true,
    })
  } else if (OS === 'darwin') {
    r = await detach('open', [safe])
  } else {
    r = await detach('xdg-open', [safe])
  }
  return r.ok
    ? { ok: true, say: 'Opened.' }
    : { ok: false, say: 'I could not open the browser on this machine.' }
}


/** Windows targets that ship with the OS and always resolve. */
const CORE_WINDOWS = new Set([
  'notepad.exe', 'calc.exe', 'explorer.exe', 'taskmgr.exe', 'cmd.exe',
  'powershell.exe', 'wt.exe', 'mspaint.exe', 'control.exe',
])

async function launchWindows(launch, name) {
  const r = await detach('cmd.exe', ['/c', 'start', '""', `"${launch.replace(/"/g, '')}"`], {
    windowsVerbatimArguments: true,
  })
  return r.ok ? { ok: true, say: `Opening ${name}.` } : { ok: false, say: `I could not open ${name}.` }
}

const resolveCache = new Map()

/** True if `start <target>` would find it: registered App Path, or on the PATH. */
async function windowsCanResolve(target) {
  if (resolveCache.has(target)) return resolveCache.get(target)
  const exe = /\.(exe|cmd|bat)$/i.test(target) ? target : `${target}.exe`
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ]
  let ok = false
  for (const key of keys) {
    if ((await run('reg.exe', ['query', key], 4000)).ok) {
      ok = true
      break
    }
  }
  if (!ok) ok = (await run('where.exe', [target], 4000)).ok
  resolveCache.set(target, ok)
  return ok
}

/** Open an application by spoken name. */
export async function openApp(rawName) {
  const name = cleanName(rawName)
  if (!name) return { ok: false, say: 'Which app should I open?' }

  const table = appTable()
  const target = table[name]

  if (WEBSITES[name] && !target) {
    const r = await openUrl(WEBSITES[name])
    return { ...r, say: r.ok ? `Opening ${name}.` : r.say }
  }

  if (IS_WINDOWS) {
    // 1. A known target that is certain to exist (system tools, URI schemes).
    if (target && (CORE_WINDOWS.has(target) || target.endsWith(':'))) {
      return launchWindows(target, name)
    }
    // 2. A known target that is only there if the app is installed (Chrome,
    //    Word...). Checked first so Windows never pops its "cannot find" box.
    if (target && (await windowsCanResolve(target))) {
      return launchWindows(target, name)
    }
    // 3. Anything else: look the spoken name up in the Start Menu, which also
    //    finds Store apps and things like "VLC media player".
    const found = await powershell(
      `$n=${psString(name)}; (Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1 -ExpandProperty AppID)`,
      10_000,
    )
    const appId = found.stdout.trim().split(/\r?\n/)[0]
    if (appId) {
      const r = await detach('explorer.exe', [`shell:AppsFolder\\${appId}`])
      return r.ok ? { ok: true, say: `Opening ${name}.` } : { ok: false, say: `I could not open ${name}.` }
    }
    // 4. Something on the PATH that is not in the Start Menu.
    if (!target && (await run('where.exe', [name], 5000)).ok) {
      return launchWindows(name, name)
    }
    return { ok: false, say: `I could not find ${name} on this laptop.` }
  }

  if (OS === 'darwin') {
    const r = await detach('open', ['-a', target ?? rawName.trim()])
    return r.ok ? { ok: true, say: `Opening ${name}.` } : { ok: false, say: `I could not open ${name}.` }
  }

  const r = await detach(target ?? name.replace(/\s+/g, '-'), [])
  return r.ok ? { ok: true, say: `Opening ${name}.` } : { ok: false, say: `I could not find ${name} on this machine.` }
}

/** Quote a string as a PowerShell single-quoted literal. */
const psString = (s) => `'${String(s).replace(/'/g, "''")}'`

// ---------------------------------------------------------------------------
// Web launches
// ---------------------------------------------------------------------------

export async function googleSearch(query) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, say: 'What should I search for?' }
  const r = await openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`)
  return { ...r, say: r.ok ? `Searching Google for ${q}.` : r.say }
}

export async function youtubeSearch(query) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, say: 'What should I look up on YouTube?' }
  const r = await openUrl(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`)
  return { ...r, say: r.ok ? `Searching YouTube for ${q}.` : r.say }
}

// ---------------------------------------------------------------------------
// Volume (no extra software: Windows virtual media keys via WScript.Shell)
// ---------------------------------------------------------------------------

const VOLUME_KEYS = { up: 175, down: 174, mute: 173 }

export async function changeVolume(direction, steps = 5) {
  const dir = String(direction).toLowerCase()
  const n = Math.max(1, Math.min(25, Math.round(Number(steps) || 5)))
  if (IS_WINDOWS) {
    const key = VOLUME_KEYS[dir]
    if (!key) return { ok: false, say: 'Say volume up, down, or mute.' }
    const count = dir === 'mute' ? 1 : n
    const r = await powershell(
      `$w=New-Object -ComObject WScript.Shell; 1..${count} | ForEach-Object { $w.SendKeys([char]${key}) }`,
      8000,
    )
    if (!r.ok) return { ok: false, say: 'I could not change the volume.' }
    return { ok: true, say: dir === 'mute' ? 'Toggled mute.' : `Volume ${dir}.` }
  }
  if (OS === 'darwin') {
    const script =
      dir === 'mute'
        ? 'set volume output muted not (output muted of (get volume settings))'
        : `set volume output volume ((output volume of (get volume settings)) ${dir === 'up' ? '+' : '-'} ${n * 3})`
    const r = await run('osascript', ['-e', script])
    return r.ok ? { ok: true, say: dir === 'mute' ? 'Toggled mute.' : `Volume ${dir}.` } : { ok: false, say: 'I could not change the volume.' }
  }
  const arg = dir === 'mute' ? 'toggle' : `${n * 3}%${dir === 'up' ? '+' : '-'}`
  const r = await run('amixer', ['set', 'Master', arg])
  return r.ok ? { ok: true, say: dir === 'mute' ? 'Toggled mute.' : `Volume ${dir}.` } : { ok: false, say: 'I could not change the volume.' }
}

/** Media keys: play/pause, next, previous. */
export async function mediaKey(action) {
  const keys = { playpause: 179, next: 176, previous: 177, stop: 178 }
  const key = keys[String(action).toLowerCase()]
  if (!key) return { ok: false, say: 'I do not know that media control.' }
  if (!IS_WINDOWS) return { ok: false, say: 'Media keys are only wired up for Windows.' }
  const r = await powershell(`(New-Object -ComObject WScript.Shell).SendKeys([char]${key})`, 6000)
  return r.ok ? { ok: true, say: 'Done.' } : { ok: false, say: 'I could not send that media key.' }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export async function takeScreenshot() {
  const dir = join(tmpdir(), 'kumari-shots')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* handled by the write failing below */
  }
  const file = join(dir, `shot-${Date.now()}.png`)

  if (IS_WINDOWS) {
    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$bmp.Save(${psString(file)},[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`
    const r = await powershell(script, 20_000)
    if (!r.ok || !existsSync(file)) return { ok: false, say: 'I could not capture the screen.' }
  } else if (OS === 'darwin') {
    const r = await run('screencapture', ['-x', file])
    if (!r.ok) return { ok: false, say: 'I could not capture the screen.' }
  } else {
    const r = (await run('gnome-screenshot', ['-f', file])).ok
      ? { ok: true }
      : await run('import', ['-window', 'root', file])
    if (!r.ok) return { ok: false, say: 'I could not capture the screen.' }
  }
  return { ok: true, file, say: 'Screenshot taken.' }
}

// ---------------------------------------------------------------------------
// Power / session
// ---------------------------------------------------------------------------

export async function lockScreen() {
  if (IS_WINDOWS) {
    const r = await detach('rundll32.exe', ['user32.dll,LockWorkStation'])
    return r.ok ? { ok: true, say: 'Locking the screen.' } : { ok: false, say: 'I could not lock the screen.' }
  }
  if (OS === 'darwin') {
    const r = await detach('pmset', ['displaysleepnow'])
    return r.ok ? { ok: true, say: 'Locking the screen.' } : { ok: false, say: 'I could not lock the screen.' }
  }
  const r = await detach('loginctl', ['lock-session'])
  return r.ok ? { ok: true, say: 'Locking the screen.' } : { ok: false, say: 'I could not lock the screen.' }
}

/**
 * Shutdown / restart / sleep. A 30 second Windows timer is used for the first
 * two so that `cancelPower` can still stop it.
 */
export async function powerAction(action) {
  const a = String(action).toLowerCase()
  if (IS_WINDOWS) {
    if (a === 'shutdown') {
      const r = await detach('shutdown.exe', ['/s', '/t', '30'])
      return r.ok ? { ok: true, say: 'Shutting down in thirty seconds. Say cancel to stop it.' } : { ok: false, say: 'I could not start the shutdown.' }
    }
    if (a === 'restart') {
      const r = await detach('shutdown.exe', ['/r', '/t', '30'])
      return r.ok ? { ok: true, say: 'Restarting in thirty seconds. Say cancel to stop it.' } : { ok: false, say: 'I could not start the restart.' }
    }
    if (a === 'sleep') {
      const r = await detach('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
      return r.ok ? { ok: true, say: 'Going to sleep.' } : { ok: false, say: 'I could not put the laptop to sleep.' }
    }
  } else if (OS === 'darwin') {
    if (a === 'sleep') return (await detach('pmset', ['sleepnow'])).ok ? { ok: true, say: 'Going to sleep.' } : { ok: false, say: 'I could not sleep.' }
    return { ok: false, say: 'Shutdown and restart are only wired up for Windows.' }
  } else if (a === 'sleep') {
    return (await detach('systemctl', ['suspend'])).ok ? { ok: true, say: 'Going to sleep.' } : { ok: false, say: 'I could not sleep.' }
  }
  return { ok: false, say: 'I do not know that power action.' }
}

export async function cancelPower() {
  if (!IS_WINDOWS) return { ok: false, say: 'Nothing to cancel here.' }
  const r = await run('shutdown.exe', ['/a'], 6000)
  return r.ok
    ? { ok: true, say: 'Cancelled.' }
    : { ok: false, say: 'There was no shutdown pending.' }
}

// ---------------------------------------------------------------------------
// Information
// ---------------------------------------------------------------------------

export async function batteryStatus() {
  if (IS_WINDOWS) {
    const r = await powershell(
      '$b=Get-CimInstance Win32_Battery; if($b){ "$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)" }',
      8000,
    )
    const [pct, status] = r.stdout.trim().split('|')
    if (!pct) return { ok: true, say: 'This machine does not report a battery. It is probably plugged in.' }
    // BatteryStatus 2 = on AC, 6-9 = charging variants
    const charging = ['2', '6', '7', '8', '9'].includes(status)
    return { ok: true, say: `The battery is at ${pct} percent${charging ? ' and charging' : ' and not charging'}.` }
  }
  if (OS === 'darwin') {
    const r = await run('pmset', ['-g', 'batt'])
    const m = /(\d+)%;\s*(\w+)/.exec(r.stdout)
    if (m) return { ok: true, say: `The battery is at ${m[1]} percent and ${m[2]}.` }
  }
  return { ok: true, say: 'I could not read the battery on this machine.' }
}

export function systemInfo() {
  const gb = (b) => (b / 1024 ** 3).toFixed(1)
  const total = totalmem()
  const used = total - freemem()
  const model = cpus()[0]?.model?.replace(/\s+/g, ' ').trim() ?? 'unknown processor'
  const hours = (uptime() / 3600).toFixed(1)
  return {
    ok: true,
    say:
      `${hostname()} is running ${OS === 'win32' ? 'Windows' : OS === 'darwin' ? 'macOS' : 'Linux'} ` +
      `on ${cpus().length} cores, ${model}. Memory use is ${gb(used)} of ${gb(total)} gigabytes. ` +
      `It has been up for ${hours} hours.`,
  }
}

export function openFolder(which) {
  const map = {
    downloads: join(homedir(), 'Downloads'),
    documents: join(homedir(), 'Documents'),
    desktop: join(homedir(), 'Desktop'),
    pictures: join(homedir(), 'Pictures'),
    music: join(homedir(), 'Music'),
    videos: join(homedir(), 'Videos'),
  }
  const key = String(which ?? '').toLowerCase().trim()
  const dir = map[key]
  if (!dir) return Promise.resolve({ ok: false, say: 'I can open downloads, documents, desktop, pictures, music or videos.' })
  const opener = IS_WINDOWS ? ['explorer.exe', [dir]] : OS === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]]
  return detach(opener[0], opener[1]).then((r) =>
    r.ok ? { ok: true, say: `Opening ${key}.` } : { ok: false, say: `I could not open ${key}.` },
  )
}
