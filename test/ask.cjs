// test/ask.cjs — the ask operation's message and its refusals (0.9.0). No model is called.
const assert = require('node:assert/strict')
const { ask, askContent, ASK_KINDS } = require('../api/handlers.js')

const msg = askContent({
  question: 'What is a Towel?',
  kind: 'more',
  pageTitle: 'Trust Plan',
  pageText: 'The plan.',
  context: '- [ ] [[What is a Towel?]] the VTA we run',
  related: [{ title: 'Towel', site: 'towel.private.fish', text: 'A Towel is a verifiable trust agent.' }],
  transcript: '',
})
assert.match(msg, /<question>What is a Towel\?<\/question>/)
assert.match(msg, /<where_it_is_asked page="Trust Plan">/)
assert.match(msg, /<wiki_page title="Towel" site="towel.private.fish">/)
assert.ok(msg.includes(ASK_KINDS.more), 'the default request is Tell me more')
assert.ok(!msg.includes('<said_so_far>'), 'nothing said, nothing sent')

const own = askContent({ question: 'Q', kind: 'own', ask: 'Who runs it?', transcript: 'I think…' })
assert.match(own, /<request>Who runs it\?<\/request>/)
assert.match(own, /<said_so_far>\nI think…/)

// related pages share 40k characters, each at most 8k
const big = askContent({ question: 'Q', related: Array.from({ length: 8 }, (_, i) => ({ title: `P${i}`, site: 's', text: 'x'.repeat(20000) })) })
assert.ok(big.length < 50000, `related text is capped (${big.length})`)

;(async () => {
  await assert.rejects(ask({}), e => e.status === 400)
  await assert.rejects(ask({ question: 'Q', kind: 'own', ask: '  ' }), e => e.status === 400 && /type your question/.test(e.message))
  console.log('ask: ok')
})()
