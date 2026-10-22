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

// The default button of a row (Save page & link it): filled and bold, so it reads first.
const PRIMARY = 'font-weight:bold; background:#2f6fcf; color:#fff; border:1px solid #2559a8; border-radius:4px; padding:2px 10px;'

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
    select.dispatchEvent(new CustomEvent('an-prompts')) // the prompts arrived: the ⚙ chip may now name a prompt's model
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
// "Auto" (0.8.0) lets the farm pick per summary by the question's size — the
// Plan Tool's rule as far as a summary shares it (Auto Model Plan, Phase 5):
// Claude Fable for a question over 48k tokens, the coop's own routing for the
// rest, Claude when the coop is down. The farm's answer carries the pick and
// its reason as `auto`, said on the status line.
const MODELS = [
  ['', 'prompt or farm default'],
  ['auto', 'Auto: the farm picks by size'],
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
    window.dispatchEvent(new CustomEvent('audionote:model', { detail: select.value })) // every tool on the page repaints its chip
  }
  return () => select.value
}

/** Who wrote a summary, for the status line: the model, Auto's pick and reason when the farm chose, and the fallback when the first could not be reached. */
const wroteIt = out => {
  const fell = out.fellBackFrom ? ` (${out.fellBackFrom} could not be reached)` : ''
  const auto = out.auto?.line ? ` — ${out.auto.line}` : ''
  return `${out.model}${fell}${auto}`
}

/** A transcript through a prompt (or the built-in plain summary) on the farm. */
const summaryFor = ({ transcript, $page, prompt, title = '', model = '', research = null }) =>
  voice.summarise({
    ...(research ? { research: research.text, researchAsked: research.asked } : {}),
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

// The Voice Tool's look, once per document: classes rather than inline styles,
// so the next step's button can be marked by a class as the stage moves on.
const VOICE_CSS = `
.an-voice { background:#eee; padding:8px 10px; border-radius:6px; }
.an-voice button { font-size:.88em; padding:1px 7px; }
.an-voice .an-primary { font-weight:bold; background:#2f6fcf; color:#fff; border:1px solid #2559a8; border-radius:4px; }
.an-voice .an-primary:disabled { opacity:.45; }
.an-voice .an-row { display:flex; align-items:center; gap:4px; flex-wrap:wrap; margin-top:5px; font-size:.9em; }
.an-voice .an-head { display:flex; align-items:center; gap:5px; }
.an-voice .an-dest { flex:1; min-width:0; font-size:.9em; padding:2px 7px; border:2px solid #9ab; border-radius:5px; background:#eef4ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.an-voice .an-cog { font-size:1.05em; padding:0 6px; line-height:1.5; }
.an-voice .an-cog.on { background:#555; color:#fff; }
.an-voice .an-settings { margin-top:5px; padding:5px 7px; border:1px solid #ccc; border-radius:4px; background:#f7f7f7; font-size:.85em; }
.an-voice .an-settings > div + div { margin-top:4px; }
.an-voice .an-steps { display:flex; gap:3px; margin-top:6px; font-size:.78em; }
.an-voice .an-step { flex:1; text-align:center; padding:2px 0; border-radius:3px; background:#dcdcdc; color:#777; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.an-voice .an-step.done { background:#d4ecd9; color:#1a7f37; }
.an-voice .an-step.now { background:#2f6fcf; color:#fff; font-weight:bold; }
.an-voice .an-nextrow { display:flex; align-items:baseline; gap:6px; margin-top:3px; }
.an-voice .an-next { flex:1; min-width:0; font-size:.82em; color:#2559a8; }
.an-voice .an-chip { flex:0 1 auto; min-width:0; max-width:48%; font-size:.78em; color:#555; text-decoration:none; border:1px solid #ccc; border-radius:10px; padding:0 7px; background:#f7f7f7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.an-voice .an-chip:hover { background:#eef4ff; border-color:#9ab; }
.an-voice .an-chip.chosen { color:#1d4f9a; border-color:#9ab; }
.an-voice details { margin-top:5px; }
.an-voice details > summary { cursor:pointer; font-size:.88em; }
.an-voice .an-box { font-size:.85em; background:#fff; padding:5px 8px; border-radius:4px; max-height:12em; overflow:auto; }
.an-voice .an-box p { margin:.3em 0; }
.an-voice .an-box ul { margin:.3em 0; padding-left:1.3em; }
.an-voice .an-ask { border:1px solid #c9d6ea; border-radius:4px; background:#f3f7fd; padding:3px 7px; }
.an-voice .an-similar { font-size:.83em; margin-top:5px; max-height:8.5em; overflow:auto; }
.an-voice .an-similar div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.an-voice .an-similar .site { color:#888; font-size:.9em; }
.an-voice .an-took:empty, .an-voice .an-ask-status:empty { display:none; }
.an-voice .an-big { flex:1; font-size:1em; padding:5px 12px; border-radius:6px; border:1px solid #2559a8; }
.an-voice .an-big.an-primary { background:linear-gradient(#3a7ce0, #2a63bd); box-shadow:0 1px 2px rgba(0,0,0,.25); }
.an-voice .an-type.an-big { flex:0 0 auto; background:#fff; color:#2559a8; font-weight:normal; }
.an-voice .an-typebox textarea { width:100%; box-sizing:border-box; font-size:.88em; height:7em; resize:vertical; }
.an-voice .an-foot { margin-top:6px; padding-top:4px; border-top:1px solid #ddd; font-size:.8em; color:#666; }
`
const voiceStyle = () => {
  if (document.getElementById('an-voice-css')) return
  const style = document.createElement('style')
  style.id = 'an-voice-css'
  style.textContent = VOICE_CSS
  document.head.appendChild(style)
}

// The model choice alone, for the Voice Tool's settings; the transcript item keeps modelRowHtml.
const modelSelectHtml = () =>
  `Model <select class="an-model" style="max-width:75%;">${MODELS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`

// The stages a recording goes through, in order, and what to do at each.
const STEPS = [
  ['speak', '① Speak or type'],
  ['transcribe', '② Transcript'],
  ['summarise', '③ Summarise'],
  ['save', '④ Save'],
]

const voiceHtml = item => `
  <div class="an-voice">
    <div class="an-head">
      <div class="an-dest"><strong>Speaking to ▸</strong> <span class="an-target">looking to the left…</span></div>
      <button class="an-cog" title="Settings: microphone, boost and the model that writes">⚙</button>
    </div>
    <div class="an-settings" style="display:none;">
      <div>Microphone <select class="an-mic" style="max-width:75%;"></select></div>
      <div style="white-space:nowrap;">Boost <input type="range" class="an-gain" min="0" max="24" step="1" value="0" style="width:110px; vertical-align:middle;">
        +<span class="an-gaindb" style="display:inline-block; min-width:1.4em;">0</span>&nbsp;dB</div>
      <div>${modelSelectHtml()}</div>
    </div>
    <div class="an-warn" style="display:none; color:#c0392b; font-size:.9em; margin-top:5px;"></div>
    <div class="an-row an-titlebox">
      <span title="The question being answered — it becomes the title of the notes page">Question</span>
      <input type="text" class="an-title" style="flex:1; min-width:9em; font-size:1em;"
        title="The question, and the title of the notes page. Change it for each question to build a series; Enter saves once there are notes.">
      <select class="an-red" style="max-width:8em; font-size:.95em; display:none;" title="Red links on the page to the left: questions it links to that nobody has answered yet. Saving under one turns the link blue."></select>
    </div>
    <details class="an-ask">
      <summary>💬 Ask about this question <span class="an-ask-note" style="color:#666;"></span></summary>
      <div class="an-row">
        <button class="an-ask-more" title="What the question asks, what its terms mean, and why it matters on this page">Tell me more</button>
        <button class="an-ask-research" title="What is known that would inform an answer — with web search when the farm reaches Claude">Research this</button>
        <button class="an-ask-similar" title="Pages on this farm like the question: they may already answer it">⌕ Similar pages</button>
      </div>
      <textarea class="an-ask-own" rows="2" placeholder="Or ask your own question — the question, its page and similar pages go with it (⌘↵ asks)"
        style="width:100%; box-sizing:border-box; margin-top:5px; font-size:.85em; height:3.2em; min-height:2.4em; resize:vertical;"></textarea>
      <div class="an-row" style="margin-top:2px;">
        <button class="an-ask-go">Ask</button>
        <span class="an-ask-status" style="font-size:.85em; color:#555;"></span>
      </div>
      <div class="an-similar"></div>
      <div class="an-box an-ask-answer" style="display:none; margin-top:5px; max-height:16em;"></div>
      <div class="an-row an-ask-actions" style="display:none;">
        <button class="an-ask-use" title="Add this answer to your own words: to what you are typing, to the words waiting to be summarised, or to the end of your notes — whichever you are at">+ Add to my answer</button>
        <button class="an-ask-ghost" title="Open the answer as a ghost page beside the tool — drag from it, or save it">Open as ghost page</button>
        <button class="an-ask-copy">Copy</button>
        <button class="an-ask-clear" title="Forget this answer">✕</button>
      </div>
    </details>
    <div class="an-steps">${STEPS.map(([k, l]) => `<span class="an-step" data-step="${k}">${l}</span>`).join('')}</div>
    <div class="an-nextrow">
      <span class="an-next"></span>
      <a class="an-chip" role="button" tabindex="0" title="The model Summarise asks — click to change it in ⚙ settings"><span aria-hidden="true">⚙</span> <span class="an-chip-name">farm default</span></a>
    </div>
    <div class="an-row an-typebox" style="display:none;">
      <textarea class="an-typed" placeholder="Type your answer to the question. Then Use this text: Summarise it, or use it as written."></textarea>
      <button class="an-typed-done" title="Take this text as the answer — the next step is to summarise it, or use it as written">Use this text</button>
      <button class="an-typed-cancel">Cancel</button>
    </div>
    <div class="an-row">
      <button class="an-record">🎙 Speak</button>
      <button class="an-type" title="Type the answer instead — where speaking is not appropriate">✎ Type instead</button>
      <button class="an-pause" style="display:none;">❚❚ Pause</button>
      <button class="an-stop" style="display:none;">■ Stop</button>
      <button class="an-retry" style="display:none;" title="Transcribe this recording again — its transcript was not kept, or the farm refused it">↻ Transcribe</button>
      <button class="an-clear" style="display:none;" title="Throw away this recording, its transcript and summary, and start again">✕ Start over</button>
    </div>
    <canvas class="an-meter" width="400" height="28" style="width:100%; background:#111; border-radius:4px; margin-top:5px; display:none;"></canvas>
    <div class="an-meterline" style="display:none;">${meterLine}</div>
    <audio class="an-player" controls style="width:100%; height:32px; margin-top:5px; display:none;"></audio>
    <details class="an-tbox" style="display:none;">
      <summary><span class="an-tlabel">Transcript</span> <span class="an-words" style="color:#666;"></span></summary>
      <div class="an-box an-transcript"></div>
    </details>
    <div class="an-row an-sumrow" style="display:none; flex-wrap:nowrap;">
      Prompt <select class="an-prompt" style="flex:1; min-width:0;"><option>finding prompts…</option></select>
      <button class="an-summarise" disabled>Summarise</button>
      <button class="an-aswritten" title="Use the words as they are, without a model: they become the notes, ready to edit and save">✓ Use as written</button>
    </div>
    <label class="an-research" style="display:none; font-size:.82em; margin-top:2px; color:#2a6;" title="Send the answer 💬 Ask gave for this question with the summary, as background: the summary draws on it where your words point to it, and says when a point comes from it rather than from you"><input type="checkbox" class="an-research-use"> Include the research (💬 Ask) when summarising</label>
    <div class="an-took" style="font-size:.8em; color:#666; margin-top:2px;" title="how long the last summary took, from this browser"></div>
    <textarea class="an-preview" rows="6" placeholder="The summary appears here to read and edit."
      style="width:100%; box-sizing:border-box; margin-top:5px; font-size:.85em; height:9em; resize:vertical; display:none;"></textarea>
    <div class="an-keepbox" style="margin-top:3px; font-size:.82em; display:none;"
      title="Unticked, the recording is thrown away and only the text remains.">
      <label><input type="checkbox" class="an-keep"> keep the audio in assets/</label><input type="text" class="an-folder" size="14" style="font-size:1em;" title="The assets folder the recording is stored in">
    </div>
    <div class="an-row an-saverow" style="display:none;">
      <button class="an-back" style="display:none;" title="Send these words back to the Revise Plan page that asked for them, as the direction for the plan's redraft; nothing is saved here">↩ Use as the direction</button>
      <button class="an-add" disabled title="The default: save the notes as a new page of this title, and put a [[link]] to it on the page to the left (and on the clipboard). Enter in the question box presses it.">Save page &amp; link it</button>
      <button class="an-ghost" disabled title="Open the notes as a ghost page under this title — drag items from it, or save it">Open as ghost page</button>
      <button class="an-put" disabled title="Add the notes to the page on the left itself: under the prompt's SECTION heading when it names one (filling an unfilled card template there), otherwise before its See section">Add to this page</button>
    </div>
    <div class="an-status" style="font-size:.8em; color:#555; margin-top:4px; min-height:1.2em;"></div>
    <div class="an-foot">
      <label class="an-pick" style="cursor:pointer; border:1px solid #aaa; border-radius:3px; padding:0 5px; background:#fafafa;"
        title="Record with the phone's own recorder, or choose a recording — works where the browser may not use the microphone (plain http)">
        🎙 record or choose a file<input type="file" class="an-file" accept="audio/*,video/*" capture style="display:none;"></label>
      or drop one on the tool
    </div>
    <p class="an-caption" style="font-style:italic; margin:4px 0 0;">${wiki.resolveLinks(itemCaption(item.text) || '')}</p>
  </div>
`

/** A model's markdown answer as HTML for the tool: paragraphs, bullets, headings, bold, and links resolved by the wiki. */
const answerHtml = markdown => {
  const inline = t =>
    wiki
      .resolveLinks(t)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/
  return String(markdown || '')
    .trim()
    .split(/\n\s*\n/)
    .map(chunk => {
      const lines = chunk.split('\n').filter(l => l.trim())
      const h = chunk.trim().match(/^#{1,6}\s+(.*)$/)
      if (h && lines.length === 1) return `<p><b>${inline(h[1])}</b></p>`
      if (lines.length && bullet.test(lines[0])) {
        const items = []
        for (const l of lines) bullet.test(l) && !/^\s{2,}/.test(l) ? items.push(l.replace(bullet, '')) : items.length ? (items[items.length - 1] += ` ${l.trim().replace(bullet, '— ')}`) : items.push(l)
        return `<ul>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`
    })
    .join('')
}

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
    titlebox: el('.an-titlebox'), title: el('.an-title'), red: el('.an-red'),
    levels: el('.an-levels'), busy: el('.an-busy'), meterline: el('.an-meterline'),
    ghost: el('.an-ghost'), add: el('.an-add'), put: el('.an-put'), back: el('.an-back'), status: el('.an-status'),
    cog: el('.an-cog'), chip: el('.an-chip'), chipName: el('.an-chip-name'), settings: el('.an-settings'), steps: el('.an-steps'), next: el('.an-next'), words: el('.an-words'),
    sumrow: el('.an-sumrow'), saverow: el('.an-saverow'), tlabel: el('.an-tlabel'),
    type: el('.an-type'), typebox: el('.an-typebox'), typed: el('.an-typed'), typedDone: el('.an-typed-done'), typedCancel: el('.an-typed-cancel'), aswritten: el('.an-aswritten'),
    ask: el('.an-ask'), askNote: el('.an-ask-note'), askMore: el('.an-ask-more'), askResearch: el('.an-ask-research'),
    askSimilar: el('.an-ask-similar'), askOwn: el('.an-ask-own'), askGo: el('.an-ask-go'), askStatus: el('.an-ask-status'),
    similar: el('.an-similar'), answer: el('.an-ask-answer'), askActions: el('.an-ask-actions'),
    askGhost: el('.an-ask-ghost'), askCopy: el('.an-ask-copy'), askClear: el('.an-ask-clear'), askUse: el('.an-ask-use'),
    research: el('.an-research'), researchUse: el('.an-research-use'),
    $item,
  }
  voiceStyle()
  const chosenModel = bindModel($item[0]) // the model choice, in the settings, remembered in this browser
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

  // A tool that asked for words back (wiki-plugin-plan 0.15.0's Revise Plan,
  // "Direction for <Plan>") leaves where to send them under audionote.returnTo,
  // beside the question it hands over. While that question is the one chosen,
  // the words go back to it — ↩ Use as the direction — instead of to a page.
  const returnTo = () => {
    try {
      const r = JSON.parse(sessionStorage.getItem('audionote.returnTo') || 'null')
      return r && r.title && r.key && slugify(r.title) === slugify(S.title || '') ? r : null
    } catch {
      return null
    }
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
    // The meter and its line only while there is something to show: a take, or the farm at work.
    ui.meter.style.display = S.recording ? '' : 'none'
    ui.meterline.style.display = S.recording || busy ? '' : 'none'
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

    // Only the buttons that mean something now: Pause and Stop while speaking,
    // Start over once there is something to start over from.
    ui.record.disabled = S.recording || !canRecord
    ui.stop.style.display = ui.pause.style.display = S.recording ? '' : 'none'
    ui.pause.textContent = S.paused ? '▶ Resume' : '❚❚ Pause'
    ui.record.textContent = S.recording ? (S.paused ? '● paused' : '● listening…') : d ? '🎙 Speak again' : '🎙 Speak your answer'
    // Before anything is said, Speak and Type are the two big ways in; after, they step back.
    const opening = !d && !S.recording && !S.typing
    ui.record.classList.toggle('an-big', opening || S.recording)
    ui.type.classList.toggle('an-big', opening)
    ui.type.style.display = S.recording || S.typing ? 'none' : ''
    ui.type.textContent = d ? '✎ Type again' : '✎ Type instead'
    ui.typebox.style.display = S.typing ? 'flex' : 'none'
    ui.record.style.display = S.typing ? 'none' : ''
    if (S.typing && document.activeElement !== ui.typed && ui.typed.value !== (S.typedText || '')) ui.typed.value = S.typedText || ''
    ui.record.style.background = S.recording ? (S.paused ? '#d68910' : '#c0392b') : ''
    ui.record.style.color = S.recording ? 'white' : ''
    ui.clear.style.display = d && !S.recording ? '' : 'none'
    // A recording the farm has not heard — refused, dropped, or restored without its text — can be sent again.
    ui.retry.style.display = d?.blob && !d?.transcript && !S.work && !S.recording ? '' : 'none'

    if (d?.blob) {
      S.blobUrl ||= URL.createObjectURL(d.blob)
      if (ui.player.getAttribute('src') !== S.blobUrl) ui.player.src = S.blobUrl
    }
    ui.player.style.display = d?.blob && !S.recording ? '' : 'none'
    // The transcript arrives folded: the summary is what is read, the transcript is there to check.
    ui.tbox.style.display = d?.transcript ? '' : 'none'
    const heard = d?.transcript ? d.transcript.text || '' : ''
    ui.transcript.textContent = d?.transcript ? heard || '(nothing was heard)' : ''
    ui.words.textContent = heard ? `· ${heard.split(/\s+/).filter(Boolean).length} words` : ''
    ui.tlabel.textContent = (d?.typed ? 'What you typed' : 'Transcript') + (d?.added ? ' + the research you added' : '')
    ui.sumrow.style.display = d?.transcript ? 'flex' : 'none'
    ui.summarise.disabled = !heard || S.summarising
    const summarised = d?.summaryText !== undefined
    ui.preview.style.display = summarised ? '' : 'none'
    ui.keepbox.style.display = summarised && d?.blob ? '' : 'none' // typed words have no audio to keep
    ui.aswritten.disabled = !heard || S.summarising
    ui.saverow.style.display = summarised ? 'flex' : 'none'
    // The research for this question rides along with Summarise, unless unticked (0.12.0).
    const R = askFor()
    ui.research.style.display = d?.transcript && R.answer && !summarised ? '' : 'none'
    ui.researchUse.checked = R.include !== false
    if (summarised && document.activeElement !== ui.preview && ui.preview.value !== d.summaryText) ui.preview.value = d.summaryText
    ui.keep.checked = !!d?.keep
    ui.keep.disabled = !!d?.kept
    if (document.activeElement !== ui.folder) ui.folder.value = d?.folder || (t ? t.slug : 'voice')
    // Named to be kept: after the page spoken to, until the author names it themselves.
    if (!S.titleTouched) S.title = titlePattern.replace('{{page}}', t ? t.title : 'Voice').trim()
    if (document.activeElement !== ui.title) ui.title.value = S.title
    ui.ghost.disabled = ui.add.disabled = ui.put.disabled = !summarised || S.saving
    const back = returnTo()
    ui.back.style.display = back && summarised ? '' : 'none'
    ui.back.textContent = back?.label || '↩ Use as the direction'
    ui.back.disabled = !summarised || S.saving

    ui.red.style.display = S.red.length ? '' : 'none'
    const options = [`<option value="">● ${S.red.length} waiting…</option>`, ...S.red.map(r => `<option>${slugify(r) === slugify(S.title || '') ? '✓ ' : ''}${esc(r)}</option>`)].join('')
    if (ui.red.dataset.for !== options) {
      ui.red.innerHTML = options
      ui.red.dataset.for = options
    }
    if (document.activeElement !== ui.red) ui.red.value = ''
    paintStage()
    paintSettings()
    paintChip()
    paintAsk()
    if (S.status) ui.status.textContent = S.status
    findRed(t)
  }

  // ---- where we are, and the one thing to do next ----
  // The stage is read from the draft: no recording → speak; a recording the
  // farm has not heard → transcript; a transcript → summarise; a summary →
  // save; saved → done. The next step's button is the blue one, and the line
  // beneath the stage bar says it in words.
  const stageOf = () => {
    const d = S.draft
    if (S.recording || !d) return 'speak'
    if (!d.transcript) return 'transcribe'
    if (d.summaryText === undefined) return 'summarise'
    return d.savedAs || d.sentBack ? 'done' : 'save'
  }
  const paintStage = () => {
    const d = S.draft
    const stage = stageOf()
    const at = STEPS.findIndex(([k]) => k === stage)
    ui.steps.querySelectorAll('.an-step').forEach((step, i) => {
      step.classList.toggle('done', stage === 'done' || i < at)
      step.classList.toggle('now', i === at)
    })
    const back = returnTo()
    const primary =
      S.recording ? ui.stop
      : stage === 'speak' ? (canRecord ? ui.record : null)
      : stage === 'transcribe' ? (S.work ? null : ui.retry)
      : stage === 'summarise' ? (S.summarising ? null : d.typed || back ? ui.aswritten : ui.summarise)
      : stage === 'save' ? (back ? ui.back : ui.add)
      : ui.clear
    const typingNow = !!S.typing
    for (const b of [ui.record, ui.stop, ui.retry, ui.summarise, ui.aswritten, ui.add, ui.back, ui.clear, ui.typedDone])
      b.classList.toggle('an-primary', typingNow ? b === ui.typedDone : b === primary)
    ui.next.textContent =
      S.recording ? (S.paused ? 'Paused — ▶ Resume to carry on, or ■ Stop to finish' : 'Listening — ■ Stop when you have finished; ❚❚ Pause to think')
      : S.typing ? 'Type your answer, then Use this text'
      : stage === 'speak' ? (canRecord ? 'Next: speak or type your answer — or 💬 ask about the question first' : 'Next: ✎ type your answer, or 🎙 record or choose a file below — this browser cannot use the microphone here')
      : stage === 'transcribe' ? (S.work ? 'Making the transcript — a moment…' : 'Next: ↻ Transcribe the recording')
      : stage === 'summarise'
        ? S.summarising ? 'Summarising — a moment…'
        : back ? 'Next: ✓ Use as written — the model revising the plan reads your words as they are — or Summarise them first'
        : d.typed ? 'Next: ✓ Use as written — or choose a prompt and Summarise'
        : 'Next: choose a prompt and Summarise — or ✓ Use as written'
      : stage === 'save' ? (back ? `Next: read the words, then ${back.label || '↩ Use as the direction'} — they go to Revise Plan, beside ${back.plan || 'the plan'}` : 'Next: read the notes, then Save page & link it')
      : d.sentBack ? `Sent to Revise Plan as the direction. Next: ✎ Revise there — or 🎙 Speak again to add more`
      : `Saved as “${d.savedAs}”. Next: ✕ Start over, or name another question and save again`
  }

  // The subject's red links, looked up once per subject (and again after a save).
  const findRed = t => {
    const key = t ? `${voice.siteOf(t.$page)}/${t.slug}` : ''
    if (S.redFor === key) {
      if (S.redReady !== key) return
      // A question handed over that the list has not seen: the page may have
      // changed since its red links were read (a Revise saved over the plan
      // and added it), so read them again before choosing.
      const want = handedOver()
      if (want && !S.red.some(r => slugify(r) === slugify(want))) S.redFor = ''
      else return waitingFor(S.red) && paint()
    }
    S.redFor = key
    S.redReady = ''
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

  // The Plan Tool's Answer (wiki-plugin-plan) leaves a question in sessionStorage: choose it as
  // the page it is waiting for, as the select would, and drop the key. The Plan Tool offers Answer
  // only for a question with no page behind it, so the question is chosen even when the red links
  // as read do not list it — it is added to the select — rather than lost under the default title.
  const handedOver = () => {
    try {
      return sessionStorage.getItem('audionote.waitingFor')
    } catch {
      return null
    }
  }
  const waitingFor = red => {
    const want = handedOver()
    try {
      sessionStorage.removeItem('audionote.waitingFor')
    } catch {}
    if (!want) return false
    let hit = red.find(r => slugify(r) === slugify(want))
    if (!hit) {
      hit = want.trim()
      if (red === S.red) S.red = [...S.red, hit]
    }
    switchTo(hit)
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
    ui.mic.parentNode.style.display = 'none'
  }

  // A draft belongs to the question it was spoken for. Choosing another
  // question — the Plan Tool's Answer, or the red-link select — parks the
  // recording, transcript and summary under the question they answer and
  // picks up the new question's own draft, or starts clean. The current draft
  // stays under item.id, so a reload still finds it.
  const parkKey = title => `${item.id}|q:${slugify(title || '')}`
  const park = draft => {
    draft.parkedAs = { title: S.title, titleTouched: S.titleTouched }
    voice.saveDraft(parkKey(S.title), { ...draft, title: S.title, titleTouched: S.titleTouched })
  }
  const switchTo = title => {
    if (slugify(title) === slugify(S.title || '')) return Object.assign(S, { title, titleTouched: true })
    if (S.draft) {
      park(S.draft)
      if (S.blobUrl) URL.revokeObjectURL(S.blobUrl)
      ui.player.removeAttribute('src')
      ui.preview.value = ''
      Object.assign(S, { draft: null, blobUrl: null, $ghost: null })
      working(null)
      voice.clearDraft(item.id) // a reload must not bring the other question's words back
    }
    Object.assign(S, { title, titleTouched: true })
    say(`ready for ${title} — speak, or drop a recording`)
    voice.loadDraft(parkKey(title)).then(found => {
      if (!(found?.blob || found?.transcript) || S.draft || slugify(S.title) !== slugify(title)) return
      const { title: _title, titleTouched: _touched, savedAt, parkedAs: _parked, ...draft } = found
      S.draft = draft
      voice.clearDraft(parkKey(title))
      persist()
      const when = new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      say(`picked up your ${draft.typed ? 'typed answer' : 'recording'} for ${title} from ${when}${draft.transcript ? '' : ' — it has no transcript yet, press ↻ Transcribe'}`)
      paint()
    })
    return true
  }
  // Work that lands after its draft was parked goes to the parked copy.
  const landParked = draft => {
    if (!draft.parkedAs) return
    const { title, titleTouched } = draft.parkedAs
    const { parkedAs: _parked, ...kept } = draft
    voice.saveDraft(parkKey(title), { ...kept, title, titleTouched })
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
    paintAsk() // the Ask panel follows the question
  }
  // Save page & link it is the default: Enter in the title presses it.
  ui.title.onkeydown = e => {
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    if (!ui.add.disabled) ui.add.click()
  }
  ui.red.onchange = () => {
    if (!ui.red.value) return
    switchTo(ui.red.value.replace(/^✓ /, ''))
    ui.red.value = ''
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

  // ---- settings: the microphone, its boost, and the model — out of the way behind ⚙ ----
  const paintSettings = () => {
    ui.settings.style.display = S.settingsOpen ? '' : 'none'
    ui.cog.classList.toggle('on', !!S.settingsOpen)
    const model = MODELS.find(([v]) => v === chosenModel())?.[1] || 'prompt or farm default'
    ui.cog.title = `Settings: microphone, boost and the model that writes (now: ${model})`
  }
  ui.cog.onclick = () => {
    S.settingsOpen = !S.settingsOpen
    paintSettings()
  }

  // ---- the model, named before it is used (0.11.0) ----
  // ⚙ <model> beside the next step: what Summarise will ask — the choice in
  // ⚙ settings, else the chosen prompt's MODEL line, else the farm's default
  // (models.json). It repaints when either choice changes, here, in another
  // Voice Tool on the page, or in another tab.
  const paintChip = () => {
    if (!ui.chip) return
    const prompt = S.prompts?.[+ui.prompt.value] || null
    const show = m => {
      const shown = voice.modelShown({ chosen: chosenModel(), prompt, farm: m })
      ui.chipName.textContent = shown.label
      ui.chip.title = `${shown.title}.`
      ui.chip.classList.toggle('chosen', shown.from !== 'farm')
    }
    show(S.farmModels)
    if (!S.farmModels)
      voice.modelsHere().then(m => {
        if (!m) return
        S.farmModels = m
        show(m)
      })
  }
  const openModel = () => {
    S.settingsOpen = true
    paintSettings()
    $item[0].querySelector('.an-model')?.focus()
  }
  ui.chip.onclick = e => {
    e.preventDefault()
    if (S.settingsOpen && $item[0].querySelector('.an-model') === document.activeElement) {
      S.settingsOpen = false
      return paintSettings()
    }
    openModel()
  }
  ui.chip.onkeydown = e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openModel())
  const modelSelect = $item[0].querySelector('.an-model')
  modelSelect?.addEventListener('change', () => (paintSettings(), paintChip()))
  ui.prompt.addEventListener('change', paintChip)
  ui.prompt.addEventListener('an-prompts', paintChip)
  // Another tool on this page, or another tab, changed the choice: follow it.
  // One pair of listeners per tool: a redraw replaces the last bind's.
  const unfollow = () => {
    window.removeEventListener('audionote:model', S.followModel)
    window.removeEventListener('storage', S.followStorage)
  }
  unfollow()
  S.followModel = () => {
    if (!$item[0].isConnected) return unfollow()
    if (modelSelect) modelSelect.value = MODELS.some(([v]) => v === storedModel()) ? storedModel() : ''
    paintSettings()
    paintChip()
  }
  S.followStorage = e => e.key === MODEL_KEY && S.followModel()
  window.addEventListener('audionote:model', S.followModel)
  window.addEventListener('storage', S.followStorage)

  // ---- asking about the question (0.9.0) ----
  // Questions on a wiki are a line long and lean on terms the page assumes.
  // Before speaking, the author can ask: Tell me more, Research this, or a
  // question of their own. Each goes to the farm's model with the question's
  // context — where the page asks it, the page, what has been said — and the
  // text of the pages the farm's search finds like it, which are listed too, to
  // open beside the tool. Answers belong to their question, as drafts do: kept
  // in the session and in this browser under <item>|ask:<question>.
  const KIND_LABEL = { more: 'Tell me more', research: 'Research this' }
  S.asks ||= {}
  const askKey = () => `${item.id}|ask:${slugify(S.title || '')}`
  const askFor = (key = askKey()) => {
    if (!S.asks[key]) {
      const A = (S.asks[key] = {})
      voice.loadDraft(key).then(found => {
        if (found && A.answer === undefined && !A.similar) {
          const { savedAt: _at, ...kept } = found
          Object.assign(A, kept)
        }
        paintAsk()
      })
    }
    return S.asks[key]
  }
  const keepAsk = (key, A) =>
    voice.saveDraft(key, { answer: A.answer, model: A.model, kind: A.kind, asked: A.asked, web: A.web, similar: A.similar, similarHow: A.similarHow, similarFor: A.similarFor, include: A.include, status: A.answer ? A.status : '' })

  // Every link names its site, this one included: the Voice Tool is a plugin page,
  // and a bare link would be looked for from its context, not the farm's.
  const pageLink = p => {
    const site = p.site || location.host
    return `<a class="internal" href="//${esc(site)}/${esc(p.slug)}.html" data-page-name="${esc(p.slug)}" data-site="${esc(site)}" title="${esc(p.synopsis)}">${esc(p.title)}</a>`
  }
  const paintAsk = () => {
    const A = askFor()
    const notOwner = voice.ownerHere() === false
    for (const b of [ui.askMore, ui.askResearch, ui.askGo]) {
      b.disabled = !!A.busy || notOwner
      b.dataset.tip ||= b.title
      b.title = notOwner ? `log in to ${location.host} as its owner to ask` : b.dataset.tip
    }
    ui.askSimilar.disabled = !!A.searching || !!A.busy
    ui.askStatus.textContent = A.status || ''
    ui.askNote.textContent = A.busy ? '· working…' : A.answer ? '· answer ready' : A.similar?.length ? `· ${A.similar.length} similar pages` : ''
    const sim = A.similar
    const simHtml = !sim
      ? ''
      : sim.length
        ? `<div style="color:#555;">Pages on this farm like the question${A.similarHow === 'keyword' ? ' (by keyword — the search by meaning is down)' : ''} — click to open beside the tool:</div>${sim.map(p => `<div>${pageLink(p)} <span class="site">${esc(p.site)}</span></div>`).join('')}`
        : '<div style="color:#777;">Nothing like this question on the farm yet.</div>'
    if (ui.similar.dataset.html !== simHtml) {
      ui.similar.innerHTML = simHtml
      ui.similar.dataset.html = simHtml
    }
    const ansHtml = A.answer ? `<div style="color:#666; font-style:italic;">${esc(A.asked || '')}</div>${answerHtml(A.answer)}` : ''
    if (ui.answer.dataset.html !== ansHtml) {
      ui.answer.innerHTML = ansHtml
      ui.answer.dataset.html = ansHtml
    }
    ui.answer.style.display = ui.askActions.style.display = A.answer ? '' : 'none'
  }
  // Open or folded as the author left it, across a redraw of the tool.
  ui.ask.open = !!S.askOpen
  ui.ask.addEventListener('toggle', () => (S.askOpen = ui.ask.open))

  const askGuard = (A, fn) => async () => {
    try {
      await fn()
    } catch (err) {
      A.status = 'error: ' + err.message
    } finally {
      clearInterval(A.tick)
      A.busy = A.searching = false
      paintAsk()
    }
  }
  const findSimilar = async (A, { fresh = false } = {}) => {
    const question = S.title.trim()
    if (!fresh && A.similar && A.similarFor === question) return A.similar
    A.searching = true
    A.status = 'searching the farm for similar pages…'
    paintAsk()
    const t = subject()
    const found = await voice.similarPages(question, { exclude: t ? [`${voice.siteOf(t.$page)}/${t.slug}`] : [] })
    A.similar = [...found]
    A.similarHow = found.how
    A.similarFor = question
    A.searching = false
    return A.similar
  }
  const askIt = kind => {
    const key = askKey()
    const A = askFor(key)
    return askGuard(A, async () => {
      const question = S.title.trim()
      if (!question) throw new Error('name the question first, in the Question box')
      const own = ui.askOwn.value.trim()
      if (kind === 'own' && !own) throw new Error('type your question in the box first')
      if (voice.ownerHere() === false) throw new Error(`log in to ${location.host} as its owner — the farm asks a model only for the owner`)
      A.busy = true
      let related = []
      let searchNote = ''
      try {
        related = await voice.withText(await findSimilar(A), 4)
      } catch (e) {
        searchNote = ` · no similar pages (${e.message})`
      }
      const t0 = Date.now()
      const what = kind === 'research' ? 'researching' : 'asking'
      const tick = () => {
        A.status = `${what}… ${Math.round((Date.now() - t0) / 1000)} s`
        paintAsk()
      }
      tick()
      A.tick = setInterval(tick, 1000)
      const t = subject()
      const out = await voice.askAbout({
        question,
        kind,
        ask: own,
        pageTitle: t?.title || '',
        pageText: t ? voice.pageText(t.$page) : '',
        context: t ? voice.questionContext(t.$page, question) : '',
        related: related.map(({ site, slug, title, synopsis, text }) => ({ site, slug, title, synopsis, text })),
        transcript: S.draft?.transcript?.text || '',
        model: chosenModel(),
      })
      const secs = Math.round((Date.now() - t0) / 1000)
      const how = out.web ? ', web search allowed' : kind !== 'more' ? ', from the wiki pages only (no web search on this model)' : ''
      const read = related.length ? ` · read ${Math.min(4, related.length)} similar page${related.length === 1 ? '' : 's'}` : ''
      Object.assign(A, { answer: out.markdown, model: out.model, kind, web: !!out.web, asked: kind === 'own' ? own : KIND_LABEL[kind] })
      A.status = `answered in ${secs} s by ${wroteIt(out)}${how}${read}${searchNote}`
      keepAsk(key, A)
    })()
  }
  ui.askMore.onclick = () => askIt('more')
  ui.askResearch.onclick = () => askIt('research')
  ui.askGo.onclick = () => askIt('own')
  ui.askOwn.onkeydown = e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      ui.askGo.click()
    }
  }
  ui.askSimilar.onclick = () => {
    const key = askKey()
    const A = askFor(key)
    askGuard(A, async () => {
      const found = await findSimilar(A, { fresh: true })
      A.status = found.length ? `${found.length} similar page${found.length === 1 ? '' : 's'} — open one beside the tool` : ''
      keepAsk(key, A)
    })()
  }
  // + Add to my answer (0.12.0): the answer joins the author's own words,
  // wherever they are now — the typing box, the words waiting to be
  // summarised, or the notes — and the status says which.
  const joinWords = (had, more) => [String(had || '').trim(), String(more || '').trim()].filter(Boolean).join('\n\n')
  ui.askUse.onclick = () => {
    const A = askFor()
    if (!A.answer) return
    const d = S.draft
    if (S.typing || !d) {
      S.typedText = joinWords(S.typing ? ui.typed.value : d?.typed ? d.transcript.text : S.typedText, A.answer)
      S.typing = true
      A.status = 'added to what you are typing — edit it, then Use this text'
    } else if (d.summaryText !== undefined) {
      d.summaryText = joinWords(ui.preview.value || d.summaryText, A.answer)
      ui.preview.value = d.summaryText
      persist()
      A.status = 'added to the end of your notes'
    } else if (d.transcript) {
      d.transcript = { ...d.transcript, text: joinWords(d.transcript.text, A.answer) }
      d.added = true
      persist()
      A.status = 'added to the words waiting to be summarised'
    }
    paint()
    if (S.typing) ui.typed.focus()
  }
  ui.researchUse.onchange = () => {
    const key = askKey()
    const A = askFor(key)
    A.include = ui.researchUse.checked
    keepAsk(key, A)
  }
  ui.askCopy.onclick = async () => {
    const A = askFor()
    try {
      await navigator.clipboard.writeText(A.answer || '')
      A.status = 'the answer is on the clipboard'
    } catch {
      A.status = 'the browser did not allow copying'
    }
    paintAsk()
  }
  ui.askClear.onclick = () => {
    const key = askKey()
    const A = askFor(key)
    Object.assign(A, { answer: undefined, asked: '', status: '' })
    keepAsk(key, A)
    paintAsk()
  }
  // The answer as a ghost page beside the tool: its points to drag where they help, or save.
  ui.askGhost.onclick = () => {
    const A = askFor()
    if (!A.answer) return
    const question = S.title.trim().replace(/\s+/g, ' ')
    const t = subject()
    const items = voice.splitMarkdown(A.answer).map(text => ({ type: 'markdown', id: voice.randomId(), text }))
    const see = [t?.title, ...(A.similar || []).filter(p => !p.site || p.site === location.host).slice(0, 4).map(p => p.title)].filter(Boolean)
    if (see.length) items.push({ type: 'markdown', id: voice.randomId(), text: `# See\n\n${[...new Set(see)].map(x => `- [[${x}]]`).join('\n')}` })
    voice.openGhost(ownPage(ui.$item), `${question.replace(/[?.!]+$/, '')} — Background`, items)
    A.status = 'opened the answer as a ghost page — drag from it, rename it, or save it'
    paintAsk()
  }

  paint()
  ui.$item.on('mouseenter', paint) // the lineup settles, and changes, after bind

  // A reload: the session is new, the draft is in the browser's store.
  if (!S.loaded) {
    S.loaded = true
    voice.loadDraft(item.id).then(found => {
      if (!(found?.blob || found?.transcript) || S.draft) return
      if (S.titleTouched && found.titleTouched && slugify(found.title) !== slugify(S.title)) {
        // the Plan Tool handed over another question before the store answered
        const { parkedAs: _parked, ...kept } = found
        voice.saveDraft(parkKey(found.title), kept)
        voice.clearDraft(item.id)
        return switchTo(S.title)
      }
      const { title, titleTouched, savedAt, parkedAs: _parked, ...draft } = found
      S.draft = draft
      if (titleTouched) Object.assign(S, { title, titleTouched })
      const when = new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      say(draft.typed ? `picked up your unsaved typed answer from ${when}` : draft.transcript ? `picked up your unsaved recording from ${when} — nothing was lost` : `picked up your recording from ${when} — it has no transcript yet, press ↻ Transcribe`)
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
  const startOver = ({ keepQuestion = false } = {}) => {
    const kept = S.draft?.kept
    if (S.blobUrl) URL.revokeObjectURL(S.blobUrl)
    ui.player.removeAttribute('src')
    ui.preview.value = ''
    Object.assign(S, { draft: null, blobUrl: null, $ghost: null, ...(keepQuestion ? {} : { titleTouched: false }) })
    working(null)
    voice.clearDraft(item.id)
    say(kept ? `cleared — the audio you kept is still in assets/${kept.folder}` : 'cleared — speak, or drop a recording')
    paint()
  }
  ui.clear.onclick = () => startOver()

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
    if (S.draft !== draft) {
      // cleared, or replaced, while the farm worked; parked for another question, it keeps its words
      draft.transcript = transcript
      return landParked(draft)
    }
    draft.transcript = transcript
    persist()
    say(`transcribed ${Math.round(transcript.duration || 0)}s in ${transcript.elapsed ?? '?'}s on ${where(transcript)} — choose a prompt and summarise`)
    paint()
  }
  ui.retry.onclick = guard(async () => {
    if (S.draft?.blob && !S.recording) await transcribeDraft(S.draft)
  })

  // one recording, from the microphone or a file, through to a transcript
  const hear = async (blob, type, name) => {
    if (S.draft) startOver({ keepQuestion: true }) // a new take for the same question
    S.typing = false
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

  // ---- typing instead of speaking ----
  // Where speaking is not appropriate the answer is typed. The words take the
  // transcript's place in the draft (typed: true, no recording), so the stages
  // carry on as for speech: Summarise them through a prompt, or Use as written.
  ui.type.onclick = () => {
    S.typing = true
    S.typedText = S.draft?.typed ? S.draft.transcript.text : S.typedText || ''
    say('')
    paint()
    ui.typed.focus()
  }
  ui.typed.oninput = () => (S.typedText = ui.typed.value)
  ui.typed.onkeydown = e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      ui.typedDone.click()
    }
  }
  ui.typedCancel.onclick = () => {
    S.typing = false
    paint()
  }
  ui.typedDone.onclick = guard(async () => {
    const text = (S.typedText || ui.typed.value || '').trim()
    if (!text) throw new Error('type your answer first')
    if (S.draft) startOver({ keepQuestion: true })
    S.draft = { typed: true, name: timestampName('typed', 'txt'), transcript: { text, typed: true, provider: 'typed' } }
    S.typing = false
    S.typedText = ''
    persist()
    say(`took ${text.split(/\s+/).length} words as your answer — use them as written, or summarise them`)
    paint()
  })
  // The words as they are become the notes: no model, nothing spent.
  ui.aswritten.onclick = guard(async () => {
    const d = S.draft
    if (!d?.transcript?.text) return
    d.summary = { model: 'as written', promptTitle: '', promptFrom: '', section: '' }
    d.summaryText = d.transcript.text.trim()
    ui.preview.value = d.summaryText
    persist()
    say('the words are the notes — edit them if you like, then save')
    paint()
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
      const R = askFor()
      const research = R.answer && R.include !== false ? { text: R.answer, asked: R.asked || '' } : null
      const out = await timed(ui.summarise.closest('.item'), () =>
        summaryFor({ transcript: draft.transcript.text, $page: t?.$page, prompt: p, title: S.title, model, research }),
      )
      const summary = { model: out.model, promptTitle: p?.title, promptFrom: p && !p.local ? p.from : '', section: p?.section || '' } // where the prompt was read from, to fork in on save
      if (S.draft !== draft) return draft.parkedAs && landParked(Object.assign(draft, { summary, summaryText: out.markdown }))
      draft.summary = summary
      draft.summaryText = out.markdown
      ui.preview.value = out.markdown
      persist()
      say(`summary by ${wroteIt(out)}${research ? ', drawing on the research' : ''} — edit it, name the page, then open or save it`)
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
      transcript: S.draft.typed ? '' : S.draft.transcript.text,
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
    say(`opened “${title}” — drag items from it, rename it on the page, or save it${kept || S.draft.typed ? '' : '; the recording was not kept'}`)
    paint()
  })

  // Back to the tool that asked: the words, as they stand in the box, by an
  // event the open Revise Plan page listens for, and in sessionStorage for one
  // that renders later. Nothing is saved on the site.
  ui.back.onclick = guard(async () => {
    const r = returnTo()
    if (!r || S.draft?.summaryText === undefined) return
    const text = String(S.draft.summaryText || '').trim()
    if (!text) throw new Error('there are no words to send')
    try {
      sessionStorage.setItem(r.key, text)
    } catch {}
    window.dispatchEvent(new CustomEvent(r.event || 'plan:direction', { detail: { slug: r.slug, site: r.site, title: r.title, text } }))
    S.draft.sentBack = true
    persist()
    say(`sent to Revise Plan as the direction for ${r.plan || 'the plan'} — ${text.split(/\s+/).length} words`)
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
      // With "keep the audio" ticked the recording is uploaded first, and its
      // player goes onto the page straight after the notes it belongs to.
      const kept = await keepIfAsked()
      const done = await voice.addToPage(t.$page, S.draft.summaryText, { section })
      if (kept) await voice.addItem(t.$page, done.last, voice.keptAudioItem(kept, S.title.trim().replace(/\s+/g, ' ')))
      const player = kept ? `, with the audio player (assets/${kept.folder})` : ''
      say(
        (done.how === 'replaced'
          ? `filled the ${section} template on ${t.title}`
          : done.how === 'section'
            ? `added ${done.count} item${done.count === 1 ? '' : 's'} at the end of ${section} on ${t.title}`
            : `added ${done.count} item${done.count === 1 ? '' : 's'} to ${t.title}${section ? ` (no ${section} heading there)` : ''}`) + player,
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
    if ($(e.target).closest('button, select, audio, canvas, textarea, details, input, label, a, .an-settings').length) return
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
      say(`summary by ${wroteIt(out)} — edit it, then open it as a ghost page or add it here`)
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
