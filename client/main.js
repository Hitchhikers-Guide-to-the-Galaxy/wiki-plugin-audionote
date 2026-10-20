/*
 * Federated Wiki : Audio Note Plugin
 *
 * Records a voice note in the browser, saves the audio file and a JSON
 * metadata sidecar into the page's assets folder through the Farm plugin's
 * shared upload, then emits a native audio item pointing at the saved file.
 *
 * With SUBJECT in its text the item becomes the Voice Tool: it speaks to the
 * page on its left — record or drop audio, transcribe it on the farm, summarise
 * it through a prompt, preview, and add the result to that page. See voice.js.
 *
 * Licensed under the MIT license.
 */

// voice.js is fetched under this module's own version query (see audionote.js,
// the loader), so the pair always arrive together and never from a stale cache.
const voice = await import(`./voice.js${new URL(import.meta.url).search}`)
const clip = await import(`./clip.js${new URL(import.meta.url).search}`)

const preferredAudioTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/wav',
]

const bestMime = () =>
  preferredAudioTypes.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || ''

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')

const timestampName = (kind, extension) => {
  const stamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z')
  return `${stamp}--${kind}.${extension}`
}

const extFor = mime => (mime.match(/audio\/(\w+)/) || [, 'bin'])[1]

const MIC_KEY = 'fedwiki-media:micId'


// ---------- target resolution (Option C: lineup scan + [[link]]/TARGET: override; Option D: item.target) ----------
//
// An audio-note records into a *target* page — "where the recording goes". Resolution order:
//   1. item.target          — a page slug pinned by dragging a page onto the item (Option D)
//   2. [[Page]] / TARGET:    — an explicit target named in the caption text       (Option C override)
//   3. lineup scan           — the nearest *other* page open in the lineup         (Option C default)
//   4. the recorder's own page (fallback, and the single-page common case)
// A named target that isn't open in the lineup falls back to the own page for emission.

const ownPage = $item => $item.parents('.page:first')

const slugify = name =>
  typeof wiki !== 'undefined' && wiki.asSlug
    ? wiki.asSlug(name)
    : name.replace(/\s/g, '-').replace(/[^A-Za-z0-9-]/g, '').toLowerCase()

// The item text is the DSL space. A line is a COMMAND when its first word is ALL-CAPS and
// followed by a colon (e.g. "TARGET: Some Page"), when it is one ALL-CAPS word alone
// ("SUBJECT"), or when the whole line is a single [[wikilink]]. Everything else is the caption.
//   TARGET: Page      — record into that page
//   SUBJECT           — the Voice Tool: speak to the page on the left
//   PROMPT: [[Title]] — the prompt chosen first
//   PROMPTS: site     — the prompt wiki to read prompts from, after this site
//   KINDS: a, b       — which kinds of prompt to offer (default summary, answer, minutes)
//   DOOR: url | farm  — where recordings are heard: a local farm's address, or never look for one
function parseItemText(text) {
  const commands = []
  const caption = []
  for (const line of (text || '').split('\n')) {
    const t = line.trim()
    const lone = t.match(/^\[\[([^\]]+)\]\]$/)
    const cmd = t.match(/^([A-Z][A-Z0-9_]+):\s*(.*)$/)
    const bare = t.match(/^([A-Z][A-Z0-9_]+)$/)
    if (lone) commands.push({ name: 'TARGET', arg: lone[1] })
    else if (cmd) commands.push({ name: cmd[1], arg: cmd[2].trim() })
    else if (bare) commands.push({ name: bare[1], arg: '' })
    else caption.push(line)
  }
  return { commands, caption: caption.join('\n').trim() }
}

// The target page named in the item text via a TARGET: command or a lone [[wikilink]] line.
function itemTarget(text) {
  const cmd = parseItemText(text).commands.find(c => c.name === 'TARGET')
  if (!cmd) return null
  const arg = cmd.arg.replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
  return arg ? slugify(arg) : null
}

const command = (text, name) => parseItemText(text).commands.find(c => c.name === name)
const isVoiceTool = item => !!command(item.text, 'SUBJECT')
const stripLink = arg => (arg || '').replace(/^\[\[/, '').replace(/\]\]$/, '').trim()

// The human caption: the item text with command lines stripped out.
const itemCaption = text => parseItemText(text).caption

// Pages render as .page elements carrying their slug as id; DOM order is lineup order.
const pageTitle = $page => $page.data('data')?.title || $page.attr('id')

function findOpenPage(slug, $self) {
  const matches = $('.page').filter((_, el) => $(el).attr('id') === slug)
  if (!matches.length) return null
  const notSelf = matches.filter((_, el) => el !== $self[0]) // same slug can be open twice
  return (notSelf.length ? notSelf : matches).first()
}

function pageForSlug(slug, $self) {
  if (!slug || slug === $self.attr('id')) return $self
  return findOpenPage(slug, $self) || $self
}

// The nearest other open page, preferring the one to the right of the recorder in the lineup.
function lineupScan($self) {
  const pages = $('.page').toArray()
  const i = pages.indexOf($self[0])
  if (i === -1) return null
  for (let j = i + 1; j < pages.length; j++) if (pages[j] !== $self[0]) return $(pages[j])
  for (let j = i - 1; j >= 0; j--) if (pages[j] !== $self[0]) return $(pages[j])
  return null
}

// Decode a dropped page the way the FedWiki client does (wiki-client/lib/drop.js), so flag drags
// work the same across browsers. isUrl: browsers expose dragged URLs differently (Firefox uses
// text/x-moz-url) and getData('URL') is the portable accessor. isPage: the client's canonical
// page-URL matcher — captures site and slug from .../<site>/<slug> (e.g. /view/welcome-visitors/view/<slug>).
function urlFromDrop(dt) {
  if (dt && dt.types && (dt.types.includes('text/uri-list') || dt.types.includes('text/x-moz-url'))) {
    const url = dt.getData('URL')
    if (url && url.length) return url
  }
  return null
}

function pageFromDrop(dt) {
  const url = urlFromDrop(dt)
  if (!url) return null
  const found = url.match(/^https?:\/\/([a-zA-Z0-9:.-]+)(\/([a-zA-Z0-9:.-]+)\/([a-z0-9-]+(_rev\d+)?))+$/)
  if (!found) return null
  const [, origin, , site, slug] = found
  return { site: ['view', 'local', 'origin'].includes(site) ? origin : site, slug }
}

const targetInfo = ($page, source, extra = {}) => ({ $page, slug: $page.attr('id'), title: pageTitle($page), source, ...extra })

function resolveTarget($item, item) {
  const $self = ownPage($item)
  if (isVoiceTool(item)) {
    const $subject = voice.leftSubject($self)
    return $subject ? targetInfo($subject, 'subject') : targetInfo($self, 'self', { unresolved: 'a page to the left' })
  }
  const fromText = itemTarget(item.text) // the visible, editable choice wins over a sticky pin
  const explicit = fromText || item.target
  if (explicit) {
    const $page = findOpenPage(explicit, $self)
    if ($page) return targetInfo($page, fromText ? 'caption' : 'pinned')
    return targetInfo($self, 'self', { unresolved: explicit }) // named but not open
  }
  const $scanned = lineupScan($self)
  if ($scanned) return targetInfo($scanned, 'lineup')
  return targetInfo($self, 'self')
}

// Insert a freshly built item into the target page's story and wire it up. When the target is the
// recorder's own page the item lands right after the recorder; otherwise it appends to the end.
function placeItem(target, $item, newItem) {
  const isOwn = target.$page[0] === ownPage($item)[0]
  const $story = target.$page.find('.story:first')
  const $anchor = isOwn ? $item : $story.children('.item').last()
  const $new = $('<div />', { class: `item ${newItem.type}`, 'data-id': newItem.id })
    .data('item', newItem)
    .data('pageElement', target.$page)
  if ($anchor.length) $anchor.after($new)
  else $story.append($new)
  wiki.doPlugin($new, newItem)
  return { $new, afterId: $anchor.length ? $anchor.attr('data-id') : null }
}

let audioContext
let meterSource // keep a reference — Chrome GCs unreferenced MediaStreamAudioSourceNodes, silencing the meter

const levelZone = db => {
  if (db > -3) return ['clipping — back off', '#c0392b']
  if (db > -30) return ['good', '#1a7f37']
  if (db > -50) return ['low — speak up or move closer', '#d68910']
  return ['no signal — wrong microphone?', '#c0392b']
}

const AGC_KEY = 'fedwiki-media:agc'
const GAIN_KEY = 'fedwiki-media:gainDb'

const storedAgc = () => localStorage.getItem(AGC_KEY) !== 'off'
const storedGainDb = () => +(localStorage.getItem(GAIN_KEY) || 0)

const micConstraints = () => {
  const audio = { autoGainControl: storedAgc(), echoCancellation: true, noiseSuppression: true }
  const micId = localStorage.getItem(MIC_KEY)
  if (micId && micId !== ASK_MIC) audio.deviceId = { exact: micId }
  return { audio }
}

// The picker's own permission step: ask the browser, let the names through,
// then show the default device — the one a first take will use.
const wireMicSelect = (select, say = () => {}) => {
  fillMicSelect(select).catch(() => {})
  select.onchange = async () => {
    if (select.value !== ASK_MIC) return localStorage.setItem(MIC_KEY, select.value)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      await fillMicSelect(select)
    } catch (err) {
      say(err.name === 'NotAllowedError' ? 'the browser did not allow the microphone — check the site permission in the address bar' : 'error: ' + err.message)
    }
  }
}

// Until the site has been allowed the microphone, the browser lists the
// devices without their names — sometimes without even their ids. Naming them
// "Microphone 1, 2, 3" pretended to a choice nobody could make. So the picker
// then holds one entry that says what is needed; choosing it asks the browser,
// and the real names follow.
const ASK_MIC = '__ask__'

async function fillMicSelect(select) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
  const current = select.value || localStorage.getItem(MIC_KEY)
  select.innerHTML = ''
  if (!devices.length || devices.every(d => !d.label)) {
    const opt = document.createElement('option')
    opt.value = ASK_MIC
    opt.textContent = devices.length ? '🎙 allow the microphone…' : '🎙 no microphone found — connect one'
    select.appendChild(opt)
    return
  }
  devices.forEach(d => {
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label
    select.appendChild(opt)
  })
  const options = [...select.options]
  if (current && options.some(o => o.value === current)) {
    select.value = current
  } else if (options.some(o => o.value === 'default')) {
    select.value = 'default' // prefer the system default device, not the first enumerated one
  }
}

// ---------- recording with level meter ----------

function recordStream(stream, ui, { maxSeconds = 600, label, gainDb = 0 }) {
  return new Promise((resolve, reject) => {
    const mime = bestMime()
    if (!mime) return reject(new Error('No supported MediaRecorder audio type'))

    const chunks = []
    const startedAt = performance.now()
    // Paused time is not recorded, so it is not counted: the timer and the
    // duration are of what was said.
    let pausedMs = 0
    let pausedAt = null
    const elapsedMs = () => (pausedAt ?? performance.now()) - startedAt - pausedMs

    // device info from the original stream, before any gain wrapping
    const track = stream.getAudioTracks()[0]
    const settings = track ? track.getSettings() : {}
    const device = track
      ? { label: track.label, sampleRate: settings.sampleRate, autoGainControl: settings.autoGainControl }
      : null

    audioContext ||= new AudioContext()
    const analyser = audioContext.createAnalyser()

    // Software gain: route through a GainNode and record the processed stream, so the
    // gain is baked into the file. The meter taps post-gain — what you see is what saves.
    // (Best fix for quiet input is still the OS input level in System Settings > Sound.)
    let recStream = stream
    if (gainDb !== 0) {
      const source = audioContext.createMediaStreamSource(stream)
      const gainNode = audioContext.createGain()
      gainNode.gain.value = Math.pow(10, gainDb / 20)
      const dest = audioContext.createMediaStreamDestination()
      source.connect(gainNode)
      gainNode.connect(dest)
      gainNode.connect(analyser)
      meterSource = { source, gainNode, dest } // hold refs — Chrome GCs unreferenced audio nodes
      recStream = dest.stream
    } else {
      meterSource = audioContext.createMediaStreamSource(stream)
      meterSource.connect(analyser)
    }

    const recorder = new MediaRecorder(recStream, { mimeType: mime })

    // The canvas is looked up every frame, not once: the Voice Tool's item can be
    // re-rendered mid-take, and the meter must follow it to the new canvas.
    const wave = new Uint8Array(analyser.frequencyBinCount)
    const buf = new Float32Array(analyser.fftSize)
    let maxPeakDb = -Infinity
    let raf

    const drawFrame = () => {
      const ctx = ui.meter.getContext('2d')
      analyser.getByteTimeDomainData(wave)
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, ui.meter.width, ui.meter.height)
      ctx.strokeStyle = '#2ecc71'
      ctx.lineWidth = 2
      ctx.beginPath()
      const step = ui.meter.width / wave.length
      wave.forEach((v, i) => {
        const y = (v / 255) * ui.meter.height
        i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y)
      })
      ctx.stroke()

      analyser.getFloatTimeDomainData(buf)
      let peak = 0
      for (const s of buf) {
        const a = Math.abs(s)
        if (a > peak) peak = a
      }
      const db = 20 * Math.log10(peak || 1e-7)
      if (db > maxPeakDb) maxPeakDb = db
      ui.db.textContent = db <= -90 ? '-inf' : db.toFixed(1)
      const [text, color] = levelZone(db)
      ui.zone.textContent = text
      ui.zone.style.color = color

      raf = requestAnimationFrame(drawFrame)
    }
    drawFrame()

    const tick = setInterval(() => {
      ui.timer.textContent = (elapsedMs() / 1000).toFixed(1) + 's' + (pausedAt ? ' paused' : '')
    }, 100)

    const timeout = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), maxSeconds * 1000)

    ui.stopFn = () => recorder.state !== 'inactive' && recorder.stop()
    // Pause and resume one take. Answers whether the take is now paused.
    ui.pauseFn = () => {
      if (recorder.state === 'recording') {
        recorder.pause()
        pausedAt = performance.now()
      } else if (recorder.state === 'paused') {
        pausedMs += performance.now() - pausedAt
        pausedAt = null
        recorder.resume()
      }
      return recorder.state === 'paused'
    }

    recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
    recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'))
    recorder.onstop = () => {
      clearTimeout(timeout)
      clearInterval(tick)
      cancelAnimationFrame(raf)
      const ctx = ui.meter.getContext('2d')
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, ui.meter.width, ui.meter.height)
      ui.timer.textContent = ''
      ui.db.textContent = '–' // the last level says nothing once nobody is speaking
      ui.zone.textContent = ''
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks, { type: mime })
      const duration = +(elapsedMs() / 1000).toFixed(2)
      resolve({ blob, mime, duration, peakDb: +maxPeakDb.toFixed(1), device, label, gainDb })
    }

    recorder.start()
  })
}

// ---------- save to assets + emit native audio item ----------

async function saveRecording(item, take, target) {
  const slug = target.slug
  const filename = timestampName('voice-note', extFor(take.mime))
  const sidecarName = filename.replace(/\.\w+$/, '.json')
  const src = `assets/${slug}/${filename}`

  const sidecar = {
    type: 'audionote',
    page: slug,
    itemId: item.id,
    filename,
    src,
    mime: take.mime,
    created: new Date().toISOString(),
    duration: take.duration,
    peakDb: take.peakDb,
    gainDb: take.gainDb,
    device: take.device,
    source: take.label,
    participantId: null,
    consent: null,
    signature: null,
    transcript: null,
    segments: [],
    markers: [],
  }

  const why = voice.cannotSave(target.$page)
  if (why) throw new Error(why)
  await voice.putAsset(slug, filename, take.blob, take.mime.split(';')[0])
  await voice.putAsset(slug, sidecarName, new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' }), 'application/json')

  return { src, filename, sidecar }
}

// The wiki server applies each action with an unserialised read-modify-write of the
// page file, so two simultaneous puts race and the second clobbers the first. Sequence
// them: pageHandler.put goes through jQuery ajax, so ajaxComplete signals the landing.
function putAndWait($page, action) {
  return new Promise(resolve => {
    const fallback = setTimeout(() => {
      $(document).off('ajaxComplete', handler)
      resolve()
    }, 2000)
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

async function saveAndEmit($item, item, take, ui) {
  const target = resolveTarget($item, item)
  ui.status.textContent = `saving into ${target.title}…`
  const caption = itemCaption(item.text) || `Voice note — ${new Date().toLocaleString()}`
  const saved = await saveRecording(item, take, target)

  // absolute URL: assets do not travel when a page is forked, so point at this site explicitly
  const audioItem = { type: 'audio', id: randomId(), text: `${location.origin}/${saved.src}\n${caption}` }
  const { afterId } = placeItem(target, $item, audioItem)

  item.recording = {
    src: saved.src,
    filename: saved.filename,
    mime: take.mime,
    duration: take.duration,
    peakDb: take.peakDb,
    created: saved.sidecar.created,
    audioItemId: audioItem.id,
    targetSlug: target.slug,
    targetTitle: target.title,
  }
  // the audio item goes onto the target page; the recorder item's metadata edit stays on its own page
  await putAndWait(target.$page, { item: audioItem, id: audioItem.id, type: 'add', after: afterId })
  await putAndWait(ownPage($item), { item, id: item.id, type: 'edit' })
  ui.transcribe.disabled = false

  const quiet = take.peakDb < -30 ? ` — warning: quiet take (peak ${take.peakDb} dBFS)` : ''
  const into = target.$page[0] === ownPage($item)[0] ? '' : ` into ${target.title}`
  ui.status.textContent = `saved ${saved.filename}${into} (${(take.blob.size / 1024).toFixed(0)} KB, ${take.duration}s)${quiet}`
  return { saved, audioItem, target }
}

// ---------- transcription (local Whisper provider) ----------

async function transcribeRecording($item, item, ui) {
  const rec = item.recording
  if (!rec?.src) throw new Error('no saved recording to transcribe')

  // resolve the same target the recording was saved into (lineup may have changed since)
  const $self = ownPage($item)
  const target = {
    $page: pageForSlug(rec.targetSlug, $self),
    slug: rec.targetSlug || $self.attr('id'),
    title: rec.targetTitle || pageTitle($self),
  }
  const $page = target.$page
  const slug = target.slug

  ui.status.textContent = 'transcribing…'
  const transcript = await voice.transcribe(slug, rec.filename, job => {
    ui.status.textContent =
      job.state === 'queued' ? `transcription queued${job.ahead ? ` behind ${job.ahead}` : ''}…` : 'transcribing on the farm…'
  })

  // The farm writes its sidecars beside the recording; a private service does not, so store them.
  let transcriptName = transcript.transcript?.split('/').pop()
  let transcriptTxtName = transcript.transcriptTxt?.split('/').pop()
  if (!transcriptName) {
    transcriptName = rec.filename.replace(/\.\w+$/, '.transcript.json')
    transcriptTxtName = rec.filename.replace(/\.\w+$/, '.transcript.txt')
    await voice.putAsset(slug, transcriptName, new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' }), 'application/json')
    await voice.putAsset(slug, transcriptTxtName, new Blob([transcript.text], { type: 'text/plain' }), 'text/plain')
  }

  // add a markdown item with the transcript text, after the audio item if we know it
  const mdItem = {
    type: 'markdown',
    id: randomId(),
    text: `> ${transcript.text}\n\n*Transcript of ${rec.filename} — ${transcript.provider} (${transcript.model}), language ${transcript.language}.*`,
  }
  let $anchor = $page.find(`.story:first > .item[data-id="${rec.audioItemId}"]`)
  if (!$anchor.length) $anchor = $page.find('.story:first > .item').last()
  const $new = $('<div />', { class: 'item markdown', 'data-id': mdItem.id }).data('item', mdItem).data('pageElement', $page)
  if ($anchor.length) $anchor.after($new)
  else $page.find('.story:first').append($new)
  wiki.doPlugin($new, mdItem)
  await putAndWait($page, { item: mdItem, id: mdItem.id, type: 'add', after: $anchor.length ? $anchor.attr('data-id') : null })

  // update the audio item's caption to [[Target Title]] - [txt-url filename]
  if (rec.audioItemId) {
    const txtUrl = `${location.origin}/assets/${slug}/${transcriptTxtName}`
    const newCaption = `[[${target.title}]] - [${txtUrl} ${transcriptTxtName}]`
    const $audioEl = $page.find(`.item[data-id="${rec.audioItemId}"]`)
    if ($audioEl.length) {
      const audioItem = $audioEl.data('item')
      if (audioItem?.text) {
        const lines = audioItem.text.split('\n')
        lines[1] = newCaption
        audioItem.text = lines.join('\n')
        $audioEl.data('item', audioItem)
        await putAndWait($page, { item: audioItem, id: audioItem.id, type: 'edit' })
      }
    }
  }

  item.recording.transcript = `assets/${slug}/${transcriptName}`
  item.recording.transcriptTxt = `assets/${slug}/${transcriptTxtName}`
  await putAndWait(ownPage($item), { item, id: item.id, type: 'edit' }) // recorder item lives on its own page

  ui.status.textContent = `transcribed — ${(transcript.segments || []).length} segments, language ${transcript.language}`
  return transcript
}

// ---------- item UI ----------

// The live level read-out. It changes many times a second, so it has a line of
// its own beneath the meter, of fixed height, that never wraps: beside the boost
// slider its changing width re-flowed the row and made the whole item jitter.
const meterLine = `
    <div style="font-family:monospace; font-size:.8em; height:1.5em; line-height:1.5em; margin:2px 0 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
      <span class="an-levels">peak <span class="an-db" style="display:inline-block; min-width:3.2em; text-align:right;">–</span> dBFS
      <span class="an-timer" style="display:inline-block; min-width:7em;"></span> <span class="an-zone"></span></span>
      <span class="an-busy" style="display:none; color:#1a5fb4;"></span>
    </div>`

const html = item => `
  <div style="background-color:#eee; padding:12px; border-radius:6px;">
    <select class="an-mic" style="width:100%; font-size:.85em; margin-bottom:6px;"></select>
    <div class="an-dest" title="Where this recording will be saved. Drag a page link here, or add a TARGET: line to the caption, to change it."
      style="font-size:.9em; margin:0 0 8px; padding:6px 9px; border:2px dashed #9ab; border-radius:5px; background:#eef4ff;">
      <strong>Saves to ▸</strong> <span class="an-target">resolving…</span>
      <span class="an-dest-hint" style="color:#7a8aa0;"> · drag a page here</span>
    </div>
    <div>
      <button class="an-check">Mic Check</button>
      <button class="an-record">Record</button>
      <button class="an-pause" disabled>Pause</button>
      <button class="an-stop" disabled>Stop</button>
      <button class="an-save" disabled>Save to Assets</button>
      <button class="an-transcribe"${item.recording?.src ? '' : ' disabled'}>Transcribe</button>
    </div>
    <div style="font-size:.8em; color:#444; margin:4px 0;">
      <label><input type="checkbox" class="an-agc"> auto&nbsp;gain</label>
      &nbsp; boost <input type="range" class="an-gain" min="0" max="24" step="1" value="0"
        style="width:110px; vertical-align:middle;"> +<span class="an-gaindb">0</span>&nbsp;dB
    </div>
    <canvas class="an-meter" width="400" height="48" style="width:100%; background:#111; border-radius:4px;"></canvas>
    ${meterLine}
    <audio class="an-player" controls style="width:100%; margin-top:6px; display:none;"></audio>
    <div class="an-status" style="font-size:.8em; color:#555; margin-top:4px;">${
      item.recording ? `last saved: ${item.recording.filename} (${item.recording.duration}s)` : 'no recording yet'
    }</div>
    <p class="an-caption" style="font-style:italic; margin:6px 0 0;">${wiki.resolveLinks(itemCaption(item.text) || '(double-click to add a caption)')}</p>
  </div>
`

const getUI = $item => {
  const el = sel => $item.find(sel)[0]
  return {
    mic: el('.an-mic'),
    agc: el('.an-agc'),
    gain: el('.an-gain'),
    gaindb: el('.an-gaindb'),
    check: el('.an-check'),
    record: el('.an-record'),
    stop: el('.an-stop'),
    pause: el('.an-pause'),
    save: el('.an-save'),
    transcribe: el('.an-transcribe'),
    db: el('.an-db'),
    zone: el('.an-zone'),
    timer: el('.an-timer'),
    meter: el('.an-meter'),
    player: el('.an-player'),
    status: el('.an-status'),
    dest: el('.an-dest'),
    target: el('.an-target'),
    stopFn: null,
  }
}

const emit = ($item, item) => {
  $item.append(isClip(item) ? clipHtml(item) : isVoiceTool(item) ? voiceHtml(item) : isTranscript(item) ? transcriptHtml(item) : html(item))
}

const bind = ($item, item) => {
  if (isClip(item)) return bindClip($item, item)
  if (isVoiceTool(item)) return bindVoice($item, item)
  if (isTranscript(item)) return bindTranscript($item, item)
  const ui = getUI($item)
  let take = null
  let checkStream = null

  wireMicSelect(ui.mic, text => (ui.status.textContent = text))

  ui.agc.checked = storedAgc()
  ui.agc.onchange = () => localStorage.setItem(AGC_KEY, ui.agc.checked ? 'on' : 'off')
  ui.gain.value = storedGainDb()
  ui.gaindb.textContent = ui.gain.value
  ui.gain.oninput = () => {
    ui.gaindb.textContent = ui.gain.value
    localStorage.setItem(GAIN_KEY, ui.gain.value)
  }
  const currentGainDb = () => +ui.gain.value

  // ---- "Saves to" destination (Option C/D): show where the recording lands, accept a dropped page ----
  const SOURCE_LABEL = { pinned: 'pinned', caption: 'from caption', lineup: 'nearby page', self: 'this page', subject: 'subject' }
  const refreshTarget = () => {
    const t = resolveTarget($item, item)
    const link = wiki.resolveLinks(`[[${t.title}]]`)
    const unpin = item.target ? ' · <a href="#" class="an-unpin" style="color:#c0392b;">✕ unpin</a>' : ''
    const warn = t.unresolved ? ` <span style="color:#c0392b">— "${t.unresolved}" isn't open, using this page</span>` : ''
    ui.target.innerHTML = `${link} <span style="color:#7a8aa0;">(${SOURCE_LABEL[t.source]})</span>${unpin}${warn}`
    // green border once a real destination is chosen (anything but the bare own-page default)
    const chosen = t.source !== 'self'
    ui.dest.style.borderColor = chosen ? '#1a7f37' : '#9ab'
    ui.dest.style.background = chosen ? '#eef9f0' : '#eef4ff'
    ui.target.querySelector('.an-unpin')?.addEventListener('click', async e => {
      e.preventDefault()
      delete item.target
      $item.data('item', item)
      await putAndWait(ownPage($item), { item, id: item.id, type: 'edit' })
      refreshTarget()
    })
  }
  refreshTarget()

  const slugFromDrop = dt => {
    // primary path: FedWiki's own page-drop decoder (handles flag drags cross-browser)
    const page = pageFromDrop(dt)
    if (page) return page.slug
    // fallbacks for non-flag drags (a rendered [[link]] or plain text)
    const txt = (dt && dt.getData && dt.getData('text/plain')) || ''
    const wl = txt.match(/\[\[([^\]]+)\]\]/)
    if (wl) return slugify(wl[1])
    if (/^[\w][\w \-]*$/.test(txt.trim())) return slugify(txt.trim())
    return null
  }
  // sibling lineup pages may finish rendering after this item binds, and the lineup can change
  // later — refresh the indicator on hover so "Saves to" is always current.
  $item.on('mouseenter', refreshTarget)
  // dragenter + dragover preventDefault is what lets a drop land (mirrors the factory plugin)
  ui.dest.addEventListener('dragenter', e => e.preventDefault())
  ui.dest.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; ui.dest.style.background = '#d8ecff' })
  ui.dest.addEventListener('dragleave', () => refreshTarget())
  ui.dest.addEventListener('drop', async e => {
    e.preventDefault()
    e.stopPropagation()
    const slug = slugFromDrop(e.dataTransfer)
    if (!slug) { refreshTarget(); ui.status.textContent = 'drop a page link onto "Saves to" to pin a destination'; return }
    item.target = slug
    $item.data('item', item)
    await putAndWait(ownPage($item), { item, id: item.id, type: 'edit' })
    refreshTarget()
    ui.status.textContent = `destination pinned to ${slug}`
  })

  const setBusy = busy => {
    ui.record.disabled = busy
    ui.check.disabled = busy && !checkStream
    ui.stop.disabled = !busy
    ui.pause.disabled = !busy
    ui.pause.textContent = 'Pause'
    ui.save.disabled = busy || !take
    ui.record.style.background = busy ? '#c0392b' : ''
    ui.record.style.color = busy ? 'white' : ''
  }

  const stopCheck = () => {
    if (!checkStream) return
    checkStream.monitor.stopFn?.()
    checkStream = null
    ui.check.textContent = 'Mic Check'
  }

  ui.check.onclick = async () => {
    if (checkStream) return stopCheck()
    try {
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints())
      await fillMicSelect(ui.mic) // labels unlock after first permission
      ui.check.textContent = 'Stop Check'
      const monitor = { meter: ui.meter, db: ui.db, zone: ui.zone, timer: ui.timer, stopFn: null }
      checkStream = { stream, monitor }
      // monitor without keeping the recording
      recordStream(stream, monitor, { maxSeconds: 3600, label: 'mic-check', gainDb: currentGainDb() }).catch(() => {})
    } catch (err) {
      ui.status.textContent = 'error: ' + err.message
    }
  }

  ui.record.onclick = async () => {
    try {
      stopCheck()
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints())
      await fillMicSelect(ui.mic)
      setBusy(true)
      take = await recordStream(stream, ui, { maxSeconds: 600, label: 'microphone', gainDb: currentGainDb() })
      ui.player.src = URL.createObjectURL(take.blob)
      ui.player.style.display = ''
      const quiet = take.peakDb < -30 ? ` — quiet take (peak ${take.peakDb} dBFS), check mic before saving` : ''
      ui.status.textContent = `recorded ${take.duration}s, peak ${take.peakDb} dBFS${quiet}`
    } catch (err) {
      ui.status.textContent = 'error: ' + err.message
    } finally {
      setBusy(false)
    }
  }

  ui.stop.onclick = () => ui.stopFn?.()
  ui.pause.onclick = () => (ui.pause.textContent = ui.pauseFn?.() ? 'Resume' : 'Pause')

  ui.transcribe.onclick = async () => {
    try {
      ui.transcribe.disabled = true
      await transcribeRecording($item, item, ui)
    } catch (err) {
      ui.status.textContent = 'error: ' + err.message
    } finally {
      ui.transcribe.disabled = !item.recording?.src
    }
  }

  ui.save.onclick = async () => {
    if (!take) return
    try {
      ui.save.disabled = true
      await saveAndEmit($item, item, take, ui)
      take = null
    } catch (err) {
      ui.status.textContent = 'error: ' + err.message
      ui.save.disabled = false
    }
  }

  $item.on('dblclick', e => {
    if ($(e.target).closest('button, select, audio, canvas').length) return
    wiki.textEditor($item, item)
  })

  // Permission-free end-to-end test: record a 2s oscillator tone, save it, emit the audio item.
  window.audioNoteSelfTest ||= async (seconds = 2) => {
    audioContext ||= new AudioContext()
    await audioContext.resume()
    if (audioContext.state !== 'running') {
      throw new Error('AudioContext is ' + audioContext.state + ' — autoplay policy needs a user gesture first')
    }
    const dest = audioContext.createMediaStreamDestination()
    const osc = audioContext.createOscillator()
    const gain = audioContext.createGain()
    gain.gain.value = 0.5 // -6 dBFS
    osc.connect(gain).connect(dest)
    osc.start()
    setBusy(true)
    try {
      const testTake = await recordStream(dest.stream, ui, { maxSeconds: seconds, label: 'self-test-oscillator', gainDb: currentGainDb() })
      osc.stop()
      const { saved, audioItem } = await saveAndEmit($item, item, testTake, ui)
      return { take: { mime: testTake.mime, bytes: testTake.blob.size, duration: testTake.duration, peakDb: testTake.peakDb }, saved: saved.src, audioItem }
    } finally {
      setBusy(false)
    }
  }
}


// ---------- prompts: shared by the Voice Tool and the transcript item ----------
//
// The prompt select offers the built-in plain summary plus every prompt of the
// item's KINDS, read from this site first and the PROMPTS: wiki second
// (prompt.geek.fish unless named); PROMPT: [[Title]] is chosen first. The list
// is found once per session and the choice is kept on the session, so a
// re-rendered item paints the same choice. `selectOf` returns the select now on
// screen (an item can be re-rendered while prompts are being found).
function promptPicker(selectOf, item, S) {
  const promptSite = command(item.text, 'PROMPTS')?.arg || 'prompt.geek.fish'
  const kinds = (command(item.text, 'KINDS')?.arg || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const wanted = stripLink(command(item.text, 'PROMPT')?.arg)
  const paintPrompts = () => {
    const select = selectOf()
    select.innerHTML =
      '<option value="-1">plain summary (built in)</option>' +
      S.prompts.map((p, i) => `<option value="${i}">${esc(p.title)} — ${esc(p.kind || 'prompt')} · ${p.local ? 'forked here' : esc(p.from)}</option>`).join('')
    select.value = S.promptChoice ?? String(S.prompts.findIndex(p => p.title.toLowerCase() === wanted.toLowerCase()))
    select.onchange = () => (S.promptChoice = select.value)
  }
  if (S.prompts) paintPrompts()
  else {
    voice
      .findPrompts({ promptSite, kinds: kinds.length ? kinds : voice.DEFAULT_KINDS, named: wanted ? [wanted] : [] })
      .then(found => {
        S.prompts = found.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
        paintPrompts()
      })
      .catch(e => (selectOf().innerHTML = `<option value="-1">plain summary — prompts unavailable (${esc(e.message)})</option>`))
  }
  return () => S.prompts?.[+selectOf().value]
}

// ---------- which model summarises (0.7.0) ----------
//
// A choice beside Summarise, remembered in this browser, to compare the doors
// on the same transcript: Claude on the farm's Max account, qwen on the
// MacMini (DNS-SD qwen._ollama._tcp) and the LLM coop's GPU machine
// (DNS-SD coop._openai._tcp, llm_auto-big). "Prompt or farm default" leaves the
// choice to the prompt's MODEL line, else the farm (wiki-claude-door >= 0.2.0).
const MODELS = [
  ['', 'prompt or farm default'],
  ['claude-opus-5-5', 'Claude (Max account)'],
  ['ollama:qwen3:4b', 'qwen3:4b on the MacMini'],
  ['openai:llm_auto-big', 'Coop GPU: llm_auto-big'],
]
const MODEL_KEY = 'audionote:summary-model'
const modelRowHtml = () => `
    <div style="margin-top:4px; font-size:.9em; white-space:nowrap; overflow:hidden;">
      Model <select class="an-model" style="max-width:55%;">${MODELS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>
      <span class="an-took" style="margin-left:6px; color:#666; font-size:.9em;" title="how long the last summary took, from this browser"></span>
    </div>`
const storedModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY) || ''
  } catch {
    return ''
  }
}
// Time a summary in the browser, so models can be compared by hand: a live
// count while it works, then "took 42 s" with the model that wrote it.
async function timed(root, run) {
  const took = root.querySelector('.an-took')
  const t0 = Date.now()
  const secs = () => Math.round((Date.now() - t0) / 1000)
  const tick = took ? setInterval(() => (took.textContent = `working… ${secs()} s`), 1000) : null
  if (took) took.textContent = 'working… 0 s'
  try {
    const out = await run()
    if (took) {
      const who = String(out?.model || '').replace(/^claude-cli:/, '').replace(/^(openai|ollama):/, '')
      took.textContent = `took ${secs()} s${who ? ` · ${who}` : ''}`
    }
    return out
  } catch (e) {
    if (took) took.textContent = `failed after ${secs()} s`
    throw e
  } finally {
    clearInterval(tick)
  }
}

function bindModel(root) {
  const select = root.querySelector('.an-model')
  if (!select) return () => ''
  select.value = MODELS.some(([v]) => v === storedModel()) ? storedModel() : ''
  select.onchange = () => {
    try {
      localStorage.setItem(MODEL_KEY, select.value)
    } catch {}
  }
  return () => select.value
}

/** A transcript through a prompt (or the built-in plain summary) on the farm. */
const summaryFor = ({ transcript, $page, prompt, title = '', model = '' }) =>
  voice.summarise({
    transcript,
    pageTitle: $page ? pageTitle($page) : '',
    pageText: $page ? voice.pageText($page) : '',
    title: (title || '').trim().replace(/\s+/g, ' '), // the page the words will be saved under, for prompts that answer one question

    prompt: prompt?.body || '',
    model: model || prompt?.model || undefined,
  })

// ---------- the Voice Tool (SUBJECT) ----------
//
// Speak, read the transcript, summarise through a prompt — and by default the
// result opens as a GHOST PAGE beside the tool, its points as separate items,
// for the author to drag to wherever they belong. Writing straight into the
// page on the left is the second choice, not the first.
//
// The recording stays in the browser. It is sent to the farm to be transcribed
// and deleted there; it reaches the site's assets only if the author ticks
// "keep the audio", and only then does an audio player appear in the result.
// The tool never edits its own item: the Voice Tool page is served by the
// plugin to every site, and an edit would fork a copy of it into the site.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const voiceHtml = item => `
  <div class="an-voice" style="background-color:#eee; padding:12px; border-radius:6px;">
    <div class="an-dest" style="font-size:.95em; margin:0 0 8px; padding:6px 9px; border:2px solid #9ab; border-radius:5px; background:#eef4ff;">
      <strong>Speaking to ▸</strong> <span class="an-target">looking to the left…</span>
    </div>
    <div class="an-warn" style="display:none; color:#c0392b; font-size:.9em; margin:0 0 8px;"></div>
    <div class="an-titlebox" style="margin:0 0 8px; font-size:.85em; white-space:nowrap;">
      Page title <input type="text" class="an-title" style="width:68%; font-size:1em;"
        title="The name of the notes page. Change it for each question to build a series — it can also be edited on the ghost page itself.">
      <div class="an-redbox" style="margin-top:4px; display:none;">
        <span style="color:#c0392b;">●</span> or a page it is waiting for
        <select class="an-red" style="max-width:62%; font-size:1em;" title="Red links on the page to the left: pages it links to that nobody has written yet. Saving under one turns the link blue."></select>
      </div>
    </div>
    <select class="an-mic" style="width:100%; font-size:.85em; margin-bottom:6px;"></select>
    <div>
      <button class="an-record">● Speak</button>
      <button class="an-pause" disabled>❚❚ Pause</button>
      <button class="an-stop" disabled>■ Stop</button>
      <button class="an-clear" disabled title="Throw away this recording, its transcript and summary, and start again">✕ Start over</button>
      <button class="an-retry" style="display:none;" title="Transcribe this recording again — its transcript was not kept, or the farm refused it">↻ Transcribe</button>
    </div>
    <div style="font-size:.8em; color:#444; margin:6px 0 4px; white-space:nowrap;">
      boost <input type="range" class="an-gain" min="0" max="24" step="1" value="0" style="width:110px; vertical-align:middle;">
      +<span class="an-gaindb" style="display:inline-block; min-width:1.4em;">0</span>&nbsp;dB
    </div>
    <canvas class="an-meter" width="400" height="36" style="width:100%; background:#111; border-radius:4px;"></canvas>
    ${meterLine}
    <div style="font-size:.85em;">
      <label class="an-pick" style="cursor:pointer; border:1px solid #999; border-radius:3px; padding:1px 6px; background:#fafafa;"
        title="Record with the phone's own recorder, or choose a recording — works where the browser may not use the microphone (plain http)">
        🎙 record or choose a file<input type="file" class="an-file" accept="audio/*,video/*" capture style="display:none;"></label>
      <span style="color:#666;">&nbsp;or drop one here</span>
    </div>
    <audio class="an-player" controls style="width:100%; margin-top:6px; display:none;"></audio>
    <details class="an-tbox" style="margin-top:6px; display:none;">
      <summary style="cursor:pointer; font-size:.9em;">Transcript</summary>
      <div class="an-transcript" style="font-size:.85em; background:#fff; padding:6px 8px; border-radius:4px; max-height:12em; overflow:auto;"></div>
    </details>
    <div style="margin-top:8px; font-size:.9em; white-space:nowrap; overflow:hidden;">
      Prompt <select class="an-prompt" style="max-width:62%;"><option>finding prompts…</option></select>
      <button class="an-summarise" disabled>Summarise</button>
    </div>
    ${modelRowHtml()}
    <textarea class="an-preview" rows="9" placeholder="The summary appears here to read and edit."
      style="width:100%; box-sizing:border-box; margin-top:6px; font-size:.85em; display:none;"></textarea>
    <div class="an-keepbox" style="margin-top:6px; font-size:.85em; display:none;">
      <label><input type="checkbox" class="an-keep"> keep the audio — upload it to assets/</label><input type="text" class="an-folder" size="16" style="font-size:1em;" title="The assets folder the recording is stored in">
      <div style="color:#666;">Unticked, the recording is thrown away and only the text remains.</div>
    </div>
    <div style="margin-top:6px;">
      <button class="an-ghost" disabled title="Open the notes as a ghost page under this title — drag items from it, or save it">Open as ghost page</button>
      <button class="an-add" disabled title="Save the notes as a new page of this title, and put a [[link]] to it on the page to the left (and on the clipboard)">Save page &amp; link it</button>
      <button class="an-put" disabled title="Add the notes to the page on the left itself: under the prompt's SECTION heading when it names one (filling an unfilled card template there), otherwise before its See section">Add to this page</button>
    </div>
    <div class="an-status" style="font-size:.8em; color:#555; margin-top:4px; min-height:1.3em;">speak, or drop a recording</div>
    <p class="an-caption" style="font-style:italic; margin:6px 0 0;">${wiki.resolveLinks(itemCaption(item.text) || '')}</p>
  </div>
`

// A Voice Tool's state lives HERE, not in the item that draws it. The lineup
// closes the tool whenever a link is followed from the page on its left, and an
// edit can re-render it; held in a closure, minutes of recording, transcript and
// summary went with it. A session outlives its item: the next bind of the same
// item paints itself from the session, takes over a take still being recorded,
// and hears the end of work begun before it existed. voice.js keeps a copy of
// the draft in IndexedDB so a reload keeps it too. None of this saves a page.
const sessions = new Map()
const sessionFor = key => {
  if (!sessions.has(key)) {
    sessions.set(key, { ui: null, fn: {}, draft: null, recording: false, paused: false, prompts: null, title: '', titleTouched: false, $ghost: null, status: '', red: [], redFor: null, loaded: false, blobUrl: null })
  }
  return sessions.get(key)
}

function bindVoice($item, item) {
  const el = sel => $item.find(sel)[0]
  const S = sessionFor(item.id)
  S.ui = {
    mic: el('.an-mic'), gain: el('.an-gain'), gaindb: el('.an-gaindb'),
    record: el('.an-record'), pause: el('.an-pause'), stop: el('.an-stop'), clear: el('.an-clear'), retry: el('.an-retry'),
    db: el('.an-db'), zone: el('.an-zone'), timer: el('.an-timer'), meter: el('.an-meter'),
    dest: el('.an-dest'), target: el('.an-target'), warn: el('.an-warn'),
    player: el('.an-player'), tbox: el('.an-tbox'), transcript: el('.an-transcript'),
    prompt: el('.an-prompt'), summarise: el('.an-summarise'), preview: el('.an-preview'),
    keepbox: el('.an-keepbox'), keep: el('.an-keep'), folder: el('.an-folder'),
    titlebox: el('.an-titlebox'), title: el('.an-title'), redbox: el('.an-redbox'), red: el('.an-red'),
    levels: el('.an-levels'), busy: el('.an-busy'),
    ghost: el('.an-ghost'), add: el('.an-add'), put: el('.an-put'), status: el('.an-status'),
    $item,
  }
  bindModel($item[0]) // the summary model choice, remembered in this browser
  // Every reach for the page goes through the session, so work begun by an
  // earlier bind — a take, a transcription, a summary — finishes on the item
  // that is on screen now. What the recorder sets (stopFn, pauseFn) is kept on
  // the session, where the next bind finds it.
  const ui = new Proxy({}, { get: (_, k) => (k in S.fn ? S.fn[k] : S.ui[k]), set: (_, k, v) => ((S.fn[k] = v), true) })
  const say = text => (ui.status.textContent = S.status = text)
  const canRecord = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
  const titlePattern = command(item.text, 'TITLE')?.arg || '{{page}} Notes' // {{page}} is the page spoken to
  const persist = () => S.draft && voice.saveDraft(item.id, { ...S.draft, title: S.title, titleTouched: S.titleTouched })

  const subject = () => {
    const t = resolveTarget(ui.$item, item)
    return t.source === 'subject' ? t : null
  }

  // While the farm works, the line under the meter says so — with a running
  // count, because a Pi can take most of a minute — in place of a microphone
  // level that stopped meaning anything when the take ended.
  const working = what => {
    clearInterval(S.workTick)
    S.work = what ? { what, since: S.work?.since ?? Date.now() } : null // one count across queued → transcribing
    if (what) S.workTick = setInterval(() => (S.work ? paintWork() : clearInterval(S.workTick)), 1000)
    paintWork()
  }
  const paintWork = () => {
    const busy = !!S.work && !S.recording
    ui.levels.style.display = busy ? 'none' : ''
    ui.busy.style.display = busy ? '' : 'none'
    if (busy) ui.busy.textContent = `⏳ ${S.work.what}… ${Math.round((Date.now() - S.work.since) / 1000)}s`
  }

  // ---- everything on screen, from the session ----
  const paint = () => {
    paintWork()
    const d = S.draft
    const t = subject()
    const why = t ? voice.cannotSave(t.$page) : null
    const notOwner = voice.ownerHere() === false
    ui.target.innerHTML = t ? wiki.resolveLinks(`[[${t.title}]]`) : '<em>no page to the left — the result opens as a ghost page</em>'
    ui.warn.style.display = notOwner || why ? '' : 'none'
    ui.warn.textContent = notOwner
      ? `log in to ${location.host} as its owner — the farm transcribes only for the owner`
      : why ? `${why}. A ghost page still works.` : ''
    ui.dest.style.borderColor = t && !why ? '#1a7f37' : '#9ab'
    ui.dest.style.background = t && !why ? '#eef9f0' : '#eef4ff'

    ui.record.disabled = S.recording || !canRecord
    ui.stop.disabled = ui.pause.disabled = !S.recording
    ui.pause.textContent = S.paused ? '▶ Resume' : '❚❚ Pause'
    ui.record.style.background = S.recording ? (S.paused ? '#d68910' : '#c0392b') : ''
    ui.record.style.color = S.recording ? 'white' : ''
    ui.clear.disabled = !d
    // A recording the farm has not heard — refused, dropped, or restored without its text — can be sent again.
    ui.retry.style.display = d?.blob && !d?.transcript && !S.work && !S.recording ? '' : 'none'

    if (d?.blob) {
      S.blobUrl ||= URL.createObjectURL(d.blob)
      if (ui.player.getAttribute('src') !== S.blobUrl) ui.player.src = S.blobUrl
    }
    ui.player.style.display = d?.blob ? '' : 'none'
    ui.tbox.style.display = d?.transcript ? '' : 'none'
    ui.transcript.textContent = d?.transcript ? d.transcript.text || '(nothing was heard)' : ''
    ui.summarise.disabled = !d?.transcript?.text || S.summarising
    const summarised = d?.summaryText !== undefined
    // The title — and the red links to choose it from — are there from the start:
    // choosing the question first, then speaking to it, is the natural order.
    ui.preview.style.display = ui.keepbox.style.display = summarised ? '' : 'none'
    if (summarised && document.activeElement !== ui.preview && ui.preview.value !== d.summaryText) ui.preview.value = d.summaryText
    ui.keep.checked = !!d?.keep
    ui.keep.disabled = !!d?.kept
    if (document.activeElement !== ui.folder) ui.folder.value = d?.folder || (t ? t.slug : 'voice')
    // Named to be kept: after the page spoken to, until the author names it themselves.
    if (!S.titleTouched) S.title = titlePattern.replace('{{page}}', t ? t.title : 'Voice').trim()
    if (document.activeElement !== ui.title) ui.title.value = S.title
    ui.ghost.disabled = ui.add.disabled = ui.put.disabled = !summarised || S.saving

    ui.redbox.style.display = S.red.length ? '' : 'none'
    const options = ['<option value="">choose…</option>', ...S.red.map(r => `<option${r === S.title ? ' selected' : ''}>${esc(r)}</option>`)].join('')
    if (ui.red.dataset.for !== options) {
      ui.red.innerHTML = options
      ui.red.dataset.for = options
    }
    if (S.status) ui.status.textContent = S.status
    findRed(t)
  }

  // The subject's red links, looked up once per subject (and again after a save).
  const findRed = t => {
    const key = t ? `${voice.siteOf(t.$page)}/${t.slug}` : ''
    if (S.redFor === key) return S.redReady === key && waitingFor(S.red) && paint()
    S.redFor = key
    S.red = []
    if (!t) return
    voice.redLinks(t.$page).then(red => {
      if (S.redFor !== key) return
      S.red = red
      S.redReady = key
      waitingFor(red)
      paint()
    })
  }

  // The Plan Tool's Answer (wiki-plugin-plan) leaves a question in sessionStorage: if it is
  // one of the red links, choose it as the page it is waiting for, as the select would; drop the key either way.
  const waitingFor = red => {
    let want = null
    try {
      want = sessionStorage.getItem('audionote.waitingFor')
      sessionStorage.removeItem('audionote.waitingFor')
    } catch {}
    const hit = want && red.find(r => slugify(r) === slugify(want))
    if (!hit) return false
    Object.assign(S, { title: hit, titleTouched: true })
    persistSoon()
    return true
  }

  wireMicSelect(ui.mic, text => (ui.status.textContent = text))
  ui.gain.value = storedGainDb()
  ui.gaindb.textContent = ui.gain.value
  ui.gain.oninput = () => {
    ui.gaindb.textContent = ui.gain.value
    localStorage.setItem(GAIN_KEY, ui.gain.value)
  }
  if (!canRecord) {
    ui.record.title = 'the browser allows the microphone only over https — use "record or choose a file"'
    ui.mic.style.display = 'none'
  }

  let saveSoon = null
  const persistSoon = () => {
    clearTimeout(saveSoon)
    saveSoon = setTimeout(persist, 600)
  }
  ui.title.oninput = () => {
    S.title = ui.title.value
    S.titleTouched = true
    persistSoon()
  }
  ui.red.onchange = () => {
    if (!ui.red.value) return
    S.title = ui.red.value
    S.titleTouched = true
    persistSoon()
    paint()
  }
  ui.preview.oninput = () => {
    if (S.draft) S.draft.summaryText = ui.preview.value
    persistSoon()
  }
  ui.keep.onchange = () => {
    if (S.draft) S.draft.keep = ui.keep.checked
    persistSoon()
  }
  ui.folder.oninput = () => {
    if (S.draft) S.draft.folder = ui.folder.value
    persistSoon()
  }

  paint()
  ui.$item.on('mouseenter', paint) // the lineup settles, and changes, after bind

  // A reload: the session is new, the draft is in the browser's store.
  if (!S.loaded) {
    S.loaded = true
    voice.loadDraft(item.id).then(found => {
      if (!found?.blob || S.draft) return
      const { title, titleTouched, savedAt, ...draft } = found
      S.draft = draft
      if (titleTouched) Object.assign(S, { title, titleTouched })
      const when = new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      say(draft.transcript ? `picked up your unsaved recording from ${when} — nothing was lost` : `picked up your recording from ${when} — it has no transcript yet, press ↻ Transcribe`)
      paint()
    })
  }

  // prompts: this site first, then the prompt wiki — found once per session
  const chosenPrompt = promptPicker(() => ui.prompt, item, S)

  const guard = fn => async (...args) => {
    try {
      await fn(...args)
    } catch (err) {
      say('error: ' + err.message)
      paint()
    }
  }

  // Back to the beginning. Nothing was stored, so there is nothing to delete —
  // unless the audio was deliberately kept, and then it stays where it was put.
  const startOver = () => {
    const kept = S.draft?.kept
    if (S.blobUrl) URL.revokeObjectURL(S.blobUrl)
    ui.player.removeAttribute('src')
    ui.preview.value = ''
    Object.assign(S, { draft: null, blobUrl: null, $ghost: null, titleTouched: false })
    working(null)
    voice.clearDraft(item.id)
    say(kept ? `cleared — the audio you kept is still in assets/${kept.folder}` : 'cleared — speak, or drop a recording')
    paint()
  }
  ui.clear.onclick = startOver

  // The farm hears a draft's recording. Kept apart from taking the recording so
  // a draft that still has its audio but no transcript — the farm refused, the
  // network dropped, or a reload found the recording kept and the text not — can
  // be transcribed again without being recorded again.
  const transcribeDraft = async draft => {
    say('transcribing…')
    working('looking for a local door')
    paint()
    // A farm on this machine hears the recording when there is one (voice.js localDoor);
    // otherwise the farm serving the page does, as before.
    const door = await voice.localDoor(item.text)
    const where = job =>
      door ? (job?.engine === 'macwhisper' ? 'this Mac, with MacWhisper' : `this machine${job?.host ? ` (${job.host})` : ''}`) : 'the farm'
    working(`sending the recording to ${door ? 'this machine' : 'the farm'}`)
    let transcript
    try {
      transcript = await voice.hearBlob(
        draft.blob,
        draft.type,
        job => {
          const what = job.state === 'queued' ? `transcription queued${job.ahead ? ` behind ${job.ahead}` : ''}` : `transcribing on ${where(job)}`
          if (S.draft === draft && S.work?.what !== what) working(what)
          say(`${what}…`)
        },
        door,
      )
    } finally {
      if (S.draft === draft || !S.draft) working(null)
    }
    if (S.draft !== draft) return // cleared, or replaced, while the farm worked
    draft.transcript = transcript
    persist()
    ui.tbox.open = true
    say(`transcribed ${Math.round(transcript.duration || 0)}s in ${transcript.elapsed ?? '?'}s on ${where(transcript)} — choose a prompt and summarise`)
    paint()
  }
  ui.retry.onclick = guard(async () => {
    if (S.draft?.blob && !S.recording) await transcribeDraft(S.draft)
  })

  // one recording, from the microphone or a file, through to a transcript
  const hear = async (blob, type, name) => {
    if (S.draft) startOver()
    const draft = (S.draft = { blob, type, name })
    persist() // the recording is safe before the farm is even asked
    await transcribeDraft(draft)
  }

  ui.record.onclick = guard(async () => {
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints())
    await fillMicSelect(ui.mic)
    Object.assign(S, { recording: true, paused: false })
    say('listening — Pause to gather your thoughts, Stop when you have finished')
    paint()
    let take
    try {
      take = await recordStream(stream, ui, { maxSeconds: 1800, label: 'microphone', gainDb: +ui.gain.value })
    } finally {
      Object.assign(S, { recording: false, paused: false })
      paint()
    }
    await hear(take.blob, take.mime.split(';')[0], timestampName('voice', extFor(take.mime)))
  })
  ui.stop.onclick = () => ui.stopFn?.()
  ui.pause.onclick = () => {
    S.paused = !!ui.pauseFn?.()
    say(S.paused ? 'paused — Resume to carry on in the same recording' : 'listening…')
    paint()
  }

  const hearFile = file => {
    const clean = file.name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-120) || 'recording'
    const stamp = timestampName('x', 'x').replace(/--x\.x$/, '')
    return guard(hear)(file, file.type || 'application/octet-stream', `${stamp}--${clean}`)
  }
  const fileInput = el('.an-file')
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (file) hearFile(file)
  })
  const box = el('.an-voice')
  box.addEventListener('dragover', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault()
    box.style.outline = '3px dashed #1a7f37'
  })
  box.addEventListener('dragleave', () => (box.style.outline = ''))
  box.addEventListener('drop', e => {
    const file = [...(e.dataTransfer?.files || [])].find(f => /^audio\/|^video\//.test(f.type) || /\.(m4a|mp3|wav|webm|ogg|opus|aiff?|mp4|mov)$/i.test(f.name))
    if (!file) return
    e.preventDefault()
    e.stopPropagation()
    box.style.outline = ''
    hearFile(file)
  })

  ui.summarise.onclick = guard(async () => {
    const draft = S.draft
    if (!draft?.transcript) return
    const p = chosenPrompt()
    const t = subject()
    S.summarising = true
    say(`summarising${p ? ` with ${p.title}` : ''}…`)
    working(`summarising${p ? ` with ${p.title}` : ''}`)
    paint()
    try {
      const model = ui.summarise.closest('.item')?.querySelector('.an-model')?.value || ''
      const out = await timed(ui.summarise.closest('.item'), () =>
        summaryFor({ transcript: draft.transcript.text, $page: t?.$page, prompt: p, title: S.title, model }),
      )
      if (S.draft !== draft) return
      draft.summary = { model: out.model, promptTitle: p?.title, promptFrom: p && !p.local ? p.from : '', section: p?.section || '' } // where the prompt was read from, to fork in on save
      draft.summaryText = out.markdown
      ui.preview.value = out.markdown
      persist()
      const fell = out.fellBackFrom ? ` (${out.fellBackFrom} could not be reached)` : ''
      say(`summary by ${out.model}${fell} — edit it, name the page, then open or save it`)
    } finally {
      S.summarising = false
      working(null)
      paint()
    }
  })

  // The deliberate act: only a ticked box puts the recording on the site.
  const keepIfAsked = async () => {
    const d = S.draft
    if (!d.keep || d.kept) return d.kept || null
    const folder = (d.folder || ui.folder.value).trim().replace(/^\/+|\/+$/g, '')
    say(`uploading the recording to assets/${folder}…`)
    const stored = await voice.putAsset(folder, d.name, d.blob, d.type)
    const txtName = d.name.replace(/\.[^.]+$/, '') + '.txt'
    const txt = await voice.putAsset(folder, txtName, new Blob([d.transcript.text + '\n'], { type: 'text/plain' }), 'text/plain')
    d.kept = { folder, src: stored.src, transcriptTxt: txt.src } // kept is kept; "Start over" begins a new one
    persist()
    return d.kept
  }
  const items = kept =>
    voice.spokenItems({
      markdown: S.draft.summaryText,
      transcript: S.draft.transcript.text,
      title: S.title.trim().replace(/\s+/g, ' '),
      subjectTitle: subject()?.title || '',
      promptTitle: S.draft.summary?.promptTitle || '',
      kept,
    })

  const showGhost = async () => {
    const title = S.title.trim().replace(/\s+/g, ' ')
    if (!title) throw new Error('give the page a title')
    const kept = await keepIfAsked()
    S.$ghost = voice.openGhost(ownPage(ui.$item), title, items(kept))
    return { title, kept }
  }
  const ghostIsOpen = () => S.$ghost && S.$ghost.hasClass('ghost') && document.contains(S.$ghost[0])

  ui.ghost.onclick = guard(async () => {
    if (S.draft?.summaryText === undefined) return
    const { title, kept } = await showGhost()
    say(`opened “${title}” — drag items from it, rename it on the page, or save it${kept ? '' : '; the recording was not kept'}`)
    paint()
  })

  // Into the page itself: a prompt with a SECTION says where its result belongs
  // (Describe This Card fills the card page's Description); without one, the
  // notes go before the page's See section.
  ui.put.onclick = guard(async () => {
    if (S.draft?.summaryText === undefined) return
    const t = subject()
    const why = t ? voice.cannotSave(t.$page) : 'there is no page to the left to add to'
    if (why) throw new Error(why)
    const section = S.draft.summary?.section || ''
    S.saving = true
    paint()
    try {
      const done = await voice.addToPage(t.$page, S.draft.summaryText, { section })
      say(
        done.how === 'replaced'
          ? `filled the ${section} template on ${t.title}`
          : done.how === 'section'
            ? `added ${done.count} item${done.count === 1 ? '' : 's'} at the end of ${section} on ${t.title}`
            : `added ${done.count} item${done.count === 1 ? '' : 's'} to ${t.title}${section ? ` (no ${section} heading there)` : ''}`,
      )
    } finally {
      S.saving = false
    }
  })

  // A link, not a copy: the notes become a page of their own, named by the
  // author — best of all, named by a red link the page to the left already
  // carries, which then turns blue. Otherwise that page gains one [[link]].
  ui.add.onclick = guard(async () => {
    if (S.draft?.summaryText === undefined) return
    if (voice.ownerHere() === false) throw new Error(`log in to ${location.host} as its owner to save a page here`)
    if (!ghostIsOpen()) await showGhost()
    const title = voice.ghostTitle(S.$ghost) // the author may have renamed it on the ghost itself
    if (await voice.pageExists(title)) {
      throw new Error(`“${title}” already exists here — change the title (name the question, say) and save again`)
    }
    S.saving = true
    say(`saving “${title}”…`)
    paint()
    try {
      await voice.saveGhost(S.$ghost, S.draft.summary?.promptFrom || '')
      const link = `[[${title}]]`
      const t = subject()
      const awaited = t && voice.linksTo(t.$page, title)
      const linked = t && !awaited && !voice.cannotSave(t.$page)
      if (linked) await voice.addLink(t.$page, title, `spoken ${new Date().toISOString().slice(0, 10)}`)
      let copied = false
      try {
        await navigator.clipboard.writeText(link)
        copied = true
      } catch {}
      S.draft.savedAs = title
      S.titleTouched = false
      S.redFor = null // look again: one red link fewer
      persist()
      say(
        `saved “${title}”` +
          (awaited ? ` — the link on ${t.title} now leads to it` : linked ? ` and linked it from ${t.title} — drag the link beside its question` : '') +
          (copied ? `; ${link} is on the clipboard` : '') +
          '. Your recording is still here: name another page, or Start over.',
      )
    } finally {
      S.saving = false
      paint()
    }
  })

  ui.$item.on('dblclick', e => {
    if ($(e.target).closest('button, select, audio, canvas, textarea, details, input, label').length) return
    wiki.textEditor($item, item)
  })
}

// ---------- the clip item (CLIP) ----------
//
// One span of a long recording, on a page broken out of it — a dream from a
// dream circle, an offer from an offers round. The bar is the whole recording;
// the shaded part is the clip, with its in and out marked. "Clip" plays in to
// out and stops there (enforced here, not left to the browser's #t= handling);
// "In context" starts a little earlier and runs on. The owner can nudge either
// edge by a second, which rewrites IN / OUT in the item. See clip.js.

const isClip = item => clip.isClipText(item.text)

const clipHtml = item => {
  const c = clip.parseClip(item.text)
  if (!c.ok) return `<div class="an-clip" style="background:#eee; padding:10px; border-radius:6px; font-size:.9em;">CLIP needs an AUDIO address with IN and OUT times.</div>`
  const who = [c.speaker, `${clip.fmt(c.in)}–${clip.fmt(c.out)}`, clip.fmt(c.out - c.in)].filter(Boolean).map(esc).join(' · ')
  return `
  <div class="an-clip" style="background-color:#eee; padding:10px 12px; border-radius:6px;">
    <audio class="an-player" preload="metadata" src="${esc(c.src)}"></audio>
    <div style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
      <button class="an-clip-play" title="Play the clip, in to out">▶ Clip</button>
      <button class="an-clip-context" title="Start ${clip.CONTEXT} seconds earlier and carry on past the out point">▶ In context</button>
      <span class="an-clip-who" style="font-size:.85em; color:#333; overflow:hidden; text-overflow:ellipsis;">${who}</span>
    </div>
    <div class="an-clip-bar" title="The whole recording; the shaded part is this clip" style="position:relative; height:14px; margin:14px 0 16px; background:#fff; border:1px solid #ccc; border-radius:3px; cursor:pointer;">
      <div class="an-clip-region" style="position:absolute; top:0; bottom:0; left:0; width:0; background:#e6a23c; opacity:.75;"></div>
      <div class="an-clip-head" style="position:absolute; top:-3px; bottom:-3px; width:2px; left:0; background:#c0392b;"></div>
      <span class="an-clip-in" style="position:absolute; top:-13px; font-size:.65em; color:#555; transform:translateX(-100%); padding-right:2px;">${esc(clip.fmt(c.in))}</span>
      <span class="an-clip-out" style="position:absolute; top:-13px; font-size:.65em; color:#555; padding-left:2px;">${esc(clip.fmt(c.out))}</span>
      <span class="an-clip-total" style="position:absolute; right:0; bottom:-14px; font-size:.65em; color:#888;"></span>
      <span class="an-clip-now" style="position:absolute; left:0; bottom:-14px; font-size:.65em; color:#888;"></span>
    </div>
    <div class="an-clip-caption" style="font-size:.85em;"></div>
    <div class="an-clip-nudge" style="display:none; margin-top:6px; font-size:.75em; color:#555; white-space:nowrap;">
      in <button data-edge="in" data-by="-1">−1s</button><button data-edge="in" data-by="1">+1s</button>
      &nbsp; out <button data-edge="out" data-by="-1">−1s</button><button data-edge="out" data-by="1">+1s</button>
      <span class="an-status" style="margin-left:6px;"></span>
    </div>
  </div>`
}

function bindClip($item, item) {
  let c = clip.parseClip(item.text)
  const el = sel => $item.find(sel)[0]
  $item.on('dblclick', e => {
    if ($(e.target).closest('button, audio, .an-clip-bar').length) return
    wiki.textEditor($item, item)
  })
  if (!c.ok) return
  const audio = el('.an-player')
  let mode = null // 'clip' stops at OUT; 'context' runs on
  const cap = [c.caption, c.source ? `From [[${c.source}]]` : ''].filter(Boolean).join(' — ')
  el('.an-clip-caption').innerHTML = cap ? wiki.resolveLinks(cap) : ''

  const paint = () => {
    const d = audio.duration || 0
    const r = clip.region(c, d)
    const reg = el('.an-clip-region')
    reg.style.left = `${r.left}%`
    reg.style.width = `${r.width}%`
    el('.an-clip-in').style.left = `${r.left}%`
    el('.an-clip-out').style.left = `${r.left + r.width}%`
    el('.an-clip-total').textContent = d ? clip.fmt(d) : ''
    el('.an-clip-head').style.left = d ? `${Math.min(100, (audio.currentTime / d) * 100)}%` : '0%'
    el('.an-clip-now').textContent = audio.currentTime ? clip.fmt(audio.currentTime) : ''
    el('.an-clip-who').textContent = [c.speaker, `${clip.fmt(c.in)}–${clip.fmt(c.out)}`, clip.fmt(c.out - c.in)].filter(Boolean).join(' · ')
    el('.an-clip-play').textContent = mode === 'clip' && !audio.paused ? '❚❚ Clip' : '▶ Clip'
    el('.an-clip-context').textContent = mode === 'context' && !audio.paused ? '❚❚ In context' : '▶ In context'
  }
  const start = (m, from) => {
    if (mode === m && !audio.paused) return audio.pause()
    mode = m
    const go = () => { audio.currentTime = from; audio.play().catch(() => {}) }
    if (audio.readyState >= 1) go()
    else { audio.addEventListener('loadedmetadata', go, { once: true }); audio.load() }
  }
  audio.addEventListener('loadedmetadata', () => { if (!audio.currentTime) audio.currentTime = c.in; paint() })
  audio.addEventListener('timeupdate', () => {
    if (mode === 'clip' && audio.currentTime >= c.out) { audio.pause(); audio.currentTime = c.out; mode = null }
    paint()
  })
  for (const ev of ['play', 'pause', 'ended', 'seeked']) audio.addEventListener(ev, paint)
  $(el('.an-clip-play')).on('click', () => start('clip', c.in))
  $(el('.an-clip-context')).on('click', () => start('context', Math.max(0, c.in - clip.CONTEXT)))
  $(el('.an-clip-bar')).on('click', e => {
    if (!audio.duration) return
    const box = el('.an-clip-bar').getBoundingClientRect()
    mode = 'context'
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * audio.duration
  })

  // the owner corrects an edge by ear; each nudge is one edit to the item
  if (voice.ownerHere() !== false) el('.an-clip-nudge').style.display = ''
  $item.find('.an-clip-nudge button').on('click', async e => {
    const by = parseFloat(e.target.dataset.by)
    const edge = e.target.dataset.edge
    item.text = clip.setTimes(item.text, edge === 'in' ? c.in + by : c.in, edge === 'out' ? c.out + by : c.out)
    c = clip.parseClip(item.text)
    paint()
    el('.an-status').textContent = 'saving…'
    try {
      await putAndWait(ownPage($item), { item, id: item.id, type: 'edit' })
      el('.an-status').textContent = `${edge} ${clip.fmt(edge === 'in' ? c.in : c.out)} saved`
    } catch {
      el('.an-status').textContent = 'not saved — log in as the owner'
    }
    if (edge === 'in') start('clip', c.in)
    else start('clip', Math.max(c.in, c.out - 3))
  })
  paint()
}

// ---------- the transcript item (TRANSCRIPT) ----------
//
// A recording that was transcribed elsewhere — a voice note forwarded to
// Marvin, paged by the Pi5's drop service — arrives as one item:
//
//   TRANSCRIPT
//   AUDIO: http://anarchive.local/assets/<slug>/<slug>.mp3
//   <the transcript>
//
// The transcript lives in the item's own text, so the wiki's search finds its
// words and a fork carries them. The item plays the recording, shows the
// transcript, and offers what the Voice Tool offers after transcribing: a
// prompt, a summary to read and edit, then a ghost page to drag from or the
// summary added to this page beneath the transcript. Its subject is the page it
// sits on. Nothing is written without the owner's click.

const TX_COMMANDS = new Set(['TRANSCRIPT', 'AUDIO', 'PROMPT', 'PROMPTS', 'KINDS', 'TITLE', 'DOOR'])
const isTranscript = item => !isVoiceTool(item) && !!command(item.text, 'TRANSCRIPT')

// Everything after the leading command lines is the transcript, verbatim — a
// spoken "YES." on a line of its own must not be read as a command.
function transcriptOf(text) {
  const lines = String(text || '').split('\n')
  let i = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    const m = t.match(/^([A-Z][A-Z0-9_]+)(:|$)/)
    if (!(t === '' || (m && TX_COMMANDS.has(m[1])))) break
  }
  return lines.slice(i).join('\n').trim()
}

const transcriptHtml = item => {
  const audio = command(item.text, 'AUDIO')?.arg
  return `
  <div class="an-tx" style="background-color:#eee; padding:12px; border-radius:6px;">
    ${audio ? `<audio class="an-player" controls preload="none" src="${esc(audio)}" style="width:100%;"></audio>` : ''}
    <div class="an-hear" style="margin-top:6px; font-size:.9em; display:none;">
      <button class="an-transcribe" title="Hear the recording — on this Mac when it has a farm, else on the farm — and keep the transcript in this item">Transcribe</button>
    </div>
    <details class="an-tbox" open style="margin-top:6px;">
      <summary style="cursor:pointer; font-size:.9em;">Transcript <span class="an-words" style="color:#666;"></span></summary>
      <div class="an-transcript" style="font-size:.85em; background:#fff; padding:6px 8px; border-radius:4px; max-height:16em; overflow:auto; white-space:pre-wrap;"></div>
    </details>
    <div style="margin-top:8px; font-size:.9em; white-space:nowrap; overflow:hidden;">
      Prompt <select class="an-prompt" style="max-width:62%;"><option>finding prompts…</option></select>
      <button class="an-summarise">Summarise</button>
    </div>
    ${modelRowHtml()}
    <div class="an-warn" style="display:none; color:#c0392b; font-size:.9em; margin-top:6px;"></div>
    <textarea class="an-preview" rows="9" placeholder="The summary appears here to read and edit."
      style="width:100%; box-sizing:border-box; margin-top:6px; font-size:.85em; display:none;"></textarea>
    <div class="an-actions" style="margin-top:6px; display:none;">
      <button class="an-ghost" title="Open the summary as a ghost page beside this one — drag items from it, or save it">Open as ghost page</button>
      <button class="an-add" title="Add the summary to this page, beneath the transcript">Add to this page</button>
    </div>
    <div class="an-status" style="font-size:.8em; color:#555; margin-top:4px; min-height:1.3em;">choose a prompt, then summarise the transcript</div>
  </div>`
}

function bindTranscript($item, item) {
  const S = sessionFor(`tx:${item.id}`)
  S.$item = $item
  const el = sel => S.$item.find(sel)[0] // the item now on screen, after any re-render
  let transcript = transcriptOf(item.text)
  const $page = () => ownPage(S.$item)
  const say = text => ((S.status = text), (el('.an-status').textContent = text))
  const persist = () => voice.saveDraft(`tx:${item.id}`, { summaryText: S.summaryText, promptTitle: S.promptTitle || '', promptSection: S.promptSection || '' })

  const paint = () => {
    const words = transcript ? transcript.split(/\s+/).length : 0
    el('.an-words').textContent = words ? `· ${words} words` : ''
    el('.an-transcript').textContent = transcript || (command(item.text, 'AUDIO') ? '(not transcribed yet — press Transcribe)' : '(nothing was heard)')
    const notOwner = voice.ownerHere() === false
    const warn = el('.an-warn')
    warn.style.display = notOwner ? '' : 'none'
    warn.textContent = notOwner ? `log in to ${location.host} as its owner — the farm summarises only for the owner` : ''
    el('.an-summarise').disabled = !transcript || S.summarising || notOwner
    // not heard yet (a drop or a webhook paged the audio only): offer Transcribe
    const audio = command(item.text, 'AUDIO')?.arg
    el('.an-hear').style.display = !transcript && audio ? '' : 'none'
    el('.an-transcribe').disabled = S.hearing || notOwner
    const has = S.summaryText !== undefined
    const preview = el('.an-preview')
    preview.style.display = el('.an-actions').style.display = has ? '' : 'none'
    if (has && document.activeElement !== preview && preview.value !== S.summaryText) preview.value = S.summaryText
    el('.an-ghost').disabled = el('.an-add').disabled = !has || S.saving
    if (S.status) el('.an-status').textContent = S.status
  }

  const chosenPrompt = promptPicker(() => el('.an-prompt'), item, S)
  const chosenModel = bindModel(S.$item[0])
  const guard = fn => async () => {
    try {
      await fn()
    } catch (err) {
      say('error: ' + err.message)
    } finally {
      paint()
    }
  }

  el('.an-summarise').onclick = guard(async () => {
    const p = chosenPrompt()
    S.summarising = true
    say(`summarising${p ? ` with ${p.title}` : ''} on the farm…`)
    paint()
    try {
      const out = await timed(S.$item[0], () => summaryFor({ transcript, $page: $page(), prompt: p, model: chosenModel() }))
      S.summaryText = out.markdown
      S.promptTitle = p?.title || ''
      S.promptSection = p?.section || ''
      persist()
      const fell = out.fellBackFrom ? ` (${out.fellBackFrom} could not be reached)` : ''
      say(`summary by ${out.model}${fell} — edit it, then open it as a ghost page or add it here`)
    } finally {
      S.summarising = false
    }
  })

  // Transcribe: the same hear door as the Voice Tool (voice.js localDoor →
  // hearBlob); the transcript is written into this item as a journal edit, so
  // search finds it, forks carry it, and Summarise works from it.
  el('.an-transcribe').onclick = guard(async () => {
    const why = voice.cannotSave($page())
    if (why) throw new Error(why)
    const audio = command(item.text, 'AUDIO')?.arg
    S.hearing = true
    say('fetching the recording…')
    paint()
    try {
      const res = await fetch(audio)
      if (!res.ok) throw new Error(`the recording did not load (${res.status})`)
      const blob = await res.blob()
      say('looking for a local door…')
      const door = await voice.localDoor(item.text)
      const where = job =>
        door ? (job?.engine === 'macwhisper' ? 'this Mac, with MacWhisper' : `this machine${job?.host ? ` (${job.host})` : ''}`) : 'the farm'
      const heard = await voice.hearBlob(
        blob,
        blob.type || 'audio/mpeg',
        job => say(job.state === 'queued' ? `transcription queued${job.ahead ? ` behind ${job.ahead}` : ''}…` : `transcribing on ${where(job)}…`),
        door,
      )
      const text = (heard.text || '').trim()
      const head = String(item.text || '').split('\n').filter(l => {
        const m = l.trim().match(/^([A-Z][A-Z0-9_]+)(:|$)/)
        return m && TX_COMMANDS.has(m[1])
      })
      say(`transcribed ${Math.round(heard.duration || 0)}s on ${where(heard)} — saving`)
      await voice.replaceText($page(), item.id, [...head, text || '(nothing was heard)'].join('\n'))
    } finally {
      S.hearing = false
    }
  })

  el('.an-preview').oninput = () => {
    S.summaryText = el('.an-preview').value
    clearTimeout(S.saveSoon)
    S.saveSoon = setTimeout(persist, 600)
  }

  el('.an-ghost').onclick = guard(async () => {
    const page = pageTitle($page())
    const title = (command(item.text, 'TITLE')?.arg || '{{page}} Notes').replace('{{page}}', page).trim()
    const items = voice.spokenItems({ markdown: S.summaryText, transcript: '', title, subjectTitle: page, promptTitle: S.promptTitle })
    voice.openGhost($page(), title, items)
    say(`opened “${title}” — drag items from it, rename it on the page, or save it`)
  })

  el('.an-add').onclick = guard(async () => {
    const why = voice.cannotSave($page())
    if (why) throw new Error(why)
    if (!voice.splitMarkdown(S.summaryText).length) throw new Error('the summary is empty')
    S.saving = true
    paint()
    try {
      // a prompt's SECTION places it; otherwise beneath the transcript, as ever
      const section = S.promptSection || ''
      const done = await voice.addToPage($page(), S.summaryText, { section, fallbackAfter: item.id })
      say(
        done.how === 'replaced'
          ? `filled the ${section} template`
          : `added ${done.count} item${done.count === 1 ? '' : 's'} ${done.how === 'section' ? `at the end of ${section}` : 'beneath the transcript'}`,
      )
    } finally {
      S.saving = false
    }
  })

  paint()
  S.$item.on('mouseenter', paint) // the login state can change after bind

  // A reload: the session is new, the draft is in the browser's store.
  if (!S.loaded) {
    S.loaded = true
    voice.loadDraft(`tx:${item.id}`).then(found => {
      if (!found || S.summaryText !== undefined || found.summaryText === undefined) return
      S.summaryText = found.summaryText
      S.promptTitle = found.promptTitle
      S.promptSection = found.promptSection || ''
      say('picked up your unsaved summary')
      paint()
    })
  }

  S.$item.on('dblclick', e => {
    if ($(e.target).closest('button, select, audio, textarea, details, summary').length) return
    wiki.textEditor(S.$item, item)
  })
}

if (typeof window !== 'undefined') {
  window.plugins['audionote'] = { emit, bind }
}

export const audioNote = typeof window == 'undefined' ? { preferredAudioTypes, timestampName, extFor, levelZone } : undefined
