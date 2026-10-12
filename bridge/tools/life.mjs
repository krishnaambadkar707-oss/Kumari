/**
 * Timers, reminders and notes.
 *
 * Reminders live in data/reminders.json and are re-armed when the bridge
 * starts, so "remind me at six" survives a restart. When one fires, the bridge
 * pushes a `say` frame to the browser, which speaks it. If no browser tab is
 * open at that moment it waits and is delivered on the next connection.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DELAY = 2 ** 31 - 1 // setTimeout's ceiling (~24.8 days)

export function createScheduler({ dataDir, onFire }) {
  const file = join(dataDir, 'reminders.json')
  /** @type {{id:string, at:number, text:string, kind:'timer'|'reminder'}[]} */
  let items = []
  const handles = new Map()
  let seq = 0

  const persist = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      /* a failed save only loses restart-survival, not the live timer */
    }
  }

  const arm = (item) => {
    const delay = item.at - Date.now()
    const wait = Math.min(Math.max(delay, 0), MAX_DELAY)
    const handle = setTimeout(() => {
      handles.delete(item.id)
      // A very distant reminder wakes up early and re-arms for the remainder.
      if (item.at - Date.now() > 1000) return arm(item)
      items = items.filter((i) => i.id !== item.id)
      persist()
      try {
        onFire(item)
      } catch (err) {
        console.warn('[kumari] reminder delivery failed:', err?.message ?? err)
      }
    }, wait)
    handle.unref?.()
    handles.set(item.id, handle)
  }

  const newId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`

  return {
    /** Load saved reminders. Anything that came due while we were off fires now. */
    start() {
      try {
        if (existsSync(file)) {
          const saved = JSON.parse(readFileSync(file, 'utf8'))
          if (Array.isArray(saved)) items = saved.filter((i) => i && i.at && i.text)
        }
      } catch {
        items = []
      }
      for (const item of [...items]) {
        if (item.at < Date.now() - 6 * 3600_000) {
          items = items.filter((i) => i.id !== item.id) // too stale to be useful
        } else {
          arm(item)
        }
      }
      persist()
    },

    add({ at, text, kind }) {
      const item = { id: newId(), at, text: String(text).trim(), kind }
      items.push(item)
      persist()
      arm(item)
      return item
    },

    list: () => [...items].sort((a, b) => a.at - b.at),

    /** Cancel by id or by a word in the text. Returns how many were cancelled. */
    cancel(which) {
      const key = String(which ?? '').toLowerCase().trim()
      const hit = items.filter(
        (i) => !key || key === 'all' || i.id === key || i.text.toLowerCase().includes(key),
      )
      for (const i of hit) {
        clearTimeout(handles.get(i.id))
        handles.delete(i.id)
      }
      items = items.filter((i) => !hit.includes(i))
      persist()
      return hit.length
    },

    stop() {
      for (const h of handles.values()) clearTimeout(h)
      handles.clear()
    },
  }
}

/** "in 5 minutes" / "at 6:30 pm" in words, for the model and for speech. */
export function describeWhen(ms, now = Date.now()) {
  const secs = Math.round((ms - now) / 1000)
  if (secs < 90) return `${Math.max(secs, 1)} seconds`
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins} minutes`
  const hours = Math.round((secs / 3600) * 10) / 10
  if (hours < 36) return `${hours} hours`
  return new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Parse "30 seconds", "5 minutes", "2 hours", "1h30m" into seconds. Returns 0 if unclear. */
export function parseDuration(input) {
  if (typeof input === 'number') return Math.max(0, Math.round(input))
  const s = String(input ?? '').toLowerCase()
  let total = 0
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g
  let m
  while ((m = re.exec(s))) {
    const n = parseFloat(m[1])
    const unit = m[2][0]
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
  }
  if (!total && /^\d+(\.\d+)?$/.test(s.trim())) total = parseFloat(s) * 60 // bare number = minutes
  return Math.round(total)
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function createNotes({ notesDir }) {
  const file = join(notesDir, 'notes.md')
  return {
    path: file,
    add(text) {
      const clean = String(text ?? '').trim()
      if (!clean) return { ok: false, say: 'What should I write down?' }
      try {
        mkdirSync(notesDir, { recursive: true })
        const stamp = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        appendFileSync(file, `- **${stamp}** — ${clean}\n`, 'utf8')
        return { ok: true, say: 'Noted.' }
      } catch (err) {
        return { ok: false, say: `I could not save the note. ${err?.code ?? ''}`.trim() }
      }
    },
    read(count = 5) {
      try {
        if (!existsSync(file)) return { ok: true, lines: [] }
        const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        return { ok: true, lines: lines.slice(-Math.max(1, Math.min(30, count))) }
      } catch {
        return { ok: false, lines: [] }
      }
    },
  }
}
