// 0.12.0 — what 💬 Ask found goes with Summarise as background, when ticked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { researchBlock } = require('../api/handlers.js')

test('researchBlock: the reply in <research> tags, named as background, with the rule; nothing when empty', () => {
  const b = researchBlock('Hugelkultur buries wood under soil.', 'Research this')
  assert.match(b, /^\n\n<research note="before answering, the author asked a model about the question \(Research this\); its reply is background, not the author's words">\nHugelkultur buries wood under soil\.\n<\/research>/)
  assert.match(b, /say when a point comes from it rather than from the author\. The summary is still of what the author said\.$/)
  assert.equal(researchBlock(''), '')
  assert.equal(researchBlock('   '), '')
  assert.ok(researchBlock('x'.repeat(50000)).length < 41000)
  assert.doesNotMatch(researchBlock('r', 'say "hi"'), /"hi"/)
})
