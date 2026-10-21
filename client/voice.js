/*
 * Federated Wiki : Audio Note Plugin — voice.js
 *
 * Speaking to a page: storing a recording beside it, transcribing it on the
 * farm, finding a prompt, summarising, and adding the result to the page.
 * The recorder (audionote.js) imports this; everything here talks to the farm
 * through documented operations rather than routes of its own:
 *
 *   /system/api/farm/assets/upload.json    the Farm plugin's shared asset upload
 *   /system/api/audionote/transcribe.json  whisper over a kept recording, as a job
 *   /system/api/audionote/hear.json        whisper over a recording sent as the body — here, or
 *                                          through the local door (see localDoor below)
 *   /system/api/audionote/job.json         the job's progress
 *   /system/api/audionote/summarise.json   Claude, through a prompt
 *
 * Licensed under the MIT license.
 */

export const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')

// ---------- which page, on which site ----------

/** Tool pages to look past when finding the page being spoken to. */
export const TOOL_SLUGS = new Set(['selected-plugin-pages', 'voice-tool', 'search-tool', 'like-this-page', 'plan-tool', 'model-settings', 'revise-plan'])

const slugOf = $page => ($page.attr('id') || '').split('_rev')[0]

/**
 * The page a Voice Tool is speaking to: the nearest page to its left that is not
 * itself a tool page. Opened from the ☰ menu the lineup reads
 * page | Selected Plugin Pages | Voice Tool, so the immediate neighbour is the
 * menu, not the subject. Adapted from the similarity plugin's subject.js.
 */
export function leftSubject($self) {
  let $host = $self.prev('.page')
  while ($host.length && ($host.hasClass('ghost') || TOOL_SLUGS.has(slugOf($host)))) $host = $host.prev('.page')
  return $host.length ? $host : null
}

/** The site a page came from. data('site') is set only on pages fetched from elsewhere. */
export const siteOf = $page => $page.data('site') || location.host

/** Whether a page can be written to from here: same origin, where the owner's cookie is. */
export const isHere = $page => {
  const site = $page.data('site')
  return !site || site === location.host || site === location.hostname || site === 'local' || site === 'origin'
}

/**
 * Whether this viewer may change this site, as the security plugin reports it:
 * true, false, or undefined when nothing is reported. Not the owner means
 * wiki-client keeps edits in this browser only, and the farm refuses the
 * recording — so the tool says so before anyone speaks.
 */
export const ownerHere = () => (typeof window.isOwner === 'boolean' ? window.isOwner : undefined)

/** Why saving into this page would fail, before anyone speaks — or null. */
export function cannotSave($page) {
  if (!$page) return 'there is no page to the left to speak to'
  if (!isHere($page)) return `this page belongs to ${siteOf($page)} — fork it here first, then speak to your copy`
  if (ownerHere() === false) return `log in to ${location.host} as its owner to save here`
  return null
}

/** The page's words, for prompts that answer it. */
export function pageText($page) {
  const data = $page.data('data') || {}
  return (data.story || [])
    .map(i => (typeof i.text === 'string' ? i.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

// ---------- the farm's operations ----------

async function failure(res) {
  let text = ''
  try {
    const body = await res.clone().json()
    text = body.error || JSON.stringify(body)
  } catch {
    text = (await res.text()).slice(0, 200)
  }
  return new Error(`${res.status} ${text}`.trim())
}

/**
 * Put a file into assets/<slug>/ through the Farm plugin's shared upload. An
 * older farm without it answers 404 from the page route, and then the stock
 * Assets plugin's form upload is used instead.
 */
export async function putAsset(slug, name, blob, type) {
  const q = new URLSearchParams({ folder: slug, name })
  const res = await fetch(`/system/api/farm/assets/upload.json?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': type || blob.type || 'application/octet-stream' },
    body: blob,
  })
  if (res.ok) return res.json()
  if (res.status !== 404) throw await failure(res)

  const form = new FormData()
  form.append('assets', slug) // field order matters: multer only sees body fields that precede the files
  form.append('file', new File([blob], name, { type: type || blob.type }))
  const old = await fetch('/plugin/assets/upload', { method: 'POST', body: form })
  if (!old.ok) throw await failure(old)
  return { src: `assets/${slug}/${name}`, url: `/assets/${slug}/${name}`, size: blob.size, via: 'assets plugin' }
}

const postJson = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw await failure(res)
  return res.json()
}

/**
 * Transcribe a stored recording and wait for it. `onProgress` hears each state
 * change, so the UI can say "queued behind 1" or "transcribing" while the Pi works.
 */
export async function transcribe(slug, filename, onProgress = () => {}) {
  const override = localStorage.getItem('fedwiki-media:transcribeUrl')
  if (override) {
    // A private whisper service, as the Media Plan's Phase 4 imagined: {url} in, transcript out.
    const t = await postJson(override, { url: `${location.origin}/assets/${slug}/${filename}` })
    if (t.error) throw new Error(t.error)
    return t
  }
  const started = await postJson('/system/api/audionote/transcribe.json', { slug, filename })
  return followJob(started, onProgress)
}

/**
 * Transcribe a recording that is NOT kept: the blob is sent as the body, read
 * from the farm's temporary folder and deleted. Nothing lands in the assets.
 */
export async function hearBlob(blob, type, onProgress = () => {}, door = null) {
  const base = door?.base || ''
  const res = await fetch(`${base}/system/api/audionote/hear.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Recording-Type': type || blob.type || '' },
    body: blob,
  })
  if (!res.ok) throw await failure(res)
  return followJob(await res.json(), onProgress, base)
}

async function followJob(started, onProgress, base = '') {
  onProgress({ state: started.state, ahead: started.ahead, engine: started.engine, host: started.host })
  for (;;) {
    await new Promise(r => setTimeout(r, 1500))
    const res = await fetch(`${base}/system/api/audionote/job.json?id=${encodeURIComponent(started.job)}`)
    if (!res.ok) throw await failure(res)
    const job = await res.json()
    onProgress(job)
    if (job.state === 'done') return { provider: 'faster-whisper', door: base ? 'local' : 'farm', ...job }
    if (job.state === 'failed') throw new Error(`transcription failed: ${job.error}`)
  }
}

// ---------- the local door ----------
//
// A recording is heard by the farm serving the page — unless the browser is on
// a machine that runs a farm of its own, which is nearer, idle, and (on a Mac
// with MacWhisper open) better. The Voice Tool asks that machine first: a farm
// at one of a few local addresses whose hear operation is gated on the place
// alone (x-fedwiki-gate: place), so it answers a page from elsewhere without a
// login there. Nothing but the recording goes through the door; the transcript
// comes back, and the page, the prompt and the summary stay with the farm the
// page lives on.
//
//   DOOR: http://host:port   — the item names the door
//   DOOR: farm               — never look for one
//
// Browsers treat http://localhost as a secure origin, so an https page may
// call it; the answer is remembered for the page's lifetime, so a door that is
// not there costs one short probe.

const DOORS = ['http://localhost:4242']
const isLocalHere = () => /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname)
const doorProbes = new Map()

const probeDoor = async base => {
  const res = await fetch(`${base}/system/api.json`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(2500) })
  if (!res.ok) return null
  const api = await res.json()
  const hear = api?.paths?.['/system/api/audionote/hear.json']?.post
  if (!hear || hear['x-fedwiki-gate'] !== 'place' || hear['x-fedwiki-cross-origin'] !== true) return null
  return { base, host: api?.info?.['x-fedwiki-host'] || new URL(base).host }
}

/** The local door to use for this item, or null: the page's own farm. */
export function localDoor(text = '') {
  const named = ((text || '').match(/^\s*DOOR:\s*(\S+)/m) || [])[1]
  if (named === 'farm' || named === 'none' || named === 'off') return Promise.resolve(null)
  const candidates = named ? [named.replace(/\/$/, '')] : isLocalHere() ? [] : DOORS
  const key = candidates.join(' ')
  if (!candidates.length) return Promise.resolve(null)
  if (!doorProbes.has(key)) {
    doorProbes.set(
      key,
      (async () => {
        for (const base of candidates) {
          try {
            const door = await probeDoor(base)
            if (door) return door
          } catch {}
        }
        return null
      })(),
    )
  }
  return doorProbes.get(key)
}

export const summarise = body => postJson('/system/api/audionote/summarise.json', body)

/** Ask a model about the question being answered (0.9.0): {question, kind, ask, pageTitle, pageText, context, related, transcript, model}. */
export const askAbout = body => postJson('/system/api/audionote/ask.json', body)

// ---------- pages like the question (0.9.0) ----------
//
// The farm's own search (the Similarity plugin) finds pages that may already
// answer the question, or explain its terms: by meaning first
// (/system/search-report.json, every site this farm serves that the viewer may
// see), and by keyword (/system/farm-search.json) when the embedder is down.
// They are shown as links to open beside the tool, and the first few are read
// and sent with a question to the model, so its answer leans on what the farm
// already knows.

const WORDS_NOT_SEARCHED = new Set(
  'a about all also an and any are as at be by can could do does for from get has have how if in into is it its more much need no not of on one or our own should so than that the their them then there these they this to use was we what when where which who why will with would you your'.split(' '),
)

/** The question as search words: the stop words dropped, so a keyword search matches what matters. */
export const searchWords = text =>
  String(text || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !WORDS_NOT_SEARCHED.has(w.toLowerCase()))
    .join(' ')

async function searchByMeaning(query, limit) {
  const res = await fetch('/system/search-report.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  })
  if (!res.ok) throw await failure(res)
  const page = await res.json()
  return (page.story || [])
    .filter(i => i.type === 'reference' && i.slug)
    .map(i => ({ site: i.site || location.host, slug: i.slug, title: i.title || i.slug, synopsis: String(i.text || '').replace(/^#+\s.*\n+/, '').slice(0, 300) }))
}

async function searchByKeyword(query, limit) {
  const q = searchWords(query) || String(query || '').trim()
  const res = await fetch(`/system/farm-search.json?${new URLSearchParams({ q, format: 'flat', limit: String(limit) })}`)
  if (!res.ok) throw await failure(res)
  return ((await res.json()).results || []).map(r => ({ site: r.domain || r.site || '', slug: r.slug, title: r.title || r.slug, synopsis: r.synopsis || '' }))
}

/**
 * Pages on this farm like `query`, best first: [{site, slug, title, synopsis}],
 * with `.how` = 'meaning' or 'keyword'. `exclude` holds "site/slug" keys not to
 * list (the page spoken to). A farm without the search says so.
 */
export async function similarPages(query, { exclude = [], limit = 8 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const want = limit + exclude.length + 4
  let found
  let how = 'meaning'
  try {
    found = await searchByMeaning(q, want)
  } catch {
    how = 'keyword'
    try {
      found = await searchByKeyword(q, want)
    } catch (e) {
      throw new Error(/^404/.test(e.message) ? 'this farm has no search (the Similarity plugin is not installed)' : `the farm's search failed: ${e.message}`)
    }
  }
  const skip = new Set(exclude)
  const seen = new Set()
  const out = []
  for (const r of found) {
    const key = `${r.site}/${r.slug}`
    if (skip.has(key) || TOOL_SLUGS.has(r.slug) || seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= limit) break
  }
  return Object.assign(out, { how })
}

/** The words of the first `n` pages found, fetched from their sites, for a question's context. */
export async function withText(pages, n = 4) {
  const read = await Promise.all(
    pages.slice(0, n).map(async p => {
      // a site that does not answer in a few seconds costs its text, not the question
      const page = await Promise.race([fetchPage(p.site === location.host ? '' : p.site, p.slug), new Promise(r => setTimeout(() => r(null), 5000))])
      const text = page ? (page.story || []).map(i => (typeof i.text === 'string' ? i.text : '')).filter(Boolean).join('\n\n') : ''
      return { ...p, text: text.slice(0, 8000) }
    }),
  )
  return [...read, ...pages.slice(n)]
}

/**
 * Where a question is asked on a page: every item that links to it, with the
 * heading above each, so a model sees the line the question came from — a plan
 * checkpoint, an open question's gloss — and not only its title.
 */
export function questionContext($page, title) {
  const story = ($page?.data('data') || {}).story || []
  const want = asSlug(title || '')
  if (!want) return ''
  const parts = []
  let heading = ''
  for (const item of story) {
    const text = String(item.text || '')
    const h = text.match(/^\s*#{1,6}\s+(.+)$/m)
    if (item.type === 'markdown' && h && text.trim().startsWith('#')) heading = h[1].trim()
    const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => asSlug(m[1].trim()))
    if (links.includes(want)) parts.push(`${heading ? `(under “${heading}”) ` : ''}${text.trim()}`)
  }
  return parts.join('\n\n')
}

// ---------- prompts ----------
//
// A prompt is a page whose first code item starts with a header, a line of
// three dashes, then the body:
//
//   KIND: summary
//   INPUT: transcript, page
//   OUTPUT: markdown
//   MODEL: claude-opus-5
//   SECTION: Description        (optional: the heading the result goes under)
//   ---
//   …{{transcript}} {{page_title}} {{page_text}} {{title}} {{date}}…
//   ({{title}} is the title the result will be saved under, a red link's question)
//
// Prompts are gathered by kind from a kind page ("Summary Prompts", "Answer
// Prompts") that links them. The current site is asked first and the prompt
// wiki second, for the kind page and for each prompt: a prompt forked here is
// the one used, so forking is how a prompt is adapted to local context.

export const DEFAULT_KINDS = ['summary', 'answer', 'minutes']

export function parsePrompt(page) {
  const code = (page.story || []).find(i => i.type === 'code' && /^\s*[A-Z]+:.*\n[\s\S]*?^---\s*$/m.test(i.text || ''))
  if (!code) return null
  const [head, ...rest] = code.text.split(/^---\s*$/m)
  const fields = {}
  for (const line of head.split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z_]*):\s*(.*?)\s*$/)
    if (m) fields[m[1].toLowerCase()] = m[2]
  }
  const body = rest.join('---').trim()
  if (!body) return null
  return {
    title: page.title,
    kind: (fields.kind || '').toLowerCase(),
    input: (fields.input || '').split(',').map(s => s.trim()).filter(Boolean),
    output: fields.output || 'markdown',
    model: fields.model || '',
    section: (fields.section || '').replace(/^#+\s*/, '').trim(),
    body,
  }
}

/**
 * The prompts a kind page lists: [[links]] that begin a bullet line, above any
 * "# See" section. Links in prose (a credit line, a pointer to the format) and
 * in See are about the page, not entries in it.
 */
const listedIn = page => {
  const story = page.story || []
  const see = story.findIndex(isSeeHeading)
  const titles = (see === -1 ? story : story.slice(0, see)).flatMap(i =>
    String(i.text || '')
      .split('\n')
      .map(line => line.match(/^\s*[-*]\s*\[\[([^\]]+)\]\]/))
      .filter(Boolean)
      .map(m => m[1].trim()),
  )
  return [...new Set(titles)]
}

const asSlug = title =>
  window.wiki?.asSlug ? window.wiki.asSlug(title) : title.replace(/\s/g, '-').replace(/[^A-Za-z0-9-]/g, '').toLowerCase()

/** A site's base address. A real domain is asked over https; a .localhost name over http. */
const baseOf = site => {
  if (!site) return ''
  if (/^https?:\/\//.test(site)) return site.replace(/\/+$/, '')
  const local = /(^|\.)localhost(:\d+)?$/.test(site) || /\.local(:\d+)?$/.test(site)
  return `${local ? 'http' : 'https'}://${site}`
}

async function fetchPage(site, slug) {
  const base = baseOf(site)
  try {
    const res = await fetch(`${base}/${slug}.json`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // a prompt wiki that is offline costs its prompts, not the tool
  }
}

/** Local first, then the prompt wiki. Returns the page and where it came from. */
async function localFirst(slug, promptSite) {
  const here = await fetchPage('', slug)
  if (here) return { page: here, from: location.host, local: true }
  if (!promptSite) return null
  const there = await fetchPage(promptSite, slug)
  return there ? { page: there, from: promptSite, local: false } : null
}

/**
 * Every usable prompt of the given kinds, plus any prompt named directly.
 * Each carries `from` (the site it was read from) and `local`.
 */
export async function findPrompts({ promptSite, kinds = DEFAULT_KINDS, named = [] }) {
  const titles = new Set(named)
  for (const kind of kinds) {
    const index = await localFirst(asSlug(`${kind} prompts`), promptSite)
    if (index) listedIn(index.page).forEach(t => titles.add(t))
  }
  const found = await Promise.all(
    [...titles].map(async title => {
      const got = await localFirst(asSlug(title), promptSite)
      const prompt = got && parsePrompt(got.page)
      // a listed page that is not a prompt of an offered kind is not offered, unless it was named
      const offered = prompt && (named.includes(title) || !prompt.kind || kinds.includes(prompt.kind))
      return offered ? { ...prompt, title: got.page.title || title, slug: asSlug(title), from: got.from, local: got.local } : null
    }),
  )
  return found.filter(Boolean)
}

// ---------- writing to the page ----------

// The wiki server applies each action with an unserialised read-modify-write of
// the page file, so two puts at once race and the second clobbers the first.
// Sequence them: pageHandler.put goes through jQuery ajax, so ajaxComplete
// signals the landing.
export function putAndWait($page, action) {
  return new Promise(resolve => {
    const fallback = setTimeout(() => {
      $(document).off('ajaxComplete', handler)
      resolve()
    }, 3000)
    const handler = (e, xhr, settings) => {
      if ((settings.url || '').includes('/action')) {
        clearTimeout(fallback)
        $(document).off('ajaxComplete', handler)
        resolve()
      }
    }
    $(document).on('ajaxComplete', handler)
    wiki.pageHandler.put($page, action)
  })
}

const isSeeHeading = item => /^\s*#{1,6}\s*see\b/i.test(item.text || '') || (item.type === 'paragraph' && /^\s*see\s*$/i.test(item.text || ''))

/** The item new material goes after: the last one before a "# See" section, else the last. */
export function insertionPoint($page) {
  const story = ($page.data('data') || {}).story || []
  const see = story.findIndex(isSeeHeading)
  const before = see === -1 ? story[story.length - 1] : story[see - 1]
  return before ? before.id : null
}

// ---------- a prompt's SECTION: where on the page its result belongs ----------

/** The label of a heading item ("# Description\n\n> …" → "Description"), or null. */
export const headingOf = item => {
  const m = String(item?.text || '').match(/^\s*#+\s*([^\n]*)/)
  return m ? m[1].trim() : null
}

/** The board's description template: seven bold labels, nothing written after any of them. */
export const BOARD_TEMPLATE = [
  '**What has to be done / description:**',
  '**Task owners:**',
  '**Resources:**',
  '**Deliverables:**',
  '**Internal ddl:**',
  '**Ddl:**',
  '**Docs:**',
]
const squash = text => String(text || '').replace(/[\s ]+/g, '')

/** Whether an item's text is only the unfilled template (whitespace and nbsp ignored). */
export const isBoardTemplate = text => squash(text) === squash(BOARD_TEMPLATE.join('\n\n'))

/**
 * A section of a story: the heading item whose label matches (any number of
 * hashes, case ignored) and the items after it up to the next item starting
 * with "#", or the end. Returns { start, end } (end exclusive) or null.
 */
export function findSection(story, label) {
  const want = String(label || '').replace(/^#+\s*/, '').trim().toLowerCase()
  if (!want) return null
  const start = story.findIndex(i => (headingOf(i) || '').toLowerCase() === want)
  if (start === -1) return null
  let end = start + 1
  while (end < story.length && headingOf(story[end]) === null) end++
  return { start, end }
}

/**
 * Where a result goes in a section: { replace: id } when the section's body is
 * exactly one markdown item holding only the unfilled board template (an edit
 * keeps its id, which is how the mirror knows the body); otherwise
 * { after: id } of the section's last item. null when there is no such section.
 */
export function sectionPlan(story, label) {
  const sec = findSection(story, label)
  if (!sec) return null
  const body = story.slice(sec.start + 1, sec.end)
  if (body.length === 1 && body[0].type === 'markdown' && isBoardTemplate(body[0].text)) return { replace: body[0].id }
  return { after: story[sec.end - 1].id }
}

/** Replace one item's text, in the DOM and on the server, as a journal edit. */
export async function replaceText($page, id, text) {
  const story = ($page.data('data') || {}).story || []
  const old = story.find(i => i.id === id) || {}
  const item = { ...old, text }
  const $item = $page.find('.story:first').children(`.item[data-id="${id}"]`)
  if ($item.length) {
    $item.data('item', item)
    wiki.doPlugin($item.empty(), item)
  }
  await putAndWait($page, { type: 'edit', id, item })
  return id
}

/**
 * Add a prompt's result to a page. With a SECTION the page has: replace an
 * unfilled board template there, or go after the section's last item. Without
 * one, after `fallbackAfter` (default: before any "# See" section).
 * Returns { how: 'replaced'|'section'|'fallback', count }.
 */
export async function addToPage($page, markdown, { section = '', fallbackAfter } = {}) {
  const story = ($page.data('data') || {}).story || []
  const plan = section ? sectionPlan(story, section) : null
  if (plan?.replace) {
    await replaceText($page, plan.replace, String(markdown || '').trim())
    return { how: 'replaced', count: 1, last: plan.replace }
  }
  const blocks = splitMarkdown(markdown)
  let after = plan ? plan.after : fallbackAfter !== undefined ? fallbackAfter : insertionPoint($page)
  for (const text of blocks) after = await addItem($page, after, { type: 'markdown', id: randomId(), text })
  // `last` is the item placed last, so whatever belongs with the notes (the kept audio) can follow it
  return { how: plan ? 'section' : 'fallback', count: blocks.length, last: after }
}

/** Add one item after `afterId`, in the DOM and on the server. Returns its id. */
export async function addItem($page, afterId, item) {
  const $story = $page.find('.story:first')
  const $anchor = afterId ? $story.children(`.item[data-id="${afterId}"]`) : $()
  const $new = $('<div />', { class: `item ${item.type}`, 'data-id': item.id }).data('item', item).data('pageElement', $page)
  if ($anchor.length) $anchor.after($new)
  else if (afterId === null) $story.prepend($new)
  else $story.append($new)
  wiki.doPlugin($new, item)
  await putAndWait($page, { type: 'add', id: item.id, item, after: afterId })
  return item.id
}

/**
 * A summary as separately draggable items: each paragraph its own item, and each
 * top-level bullet its own item with anything nested beneath it, so an author
 * can carry one point to one page and another elsewhere.
 */
export function splitMarkdown(markdown) {
  const blocks = []
  for (const chunk of String(markdown || '').trim().split(/\n\s*\n/)) {
    const lines = chunk.split('\n')
    const isList = lines.every(l => /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s+\S/.test(l))
    if (!isList) {
      blocks.push(chunk.trim())
      continue
    }
    let current = null
    for (const line of lines) {
      if (/^([-*+]|\d+[.)])\s/.test(line)) {
        if (current) blocks.push(current)
        current = line
      } else current = current === null ? line : `${current}\n${line}`
    }
    if (current) blocks.push(current)
  }
  return blocks.filter(Boolean)
}

/**
 * What speaking produces, as story items, in the order an author reads them:
 * the answer first — the summary, each point its own item, with no heading and
 * no date line above it, since the question is the title and the journal keeps
 * the date; then the recording with its assets folder, ONLY where the author
 * chose to keep the audio (the transcript is not copied in — the assets item
 * already shows the .txt beside the recording); where nothing was kept, the
 * transcript follows under its own heading so the words are not lost; and last
 * a "# See" section linking back to the page the note answers and to the
 * prompt that shaped the summary (its site is forked in when the page is saved,
 * so that link leads somewhere — see seedFork).
 * `kept` is { folder, src, transcriptTxt } once the audio has been uploaded.
 * Model page: chat.private.fish/are-embassies-only-in-the-uk-this-year.
 */
/**
 * The player for a kept recording: an audio item at this site's absolute
 * address (assets do not travel with a fork, so the link names this site),
 * captioned with the question and the day it was recorded.
 */
export function keptAudioItem(kept, title = '') {
  const date = new Date().toISOString().slice(0, 10)
  const caption = title ? `${/[.?!]$/.test(title) ? title : `${title}.`} Recorded ${date}.` : `Recorded ${date}.`
  return { type: 'audio', id: randomId(), text: `${location.origin}/${kept.src}\n${caption}` }
}

export function spokenItems({ markdown, transcript, title, subjectTitle, promptTitle, kept }) {
  const item = (type, text, extra = {}) => ({ type, id: randomId(), text, ...extra })
  const items = splitMarkdown(markdown).map(t => item('markdown', t))
  if (kept) {
    items.push(keptAudioItem(kept, title), item('markdown', '# Assets'), item('assets', kept.folder))
  } else if (transcript) {
    items.push(item('markdown', '# Transcript'), item('markdown', transcript.trim()))
  }
  const see = [subjectTitle, promptTitle].filter(Boolean).map(t => `- [[${t}]]`)
  if (see.length) items.push(item('markdown', `# See\n\n${see.join('\n')}`))
  return items
}

/**
 * Open the result as a ghost page beside the tool. A ghost is nothing until the
 * author acts: items are dragged from it to wherever they belong, and the rest
 * evaporates. That keeps authorship with the author.
 *
 * The ghost carries a journal of exactly one `create`. wiki-client reads that as
 * "a page about to be made": its title can be edited in place, and its fork flag
 * saves it as a real page under whatever the title then says. So the ghost is
 * named to be kept — "Open Questions Notes" — not named after the tool.
 */
export function openGhost($toolPage, title, items) {
  const story = items.map(i => ({ ...i }))
  const page = wiki.newPage({ title, story, journal: [{ type: 'create', item: { title, story: items.map(i => ({ ...i })) }, date: Date.now() }] })
  wiki.showResult(page, { $page: $toolPage })
  return $toolPage.nextAll('.page').first()
}

/**
 * Join `site` to a page's neighbourhood without giving it credit: a fork event
 * at index 0, dated a millisecond before the first action. wiki-client reads any
 * fork in the journal as link-resolution context, so a [[link]] to a page on
 * that site leads there; the credit walk runs backwards, so index 0 is the one
 * seat that hands nothing over (fedwiki-lib seed_fork, ported). Idempotent.
 */
export function seedFork(page, site) {
  if (!site || !page) return page
  const journal = page.journal || (page.journal = [])
  if (journal[0]?.type === 'fork' && journal[0].site === site) return page
  const first = journal[0]
  journal.unshift({ type: 'fork', site, date: (first?.date || Date.now()) - 1 })
  return page
}

/** The title a ghost shows now — the author may have edited it on the page itself. */
export const ghostTitle = $ghost => $ghost.find('h1 .title').text().trim().replace(/\s+/g, ' ') || $ghost.find('h1').text().trim().replace(/\s+/g, ' ')

/** Whether this site already has a page of that title; saving over it would replace it. */
export async function pageExists(title) {
  try {
    return (await fetch(`/${asSlug(title)}.json`, { method: 'HEAD' })).ok
  } catch {
    return false
  }
}

/**
 * Save a ghost as a real page, by wiki-client's own path: its fork flag. That
 * path takes the title from the page, re-slugs it, writes it and drops the ghost
 * class — better borrowed than imitated.
 */
export function saveGhost($ghost, forkFrom = '') {
  return new Promise((resolve, reject) => {
    // wiki-client draws the fork flag only for someone who may write here
    if (!$ghost.find('.fork-page').length) return reject(new Error(`log in to ${location.host} as its owner to save a page here`))
    const done = () => {
      clearTimeout(fallback)
      $(document).off('ajaxComplete', handler)
      resolve()
    }
    const fallback = setTimeout(done, 4000)
    const handler = (e, xhr, settings) => (settings.url || '').includes('/action') && done()
    $(document).on('ajaxComplete', handler)
    // The ghost's journal stays a lone `create` until now, so its title was
    // editable on the page. Settle the title first, as the flag handler would,
    // then seed the prompt's site as a fork at index 0: the handler sends the
    // raw page, journal and all, so the saved page carries the fork.
    const pageObject = window.wiki?.lineup?.atKey?.($ghost.data('key'))
    if (pageObject) {
      const newtitle = ghostTitle($ghost)
      if (newtitle && newtitle !== pageObject.getTitle()) {
        $ghost.attr('id', asSlug(newtitle))
        pageObject.setCreateTitle(newtitle)
        $ghost.find('h1 .title').removeAttr('contenteditable')
      }
      if (forkFrom) seedFork(pageObject.getRawPage(), forkFrom)
    }
    $ghost.find('.fork-page').first().trigger('click')
  })
}

/**
 * Link a page from another: one item holding [[Title]], before any "# See"
 * section. A link, not a copy — the notes live on their own page, and the item
 * can be dragged beside the question it answers.
 */
export const addLink = ($page, title, note = '') =>
  addItem($page, insertionPoint($page), { type: 'markdown', id: randomId(), text: `[[${title}]]${note ? ` — ${note}` : ''}` })

/** Add the same items to a page directly, before any "# See" section. */
export async function addSpoken($page, items) {
  let after = insertionPoint($page)
  for (const item of items) after = await addItem($page, after, item)
  return items
}

// ---------- red links: pages the subject asks for that nobody has written ----------

/** Every [[Title]] a page's story mentions, in page order, once each. */
export function linksOf($page) {
  const story = ($page.data('data') || {}).story || []
  const seen = new Set()
  const titles = []
  for (const item of story) {
    for (const m of String(item.text || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
      const title = m[1].trim()
      const slug = asSlug(title)
      if (slug && !seen.has(slug)) {
        seen.add(slug)
        titles.push(title)
      }
    }
  }
  return titles
}

/**
 * The subject's red links: linked titles found neither on this site nor anywhere
 * in the neighbourhood. These are the pages the author has already said they
 * want — so they are the natural titles for spoken notes, and saving under one
 * turns the link blue with no new link to add.
 */
export async function redLinks($page) {
  const titles = linksOf($page)
  if (!titles.length) return []
  const known = new Set()
  try {
    const res = await fetch('/system/sitemap.json')
    if (res.ok) for (const p of await res.json()) known.add(p.slug)
  } catch {}
  for (const site of Object.values(window.wiki?.neighborhoodObject?.sites || {})) {
    for (const p of site.sitemap || []) known.add(p.slug)
  }
  return titles.filter(t => !known.has(asSlug(t)))
}

/** Whether a page's story already links to a title. */
export const linksTo = ($page, title) => linksOf($page).some(t => asSlug(t) === asSlug(title))

// ---------- drafts: unsaved speech survives the lineup, and a reload ----------
//
// A recording, its transcript and its summary are minutes of someone's work, and
// they used to live in one item's closure: click a link on the page to the left
// and the lineup closes the tool, taking all of it. A draft is kept in this
// browser instead — in memory by the tool, and in IndexedDB here so a reload
// keeps it too. Nothing is saved to the wiki; "Start over" and a successful save
// are what clear it.

const DB = 'audionote-voice'
const STORE = 'drafts'

const openDb = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const withStore = async (mode, fn) => {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req?.result)
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

// Best effort throughout: a browser that refuses storage costs the reload
// safety net, never the tool.
export const saveDraft = (key, draft) => withStore('readwrite', s => s.put({ ...draft, savedAt: Date.now() }, key)).catch(() => {})
export const loadDraft = key => withStore('readonly', s => s.get(key)).catch(() => null)
export const clearDraft = key => withStore('readwrite', s => s.delete(key)).catch(() => {})
