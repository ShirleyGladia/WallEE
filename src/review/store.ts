// Human verdicts on clips, kept per dataset in this browser, and exported as an edit list.
import { useSyncExternalStore } from 'react'
import type { MomentKind } from '../ingest/types'

export type Verdict = 'ok' | 'wrong' | 'unsure'
export type Fix = 'trim' | 'drop' // wrong: cut these seconds out (episode is split there) or leave the whole episode out

export interface Clip {
  id: string
  dataset: string
  episode: number
  from: number // frame
  to: number // frame after the last
  kind: MomentKind
  reason: string
  source: 'auto' | 'manual'
  verdict?: Verdict
  fix?: Fix
  note?: string
  by?: string
  at?: string
}

const KEY = (d: string) => `review:${d}`
const cache = new Map<string, Record<string, Clip>>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function read(dataset: string): Record<string, Clip> {
  if (!cache.has(dataset)) {
    let v: Record<string, Clip> = {}
    try { v = JSON.parse(localStorage.getItem(KEY(dataset)) ?? '{}') } catch { /* empty */ }
    cache.set(dataset, v)
  }
  return cache.get(dataset)!
}
function write(dataset: string, v: Record<string, Clip>) {
  cache.set(dataset, v)
  try { localStorage.setItem(KEY(dataset), JSON.stringify(v)) } catch { /* private window */ }
  emit()
}

export function useReview(dataset: string) {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => read(dataset))
}
export const getReview = read

export function saveClip(c: Clip) {
  write(c.dataset, { ...read(c.dataset), [c.id]: c })
}
export function removeClip(dataset: string, id: string) {
  const v = { ...read(dataset) }
  delete v[id]
  write(dataset, v)
}

export function getReviewer() {
  try { return localStorage.getItem('reviewer') ?? '' } catch { return '' }
}
export function setReviewer(name: string) {
  try { localStorage.setItem('reviewer', name) } catch { /* ignore */ }
}

// What training should do with the reviewed clips.
export function editList(dataset: string, fps: number) {
  const clips = Object.values(read(dataset)).filter((c) => c.verdict).sort((a, b) => a.episode - b.episode || a.from - b.from)
  return clips.map((c) => ({
    dataset: c.dataset,
    episode: c.episode,
    start_s: +(c.from / fps).toFixed(2),
    end_s: +(c.to / fps).toFixed(2),
    start_frame: c.from,
    end_frame: c.to,
    verdict: c.verdict,
    action: c.verdict === 'wrong' ? (c.fix === 'drop' ? 'drop_episode' : 'trim') : c.verdict === 'unsure' ? 'needs_second_look' : 'keep',
    reason: c.reason,
    note: c.note ?? '',
    reviewer: c.by ?? '',
    at: c.at ?? '',
  }))
}
