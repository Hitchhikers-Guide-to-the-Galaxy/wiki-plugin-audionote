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

let audioContext
let meterSource // keep a reference — Chrome GCs unreferenced MediaStreamAudioSourceNodes, silencing the meter

const levelZone = db => {
  if (db > -3) return ['clipping — back off', '#c0392b']
  if (db > -30) return ['good', '#1a7f37']
  if (db > -50) return ['low — speak up or move closer', '#d68910']
  return ['no signal — wrong microphone?', '#c0392b']
}

const micConstraints = () => {
  const audio = { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
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

function recordStream(stream, ui, { maxSeconds = 600, label }) {
  return new Promise((resolve, reject) => {
    const mime = bestMime()
    if (!mime) return reject(new Error('No supported MediaRecorder audio type'))

    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks = []
    const startedAt = performance.now()

    const track = stream.getAudioTracks()[0]
    const device = track ? { label: track.label, sampleRate: track.getSettings().sampleRate } : null

    audioContext ||= new AudioContext()
    const analyser = audioContext.createAnalyser()
    meterSource = audioContext.createMediaStreamSource(stream)
    meterSource.connect(analyser)

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
      resolve({ blob, mime, duration, peakDb: +maxPeakDb.toFixed(1), device, label })
    }

    recorder.start()
  })
}

// ---------- save to assets + emit native audio item ----------

async function saveRecording($item, item, take) {
  const $page = $item.parents('.page:first')
  const slug = $page.attr('id')
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

function emitAudioItem($item, item, src, caption) {
  const audioItem = {
    type: 'audio',
    id: randomId(),
    // absolute URL: assets do not travel when a page is forked, so point at this site explicitly
    text: `${location.origin}/${src}\n${caption}`,
  }
  const $page = $item.parents('.page:first')
  const $new = $('<div />', { class: 'item audio', 'data-id': audioItem.id }).data('item', audioItem).data('pageElement', $page)
  $item.after($new)
  wiki.doPlugin($new, audioItem)
  return audioItem
}

async function saveAndEmit($item, item, take, ui) {
  ui.status.textContent = 'saving…'
  const caption = (item.text || '').trim() || `Voice note — ${new Date().toLocaleString()}`
  const saved = await saveRecording($item, item, take)
  const audioItem = emitAudioItem($item, item, saved.src, caption)

  item.recording = {
    src: saved.src,
    filename: saved.filename,
    mime: take.mime,
    duration: take.duration,
    peakDb: take.peakDb,
    created: saved.sidecar.created,
  }
  const $page = $item.parents('.page:first')
  await putAndWait($page, { item: audioItem, id: audioItem.id, type: 'add', after: item.id })
  await putAndWait($page, { item, id: item.id, type: 'edit' })

  const quiet = take.peakDb < -30 ? ` — warning: quiet take (peak ${take.peakDb} dBFS)` : ''
  ui.status.textContent = `saved ${saved.filename} (${(take.blob.size / 1024).toFixed(0)} KB, ${take.duration}s)${quiet}`
  return { saved, audioItem }
}

// ---------- item UI ----------

const html = item => `
  <div style="background-color:#eee; padding:12px; border-radius:6px;">
    <select class="an-mic" style="width:100%; font-size:.85em; margin-bottom:6px;"></select>
    <div>
      <button class="an-check">Mic Check</button>
      <button class="an-record">Record</button>
      <button class="an-stop" disabled>Stop</button>
      <button class="an-save" disabled>Save to Assets</button>
    </div>
    <div style="font-family:monospace; font-size:.85em; margin:4px 0;">
      peak <span class="an-db">–</span> dBFS <span class="an-zone"></span> <span class="an-timer"></span>
    </div>
    <canvas class="an-meter" width="400" height="48" style="width:100%; background:#111; border-radius:4px;"></canvas>
    <audio class="an-player" controls style="width:100%; margin-top:6px; display:none;"></audio>
    <div class="an-status" style="font-size:.8em; color:#555; margin-top:4px;">${
      item.recording ? `last saved: ${item.recording.filename} (${item.recording.duration}s)` : 'no recording yet'
    }</div>
    <p class="an-caption" style="font-style:italic; margin:6px 0 0;">${wiki.resolveLinks(item.text || '(double-click to add a caption)')}</p>
  </div>
`

const getUI = $item => {
  const el = sel => $item.find(sel)[0]
  return {
    mic: el('.an-mic'),
    check: el('.an-check'),
    record: el('.an-record'),
    stop: el('.an-stop'),
    save: el('.an-save'),
    db: el('.an-db'),
    zone: el('.an-zone'),
    timer: el('.an-timer'),
    meter: el('.an-meter'),
    player: el('.an-player'),
    status: el('.an-status'),
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
      recordStream(stream, monitor, { maxSeconds: 3600, label: 'mic-check' }).catch(() => {})
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
      take = await recordStream(stream, ui, { maxSeconds: 600, label: 'microphone' })
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
      const testTake = await recordStream(dest.stream, ui, { maxSeconds: seconds, label: 'self-test-oscillator' })
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
