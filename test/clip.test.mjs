import test from 'node:test'
import assert from 'node:assert/strict'
import { toSeconds, fmt, parseClip, setTimes, region, isClipText, fragment } from '../client/clip.js'

const TEXT = `CLIP
AUDIO: http://solidarity.localhost/assets/dream-circle/dream-circle.m4a#t=321.8,403.5
IN: 5:22
OUT: 6:43
SPEAKER: Sepp
SOURCE: Dream Circle
Sepp's mutualism coin, as spoken.`

test('times', () => {
  assert.equal(toSeconds('5:22'), 322); assert.equal(toSeconds('1:05:22'), 3922); assert.equal(toSeconds('322.5'), 322.5)
  assert.ok(Number.isNaN(toSeconds('soon'))); assert.equal(fmt(322), '5:22'); assert.equal(fmt(3922), '1:05:22')
})
test('parse', () => {
  const c = parseClip(TEXT)
  assert.equal(c.in, 321.8); assert.equal(c.out, 403.5); assert.equal(c.speaker, 'Sepp'); assert.equal(c.source, 'Dream Circle')
  assert.equal(c.src, 'http://solidarity.localhost/assets/dream-circle/dream-circle.m4a'); assert.equal(c.caption, "Sepp's mutualism coin, as spoken."); assert.ok(c.ok)
  assert.ok(isClipText(TEXT)); assert.ok(!isClipText('TRANSCRIPT\nAUDIO: x'))
})
test('fragment alone is enough', () => {
  const c = parseClip('CLIP\nAUDIO: http://x/a.m4a#t=10,25.5')
  assert.equal(c.in, 10); assert.equal(c.out, 25.5); assert.ok(c.ok); assert.deepEqual(fragment('a#t=3'), { in: 3, out: NaN })
})
test('a caption line in capitals is not a command', () => {
  assert.equal(parseClip(TEXT + '\nYES.').caption, "Sepp's mutualism coin, as spoken.\nYES.")
})
test('an edited IN beats a stale fragment', () => assert.equal(parseClip(TEXT.replace('IN: 5:22', 'IN: 5:10')).in, 310))
test('not ok without an out point', () => assert.ok(!parseClip('CLIP\nAUDIO: http://x/a.m4a\nIN: 0:10').ok))
test('setTimes rewrites IN, OUT and the fragment only', () => {
  const t = setTimes(TEXT, 320, 400); const c = parseClip(t)
  assert.equal(c.in, 320); assert.equal(c.out, 400); assert.match(t, /#t=320\.0,400\.0/); assert.match(t, /SPEAKER: Sepp/); assert.match(t, /as spoken\.$/)
  assert.equal(parseClip(setTimes('CLIP\nAUDIO: http://x/a.m4a#t=1,2', 5, 9)).out, 9)
})
test('region', () => {
  const r = region(parseClip(TEXT), 4131); assert.ok(Math.abs(r.left - 7.79) < 0.05); assert.ok(r.width > 1.9 && r.width < 2.0)
  assert.deepEqual(region(parseClip(TEXT), 0), { left: 0, width: 0 })
})
