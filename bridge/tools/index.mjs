/**
 * The full tool set a session offers the model.
 *
 * Kept deliberately small (about a dozen of Kumari's own plus the interface
 * tools): small and mid-size models pick the wrong tool when shown forty.
 */

import { z } from 'zod'
import { tool, textResult, errorResult } from '../tooling.mjs'
import { displayServer } from '../panels.mjs'
import { uiServer } from '../ui.mjs'
import { visionServer } from '../vision.mjs'
import * as sys from './system.mjs'
import * as web from './web.mjs'
import { describeWhen, parseDuration } from './life.mjs'
import { handleMemoryCommand } from '../memory.mjs'

const reply = (r) => (r.ok === false ? errorResult(r.say ?? r.error ?? 'Failed.') : textResult(r.say ?? 'Done.'))
const str = (d) => z.string().optional().catch(undefined).describe(d)

export function buildTools(ctx) {
  const { config, memory, scheduler, notes, send, ask } = ctx
  const emitBlade = (blade) => send({ type: 'blade', blade })
  let bladeSeq = 0

  const own = [
    tool(
      'open_app',
      'Open an application on this laptop by its spoken name, e.g. "chrome", "notepad", "vs code", "calculator", "spotify", "word", "whatsapp".',
      { name: z.string().describe('The app name as the user said it.') },
      async (a) => reply(await sys.openApp(a.name)),
    ),

    tool(
      'open_website',
      'Open a website in the default browser. Give a known name ("youtube", "gmail", "github") or a domain ("example.com").',
      { site: z.string().describe('Site name or domain.') },
      async (a) => {
        const n = sys.cleanName(a.site)
        const url = sys.WEBSITES[n] ?? sys.safeUrl(n)
        if (!url) return errorResult('That does not look like a website address.')
        const r = await sys.openUrl(url)
        return reply({ ...r, say: r.ok ? `Opening ${n}.` : r.say })
      },
    ),

    tool(
      'browser_search',
      'Open a Google or YouTube search results page in the browser, for when the user wants to browse results themselves. For answering a question, use web_search instead.',
      {
        query: z.string().describe('What to search for.'),
        site: z.enum(['google', 'youtube']).optional().catch(undefined).describe('Default google.'),
      },
      async (a) => reply(a.site === 'youtube' ? await sys.youtubeSearch(a.query) : await sys.googleSearch(a.query)),
    ),

    tool(
      'media_control',
      'Control sound and media playback: volume up, volume down, mute, or play/pause, next, previous track.',
      {
        action: z.enum(['volume_up', 'volume_down', 'mute', 'play_pause', 'next', 'previous']).describe('What to do.'),
        steps: z.union([z.number(), z.string()]).optional().catch(undefined).describe('For volume: how many steps (each about 2 percent). Default 5.'),
      },
      async (a) => {
        if (a.action === 'volume_up') return reply(await sys.changeVolume('up', a.steps))
        if (a.action === 'volume_down') return reply(await sys.changeVolume('down', a.steps))
        if (a.action === 'mute') return reply(await sys.changeVolume('mute'))
        return reply(await sys.mediaKey(a.action === 'play_pause' ? 'playpause' : a.action))
      },
    ),

    tool(
      'screenshot',
      'Take a screenshot of the whole screen and show it on the display.',
      {},
      async () => {
        const r = await sys.takeScreenshot()
        if (!r.ok) return reply(r)
        emitBlade({
          id: `s${Date.now().toString(36)}-${bladeSeq++}`,
          title: 'SCREENSHOT',
          kind: 'image',
          url: r.file,
          size: 'wide',
          hold: 'turn',
        })
        return textResult('Screenshot taken and shown on the display.')
      },
    ),

    tool(
      'system_status',
      'Report the battery level and basic facts about this laptop (processor, memory use, uptime).',
      { what: z.enum(['battery', 'overview']).optional().catch(undefined).describe('Default overview.') },
      async (a) => reply(a.what === 'battery' ? await sys.batteryStatus() : sys.systemInfo()),
    ),

    tool(
      'open_folder',
      'Open a common folder in the file manager: downloads, documents, desktop, pictures, music or videos.',
      { folder: z.string().describe('Folder name.') },
      async (a) => reply(await sys.openFolder(a.folder)),
    ),

    tool(
      'power',
      'Lock the screen, put the laptop to sleep, shut down, restart, or cancel a pending shutdown. Shutdown, restart and sleep REQUIRE the user to have confirmed out loud first; set confirmed to true only after they said yes.',
      {
        action: z.enum(['lock', 'sleep', 'shutdown', 'restart', 'cancel']).describe('What to do.'),
        confirmed: z.union([z.boolean(), z.string()]).optional().catch(undefined).describe('True only after the user explicitly confirmed.'),
      },
      async (a) => {
        if (a.action === 'lock') return reply(await sys.lockScreen())
        if (a.action === 'cancel') return reply(await sys.cancelPower())
        if (!config.allowPower) return errorResult('Power actions are switched off in the settings.')
        const yes = a.confirmed === true || String(a.confirmed).toLowerCase() === 'true'
        if (!yes) return errorResult('Not done. Ask the user to confirm out loud first, then call again with confirmed true.')
        return reply(await sys.powerAction(a.action))
      },
    ),

    tool(
      'set_reminder',
      'Set a timer or a reminder that will be spoken aloud when it is due. Use "in" for a delay ("10 minutes", "1 hour 30 minutes") or "at" for a clock time as a local ISO date-time such as 2026-10-11T18:30:00.',
      {
        text: z.string().describe('What to say when it fires, e.g. "your tea is ready" or "call mom".'),
        in: str('A delay such as "5 minutes" or "2 hours".'),
        at: str('Local ISO date-time, e.g. 2026-10-11T18:30:00.'),
      },
      async (a) => {
        let when = 0
        if (a.in) when = Date.now() + parseDuration(a.in) * 1000
        else if (a.at) {
          const t = new Date(a.at).getTime()
          if (Number.isFinite(t)) when = t
        }
        if (!when || when <= Date.now() + 500) {
          return errorResult('I could not work out when that should be. Ask the user for the time again.')
        }
        const item = scheduler.add({ at: when, text: a.text, kind: a.in ? 'timer' : 'reminder' })
        return textResult(`Set for ${describeWhen(item.at)} from now: ${item.text}`)
      },
    ),

    tool(
      'reminders',
      'List or cancel the pending timers and reminders.',
      {
        action: z.enum(['list', 'cancel']).describe('list or cancel.'),
        which: str('For cancel: a word from the reminder, or "all".'),
      },
      async (a) => {
        if (a.action === 'cancel') {
          const n = scheduler.cancel(a.which ?? 'all')
          return textResult(n ? `Cancelled ${n}.` : 'Nothing matched.')
        }
        const items = scheduler.list()
        if (!items.length) return textResult('There are no pending reminders.')
        return textResult(items.map((i) => `${i.text}, in ${describeWhen(i.at)}`).join('; '))
      },
    ),

    tool(
      'notes',
      'Write a note into the notes file in the Documents folder, or read back the latest notes.',
      {
        action: z.enum(['add', 'read']).describe('add or read.'),
        text: str('For add: the note.'),
      },
      async (a) => {
        if (a.action === 'add') return reply(notes.add(a.text))
        const r = notes.read(5)
        return textResult(r.lines.length ? r.lines.join('\n') : 'There are no notes yet.')
      },
    ),

    tool(
      'memory',
      'Long-term memory. "remember" saves a durable fact about the user; "forget" removes facts containing a word; "list" reads them back.',
      {
        action: z.enum(['remember', 'forget', 'list']).describe('What to do.'),
        text: str('The fact to remember, or the word to forget.'),
      },
      async (a) => {
        if (a.action === 'list') {
          const f = memory.facts()
          return textResult(f.length ? f.map((x) => x.text).join('; ') : 'Nothing is saved yet.')
        }
        if (!a.text) return errorResult('Nothing was given.')
        if (a.action === 'forget') {
          const n = memory.removeFacts(a.text)
          return textResult(n ? `Forgot ${n} item${n > 1 ? 's' : ''}.` : 'Nothing matched.')
        }
        const r = memory.addFact(a.text)
        return textResult(r.added ? 'Saved.' : 'Already saved.')
      },
    ),

    tool(
      'web_search',
      'Search the web and get titles, snippets and links. Use for current facts, prices, sports, anything you are not sure of.',
      { query: z.string().describe('A short search query.') },
      async (a) => {
        const r = await web.webSearch(a.query)
        if (!r.ok) return errorResult(r.error)
        return textResult(
          r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.snippet}\n${x.url}`).join('\n\n'),
        )
      },
    ),

    tool(
      'read_page',
      'Fetch a web page and return its readable text and image links. Use after web_search to read a result in detail.',
      { url: z.string().describe('An absolute http(s) URL taken from a search result.') },
      async (a) => {
        const r = await web.readPage(a.url)
        if (!r.ok) return errorResult(r.error)
        return textResult(
          `${r.title}\n\n${r.text}${r.images.length ? `\n\nImages:\n${r.images.join('\n')}` : ''}`,
        )
      },
    ),

    tool(
      'get_weather',
      'Current weather and a three day forecast for a place.',
      { place: str(`City name. Defaults to ${config.city || 'the user\'s city'}.`) },
      async (a) => {
        const place = a.place || config.city
        if (!place) return errorResult('No city was given. Ask the user which city.')
        const r = await web.getWeather(place)
        if (!r.ok) return errorResult(r.error)
        return textResult(JSON.stringify(r))
      },
    ),

    tool(
      'get_news',
      'Latest news headlines, optionally on a topic. Defaults to top India headlines.',
      { topic: str('Optional topic, e.g. "cricket" or "AI".') },
      async (a) => {
        const r = await web.getNews(a.topic)
        if (!r.ok) return errorResult(r.error)
        return textResult(r.items.map((i) => `${i.title}${i.source ? ` (${i.source})` : ''}`).join('\n'))
      },
    ),

    tool(
      'wiki_summary',
      'A short Wikipedia summary of a person, place or concept.',
      { topic: z.string().describe('The topic.') },
      async (a) => {
        const r = await web.wikiSummary(a.topic)
        if (!r.ok) return errorResult(r.error)
        return textResult(`${r.title}: ${r.summary}${r.image ? `\nImage: ${r.image}` : ''}`)
      },
    ),
  ]

  const bundles = [
    displayServer(
      (panel) => send({ type: 'panel', panel }),
      (blade) => send({ type: 'blade', blade }),
    ),
    uiServer((op, args) => send({ type: 'ui', op, args })),
    visionServer(ask),
  ]

  return [...own, ...bundles.flatMap((b) => b.tools)]
}

/** Tools that draw on the screen rather than do work, so no "working on it". */
export const SILENT_TOOLS = new Set([
  'display', 'blade', 'probe_url',
  'ui_theme', 'ui_reactor', 'ui_orbit', 'ui_chrome', 'ui_effect', 'ui_screen', 'ui_reset',
])

export { handleMemoryCommand }
