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
//                 "auto" lets the farm pick per summary by the question's size
//                 (Auto Model Plan, Phase 5) — see autoPick below.
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
const askModel = async (model, content, { system = SYSTEM, timeoutMs = 7 * 60 * 1000, tools = null } = {}) => {
  const { ms: _ms, ...out } = await (await doorReady()).ask(model, content, { system, timeoutMs, allowTools: false, tools })
  return out
}

// ---------- Auto (0.8.0): the Voice Tool shares the Plan Tool's rule, as far as it fits ----------
//
// The Plan Tool's Auto (Auto Model Plan) weighs a run by its size, its
// answered questions, its open phases, the pages of a site and the action a
// row asks. A summary has none of those but the first: it is one transcript
// and one page through one prompt, so the only signal that fits is how big
// the question is. The rule here is that one signal, with the same threshold:
// over AUDIONOTE_AUTO_BIG_TOKENS (default 48k, the Plan Tool's
// PLAN_AUTO_BIG_TOKENS) the tier is big, else light. The door's autoModel
// turns the tier into a model it reaches now that holds the question with
// AUTO_ROOM to answer in: the coop's own router (llm_auto-big, or
// AUDIONOTE_AUTO_LIGHT) for light, Claude Fable 5.1 (or AUDIONOTE_AUTO_BIG)
// for big, and Claude when the coop is down or cannot hold it. The pick and
// its reason come back on the answer as `auto`, and the status line in the
// browser says `auto → model: reason`, as the Plan Tool's does.
const AUTO_BIG_TOKENS = 48000
const AUTO_ROOM = 4096 // a summary is short; the door's own answer allowance

/** The Voice Tool's tier for a question of `tokens`: {tier, why}. Size alone decides. */
const voiceTier = ({ tokens = 0, bigTokens = AUTO_BIG_TOKENS } = {}) => {
  const label = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
  return { tier: tokens > bigTokens ? 'big' : 'light', why: `${label} tokens` }
}

/** A status line for a pick: auto → glm-5.3-flash-pp: 9k tokens (routes to …), or auto → claude-fable-5-1 (big): 52k tokens. */
const autoLine = auto => {
  if (!auto || !auto.model) return ''
  const name = String(auto.model).replace(/^(openai:llm_|openai:|ollama:|claude-cli:)/, '')
  const tier = auto.tier && auto.tier !== 'light' ? ` (${auto.tier})` : ''
  return `auto → ${name}${tier}: ${auto.why}${auto.note ? ` (${auto.note})` : ''}`
}

/**
 * Auto's pick for one summary: {asked, tier, why, model, note, tokens, line}.
 * `doors` is listModels' answer when the caller has it (the tests); else the
 * door is asked, which it remembers for a minute. No model that holds the
 * question is a 400 with the reason, never a silent cut.
 */
const autoPick = async (content, { system = SYSTEM, doors = null } = {}) => {
  const { estimateTokens, listModels, autoModel } = await doorReady()
  const need = estimateTokens(system) + estimateTokens(content)
  const t = voiceTier({ tokens: need, bigTokens: +process.env.AUDIONOTE_AUTO_BIG_TOKENS || AUTO_BIG_TOKENS })
  const list = doors || (await listModels()).doors
  const r = autoModel({ tier: t.tier, need, doors: list, answer: AUTO_ROOM, light: process.env.AUDIONOTE_AUTO_LIGHT || '', big: process.env.AUDIONOTE_AUTO_BIG || '' })
  const auto = { asked: t.tier, tier: r.tier, why: t.why, model: r.model, note: r.note || '', tokens: need }
  if (!r.model) throw problem(400, `auto found no model for this summary (${t.why}): ${r.note}`)
  return { ...auto, line: autoLine(auto) }
}

const summarise = async ({ transcript, pageTitle, pageText, title, prompt, model }, { doors = null } = {}) => {
  const t = String(transcript || '').trim()
  if (!t) throw problem(400, 'there is no transcript to summarise')
  const { MODEL_ID, defaultModel, fallbackModel } = await doorReady()
  const DEFAULT_MODEL = defaultModel('claude-opus-5')
  const FALLBACK_MODEL = fallbackModel()
  const auto = model === 'auto'
  let chosen = !auto && typeof model === 'string' && MODEL_ID.test(model) ? model : DEFAULT_MODEL
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
  let picked = null
  if (auto) {
    picked = await autoPick(content, { doors })
    chosen = picked.model
  }
  const withPick = out => (picked ? { ...out, auto: picked } : out)
  try {
    return withPick(await askModel(door(chosen), content))
  } catch (e) {
    if (!e.unreachable || !FALLBACK_MODEL || FALLBACK_MODEL === chosen) throw e
    const out = await askModel(FALLBACK_MODEL, content)
    return withPick({ ...out, fellBackFrom: chosen, why: e.message })
  }
}

// ---------- asking about the question (0.9.0) ----------
//
// Before speaking, an author often needs to understand the question: wiki
// questions are a line long and lean on terms the page around them assumes.
// `ask` puts one question to a model — "tell me more", "research this", or the
// author's own words — with the question's context: the lines of the page
// where it is asked, the page itself, the pages the farm's search found like
// it (the browser finds them and sends their text), and what has been said so
// far. "research" lets Claude read the web (WebSearch, WebFetch) when the farm
// reaches Claude by the CLI; other doors answer from the pages alone, and say so.

const ASK_SYSTEM =
  'You help an author on a federated wiki who has been set a question to answer, usually by speaking their answer. ' +
  'Wiki questions are brief and often use terms, names and ideas the author may not know. Write plain markdown that reads well on a wiki page: ' +
  'no preamble, no closing remarks, no hard line wraps inside paragraphs. Explain unfamiliar terms plainly. ' +
  'Use the page the question is asked on and the related wiki pages you are given; when one helps, link it as [[Its Title]]. ' +
  'Say plainly what you do not know or are unsure of, and never invent a source.'

const ASK_KINDS = {
  more:
    'Tell me more about this question: what it is asking, what its terms and ideas mean, and why it matters on this page. ' +
    'Keep it short — a few short paragraphs or bullets — and end with a line naming which related pages, if any, are worth reading first.',
  research:
    'Research this question for me. Set out what is known that would inform an answer: the main positions, facts, examples and sources, ' +
    'and which of the related wiki pages already help. Do not write the answer for me; end with two or three points I might make in answering it.',
}

const clip = (text, n) => {
  const t = String(text || '').trim()
  return t.length > n ? `${t.slice(0, n)}\n…(cut)` : t
}
const attr = s => String(s || '').replace(/[<>"\n]/g, ' ').trim()

/** The question and all its context as one message, in tagged parts a model reads easily. */
const askContent = ({ question, kind, ask: own, pageTitle, pageText, context, related, transcript }) => {
  const task = kind === 'own' ? String(own || '').trim() : ASK_KINDS[kind] || ASK_KINDS.more
  const pages = (Array.isArray(related) ? related : []).slice(0, 8)
  let room = 40000
  const relatedText = pages
    .map(p => {
      const body = clip(p.text || p.synopsis || '', Math.min(8000, Math.max(0, room)))
      room -= body.length
      return `<wiki_page title="${attr(p.title)}" site="${attr(p.site)}">\n${body}\n</wiki_page>`
    })
    .join('\n')
  return [
    `<question>${String(question || '').trim()}</question>`,
    context ? `<where_it_is_asked page="${attr(pageTitle)}">\n${clip(context, 4000)}\n</where_it_is_asked>` : '',
    pageText ? `<page title="${attr(pageTitle)}">\n${clip(pageText, 60000)}\n</page>` : '',
    relatedText ? `<related_pages>\n${relatedText}\n</related_pages>` : '',
    transcript ? `<said_so_far>\n${clip(transcript, 20000)}\n</said_so_far>` : '',
    `<request>${task}</request>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

const ask = async (body, { doors = null } = {}) => {
  const question = String(body?.question || '').trim()
  if (!question) throw problem(400, 'there is no question to ask about')
  const kind = ['more', 'research', 'own'].includes(body.kind) ? body.kind : 'more'
  if (kind === 'own' && !String(body.ask || '').trim()) throw problem(400, 'type your question first')
  const { MODEL_ID, defaultModel, fallbackModel, RESEARCH_TOOLS } = await doorReady()
  const model = body.model
  let chosen = model !== 'auto' && typeof model === 'string' && MODEL_ID.test(model) ? model : defaultModel('claude-opus-5')
  const content = askContent({ ...body, question, kind })
  let picked = null
  if (model === 'auto') {
    picked = await autoPick(content, { system: ASK_SYSTEM, doors })
    chosen = picked.model
  }
  // Only the CLI road has tools; research elsewhere reads the pages alone.
  const how = door(chosen)
  const web = kind !== 'more' && how.startsWith('claude-cli:')
  const opts = { system: ASK_SYSTEM, timeoutMs: (web ? 10 : 5) * 60 * 1000, tools: web ? RESEARCH_TOOLS : null }
  const withPick = out => ({ ...out, web, kind, ...(picked ? { auto: picked } : {}) })
  try {
    return withPick(await askModel(how, content, opts))
  } catch (e) {
    const FALLBACK_MODEL = fallbackModel()
    if (!e.unreachable || !FALLBACK_MODEL || FALLBACK_MODEL === chosen) throw e
    const out = await askModel(FALLBACK_MODEL, content, { ...opts, tools: null })
    return { ...withPick(out), web: false, fellBackFrom: chosen, why: e.message }
  }
}

// ---------- models (0.11.0): the farm's default, for the Voice Tool's ⚙ chip ----------
//
// Read-only and spends nothing: the model Summarise and Ask use when the
// browser chose none and the prompt names none, where that choice was set,
// and the fallback tried when it cannot be reached.
const models = async () => {
  const { defaultModel, fallbackModel } = await doorReady()
  const from = ['CLAUDE_DOOR_MODEL', 'AUDIONOTE_SUMMARY_MODEL'].find(n => process.env[n]) || 'the Voice Tool'
  return { default: defaultModel('claude-opus-5'), defaultFrom: from, fallback: fallbackModel() || null }
}

module.exports = { transcribe, hear, job, summarise, ask, models, askContent, ASK_KINDS, fill, door, engine, fromMacWhisper, macwhisperUp, voiceTier, autoPick, autoLine, AUTO_BIG_TOKENS, AUTO_ROOM }
