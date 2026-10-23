// Lighting per episode, from one frame in the middle of each episode of a camera.
// A VLA trained under one light can fail under another, so the spread matters as much as the level.
import { grabFrames, lightOf } from './grab'
import type { IngestResult } from './types'

export interface Light { episode: number; brightness: number; contrast: number; warmth: number; thumb?: string }
export interface LightingResult { camera: string; lights: Light[]; failed: number }

const cache = new Map<string, LightingResult>()
export const cachedLighting = (r: IngestResult, cam: string) => cache.get(`${r.name}|${cam}`)

export async function measureLighting(r: IngestResult, cam: string, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<LightingResult> {
  const key = `${r.name}|${cam}`
  if (cache.has(key)) return cache.get(key)!
  const c = r.cameras.find((x) => x.key === cam)
  if (!c) throw new Error('Camera not loaded')
  // group episodes by video file so each file is opened once
  const byFile = new Map<number, { episode: number; t: number }[]>()
  for (const e of r.episodes) {
    const s = r.segments[e.episode]?.[cam]
    if (!s || !c.fileUrls[s.fi]) continue
    byFile.set(s.fi, [...(byFile.get(s.fi) ?? []), { episode: e.episode, t: (s.from + s.to) / 2 }])
  }
  const total = [...byFile.values()].reduce((s, v) => s + v.length, 0)
  const lights: Light[] = []
  let done = 0, failed = 0
  const files = [...byFile.entries()]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, async () => {
    while (next < files.length && !signal?.aborted) {
      const [fi, items] = files[next++]
      try {
        const grabs = await grabFrames(c.fileUrls[fi], items.map((x) => x.t), { width: 64, thumbs: true, signal })
        grabs.forEach((g, k) => lights.push({ episode: items[k].episode, ...lightOf(g.image), thumb: g.url }))
      } catch {
        failed += items.length
      }
      done += items.length
      onProgress(done, total)
    }
  }))
  const res = { camera: cam, lights: lights.sort((a, b) => a.episode - b.episode), failed }
  if (!signal?.aborted) cache.set(key, res)
  return res
}

export function lightingVerdict(lights: Light[]) {
  const b = lights.map((l) => l.brightness)
  const mean = b.reduce((s, x) => s + x, 0) / Math.max(1, b.length)
  const std = Math.sqrt(b.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, b.length))
  const w = lights.map((l) => l.warmth)
  const wStd = Math.sqrt(w.reduce((s, x) => s + (x - w.reduce((a, y) => a + y, 0) / w.length) ** 2, 0) / Math.max(1, w.length))
  const sorted = [...b].sort((x, y) => x - y)
  const range = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)] : 0
  // brightness that moves less than ~8% and colour that barely moves: one lighting setup
  const uniform = std / Math.max(1, mean) < 0.08 && wStd < 6
  return { mean, std, range, warmthStd: wStd, uniform }
}
