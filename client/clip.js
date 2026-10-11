// clip — the pure half of the CLIP mode. No DOM, no window, so `node --test`
// imports it directly. A CLIP item plays one span of a long recording and
// marks where that span sits in the whole:
//
//   CLIP
//   AUDIO: http://site/assets/dream-circle/dream-circle.m4a#t=322,403
//   IN: 5:22
//   OUT: 6:43
//   SPEAKER: Sepp
//   SOURCE: Dream Circle
//   a caption
//
// IN and OUT are the authority and are what a human edits. The #t= fragment on
// AUDIO says the same thing in the standard way, so the address still starts in
// the right place in a plain <audio> where this plugin is absent.

export const CLIP_COMMANDS = new Set(['CLIP', 'AUDIO', 'IN', 'OUT', 'SPEAKER', 'SOURCE'])

// '5:22' | '1:05:22' | '322.5' → seconds (NaN when it is not a time)
export const toSeconds = v => {
  const t = String(v ?? '').trim()
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return NaN
  return t.split(':').reduce((s, p) => s * 60 + parseFloat(p), 0)
}

// seconds → 'm:ss' or 'h:mm:ss'
export const fmt = sec => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export const fragment = url => {
  const m = String(url || '').match(/#t=([\d.]+)(?:,([\d.]+))?/)
  return m ? { in: parseFloat(m[1]), out: m[2] === undefined ? NaN : parseFloat(m[2]) } : { in: NaN, out: NaN }
}

export const isClipText = text => /^\s*CLIP\s*(\n|$)/.test(text || '')

export function parseClip(text) {
  const out = { audio: '', in: NaN, out: NaN, speaker: '', source: '', caption: '' }
  const caption = []
  for (const line of (text || '').split('\n')) {
    const m = line.trim().match(/^([A-Z]+)(?::\s*(.*))?$/)
    if (m && CLIP_COMMANDS.has(m[1])) {
      const arg = (m[2] || '').trim()
      if (m[1] === 'AUDIO') out.audio = arg
      else if (m[1] === 'IN') out.in = toSeconds(arg)
      else if (m[1] === 'OUT') out.out = toSeconds(arg)
      else if (m[1] === 'SPEAKER') out.speaker = arg
      else if (m[1] === 'SOURCE') out.source = arg.replace(/^\[\[|\]\]$/g, '')
    } else caption.push(line)
  }
  const f = fragment(out.audio)
  // IN / OUT are whole seconds for people; when the fragment agrees to the second it carries the finer edge
  const finer = (t, frag) => (Number.isNaN(t) ? frag : !Number.isNaN(frag) && Math.abs(frag - t) < 1 ? frag : t)
  out.in = finer(out.in, f.in)
  if (Number.isNaN(out.in)) out.in = 0
  out.out = finer(out.out, f.out)
  out.src = out.audio.split('#')[0]
  out.caption = caption.join('\n').trim()
  out.ok = !!out.src && !Number.isNaN(out.out) && out.out > out.in
  return out
}

// Rewrite IN / OUT (and the fragment) in an item's text, leaving every other line as it is.
export function setTimes(text, inSec, outSec) {
  const a = Math.max(0, inSec), b = Math.max(a + 0.5, outSec)
  let seenIn = false, seenOut = false
  const lines = (text || '').split('\n').map(line => {
    if (/^\s*IN:/.test(line)) { seenIn = true; return `IN: ${fmt(a)}` }
    if (/^\s*OUT:/.test(line)) { seenOut = true; return `OUT: ${fmt(b)}` }
    if (/^\s*AUDIO:/.test(line)) return `AUDIO: ${line.replace(/^\s*AUDIO:\s*/, '').split('#')[0]}#t=${a.toFixed(1)},${b.toFixed(1)}`
    return line
  })
  const at = lines.findIndex(l => /^\s*AUDIO:/.test(l)) + 1
  if (!seenOut) lines.splice(at, 0, `OUT: ${fmt(b)}`)
  if (!seenIn) lines.splice(at, 0, `IN: ${fmt(a)}`)
  return lines.join('\n')
}

// Where the clip sits in the whole, as percentages for the bar.
export const region = (clip, duration) => {
  if (!duration || !clip.ok) return { left: 0, width: 0 }
  const left = Math.min(100, (clip.in / duration) * 100)
  return { left, width: Math.max(0.6, Math.min(100 - left, ((clip.out - clip.in) / duration) * 100)) }
}

export const CONTEXT = 10 // seconds of lead-in for "in context"
