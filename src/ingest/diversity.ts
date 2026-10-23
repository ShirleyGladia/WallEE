// How different the episodes are from each other: a 2-D behaviour map, near-copies, and start-pose spread.
import type { EpisodeReport } from './types'

const dist = (a: number[], b: number[]) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return Math.sqrt(s / (a.length / 3)) // RMS distance per gripper point (m)
}

export interface Diversity {
  map: { episode: number; x: number; y: number }[] // first two principal components of the signatures
  nnMedianMm: number // typical distance from an episode to its closest other episode
  nearCopies: { a: number; b: number; mm: number }[]
  startSpreadDeg: number // average spread (std) of the first-frame joint angles
  explained: number // share of variation the map shows
}

export function diversity(eps: EpisodeReport[], nearMm = 5): Diversity | null {
  const lens = new Map<number, number>()
  for (const e of eps) if (e.sig) lens.set(e.sig.length, (lens.get(e.sig.length) ?? 0) + 1)
  const len = [...lens.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  const list = eps.filter((e) => e.sig && e.sig.length === len && e.sig.every(Number.isFinite))
  if (list.length < 3) return null
  const X = list.map((e) => e.sig!)
  const d = X[0].length
  const mean = new Array(d).fill(0)
  for (const x of X) for (let i = 0; i < d; i++) mean[i] += x[i] / X.length
  const C = X.map((x) => x.map((v, i) => v - mean[i]))
  // top two principal directions by power iteration
  const comps: number[][] = []
  let total = 0
  for (const r of C) for (const v of r) total += v * v
  let shown = 0
  for (let k = 0; k < 2; k++) {
    let v = Array.from({ length: d }, (_, i) => Math.sin(i * 7.1 + k * 3.3) + 0.01)
    for (let it = 0; it < 60; it++) {
      const w = new Array(d).fill(0)
      for (const r of C) {
        let p = 0
        for (let i = 0; i < d; i++) p += r[i] * v[i]
        for (let i = 0; i < d; i++) w[i] += p * r[i]
      }
      for (const c of comps) { let p = 0; for (let i = 0; i < d; i++) p += w[i] * c[i]; for (let i = 0; i < d; i++) w[i] -= p * c[i] }
      const n = Math.hypot(...w) || 1
      v = w.map((x) => x / n)
    }
    comps.push(v)
    for (const r of C) { let p = 0; for (let i = 0; i < d; i++) p += r[i] * v[i]; shown += p * p }
  }
  const map = C.map((r, j) => ({
    episode: list[j].episode,
    x: r.reduce((s, v, i) => s + v * comps[0][i], 0),
    y: r.reduce((s, v, i) => s + v * comps[1][i], 0),
  }))
  // nearest neighbours
  const nn: number[] = []
  const nearCopies: Diversity['nearCopies'] = []
  for (let a = 0; a < X.length; a++) {
    let best = Infinity
    for (let b = 0; b < X.length; b++) {
      if (a === b) continue
      const dd = dist(X[a], X[b])
      if (dd < best) best = dd
      if (b > a && dd * 1000 < nearMm) nearCopies.push({ a: list[a].episode, b: list[b].episode, mm: dd * 1000 })
    }
    nn.push(best * 1000)
  }
  nn.sort((x, y) => x - y)
  // start pose spread
  const starts = eps.map((e) => e.start).filter((s): s is number[] => !!s && s.length > 0)
  let spread = 0
  if (starts.length > 1) {
    const n = starts[0].length
    let acc = 0, cnt = 0
    for (let j = 0; j < n; j++) {
      const v = starts.map((s) => s[j]).filter(Number.isFinite)
      const m = v.reduce((s, x) => s + x, 0) / v.length
      acc += Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)
      cnt++
    }
    spread = ((acc / cnt) * 180) / Math.PI
  }
  return { map, nnMedianMm: nn[Math.floor(nn.length / 2)], nearCopies, startSpreadDeg: spread, explained: total ? shown / total : 0 }
}
