// The ⚙ chip (0.11.0): the Voice Tool names the model Summarise will ask
// before anything runs — the choice in ⚙ settings, else the prompt's MODEL
// line, else the farm's default from models.json.
//
//   node --test test/model-chip.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

globalThis.location ||= { origin: 'http://demo.localhost', host: 'demo.localhost' }
const voice = await import('../client/voice.js')
const require = createRequire(import.meta.url)

test('modelLabel shortens ids as the Plan Tool does', () => {
  assert.equal(voice.modelLabel(''), 'farm default')
  assert.equal(voice.modelLabel('auto'), 'auto')
  assert.equal(voice.modelLabel('claude-opus-5-5'), 'Claude Opus 5.5')
  assert.equal(voice.modelLabel('claude-opus-5'), 'Claude Opus 5')
  assert.equal(voice.modelLabel('claude-cli:claude-fable-5-1'), 'Claude Fable 5.1')
  assert.equal(voice.modelLabel('openai:llm_auto-big'), 'coop · auto-big')
  assert.equal(voice.modelLabel('ollama:qwen3:4b'), 'Ollama · qwen3:4b')
  assert.equal(voice.modelLabel('something-else'), 'something-else')
})

const farm = { default: 'openai:llm_auto-big', defaultFrom: 'CLAUDE_DOOR_MODEL' }
const prompt = { title: 'Interview Answer', model: 'claude-opus-5' }

test('the choice in ⚙ settings wins over the prompt and the farm', () => {
  const shown = voice.modelShown({ chosen: 'ollama:qwen3:4b', prompt, farm })
  assert.equal(shown.label, 'Ollama · qwen3:4b')
  assert.equal(shown.from, 'chosen')
  assert.match(shown.title, /chosen in ⚙ settings/)
})

test('auto is named as auto', () => {
  const shown = voice.modelShown({ chosen: 'auto', prompt, farm })
  assert.equal(shown.label, 'auto')
  assert.equal(shown.from, 'chosen')
})

test("nothing chosen: the prompt's MODEL line, and Ask is said to use the farm's", () => {
  const shown = voice.modelShown({ chosen: '', prompt, farm })
  assert.equal(shown.label, 'Claude Opus 5')
  assert.equal(shown.from, 'prompt')
  assert.match(shown.title, /Interview Answer/)
  assert.match(shown.title, /💬 Ask uses coop · auto-big/)
})

test("nothing chosen, no prompt model: the farm's default, and who set it", () => {
  const shown = voice.modelShown({ chosen: '', prompt: { title: 'Plain', model: '' }, farm })
  assert.equal(shown.label, 'coop · auto-big')
  assert.equal(shown.from, 'farm')
  assert.match(shown.title, /set by CLAUDE_DOOR_MODEL/)
})

test('a farm without models.json still says "farm default"', () => {
  const shown = voice.modelShown({ chosen: '', prompt: null, farm: null })
  assert.equal(shown.label, 'farm default')
  assert.equal(shown.from, 'farm')
})

test('models.json answers the default Summarise uses, and where it was set', async () => {
  const { models } = require('../api/handlers.js')
  const saved = { CLAUDE_DOOR_MODEL: process.env.CLAUDE_DOOR_MODEL, AUDIONOTE_SUMMARY_MODEL: process.env.AUDIONOTE_SUMMARY_MODEL }
  try {
    delete process.env.CLAUDE_DOOR_MODEL
    delete process.env.AUDIONOTE_SUMMARY_MODEL
    assert.deepEqual(await models(), { default: 'claude-opus-5', defaultFrom: 'the Voice Tool', fallback: (await models()).fallback })
    process.env.AUDIONOTE_SUMMARY_MODEL = 'openai:llm_auto-big'
    const m = await models()
    assert.equal(m.default, 'openai:llm_auto-big')
    assert.equal(m.defaultFrom, 'AUDIONOTE_SUMMARY_MODEL')
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('models.json is declared read-only, so it never spends or gates', () => {
  const spec = require('../api/openapi.json')
  const op = spec.paths['/models.json']?.get
  assert.equal(op?.operationId, 'models')
  assert.equal(op['x-fedwiki-read-only'], true)
  assert.ok(!op['x-fedwiki-spends'] && !op['x-fedwiki-writes'])
})
