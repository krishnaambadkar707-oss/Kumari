/**
 * The fast path.
 *
 * Simple, unambiguous commands ("open chrome", "volume up", "what time is it",
 * "remember that my viva is on the tenth") are answered here in milliseconds,
 * without a round trip to a language model. This is also what keeps Kumari
 * useful when there is no internet or no API key.
 *
 * Anything not recognised confidently returns null and goes to the model, which
 * has the same actions available as tools. The rule is: only intercept what
 * cannot be misread.
 */

import * as sys from './tools/system.mjs'
import { handleMemoryCommand } from './memory.mjs'

const HINDI_APPS = {
  क्रोम: 'chrome', 'गूगल क्रोम': 'chrome', यूट्यूब: 'youtube', यूट्यूब: 'youtube',
  नोटपैड: 'notepad', कैलकुलेटर: 'calculator', गूगल: 'google', जीमेल: 'gmail',
  व्हाट्सएप: 'whatsapp', व्हाट्सऐप: 'whatsapp', वॉट्सऐप: 'whatsapp', स्पॉटिफाई: 'spotify',
  इंस्टाग्राम: 'instagram', वर्ड: 'word', एक्सेल: 'excel', 'वीएस कोड': 'vs code',
  टर्मिनल: 'terminal', सेटिंग्स: 'settings', डिस्कॉर्ड: 'discord', गिटहब: 'github',
  लिंक्डइन: 'linkedin', नेटफ्लिक्स: 'netflix', 'फाइल एक्सप्लोरर': 'file explorer',
  कैमरा: 'camera', पेंट: 'paint', एज: 'edge', फेसबुक: 'facebook',
}

const hasDevanagari = (s) => /[\u0900-\u097F]/.test(s)
const norm = (s) => String(s ?? '').trim().replace(/[.!?।,]+$/g, '').replace(/\s+/g, ' ')

function appName(raw) {
  const n = sys.cleanName(raw)
  return HINDI_APPS[n] ?? HINDI_APPS[raw.trim()] ?? n
}

const OPEN_PATTERNS = [
  /^(?:please\s+)?(?:open|launch|start|run)\s+(.+)$/i,
  /^(.+?)\s+(?:kholo|khol\s*do|khol\s*de|chalu\s*karo|start\s*karo|open\s*karo|chala\s*do)$/i,
  /^(.+?)\s+(?:खोलो|खोल\s*दो|खोल\s*दीजिए|चालू\s*करो|ओपन\s*करो|चला\s*दो)$/,
  /^(?:ओपन|खोलो)\s+(.+)$/,
]

/**
 * @param {string} text
 * @param {{ memory: any, hasBrain: boolean, config: any }} env
 * @returns {null | { tool: string, run: () => Promise<{ ok?: boolean, say: string, file?: string }> }}
 */
export function matchLocal(text, { memory, hasBrain }) {
  const t = norm(text)
  if (!t || t.length > 120) return null
  const hi = hasDevanagari(t)

  // --- memory ---------------------------------------------------------------
  const mem = handleMemoryCommand(memory, t)
  if (mem) return { tool: mem.tool ?? 'memory', run: async () => ({ ok: true, say: mem.reply }) }

  // --- open -----------------------------------------------------------------
  for (const re of OPEN_PATTERNS) {
    const m = re.exec(t)
    if (!m) continue
    const target = appName(m[1])
    const known = sys.knownTarget(target)
    // Unknown names go to the model, which can use the Start Menu search and
    // ask a sensible follow-up; with no model, try anyway.
    if (!known && hasBrain) return null
    if (!known && !hasBrain && target.split(' ').length > 3) return null
    return {
      tool: 'open_app',
      run: async () => {
        if (known?.kind === 'domain') {
          const r = await sys.openUrl(sys.safeUrl(target))
          return { ...r, say: r.ok ? `Opening ${target}.` : r.say }
        }
        const r = await sys.openApp(target)
        return hi && r.ok ? { ...r, say: `${target} खोल रही हूँ।` } : r
      },
    }
  }

  // --- searching ------------------------------------------------------------
  let m = /^(?:search|look\s*up)\s+(youtube|google)\s+for\s+(.+)$/i.exec(t)
  if (m) {
    const [, site, q] = m
    return { tool: 'browser_search', run: () => (site.toLowerCase() === 'youtube' ? sys.youtubeSearch(q) : sys.googleSearch(q)) }
  }
  m = /^play\s+(.+?)\s+on\s+youtube$/i.exec(t) ?? /^youtube\s+(?:par|pe|पर)\s+(.+?)\s+(?:chalao|play\s*karo|चलाओ)$/i.exec(t)
  if (m) return { tool: 'browser_search', run: () => sys.youtubeSearch(m[1]) }

  // --- volume ---------------------------------------------------------------
  if (/^(?:volume\s+up|(?:increase|raise|turn\s+up)\s+(?:the\s+)?volume|louder|volume\s+(?:badha\w*|zyada\s+karo))$/i.test(t) || /^(?:आवाज़?|वॉल्यूम)\s+(?:बढ़ाओ|ज़्यादा\s+करो|बढ़ा\s+दो)$/.test(t)) {
    return { tool: 'media_control', run: () => sys.changeVolume('up', 5) }
  }
  if (/^(?:volume\s+down|(?:decrease|lower|reduce|turn\s+down)\s+(?:the\s+)?volume|quieter|volume\s+(?:kam\s+karo|ghata\w*))$/i.test(t) || /^(?:आवाज़?|वॉल्यूम)\s+(?:कम\s+करो|घटाओ|कम\s+कर\s+दो)$/.test(t)) {
    return { tool: 'media_control', run: () => sys.changeVolume('down', 5) }
  }
  if (/^(?:mute|unmute|mute\s+(?:the\s+)?(?:sound|volume)|volume\s+mute(?:\s+karo)?)$/i.test(t) || /^(?:म्यूट|आवाज़?\s+बंद\s+करो)$/.test(t)) {
    return { tool: 'media_control', run: () => sys.changeVolume('mute') }
  }
  if (/^(?:pause|resume|play|play\s*pause|pause\s+(?:the\s+)?(?:music|video|song))$/i.test(t)) {
    return { tool: 'media_control', run: () => sys.mediaKey('playpause') }
  }
  if (/^(?:next|skip)(?:\s+(?:song|track))?$/i.test(t)) return { tool: 'media_control', run: () => sys.mediaKey('next') }
  if (/^(?:previous|go\s+back)(?:\s+(?:song|track))?$/i.test(t)) return { tool: 'media_control', run: () => sys.mediaKey('previous') }

  // --- time & date ------------------------------------------------------------
  if (/^(?:what(?:'s|\s+is)?\s+(?:the\s+)?time(?:\s+(?:is\s+it|now))?|what\s+time\s+is\s+it|(?:abhi\s+)?time\s+kya\s+(?:hua\s+)?hai|kitne\s+baje\s+hain?)$/i.test(t) || /^(?:समय|टाइम)\s+क्या\s+(?:हुआ|है)|^कितने\s+बजे\s+हैं?$/.test(t)) {
    return {
      tool: 'clock',
      run: async () => {
        const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
        return { ok: true, say: hi ? `अभी ${now} हुए हैं।` : `It is ${now}.` }
      },
    }
  }
  if (/^(?:what(?:'s|\s+is)?\s+(?:the\s+)?(?:date|day)(?:\s+today)?|what\s+day\s+is\s+it(?:\s+today)?|aaj\s+(?:kya\s+)?(?:date|din|tarikh)\s+(?:kya\s+)?hai)$/i.test(t) || /^आज\s+(?:की\s+)?(?:तारीख|तारीख़|दिन)\s+क्या\s+है$/.test(t)) {
    return {
      tool: 'clock',
      run: async () => {
        const d = new Date().toLocaleDateString(hi ? 'hi-IN' : 'en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        return { ok: true, say: hi ? `आज ${d} है।` : `Today is ${d}.` }
      },
    }
  }

  // --- screen / system ---------------------------------------------------------
  if (/^(?:take\s+(?:a\s+)?screenshot|screenshot(?:\s+(?:lo|le\s*lo|le))?|capture\s+(?:the\s+)?screen)$/i.test(t) || /^स्क्रीनशॉट(?:\s+(?:लो|ले\s*लो))?$/.test(t)) {
    return { tool: 'screenshot', screenshot: true, run: () => sys.takeScreenshot() }
  }
  if (/^lock\s+(?:the\s+)?(?:screen|laptop|computer|pc)$/i.test(t) || /^(?:स्क्रीन|लैपटॉप)\s+लॉक\s+(?:करो|कर\s+दो)$/.test(t)) {
    return { tool: 'power', run: () => sys.lockScreen() }
  }
  if (/^cancel\s+(?:the\s+)?(?:shutdown|restart)$/i.test(t)) return { tool: 'power', run: () => sys.cancelPower() }
  if (/^(?:battery|battery\s+(?:status|level|kitni\s+hai)|how\s+much\s+battery(?:\s+is\s+left)?|what(?:'s|\s+is)\s+(?:the\s+)?battery(?:\s+(?:level|at))?)$/i.test(t) || /^बैटरी(?:\s+कितनी\s+है)?$/.test(t)) {
    return { tool: 'system_status', run: () => sys.batteryStatus() }
  }

  return null
}
