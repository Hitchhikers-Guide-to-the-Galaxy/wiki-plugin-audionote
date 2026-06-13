/*
 * Federated Wiki : Audio Note Plugin
 *
 * Records a voice note in the browser, saves the audio file and a JSON
 * metadata sidecar into the wiki assets folder via the bundled
 * wiki-plugin-assets upload endpoint, then emits a native audio item
 * pointing at the saved file.
 *
 * Licensed under the MIT license.
 */

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

// Local Whisper endpoint (FedWiki Media Plan Phase 4, "local-whisper" provider).
// Override with localStorage key fedwiki-media:transcribeUrl.
const transcribeUrl = () => localStorage.getItem('fedwiki-media:transcribeUrl') || 'http://localhost:8000/transcribe'

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
// followed by a colon (e.g. "TARGET: Some Page"), or when the whole line is a single [[wikilink]].
// Everything else is the human caption. (Command vocabulary is expected to grow later.)
function parseItemText(text) {
  const commands = []
  const caption = []
  for (const line of (text || '').split('\n')) {
    const t = line.trim()
    const lone = t.match(/^\[\[([^\]]+)\]\]$/)
    const cmd = t.match(/^([A-Z][A-Z0-9_]+):\s*(.*)$/)
    if (lone) commands.push({ name: 'TARGET', arg: lone[1] })
    else if (cmd) commands.push({ name: cmd[1], arg: cmd[2].trim() })
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

const targetInfo = ($page, source, extra = {}) => ({ $page, slug: $page.attr('id'), title: pageTitle($page), source, ...extra })

function resolveTarget($item, item) {
  const $self = ownPage($item)
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
  if (micId) audio.deviceId = { exact: micId }
  return { audio }
}

async function fillMicSelect(select) {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const current = select.value || localStorage.getItem(MIC_KEY)
  select.innerHTML = ''
  devices
    .filter(d => d.kind === 'audioinput')
    .forEach((d, i) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `Microphone ${i + 1}`
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

    const ctx = ui.meter.getContext('2d')
    const wave = new Uint8Array(analyser.frequencyBinCount)
    const buf = new Float32Array(analyser.fftSize)
    let maxPeakDb = -Infinity
    let raf

    const drawFrame = () => {
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
      ui.timer.textContent = ((performance.now() - startedAt) / 1000).toFixed(1) + 's'
    }, 100)

    const timeout = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), maxSeconds * 1000)

    ui.stopFn = () => recorder.state !== 'inactive' && recorder.stop()

    recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
    recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'))
    recorder.onstop = () => {
      clearTimeout(timeout)
      clearInterval(tick)
      cancelAnimationFrame(raf)
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, ui.meter.width, ui.meter.height)
      ui.timer.textContent = ''
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks, { type: mime })
      const duration = +((performance.now() - startedAt) / 1000).toFixed(2)
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
    type: 'audio-note',
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

  const form = new FormData()
  form.append('assets', slug) // field order matters: multer only sees body fields that precede the files
  form.append('file', new File([take.blob], filename, { type: take.mime }))
  form.append('file', new File([new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' })], sidecarName))

  const res = await fetch('/plugin/assets/upload', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`)

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
  ui.status.textContent = 'transcribing… (first run downloads the model)'

  const res = await fetch(transcribeUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${location.origin}/${rec.src}` }),
  })
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`)
  const transcript = await res.json()
  if (transcript.error) throw new Error(transcript.error)

  // resolve the same target the recording was saved into (lineup may have changed since)
  const $self = ownPage($item)
  const target = {
    $page: pageForSlug(rec.targetSlug, $self),
    slug: rec.targetSlug || $self.attr('id'),
    title: rec.targetTitle || pageTitle($self),
  }

  // save JSON sidecar and plain-text transcript next to the recording
  const $page = target.$page
  const slug = target.slug
  const transcriptName = rec.filename.replace(/\.\w+$/, '.transcript.json')
  const transcriptTxtName = rec.filename.replace(/\.\w+$/, '.transcript.txt')
  const form = new FormData()
  form.append('assets', slug)
  form.append(
    'file',
    new File([new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' })], transcriptName),
  )
  form.append(
    'file',
    new File([new Blob([transcript.text], { type: 'text/plain' })], transcriptTxtName),
  )
  const up = await fetch('/plugin/assets/upload', { method: 'POST', body: form })
  if (!up.ok) throw new Error(`transcript upload failed: ${up.status}`)

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

  ui.status.textContent = `transcribed — ${transcript.segments.length} segments, language ${transcript.language}`
  return transcript
}

// ---------- item UI ----------

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
      <button class="an-stop" disabled>Stop</button>
      <button class="an-save" disabled>Save to Assets</button>
      <button class="an-transcribe"${item.recording?.src ? '' : ' disabled'}>Transcribe</button>
    </div>
    <div style="font-size:.8em; color:#444; margin:4px 0;">
      <label><input type="checkbox" class="an-agc"> auto&nbsp;gain</label>
      &nbsp; boost <input type="range" class="an-gain" min="0" max="24" step="1" value="0"
        style="width:110px; vertical-align:middle;"> +<span class="an-gaindb">0</span>&nbsp;dB
    </div>
    <div style="font-family:monospace; font-size:.85em; margin:4px 0;">
      peak <span class="an-db">–</span> dBFS <span class="an-zone"></span> <span class="an-timer"></span>
    </div>
    <canvas class="an-meter" width="400" height="48" style="width:100%; background:#111; border-radius:4px;"></canvas>
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
  $item.append(html(item))
}

const bind = ($item, item) => {
  const ui = getUI($item)
  let take = null
  let checkStream = null

  fillMicSelect(ui.mic).catch(() => {})
  ui.mic.onchange = () => localStorage.setItem(MIC_KEY, ui.mic.value)

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
  const SOURCE_LABEL = { pinned: 'pinned', caption: 'from caption', lineup: 'nearby page', self: 'this page' }
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
    const uri = dt.getData('text/uri-list') || ''
    const txt = dt.getData('text/plain') || ''
    const url = (uri + ' ' + txt).match(/\/view\/([A-Za-z0-9-]+)/)
    if (url) return url[1]
    const wl = txt.match(/\[\[([^\]]+)\]\]/)
    if (wl) return slugify(wl[1])
    try { const j = JSON.parse(txt); if (j?.title) return slugify(j.title) } catch {}
    if (/^[\w][\w \-]*$/.test(txt.trim())) return slugify(txt.trim())
    return null
  }
  // sibling lineup pages may finish rendering after this item binds, and the lineup can change
  // later — refresh the indicator on hover so "Saves to" is always current.
  $item.on('mouseenter', refreshTarget)
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

if (typeof window !== 'undefined') {
  window.plugins['audio-note'] = { emit, bind }
}

export const audioNote = typeof window == 'undefined' ? { preferredAudioTypes, timestampName, extFor, levelZone } : undefined
