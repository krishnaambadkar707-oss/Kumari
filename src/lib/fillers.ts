/**
 * Filler speech.
 *
 * A slow tool (a web search, the weather) can take several seconds, and silence
 * that long reads as a crash. So Kumari says one short line the instant slow
 * work starts, then goes quiet until she has an answer. Quick actions (opening
 * an app, volume, a note) say nothing at all: the answer arrives faster than a
 * filler could be spoken.
 *
 * Lines come in two languages, picked by whichever the user last spoke.
 */

export type Lang = 'hi' | 'en'

let lang: Lang = 'hi'

/** Called with the user's words each turn, and once at boot from the mic language. */
export function setFillerLang(next: Lang) {
  lang = next
}

/** Devanagari in the text means Hindi; anything else means English. */
export function langOf(text: string): Lang {
  return /[\u0900-\u097F]/.test(text) ? 'hi' : 'en'
}

export function currentLang(): Lang {
  return lang
}

const WORKING: Record<Lang, string[]> = {
  hi: ['एक सेकंड।', 'देख रही हूँ।', 'अभी देखती हूँ।', 'ढूँढ रही हूँ।'],
  en: ['One moment.', 'Looking into it.', 'On it.', 'Checking.'],
}

const ACKNOWLEDGE: Record<Lang, string[]> = {
  hi: ['ठीक है।', 'जी, ज़रूर।', 'हो गया।'],
  en: ['Understood.', 'Of course.', 'Done.'],
}

const ATTENTION: Record<Lang, string[]> = {
  hi: ['जी?', 'हाँ, बोलिए?', 'मैं सुन रही हूँ।'],
  en: ['Yes?', "I'm listening.", 'Go ahead.'],
}

const SEARCHING: Record<Lang, string[]> = {
  hi: ['ढूँढ रही हूँ।', 'अभी खोजती हूँ।'],
  en: ['Searching.', 'Let me look that up.'],
}

const WEATHER: Record<Lang, string[]> = {
  hi: ['मौसम देख रही हूँ।'],
  en: ['Checking the weather.'],
}

const LOOKING: Record<Lang, string[]> = {
  hi: ['देख रही हूँ।'],
  en: ['Looking.'],
}

/** Avoids repeating the same phrase twice running, which is what makes canned lines sound canned. */
function makePicker(pool: Record<Lang, string[]>) {
  const last: Record<Lang, number> = { hi: -1, en: -1 }
  return () => {
    const list = pool[lang]
    if (list.length < 2) return list[0] ?? ''
    let i = last[lang]
    while (i === last[lang]) i = Math.floor(Math.random() * list.length)
    last[lang] = i
    return list[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)
const searching = makePicker(SEARCHING)
const weather = makePicker(WEATHER)
const looking = makePicker(LOOKING)

/** Tools slow enough to deserve a spoken line; everything else is instant. */
export function forTool(toolName: string): string {
  const name = toolName.toLowerCase()
  if (/weather/.test(name)) return weather()
  if (/web_search|read_page|get_news|wiki/.test(name)) return searching()
  if (/^look$|^watch$/.test(name)) return looking()
  if (/^(open_|browser_|media_|screenshot|system_|power|set_reminder|reminders|notes|memory|remember|forget|clock)/.test(name)) {
    return ''
  }
  return working()
}
