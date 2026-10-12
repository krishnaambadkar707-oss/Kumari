/**
 * Kumari's memory.
 *
 * A port of the original Python memory.py, same two layers and same file names
 * (data/facts_memory.json, data/conversation_memory.json), so anything already
 * saved is picked up:
 *
 *   1. Facts — durable notes that persist across restarts and are always in the
 *      system prompt. Added when you say "remember ..." (English or Hindi), or
 *      when the model decides something is worth keeping and calls `remember`.
 *   2. Conversation — the last N turns, so replies stay contextual and Kumari
 *      still knows what you were talking about after a restart.
 *
 * Writes are atomic (temp file + rename) so a crash or a power cut mid-write
 * can never leave a half-written, unreadable memory file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export function createMemory({ dataDir, maxTurns = 24 }) {
  const factsFile = join(dataDir, 'facts_memory.json')
  const convoFile = join(dataDir, 'conversation_memory.json')

  const ensure = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
    } catch {
      /* surfaced when the write fails */
    }
  }

  const load = (path, fallback) => {
    try {
      if (!existsSync(path)) return fallback
      const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(data) ? data : fallback
    } catch {
      return fallback
    }
  }

  const save = (path, data) => {
    ensure()
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, path)
      return true
    } catch (err) {
      // Windows can refuse a rename while an antivirus scanner holds the target.
      try {
        writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
        return true
      } catch {
        console.warn(`[kumari] could not save ${path}: ${err?.message ?? err}`)
        return false
      } finally {
        try {
          unlinkSync(tmp)
        } catch {
          /* already gone */
        }
      }
    }
  }

  const stamp = () => new Date().toISOString().slice(0, 19)
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

  return {
    // ---------------------------------------------------------------- facts
    facts: () => load(factsFile, []),

    addFact(text) {
      const clean = String(text ?? '').trim().replace(/^that\s+/i, '')
      if (!clean) return { added: false, fact: null }
      const facts = load(factsFile, [])
      const dupe = facts.find((f) => norm(f.text) === norm(clean))
      if (dupe) return { added: false, fact: dupe }
      const fact = { text: clean, ts: stamp() }
      facts.push(fact)
      save(factsFile, facts.slice(-200))
      return { added: true, fact }
    },

    /** Remove every fact containing `keyword`. Returns how many went. */
    removeFacts(keyword) {
      const key = norm(keyword)
      if (!key) return 0
      const facts = load(factsFile, [])
      const kept = facts.filter((f) => !norm(f.text).includes(key))
      const removed = facts.length - kept.length
      if (removed) save(factsFile, kept)
      return removed
    },

    clearFacts() {
      save(factsFile, [])
    },

    factsBlock() {
      const facts = load(factsFile, [])
      if (!facts.length) return ''
      return (
        '\nThings the user has asked you to remember (treat as true, use when relevant):\n' +
        facts.map((f) => `- ${f.text}`).join('\n') +
        '\n'
      )
    },

    // --------------------------------------------------------- conversation
    conversation: () => load(convoFile, []),

    appendTurn(role, text) {
      const clean = String(text ?? '').trim()
      if (!clean) return
      const convo = load(convoFile, [])
      convo.push({ role, content: clean, ts: stamp() })
      save(convoFile, convo.slice(-maxTurns))
    },

    clearConversation() {
      save(convoFile, [])
    },

    /** History in the neutral message format the providers take. */
    historyMessages() {
      const convo = load(convoFile, [])
      const out = []
      for (const t of convo) {
        if (t.role !== 'user' && t.role !== 'assistant') continue
        if (t.role === 'user') out.push({ role: 'user', text: t.content })
        else out.push({ role: 'assistant', text: t.content })
      }
      // Providers insist the conversation starts with the user and alternates
      // sensibly; trim stray leading assistant turns left by truncation.
      while (out.length && out[0].role !== 'user') out.shift()
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Spoken memory commands, English + Hindi/Hinglish. Matched strictly so an
// ordinary sentence containing the word "remember" is left to the model.
// ---------------------------------------------------------------------------

const REMEMBER = [
  /^(?:please\s+)?remember\s+(?:that\s+)?(.{3,})$/i,
  /^(?:please\s+)?note\s+that\s+(.{3,})$/i,
  /^don'?t\s+forget\s+(?:that\s+)?(.{3,})$/i,
  /^(?:yaad|yad)\s+rakh(?:o|na|na\s+ki)?\s+(?:ki\s+)?(.{3,})$/i,
  /^(?:mujhe\s+)?yaad\s+(?:dilana|rakhna)\s+(?:ki\s+)?(.{3,})$/i,
  /^(?:याद|यद)\s+रख(?:ो|ना)?\s+(?:कि\s+)?(.{3,})$/,
  /^(?:ये|यह)\s+याद\s+रखो[\s,:-]+(.{3,})$/,
]

const FORGET = [
  /^forget\s+(?:about\s+|that\s+)?(.{2,})$/i,
  /^(?:bhool|bhul)\s+jao\s+(.{2,})$/i,
  /^(.{2,})\s+(?:bhool|bhul)\s+jao$/i,
  /^(.{2,})\s+भूल\s+जाओ$/,
  /^भूल\s+जाओ\s+(.{2,})$/,
]

const LIST = [
  /^what\s+(?:do\s+you|have\s+you)\s+remember(?:ed)?(?:\s+about\s+me)?\??$/i,
  /^what\s+do\s+you\s+know\s+about\s+me\??$/i,
  /^(?:list|show)\s+(?:my\s+)?(?:memories|facts|notes)$/i,
  /^(?:tumhe|tumhein|aapko)\s+kya\s+(?:kya\s+)?yaad\s+hai\??$/i,
  /^तुम्हें\s+क्या\s+(?:क्या\s+)?याद\s+है\??$/,
]

/**
 * Handle "remember X" / "forget X" / "what do you remember".
 * Returns { reply } when handled, or null to pass the text on.
 */
export function handleMemoryCommand(memory, rawText) {
  const text = String(rawText ?? '').trim().replace(/[.!?।]+$/, '')
  if (!text) return null

  for (const re of LIST) {
    if (re.test(text)) {
      const facts = memory.facts()
      if (!facts.length) return { reply: 'I have nothing saved yet. Tell me to remember something.' }
      const spoken = facts.slice(-8).map((f) => f.text).join('. ')
      return { reply: `Here is what I remember. ${spoken}.` }
    }
  }
  for (const re of REMEMBER) {
    const m = re.exec(text)
    if (m) {
      const { added } = memory.addFact(m[1])
      return {
        reply: added ? `Got it. I will remember that ${m[1].trim()}.` : 'I already had that noted.',
        tool: 'remember',
      }
    }
  }
  for (const re of FORGET) {
    const m = re.exec(text)
    if (m) {
      const removed = memory.removeFacts(m[1])
      return {
        reply: removed
          ? `Done. I have forgotten what I knew about ${m[1].trim()}.`
          : `I had nothing stored about ${m[1].trim()}.`,
        tool: 'forget',
      }
    }
  }
  return null
}
