// handlers.js — audionote's operations, mounted by the Farm plugin.
//
// audionote has no server of its own. It declares these operations in
// package.json (fedwiki.api) and the Farm plugin mounts them beneath
// /system/api/audionote/, gates the writing ones by the wiki's own owner test,
// and documents them for people and agents alike. Each handler is a plain
// function: values in, value out.
//
//   transcribe  — run whisper over a recording already in the site's assets;
//                 writes <name>.whisper.json and <name>.txt beside it. Long on
//                 a Pi, so it answers with a job to poll. The engine is
//                 MacWhisper's CLI where that app is running (a Mac), else
//                 faster-whisper — see engine() below.
//   hear        — the same, for a recording sent as the request body and NOT
//                 kept: transcribed from the farm's temporary folder, then
//                 deleted. The Voice Tool's default.
//   job         — how a transcription is getting on.
//   summarise   — fill a prompt with the transcript and the page, and ask a
//                 model: the Claude API ("claude-opus-5"), the Claude Code CLI
//                 under whoever is logged in on the farm's machine — a Claude
//                 Max account, no API key ("claude-cli:claude-opus-5") — or an
//                 Ollama model for a farm off the network ("ollama:gemma3:4b");
//                 a fallback model is tried when the first cannot be reached.
//
// CommonJS: the farm imports handlers with import(), which takes either.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
// The door to a model lives in a module the Voice Tool and the Plan Tool both
// import (Plan Tool Plan, Phase 4): askClaude, askClaudeCli, askOllama, door,
// ask, fill, the model-id test, the key and token lookups and DNS-SD moved
// there. CommonJS requiring an ES module: Node 22.12 or later.
// That require() fails with "not yet fully loaded" while the farm is still
// importing another plugin that imports the door itself (the Plan Tool), so
// when it does, the door is imported on demand and the first summarise waits.
let claudeDoor = null
try {
  claudeDoor = require('@fortyfoxes/wiki-claude-door')
} catch (e) {
  if (!/not yet fully loaded|ERR_REQUIRE_ASYNC_MODULE|ERR_REQUIRE_CYCLE_MODULE/.test(`${e.code} ${e.message}`)) throw e
}
const doorReady = async () => claudeDoor || (claudeDoor = await import('@fortyfoxes/wiki-claude-door'))

const problem = (status, message) => Object.assign(new Error(message), { status })

// ---------- where things are ----------

const siteDir = status => {
  if (!status) throw problem(500, 'the farm did not say where this site lives')
  return path.dirname(status)
}

/** A page slug, as the asset folder is named after it. No dots, so no climbing. */
const checkSlug = slug => {
  const s = String(slug ?? '')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw problem(400, `not a page slug: ${slug}`)
  return s
}

const checkFile = name => {
  const n = String(name ?? '')
  if (!n || n.startsWith('.') || /[/\\\0]/.test(n) || n.length > 200) throw problem(400, `not an acceptable file name: ${name}`)
  return n
}

const home = os.homedir()

/** The Python that has faster-whisper: the operator's choice, the voice-engine venv, else python3. */
const python = () => {
  if (process.env.AUDIONOTE_PYTHON) return process.env.AUDIONOTE_PYTHON
  const venv = path.join(home, 'voice-engine', 'venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : 'python3'
}

const whisperModel = requested => {
  const allowed = ['tiny.en', 'base.en', 'small.en', 'tiny', 'base', 'small']
  if (requested && allowed.includes(requested)) return requested
  return process.env.AUDIONOTE_WHISPER_MODEL || 'base.en'
}

// ---------- transcription jobs ----------
//
// One at a time, in arrival order: a Pi has four cores and whisper will use all
// of them, so two at once would each take twice as long and both be late.

const jobs = new Map()
let queue = Promise.resolve()
const JOB_TTL_MS = 6 * 60 * 60 * 1000
const JOB_TIMEOUT_MS = 30 * 60 * 1000

const forget = () => {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) if (job.finished && job.finished < cutoff) jobs.delete(id)
}

// ---------- which engine ----------
//
// Two engines write the same two files, so nothing downstream knows which ran:
//
//   faster-whisper  transcribe.py in the voice-engine venv — the Pis, the Mini,
//                   any Linux farm, and a Mac where MacWhisper is closed.
//   macwhisper      the MacWhisper app's own CLI (mw), which talks to the
//                   RUNNING app over a socket and uses whatever model the app
//                   has selected (Parakeet v3, say — faster and better than
//                   base.en, and already on the laptop). Never on a Pi.
//
// AUDIONOTE_ENGINE names one outright; unset (or "auto") it is MacWhisper when
// the app is up and faster-whisper otherwise, decided per job, so opening or
// quitting the app changes the next recording and nothing else.

const MACWHISPER_BIN = process.env.AUDIONOTE_MACWHISPER_BIN || '/Applications/MacWhisper.app/Contents/MacOS/mw'
const MACWHISPER_SOCK = path.join(home, 'Library', 'Application Support', 'MacWhisper', 'cli.sock')

/** Whether the MacWhisper app is running here, so its CLI will answer. */
const macwhisperUp = () => {
  if (process.platform !== 'darwin' || !fs.existsSync(MACWHISPER_BIN)) return false
  try {
    return fs.statSync(MACWHISPER_SOCK).isSocket()
  } catch {
    return false
  }
}

const engine = () => {
  const asked = String(process.env.AUDIONOTE_ENGINE || 'auto').toLowerCase()
  if (asked === 'macwhisper') return 'macwhisper'
  if (asked === 'faster-whisper' || asked === 'whisper') return 'faster-whisper'
  return macwhisperUp() ? 'macwhisper' : 'faster-whisper'
}

/** The model MacWhisper has selected (the ▸ row of `mw models list`), remembered for a minute. */
let modelCache = { at: 0, id: '' }
const macwhisperModel = () =>
  new Promise(resolve => {
    if (process.env.AUDIONOTE_MACWHISPER_MODEL) return resolve(process.env.AUDIONOTE_MACWHISPER_MODEL)
    if (Date.now() - modelCache.at < 60 * 1000) return resolve(modelCache.id)
    const child = spawn(MACWHISPER_BIN, ['models', 'list'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    const done = () => {
      const row = out.split('\n').find(l => /^\s*▸/.test(l)) || ''
      const id = (row.replace(/^\s*▸\s*/, '').split(/\s{2,}/)[0] || '').trim()
      modelCache = { at: Date.now(), id }
      resolve(id)
    }
    child.on('error', done)
    child.on('close', done)
    setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, 10 * 1000).unref()
  })

/**
 * MacWhisper's JSON — segments in milliseconds with words, and the text — as
 * the record transcribe.py writes, so the two engines are one to everything
 * that reads the files. Language is not reported by the CLI; duration is the
 * end of the last segment.
 */
const fromMacWhisper = (json, { model = '', elapsed = 0 } = {}) => {
  const segs = (json.segments || []).map(seg => ({
    start: Math.round(Number(seg.start || 0)) / 1000,
    end: Math.round(Number(seg.end || 0)) / 1000,
    text: String(seg.text || '').trim(),
  }))
  const text = String(json.text || segs.map(s => s.text).join(' ')).trim()
  const duration = segs.length ? segs[segs.length - 1].end : 0
  return { provider: 'macwhisper', model, language: json.language || '', duration, elapsed, text, segments: segs }
}

const runMacWhisper = (audio, outbase) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const mwOut = `${outbase}.mw.json`
    const args = ['transcribe', audio, '--format', 'json', '--no-speakers', '-o', mwOut, '--overwrite']
    if (process.env.AUDIONOTE_MACWHISPER_MODEL) args.push('--model', process.env.AUDIONOTE_MACWHISPER_MODEL)
    if (/^(1|yes|true|on)$/i.test(String(process.env.AUDIONOTE_MACWHISPER_PERSIST || ''))) args.push('--persist')
    const child = spawn(MACWHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => (err += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), JOB_TIMEOUT_MS)
    child.on('error', e => {
      clearTimeout(timer)
      reject(new Error(`could not start MacWhisper's CLI: ${e.message}`))
    })
    child.on('close', async code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `MacWhisper exited with ${code}`))
      try {
        const json = JSON.parse(fs.readFileSync(mwOut, 'utf8'))
        const record = fromMacWhisper(json, { model: await macwhisperModel(), elapsed: Math.round((Date.now() - started) / 10) / 100 })
        fs.writeFileSync(`${outbase}.whisper.json`, JSON.stringify(record, null, 1))
        fs.writeFileSync(`${outbase}.txt`, record.text + '\n')
        resolve({ provider: record.provider, model: record.model, language: record.language, duration: record.duration, elapsed: record.elapsed })
      } catch (e) {
        reject(new Error(`MacWhisper finished but its transcript could not be read: ${e.message}`))
      } finally {
        fs.rmSync(mwOut, { force: true })
      }
    })
  })

const runWhisper = (audio, model, outbase) =>
  engine() === 'macwhisper'
    ? runMacWhisper(audio, outbase)
    : runFasterWhisper(audio, model, outbase)

const runFasterWhisper = (audio, model, outbase) =>
  new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'transcribe.py')
    const child = spawn(python(), [script, audio, model, outbase], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), JOB_TIMEOUT_MS)
    child.on('error', e => {
      clearTimeout(timer)
      reject(new Error(`could not start ${python()}: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `whisper exited with ${code}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        reject(new Error('whisper finished but said nothing readable'))
      }
    })
  })

/**
 * Queue one whisper run. `kept` says what the finished job reports beyond the
 * text; `after` always runs, and is where a recording nobody asked to keep is
 * thrown away.
 */
const enqueue = ({ origin, audio, outbase, model, about = {}, kept = () => ({}), after = () => {} }) => {
  forget()
  const id = crypto.randomBytes(8).toString('hex')
  const job = { id, origin, state: 'queued', model, engine: engine(), host: os.hostname(), queued: Date.now(), ...about }
  jobs.set(id, job)
  queue = queue.then(async () => {
    job.state = 'running'
    job.started = Date.now()
    job.engine = engine() // decided now, not when queued: the app may have opened meanwhile
    try {
      const summary = await runWhisper(audio, model, outbase)
      const record = JSON.parse(fs.readFileSync(`${outbase}.whisper.json`, 'utf8'))
      Object.assign(job, { state: 'done', provider: record.provider || 'faster-whisper', ...summary, text: record.text, segments: record.segments, ...kept() })
    } catch (e) {
      Object.assign(job, { state: 'failed', error: e.message })
    }
    try {
      after()
    } catch {}
    job.finished = Date.now()
  })
  return { job: id, state: job.state, model, engine: job.engine, host: job.host, ahead: [...jobs.values()].filter(j => j.state === 'queued' || j.state === 'running').length - 1 }
}

const transcribe = ({ slug, filename, model, origin, status }) => {
  const s = checkSlug(slug)
  const f = checkFile(filename)
  const audio = path.join(siteDir(status), 'assets', s, f)
  if (!fs.existsSync(audio)) throw problem(404, `no such recording: assets/${s}/${f}`)
  const base = f.replace(/\.[^.]+$/, '')
  return enqueue({
    origin,
    audio,
    outbase: path.join(siteDir(status), 'assets', s, base),
    model: whisperModel(model),
    about: { slug: s, filename: f },
    kept: () => ({ transcript: `assets/${s}/${base}.whisper.json`, transcriptTxt: `assets/${s}/${base}.txt` }),
  })
}

/**
 * Transcribe a recording WITHOUT keeping it. Most speech is wanted as text and
 * the audio is thrown away, so nothing is put in the site's assets: the body
 * the farm streamed to its temporary folder is claimed, transcribed, and
 * deleted with whisper's own output. Keeping the audio is a separate, later,
 * deliberate upload.
 */
const hear = ({ model, origin, body }) => {
  if (!body || !body.tmpPath) throw problem(400, 'send the recording as the request body')
  if (!body.size) throw problem(400, 'the recording is empty')
  // The farm removes its temporary file as soon as this returns; the job runs later, so claim it.
  const audio = `${body.tmpPath}.hear`
  fs.renameSync(body.tmpPath, audio)
  const outbase = `${audio}.out`
  return enqueue({
    origin,
    audio,
    outbase,
    model: whisperModel(model),
    about: { kept: false },
    after: () => [audio, `${outbase}.whisper.json`, `${outbase}.txt`].forEach(f => fs.rmSync(f, { force: true })),
  })
}

/** A job as the asking site may see it. Another site's jobs are not found, not forbidden. */
const job = ({ id, origin }) => {
  const j = jobs.get(String(id || ''))
  if (!j || j.origin !== origin) throw problem(404, 'no such job here')
  const { origin: _o, ...visible } = j
  return visible
}

// ---------- summarising ----------

// Which model writes, when a prompt does not say: the operator's choice per
// farm (CLAUDE_DOOR_MODEL, or AUDIONOTE_SUMMARY_MODEL as before), else
// claude-opus-5. The fallback (CLAUDE_DOOR_FALLBACK_MODEL or
// AUDIONOTE_FALLBACK_MODEL) is tried when the first choice cannot be reached
// (no network, no key), so a summary still appears — marked with who wrote it.
const notYet = () => new Error('the Claude door is still loading — ask again in a moment')
const fill = (...a) => (claudeDoor ? claudeDoor.fill(...a) : (() => { throw notYet() })())
const door = (...a) => (claudeDoor ? claudeDoor.door(...a) : (() => { throw notYet() })())

const SYSTEM =
  'You turn spoken notes into text for a federated wiki page. Write plain markdown that reads well on the page: ' +
  'no preamble, no closing remarks, no hard line wraps inside paragraphs. Use [[Page Title]] links only for pages ' +
  'the speaker or the page already names. Say only what the speaker said, what follows directly from it, or what the prompt asks you to carry over from the page.'

// One question, no tools, seven minutes at most: the door's defaults, with the
// Voice Tool's own system prompt. The door's answer also carries ms, dropped
// here so the summarise answer keeps its shape.
const ask = async (model, content) => {
  const { ms: _ms, ...out } = await (await doorReady()).ask(model, content, { system: SYSTEM, timeoutMs: 7 * 60 * 1000, allowTools: false })
  return out
}

const summarise = async ({ transcript, pageTitle, pageText, title, prompt, model }) => {
  const t = String(transcript || '').trim()
  if (!t) throw problem(400, 'there is no transcript to summarise')
  const { MODEL_ID, defaultModel, fallbackModel } = await doorReady()
  const DEFAULT_MODEL = defaultModel('claude-opus-5')
  const FALLBACK_MODEL = fallbackModel()
  const chosen = typeof model === 'string' && MODEL_ID.test(model) ? model : DEFAULT_MODEL
  const template =
    String(prompt || '').trim() ||
    'Summarise what was said about the page "{{page_title}}" as a few short paragraphs or a bullet list.\n\n<page>\n{{page_text}}\n</page>\n\n<transcript>\n{{transcript}}\n</transcript>'
  const content = fill(template, {
    transcript: t,
    page_title: pageTitle || '',
    page_text: String(pageText || '').slice(0, 200000),
    title: String(title || '').trim(), // the page the words will be saved under, often a red link's question
    date: new Date().toISOString().slice(0, 10),
  })
  try {
    return await ask(door(chosen), content)
  } catch (e) {
    if (!e.unreachable || !FALLBACK_MODEL || FALLBACK_MODEL === chosen) throw e
    const out = await ask(FALLBACK_MODEL, content)
    return { ...out, fellBackFrom: chosen, why: e.message }
  }
}

module.exports = { transcribe, hear, job, summarise, fill, door, engine, fromMacWhisper, macwhisperUp }
