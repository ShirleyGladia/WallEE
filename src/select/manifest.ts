// The training manifest: which episodes of which datasets are used for train / validation / test,
// what was left out and why, and who decided. Train reads the latest one; Version & serve links to it.
import { useSyncExternalStore } from 'react'

export type Role = 'train' | 'validation' | 'test' | 'exclude'

export interface ManifestGroup {
  group: string // "Group 1"
  dataset: string
  role: Role
  eligibility: 'eligible' | 'eligible-with-exclusions' | 'not-eligible'
  episodes_total: number
  episodes: number[] // episodes used in this group's role (after exclusions and the validation hold-out)
  excluded: { episode: number; reason: string }[]
  trims: { episode: number; start_s: number; end_s: number; reason: string }[] // cut out; the episode is split there
  vlm?: { model: string; ok: number; problem: number; unsure: number; at: string }
}

export interface Manifest {
  schema: 'loop-console/training-manifest@1'
  id: string
  version: number
  created: string
  author: string
  reason: string
  task: string[]
  fps: number
  groups: ManifestGroup[]
  splits: Record<'train' | 'validation' | 'test', { dataset: string; episodes: number[] }[]>
  counts: Record<'train' | 'validation' | 'test' | 'excluded', number>
  checks: { rule: string; ok: boolean; detail: string }[]
  notes: { recompute_norm_stats: boolean; held_out_validation: string | null }
}

const KEY = 'manifests'
const listeners = new Set<() => void>()
let list: Manifest[] = load()
function load(): Manifest[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}
export function saveManifest(m: Manifest) {
  list = [m, ...list].slice(0, 30)
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* quota */ }
  listeners.forEach((l) => l())
}
export function useManifests() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => list)
}
export const latestManifest = () => list[0] ?? null
export const nextVersion = () => (list[0]?.version ?? 0) + 1

export function downloadManifest(m: Manifest) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${m.id}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
