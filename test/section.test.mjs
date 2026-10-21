import test from 'node:test'
import assert from 'node:assert/strict'

// a chainable stand-in for jQuery: enough for addItem / replaceText / putAndWait
const chain = () => {
  const c = new Proxy(function () {}, {
    get: (t, k) => (k === 'length' ? 1 : k === 'then' ? undefined : () => c),
    apply: () => c,
  })
  return c
}
const actions = []
globalThis.$ = target => {
  if (target === globalThis.document) return { on: (ev, fn) => fn(null, null, { url: '/page/x/action' }), off: () => {} }
  return chain()
}
globalThis.document = {}
globalThis.location ||= { origin: "http://demo.localhost", host: "demo.localhost" }
globalThis.wiki = { doPlugin: () => {}, pageHandler: { put: (_p, a) => actions.push(a) } }

const voice = await import('../client/voice.js')
const { parsePrompt, findSection, isBoardTemplate, sectionPlan, addToPage, BOARD_TEMPLATE } = voice

const TEMPLATE = BOARD_TEMPLATE.join('\n\n')
const md = (id, text) => ({ type: 'markdown', id, text })
const card = body => [
  md('a', '**Beta Tests** is a card on the [[Lab Board]].'),
  md('h1', "# Board\n\n> The card on the board."),
  md('b', '- Card #30 on the board'),
  md('h2', "# Description\n\n> What the task is. The mirror sends this section to Taiga."),
  ...body,
  md('h3', '# Check-Ins\n\n> Voice notes.'),
  md('c', 'None yet.'),
  md('see', '# See\n\n- [[Lab Board]]'),
]
const fakePage = story => ({ data: () => ({ story }), find: () => chain() })

test('parsePrompt reads SECTION', () => {
  const page = { title: 'Describe This Card', story: [{ type: 'code', id: 'p', text: 'KIND: summary\nINPUT: transcript, page\nOUTPUT: markdown\nSECTION: Description\nMODEL: claude-opus-5-5\n---\nWrite it.' }] }
  assert.equal(parsePrompt(page).section, 'Description')
  page.story[0].text = 'KIND: summary\n---\nWrite it.'
  assert.equal(parsePrompt(page).section, '')
})

test('a section is found by its label, any number of hashes, case ignored', () => {
  const story = card([md('t', TEMPLATE)])
  assert.deepEqual(findSection(story, 'Description'), { start: 3, end: 5 })
  assert.deepEqual(findSection(story, '## description'), { start: 3, end: 5 })
  story[3] = md('h2', '### Description')
  assert.deepEqual(findSection(story, 'Description'), { start: 3, end: 5 })
  assert.equal(findSection(story, 'Offer'), null)
  assert.deepEqual(findSection(story, 'See'), { start: 7, end: 8 })
})

test('the board template is detected, nbsp and whitespace ignored', () => {
  assert.ok(isBoardTemplate(TEMPLATE))
  assert.ok(isBoardTemplate(TEMPLATE.replace(/\n\n/g, '\n  \n').replace('Docs:**', 'Docs:** ')))
  assert.ok(!isBoardTemplate(TEMPLATE.replace('**Ddl:**', '**Ddl:** 9 November')))
  assert.ok(!isBoardTemplate(TEMPLATE.replace('\n\n**Docs:**', '')))
  assert.ok(!isBoardTemplate(''))
})

test('an unfilled template is replaced; anything else is inserted after the section', () => {
  assert.deepEqual(sectionPlan(card([md('t', TEMPLATE)]), 'Description'), { replace: 't' })
  assert.deepEqual(sectionPlan(card([md('t', TEMPLATE.replace('**Ddl:**', '**Ddl:** soon'))]), 'Description'), { after: 't' })
  assert.deepEqual(sectionPlan(card([md('t', TEMPLATE), md('u', 'more')]), 'Description'), { after: 'u' })
  assert.deepEqual(sectionPlan(card([]), 'Description'), { after: 'h2' })
  assert.deepEqual(sectionPlan(card([{ type: 'paragraph', id: 't', text: TEMPLATE }]), 'Description'), { after: 't' })
  assert.equal(sectionPlan(card([]), 'Offer'), null)
})

test('addToPage: replace keeps the id as one edit', async () => {
  actions.length = 0
  const done = await addToPage(fakePage(card([md('t', TEMPLATE)])), '**What has to be done / description:**\n\nTest the beta.\n\n**Docs:**\n\nNone.', { section: 'Description' })
  assert.deepEqual(done, { how: 'replaced', count: 1, last: 't' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].type, 'edit')
  assert.equal(actions[0].id, 't')
  assert.match(actions[0].item.text, /Test the beta\./)
})

test('addToPage: a filled section gets adds after its last item', async () => {
  actions.length = 0
  const done = await addToPage(fakePage(card([md('t', 'Already written.')])), 'One.\n\nTwo.', { section: 'Description' })
  assert.deepEqual(done, { how: 'section', count: 2, last: actions[1].id })
  assert.deepEqual(actions.map(a => [a.type, a.after]), [['add', 't'], ['add', actions[0].id]])
})

test('Add to this page with the audio kept: the player follows the notes', async () => {
  actions.length = 0
  const $page = fakePage(card([md('t', 'Already written.')]))
  const done = await addToPage($page, 'One.\n\nTwo.', { section: 'Description' })
  const audio = voice.keptAudioItem({ src: 'assets/q/2026-10-21--voice.webm', folder: 'q' }, 'Does it work?')
  await voice.addItem($page, done.last, audio)
  const last = actions[actions.length - 1]
  assert.equal(last.item.type, 'audio')
  assert.equal(last.after, actions[1].id, 'straight after the last note')
  assert.match(last.item.text, /^http:\/\/[^/]+\/assets\/q\/2026-10-21--voice\.webm\nDoes it work\? Recorded \d{4}-\d\d-\d\d\.$/)
})

test('addToPage: no SECTION, or no such heading, falls back to before See', async () => {
  actions.length = 0
  let done = await addToPage(fakePage(card([md('t', TEMPLATE)])), 'One.', {})
  assert.deepEqual({ ...done, last: undefined }, { how: 'fallback', count: 1, last: undefined })
  assert.equal(actions[0].after, 'c')
  actions.length = 0
  done = await addToPage(fakePage(card([md('t', TEMPLATE)])), 'One.', { section: 'Offer' })
  assert.equal(done.how, 'fallback')
  assert.equal(actions[0].after, 'c')
  actions.length = 0
  await addToPage(fakePage(card([])), 'One.', { section: 'Offer', fallbackAfter: 'a' })
  assert.equal(actions[0].after, 'a')
})
