#!/usr/bin/env node
// auto.cjs — the Voice Tool's Auto (0.8.0): size alone decides the tier, and
// the door's autoModel turns the tier into a model, without a network.
//
//   node test/auto.cjs

const { voiceTier, autoPick, autoLine, summarise, AUTO_BIG_TOKENS } = require('../api/handlers.js')

const problems = []
const check = (name, ok, detail = '') => ok || problems.push(detail ? `${name} — ${detail}` : name)

// listModels' answer as the laptop saw it on 20 Oct 2026, trimmed
const doors = ({ coopError = '', routerWindow = 262144 } = {}) => [
  {
    door: 'openai',
    error: coopError,
    models: coopError
      ? []
      : [
          { id: 'openai:llm_auto-big', contextLength: routerWindow, loaded: true, selector: true, routesTo: 'openai:llm_glm-5.3-flash-pp' },
          { id: 'openai:llm_glm-5.3-flash-pp', contextLength: 262144, loaded: true },
          { id: 'openai:llm_dsv4s-pp-optimized', contextLength: 384000, loaded: false },
          { id: 'openai:llm_qwen3.8-27b-uncensored', contextLength: 32768, loaded: false },
        ],
  },
  { door: 'claude', models: [{ id: 'claude-fable-5-1', contextLength: 200000 }, { id: 'claude-opus-5-5', contextLength: 200000 }] },
  { door: 'ollama', models: [{ id: 'ollama:qwen3:4b', contextLength: 32768 }] },
]

const main = async () => {
  // ---------- the tier: size alone ----------
  check('a short question is light', voiceTier({ tokens: 2000 }).tier === 'light')
  check('the reason is the size', voiceTier({ tokens: 2000 }).why === '2k tokens')
  check('a small count is said in full', voiceTier({ tokens: 400 }).why === '400 tokens')
  check('at the threshold is still light', voiceTier({ tokens: AUTO_BIG_TOKENS }).tier === 'light')
  check('over the threshold is big', voiceTier({ tokens: AUTO_BIG_TOKENS + 1 }).tier === 'big')
  check('the threshold can be set', voiceTier({ tokens: 10000, bigTokens: 8000 }).tier === 'big')
  check('the default threshold is the Plan Tool\'s', AUTO_BIG_TOKENS === 48000)

  // ---------- the pick: the door's rule ----------
  const short = 'The speaker said the garden needs water. '.repeat(50) // ~2k tokens
  const light = await autoPick(short, { doors: doors() })
  check('light goes to the coop router', light.model === 'openai:llm_auto-big', light.model)
  check('light says where the router routes', /routes to glm-5.3-flash-pp/.test(light.note), light.note)
  check('the line reads auto → auto-big: Nk tokens (routes to …)', /^auto → auto-big: \d+k? tokens \(routes to glm-5\.3-flash-pp\)$/.test(light.line), light.line)
  check('the pick carries what it was asked', light.asked === 'light' && light.tier === 'light')

  const big = 'A long page. '.repeat(16000) // ~60k tokens
  const heavy = await autoPick(big, { doors: doors() })
  check('big goes to Claude Fable', heavy.model === 'claude-fable-5-1', heavy.model)
  check('big says so on the line', /^auto → claude-fable-5-1 \(big\): \d+k tokens$/.test(heavy.line), heavy.line)

  const was = process.env.AUDIONOTE_AUTO_BIG
  process.env.AUDIONOTE_AUTO_BIG = 'claude-opus-5-5'
  check('AUDIONOTE_AUTO_BIG names the big model', (await autoPick(big, { doors: doors() })).model === 'claude-opus-5-5')
  if (was === undefined) delete process.env.AUDIONOTE_AUTO_BIG
  else process.env.AUDIONOTE_AUTO_BIG = was

  const down = await autoPick(short, { doors: doors({ coopError: 'fetch failed' }) })
  check('coop down: Claude, and the reason says so', down.model === 'claude-fable-5-1' && /coop did not answer/.test(down.note), `${down.model} ${down.note}`)

  const roomy = await autoPick('A long page. '.repeat(100000), { doors: doors() }) // ~370k tokens: past Claude, inside DeepSeek's 384k
  check("past Claude's window: the coop's roomiest model, cold", roomy.model === 'openai:llm_dsv4s-pp-optimized' && /too big for Claude's window; cold/.test(roomy.note), `${roomy.model} ${roomy.note}`)

  const tooBig = 'A long page. '.repeat(140000) // ~520k tokens: no coop model, not Claude
  let refused = null
  try {
    await autoPick(tooBig, { doors: doors() })
  } catch (e) {
    refused = e
  }
  check('nothing holds it: a 400 with the reason', refused && refused.status === 400 && /every coop model/.test(refused.message), refused && refused.message)

  // ---------- the line ----------
  check('no model, no line', autoLine({}) === '')
  check('a light line has no tier', autoLine({ model: 'openai:llm_glm-5.3-flash-pp', tier: 'light', why: '9k tokens' }) === 'auto → glm-5.3-flash-pp: 9k tokens')

  // ---------- summarise: auto is a word the handler takes ----------
  let bad = null
  try {
    await summarise({ transcript: '' , model: 'auto' })
  } catch (e) {
    bad = e
  }
  check('an empty transcript is refused before any pick', bad && bad.status === 400)

  if (problems.length) {
    console.error(`auto: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    problems.forEach(p => console.error('  -', p))
    process.exit(1)
  }
  console.log('auto: ok')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
