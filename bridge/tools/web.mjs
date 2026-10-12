/**
 * Live information with no API keys: web search, page reading, weather, news.
 *
 * Everything goes through net.mjs's fetchText, the SSRF-guarded client, so a
 * link that turns out to point at the router's admin page is refused rather
 * than fetched.
 *
 * Each source has a fallback, because any one of these free endpoints can be
 * down or change its markup on a given day:
 *   search : DuckDuckGo HTML  ->  Wikipedia search
 *   news   : Google News RSS  ->  (the model falls back to web_search)
 *   weather: Open-Meteo (geocoding + forecast), no key
 */

import { fetchText } from '../net.mjs'

const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Parse DuckDuckGo's no-JavaScript results page. Exported for tests. */
export function parseDuckDuckGo(html, limit = 6) {
  const results = []
  // Split into one chunk per result anchor so each snippet is searched only
  // within its own result, never borrowed from the next.
  const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/g)]
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const start = anchors[i].index
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length
    const chunk = html.slice(start, end)

    const href = /href="([^"]+)"/.exec(anchors[i][0])?.[1]
    if (!href) continue
    let url = href.replace(/&amp;/g, '&')
    const wrapped = /[?&]uddg=([^&]+)/.exec(url)
    if (wrapped) {
      try {
        url = decodeURIComponent(wrapped[1])
      } catch {
        continue
      }
    }
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//i.test(url)) continue
    // Ads are tracked through y.js and carry no editorial value.
    if (/duckduckgo\.com\/y\.js/.test(url)) continue

    const title = decode(/<a\b[^>]*result__a[^>]*>([\s\S]*?)<\/a>/.exec(chunk)?.[1] ?? '')
    const snippet = decode(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(chunk)?.[1] ?? '',
    )
    if (title) results.push({ title, url, snippet })
  }
  return results
}

async function ddgSearch(query, limit) {
  const page = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    maxBytes: 2_000_000,
    timeoutMs: 9000,
  })
  return parseDuckDuckGo(page.text, limit)
}

async function wikipediaSearch(query, limit) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=' +
    `${limit}&srsearch=${encodeURIComponent(query)}`
  const page = await fetchText(url, { maxBytes: 1_000_000, timeoutMs: 8000, accept: 'application/json' })
  const j = JSON.parse(page.text)
  return (j.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: decode(r.snippet),
  }))
}

export async function webSearch(query, limit = 6) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: 'No search query was given.' }
  let results = []
  let source = 'duckduckgo'
  try {
    results = await ddgSearch(q, limit)
  } catch {
    results = []
  }
  if (!results.length) {
    try {
      results = await wikipediaSearch(q, limit)
      source = 'wikipedia'
    } catch {
      results = []
    }
  }
  if (!results.length) {
    return { ok: false, error: 'Search is not reachable right now. Check the internet connection.' }
  }
  return { ok: true, source, results }
}

// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

/** Pull readable text and a few images out of an HTML document. Exported for tests. */
export function extractPage(html, baseUrl, maxChars = 6000) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? [])[1] ?? '')

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')

  // Prefer the article body when the page marks one.
  const article = /<article\b[\s\S]*?<\/article>/i.exec(body) ?? /<main\b[\s\S]*?<\/main>/i.exec(body)
  if (article) body = article[0]

  const images = []
  const imgRe = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi
  let im
  while ((im = imgRe.exec(body)) && images.length < 6) {
    try {
      const abs = new URL(im[1], baseUrl).href
      if (/^https?:/.test(abs) && !/(sprite|logo|icon|pixel|tracking|\.svg(\?|$))/i.test(abs)) {
        images.push(abs)
      }
    } catch {
      /* skip unparsable */
    }
  }
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og) {
    try {
      const abs = new URL(og[1], baseUrl).href
      if (/^https?:/.test(abs) && !images.includes(abs)) images.unshift(abs)
    } catch {
      /* ignore */
    }
  }

  const text = body
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const lines = decodeKeepNewlines(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 30) // drop menus and one-word fragments

  let out = ''
  for (const line of lines) {
    if (out.length + line.length > maxChars) break
    out += `${line}\n`
  }
  return { title, text: out.trim(), images }
}

function decodeKeepNewlines(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
}

export async function readPage(url) {
  let page
  try {
    page = await fetchText(String(url ?? ''), { maxBytes: 4_000_000, timeoutMs: 10_000 })
  } catch (err) {
    return { ok: false, error: `Could not open that page: ${err?.message ?? 'unknown error'}` }
  }
  if (!/^text\/html|^application\/xhtml/.test(page.type)) {
    return { ok: false, error: `That address is not a web page (${page.type || 'unknown type'}).` }
  }
  const { title, text, images } = extractPage(page.text, page.url)
  if (!text) return { ok: false, error: 'The page had no readable text.' }
  return { ok: true, title, url: page.url, text, images }
}

// ---------------------------------------------------------------------------
// News (Google News RSS)
// ---------------------------------------------------------------------------

export function parseRss(xml, limit = 6) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1]
    const pick = (tag) => {
      const t = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      return t ? decode(t[1]) : ''
    }
    const title = pick('title')
    if (!title) continue
    items.push({
      title,
      source: pick('source'),
      link: pick('link'),
      published: pick('pubDate'),
    })
  }
  return items
}

export async function getNews(topic, limit = 6) {
  const t = String(topic ?? '').trim()
  const base = t
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(t)}&hl=en-IN&gl=IN&ceid=IN:en`
    : 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en'
  try {
    const page = await fetchText(base, {
      maxBytes: 2_000_000,
      timeoutMs: 9000,
      accept: 'application/rss+xml,application/xml,text/xml,*/*;q=0.8',
    })
    const items = parseRss(page.text, limit)
    if (items.length) return { ok: true, items }
  } catch {
    /* fall through */
  }
  return { ok: false, error: 'The news feed is not reachable right now.' }
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, no key)
// ---------------------------------------------------------------------------

const WMO = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain',
  65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow',
  73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a severe thunderstorm with hail',
}
export const describeWeather = (code) => WMO[code] ?? 'unsettled weather'

export async function getWeather(place) {
  const name = String(place ?? '').trim()
  if (!name) return { ok: false, error: 'No place was given.' }
  try {
    const geo = JSON.parse(
      (
        await fetchText(
          `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`,
          { maxBytes: 500_000, timeoutMs: 8000, accept: 'application/json' },
        )
      ).text,
    )
    const hit = geo.results?.[0]
    if (!hit) return { ok: false, error: `I could not find a place called ${name}.` }

    const f = JSON.parse(
      (
        await fetchText(
          'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${hit.latitude}&longitude=${hit.longitude}` +
            '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
            '&timezone=auto&forecast_days=3',
          { maxBytes: 1_000_000, timeoutMs: 8000, accept: 'application/json' },
        )
      ).text,
    )
    const c = f.current ?? {}
    const d = f.daily ?? {}
    return {
      ok: true,
      place: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
      now: {
        temperatureC: c.temperature_2m,
        feelsLikeC: c.apparent_temperature,
        humidityPercent: c.relative_humidity_2m,
        windKmh: c.wind_speed_10m,
        conditions: describeWeather(c.weather_code),
      },
      days: (d.time ?? []).map((date, i) => ({
        date,
        highC: d.temperature_2m_max?.[i],
        lowC: d.temperature_2m_min?.[i],
        rainChancePercent: d.precipitation_probability_max?.[i],
        conditions: describeWeather(d.weather_code?.[i]),
      })),
    }
  } catch {
    return { ok: false, error: 'The weather service is not reachable right now.' }
  }
}

// ---------------------------------------------------------------------------
// Wikipedia summary
// ---------------------------------------------------------------------------

export async function wikiSummary(topic) {
  const t = String(topic ?? '').trim()
  if (!t) return { ok: false, error: 'No topic was given.' }
  try {
    const s = JSON.parse(
      (
        await fetchText(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`,
          { maxBytes: 500_000, timeoutMs: 8000, accept: 'application/json' },
        )
      ).text,
    )
    if (!s.extract) return { ok: false, error: `Wikipedia has nothing on ${t}.` }
    return {
      ok: true,
      title: s.title,
      summary: s.extract,
      image: s.originalimage?.source ?? s.thumbnail?.source ?? null,
      url: s.content_urls?.desktop?.page ?? null,
    }
  } catch {
    // A near-miss title 404s; a search finds the right article.
    const found = await wikipediaSearch(t, 1).catch(() => [])
    if (found[0] && found[0].title.toLowerCase() !== t.toLowerCase()) return wikiSummary(found[0].title)
    return { ok: false, error: `Wikipedia has nothing on ${t}.` }
  }
}
