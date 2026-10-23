// Finds the few seconds of each episode worth a human look: what the checks flagged,
// plus stretches where a trace crosses a threshold. Each one becomes a short clip.
import type { EpisodeReport, Moment, MomentKind } from '../ingest/types'
import type { Thresholds } from './settings'

export const KIND_LABEL: Record<MomentKind, string> = {
  spike: 'Sensor spike', stuck: 'Stuck joint', limit: 'Past joint limit', gripper: 'Gripper out of range', missing: 'Missing values',
  sync: 'Arms out of sync', camera: 'Camera problem', fast: 'Fast joint', reach: 'Near reach limit', table: 'Below the table',
  tcp: 'Fast gripper', noise: 'Noisy readings', manual: 'Picked by hand',
}

// Stretches of frames where test(i) holds, padded and merged, as clips of 3–10 s.
// If the stretches add up to more than 10 s, it's the whole episode: one clip at the worst moment.
function runs(n: number, fps: number, test: (i: number) => boolean, score: (i: number) => number) {
  const out: { from: number; to: number; worst: number }[] = []
  let s = -1
  for (let i = 0; i <= n; i++) {
    const on = i < n && test(i)
    if (on && s < 0) s = i
    if (!on && s >= 0) { out.push({ from: s, to: i, worst: s }); s = -1 }
  }
  const pad = Math.round(1.5 * fps)
  const min = Math.round(3 * fps)
  const max = Math.round(10 * fps)
  const merged: { from: number; to: number }[] = []
  for (const r of out) {
    let from = Math.max(0, r.from - pad)
    let to = Math.min(n, Math.min(r.to, r.from + max - 2 * pad) + pad)
    if (to - from < min) { const c = (from + to) / 2; from = Math.max(0, Math.round(c - min / 2)); to = Math.min(n, from + min) }
    const last = merged.at(-1)
    if (last && from <= last.to + fps) last.to = Math.max(last.to, to)
    else merged.push({ from, to })
  }
  const total = out.reduce((s, r) => s + r.to - r.from, 0)
  if (merged.length > 3 || merged.some((m) => m.to - m.from > max)) {
    let worst = out[0]?.from ?? 0
    for (const r of out) for (let i = r.from; i < r.to; i++) if (score(i) > score(worst)) worst = i
    const from = Math.max(0, worst - Math.round(3 * fps))
    return [{ from, to: Math.min(n, from + Math.round(6 * fps)), total }]
  }
  return merged.map((m) => ({ ...m, total }))
}

export function findMoments(e: EpisodeReport, fps: number, th: Thresholds): Moment[] {
  const list: Moment[] = [...(e.moments ?? [])]
  const tr = e.trace
  if (tr) {
    const n = tr.speed.length
    const add = (kind: MomentKind, test: (i: number) => boolean, reason: (from: number, to: number) => string, score: (i: number) => number) => {
      for (const r of runs(n, fps, test, score)) {
        const long = r.total > r.to - r.from + fps
        list.push({ from: r.from, to: r.to, kind, reason: reason(r.from, r.to) + (long ? ` · over the limit for ${(r.total / fps).toFixed(0)} s in this episode` : '') })
      }
    }
    const peak = (a: Float32Array, from: number, to: number, f: (v: number) => number = (v) => v) => {
      let m = -Infinity
      for (let i = from; i < to; i++) m = Math.max(m, f(a[i]))
      return m
    }
    // the checks above already describe sensor glitches; don't repeat them as "fast"
    const noisy = e.warnings.find((w) => w.startsWith('Noisy'))
    if (noisy) {
      let worst = 0
      for (let i = 0; i < n; i++) if (tr.tcp[i] > tr.tcp[worst]) worst = i
      const from = Math.max(0, worst - Math.round(3 * fps))
      list.push({ from, to: Math.min(n, from + Math.round(6 * fps)), kind: 'noise', reason: noisy })
    }
    const glitch = list.some((m) => m.kind === 'spike' || m.kind === 'missing' || m.kind === 'noise')
    if (!glitch) add('fast', (i) => tr.speed[i] > th.speed, (a, b) => `Joint at ${Math.round(peak(tr.speed, a, b) * 100)}% of its FR3 speed limit (threshold ${Math.round(th.speed * 100)}%)`, (i) => tr.speed[i])
    if (!glitch) add('tcp', (i) => tr.tcp[i] > th.tcp, (a, b) => `Gripper moving ${Math.round(peak(tr.tcp, a, b))} mm/s (threshold ${th.tcp} mm/s)`, (i) => tr.tcp[i])
    add('reach', (i) => tr.reach[i] > th.reach, (a, b) => `Arm at ${Math.round(peak(tr.reach, a, b) * 100)}% of its maximum reach`, (i) => tr.reach[i])
    if (th.tableMm > 0) {
      const z = -th.tableMm / 1000
      add('table', (i) => tr.lowest[i] < z - 0.001, (a, b) => `Arm ${Math.round(peak(tr.lowest, a, b, (v) => z - v) * 1000)} mm below the table`, (i) => -tr.lowest[i])
    }
  }
  // Overlapping moments become one clip; the check that found it first names it.
  const out: Moment[] = []
  for (const m of list.sort((a, b) => a.from - b.from)) {
    const o = out.find((x) => m.from < x.to && x.from < m.to)
    if (!o) { out.push({ ...m }); continue }
    if (o.to - o.from < 10 * fps) o.to = Math.min(Math.max(o.to, m.to), o.from + Math.round(10 * fps))
    if (!o.reason.includes(m.reason)) o.reason += ` · ${m.reason}`
  }
  return out
}

export const momentId = (dataset: string, episode: number, m: { from: number; to: number; kind: string }) => `${dataset}|${episode}|${m.kind}|${m.from}-${m.to}`
