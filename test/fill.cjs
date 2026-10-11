#!/usr/bin/env node
// fill.cjs — the parts of speaking to a page that need no farm, no browser and no model:
// filling a prompt, reading a prompt page, and finding where new items go.
//
//   node test/fill.cjs

const { fill } = require('../api/handlers.js')

const problems = []
const check = (name, ok, detail = '') => ok || problems.push(detail ? `${name} — ${detail}` : name)

const main = async () => {
  // ---------- filling ----------
  check('fills named values', fill('A {{page_title}} B', { transcript: 't', page_title: 'P' }).startsWith('A P B'))
  check('unknown names left as written', fill('{{nope}} {{transcript}}', { transcript: 't' }) === '{{nope}} t')
  check('transcript appended when the prompt never names it', fill('Summarise.', { transcript: 'words' }).includes('<transcript>\nwords\n</transcript>'))
  check('spaces inside braces', fill('{{ transcript }}', { transcript: 'x' }) === 'x')

  // ---------- prompt pages ----------
  const voice = await import('../client/voice.js')
  const prompt = voice.parsePrompt({
    title: 'Answer Open Questions',
    story: [
      { type: 'paragraph', text: 'For a page of questions.' },
      { type: 'code', text: 'KIND: answer\nINPUT: transcript, page\nOUTPUT: markdown\nMODEL: ollama:gemma3:4b\n---\nAnswer {{page_title}}.\n\n---\n\nKeep going.' },
    ],
  })
  check('parses kind', prompt && prompt.kind === 'answer')
  check('parses model', prompt && prompt.model === 'ollama:gemma3:4b')
  check('parses inputs', prompt && prompt.input.join('|') === 'transcript|page')
  check('body keeps a later ---', prompt && prompt.body.includes('Keep going.') && prompt.body.startsWith('Answer'))
  check('no header, no prompt', voice.parsePrompt({ story: [{ type: 'code', text: 'just code\n---\nmore' }] }) === null)
  check('empty body, no prompt', voice.parsePrompt({ story: [{ type: 'code', text: 'KIND: summary\n---\n' }] }) === null)

  // ---------- where new items go (insertionPoint reads $page.data('data')) ----------
  const fakePage = story => ({ data: () => ({ story }) })
  check('before # See', voice.insertionPoint(fakePage([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 's', type: 'markdown', text: '# See' }, { id: 'c', text: '- [[Z]]' }])) === 'b')
  check('end when there is no See', voice.insertionPoint(fakePage([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }])) === 'b')
  check('empty page', voice.insertionPoint(fakePage([])) === null)
  check('See as a paragraph', voice.insertionPoint(fakePage([{ id: 'a', text: 'x' }, { id: 's', type: 'paragraph', text: 'See' }])) === 'a')

  // ---------- a summary as draggable items ----------
  const blocks = voice.splitMarkdown('Intro line.\n\n- one\n  - nested under one\n- two\n* three\n\nA closing paragraph\nthat runs on.')
  check('paragraphs and bullets split', blocks.length === 5, JSON.stringify(blocks))
  check('nested bullet stays with its parent', blocks[1] === '- one\n  - nested under one')
  check('a wrapped paragraph stays whole', blocks[4] === 'A closing paragraph\nthat runs on.')
  check('numbered lists split too', voice.splitMarkdown('1. a\n2. b').length === 2)

  // ---------- the page a spoken note makes: answer first, then only what was kept ----------
  globalThis.location = { origin: 'http://test.localhost' }
  const base = { markdown: 'The answer.\n\n- a point\n- another', transcript: 'What was said.', title: 'Is it so?', subjectTitle: 'Open Questions', promptTitle: 'Summarise Spoken Notes' }
  const thrown = voice.spokenItems(base)
  check('answer first — no heading, no date line', thrown[0].text === 'The answer.' && thrown[1].text === '- a point' && thrown[2].text === '- another')
  check('not kept — no audio item', !thrown.some(i => i.type === 'audio'))
  check('not kept — no assets item', !thrown.some(i => i.type === 'assets'))
  check('not kept — transcript carried under its heading', thrown.some(i => i.text === '# Transcript') && thrown.some(i => i.text === 'What was said.'))
  check('no metadata line', !thrown.some(i => /summarised|Spoken note|not kept/.test(i.text)))
  check('See links the subject then the prompt', thrown[thrown.length - 1].text === '# See\n\n- [[Open Questions]]\n- [[Summarise Spoken Notes]]')
  check('no prompt, See has the subject alone', voice.spokenItems({ ...base, promptTitle: '' }).pop().text === '# See\n\n- [[Open Questions]]')
  check('neither, no See', !voice.spokenItems({ ...base, subjectTitle: '', promptTitle: '' }).some(i => /^# See/.test(i.text)))

  // ---------- the prompt's site is forked in at index 0, so its link leads there ----------
  const ghost = { title: 'Is it so?', story: [], journal: [{ type: 'create', item: { title: 'Is it so?' }, date: 1000 }] }
  voice.seedFork(ghost, 'prompt.geek.fish')
  check('fork sits first, dated before the create', ghost.journal[0].type === 'fork' && ghost.journal[0].site === 'prompt.geek.fish' && ghost.journal[0].date === 999 && ghost.journal[1].type === 'create')
  voice.seedFork(ghost, 'prompt.geek.fish')
  check('seeding twice adds nothing', ghost.journal.length === 2)
  check('no site, no fork', voice.seedFork({ journal: [] }, '').journal.length === 0)
  const kept = voice.spokenItems({ ...base, kept: { folder: 'open-questions', src: 'assets/open-questions/v.webm', transcriptTxt: 'assets/open-questions/v.txt' } })
  const types = kept.map(i => i.type)
  check('kept — audio then Assets heading then assets item', types.indexOf('audio') > 0 && kept[types.indexOf('audio') + 1].text === '# Assets' && kept[types.indexOf('assets')].text === 'open-questions')
  check('kept — audio link is absolute', kept[types.indexOf('audio')].text.startsWith('http://test.localhost/assets/open-questions/v.webm'))
  check('kept — caption is the title and the date', /\nIs it so\? Recorded \d{4}-\d\d-\d\d\.$/.test(kept[types.indexOf('audio')].text))
  check('kept — transcript not copied in', !kept.some(i => i.text === '# Transcript' || i.text === 'What was said.'))
  check('kept — See still last', kept[kept.length - 1].text.startsWith('# See'))
  check('every item has its own id', new Set(kept.map(i => i.id)).size === kept.length)

  // ---------- which door a model name opens ----------
  const { door } = require('../api/handlers.js')
  check('ollama passes through', door('ollama:gemma3:4b') === 'ollama:gemma3:4b')
  check('explicit cli passes through', door('claude-cli:claude-opus-5') === 'claude-cli:claude-opus-5')

  // ---------- delivery: the loader must find the version it will ask for ----------
  const fsx = require('node:fs'), pathx = require('node:path')
  const here = f => pathx.join(__dirname, '..', f)
  check('version.json matches package.json', JSON.parse(fsx.readFileSync(here('client/version.json'))).version === require('../package.json').version)
  check('the loader asks for the version without cache', /version\.json[\s\S]*no-store/.test(fsx.readFileSync(here('client/audionote.js'), 'utf8')))
  check('main.js loads voice.js under its own version', fsx.readFileSync(here('client/main.js'), 'utf8').includes('voice.js${new URL(import.meta.url).search}'))

  if (problems.length) {
    console.log(`fill:      FAILS — ${problems.length} wrong`)
    problems.forEach(p => console.log(`  - ${p}`))
    process.exit(1)
  }
  console.log('fill:      KEEPS prompts and placement — every question answered right')
}
main().catch(e => {
  console.error(e)
  process.exit(1)
})
