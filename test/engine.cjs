#!/usr/bin/env node
// engine.cjs — which engine hears a recording, and MacWhisper's JSON as the record transcribe.py writes.
//
//   node test/engine.cjs

const { engine, fromMacWhisper, macwhisperUp } = require('../api/handlers.js')

const problems = []
const check = (name, ok, detail = '') => ok || problems.push(detail ? `${name} — ${detail}` : name)

// ---------- choosing ----------
const was = process.env.AUDIONOTE_ENGINE
process.env.AUDIONOTE_ENGINE = 'macwhisper'
check('AUDIONOTE_ENGINE=macwhisper is obeyed', engine() === 'macwhisper')
process.env.AUDIONOTE_ENGINE = 'faster-whisper'
check('AUDIONOTE_ENGINE=faster-whisper is obeyed', engine() === 'faster-whisper')
process.env.AUDIONOTE_ENGINE = 'whisper'
check('whisper is a spelling of faster-whisper', engine() === 'faster-whisper')
delete process.env.AUDIONOTE_ENGINE
check('auto follows whether the app is up', engine() === (macwhisperUp() ? 'macwhisper' : 'faster-whisper'))
if (was === undefined) delete process.env.AUDIONOTE_ENGINE
else process.env.AUDIONOTE_ENGINE = was

// ---------- converting ----------
const json = {
  segments: [
    { id: 'A', start: 1, end: 5920, text: ' The voice tool should transcribe here. ', words: [{ start: 0, end: 160, text: 'The' }] },
    { id: 'B', start: 6000, end: 8250, text: 'And on the farm when it is not.' },
  ],
  text: 'The voice tool should transcribe here. And on the farm when it is not.',
}
const r = fromMacWhisper(json, { model: 'parakeet-pro:nvidia_parakeet-v3', elapsed: 2.5 })
check('provider named', r.provider === 'macwhisper')
check('model carried', r.model === 'parakeet-pro:nvidia_parakeet-v3')
check('milliseconds become seconds', r.segments[0].end === 5.92 && r.segments[1].start === 6)
check('segment text trimmed', r.segments[0].text === 'The voice tool should transcribe here.')
check('duration is the last end', r.duration === 8.25)
check('text kept', r.text === json.text)
check('elapsed kept', r.elapsed === 2.5)
check('language blank when not reported', r.language === '')
const bare = fromMacWhisper({ segments: [{ start: 0, end: 1000, text: 'hi' }] })
check('text built from segments when absent', bare.text === 'hi')
check('empty json is an empty record', fromMacWhisper({}).text === '' && fromMacWhisper({}).duration === 0)

if (problems.length) {
  console.error('engine: FAILED\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('engine: ok')
