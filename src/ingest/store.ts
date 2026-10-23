// Holds the latest ingest result so other stages (dataset intelligence next) can use it.
import { useSyncExternalStore } from 'react'
import { analyzeDataset } from './analyze'
import { datasetName } from './collect'
import { fromUrl } from './source'
import type { IngestResult, InputFile } from './types'

interface State {
  result: IngestResult | null
  results: Record<string, IngestResult> // every dataset read in this session, by name (for Selection)
  checking: Record<string, { done: number; total: number } | 'error'>
  running: boolean
  progress: { label: string; done: number; total: number } | null
  error: string | null
}

let state: State = { result: null, results: {}, checking: {}, running: false, progress: null, error: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useIngest() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state)
}

export async function ingestFiles(picked: InputFile[], source: 'project' | 'upload' = 'upload', forcedName?: string) {
  if (!picked.length) return
  const { name, files } = datasetName(picked)
  set({ running: true, error: null, progress: { label: 'Starting', done: 0, total: 1 } })
  try {
    const result = await analyzeDataset(forcedName ?? name, files, source, (label, done, total) => set({ progress: { label, done, total } }))
    if (!result.files.some((f) => f.kind === 'data' || f.kind === 'video')) {
      set({ running: false, error: 'No parquet or MP4 files found. Choose the dataset folder (the one with data/, videos/ and meta/ inside), or the .parquet and .mp4 files themselves.' })
      return
    }
    set({ result, results: { ...state.results, [result.name]: result }, running: false, progress: null })
  } catch (e) {
    set({ running: false, error: (e as Error).message })
  }
}

// ---- datasets that live in the project (src/datasets/<name>), served by the dev server ----

export interface ProjectDataset {
  name: string
  bytes: number
  files: { path: string; size: number }[]
}

const API = `${import.meta.env.BASE_URL}__datasets`

export async function listProjectDatasets(): Promise<ProjectDataset[]> {
  try {
    const res = await fetch(API)
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return []
    const list = await res.json()
    return Array.isArray(list) ? list.filter((d) => d.files?.length) : []
  } catch {
    return [] // not running under the dev server (e.g. a static build)
  }
}

const projectFiles = (d: ProjectDataset): InputFile[] => d.files.map((f) => ({
  path: f.path,
  file: fromUrl(`${API}/${encodeURIComponent(d.name)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, f.size, f.path.split('/').pop()!),
}))

export async function ingestProjectDataset(d: ProjectDataset) {
  await ingestFiles(projectFiles(d), 'project', d.name)
}

// Read a project dataset in the background (Selection), without changing what Ingest shows.
export async function checkProjectDataset(d: ProjectDataset) {
  if (state.results[d.name] || typeof state.checking[d.name] === 'object') return state.results[d.name]
  set({ checking: { ...state.checking, [d.name]: { done: 0, total: 1 } } })
  try {
    const { files } = datasetName(projectFiles(d))
    const r = await analyzeDataset(d.name, files, 'project', (_, done, total) => set({ checking: { ...state.checking, [d.name]: { done, total } } }))
    const checking = { ...state.checking }
    delete checking[d.name]
    set({ results: { ...state.results, [d.name]: r }, checking })
    return r
  } catch {
    set({ checking: { ...state.checking, [d.name]: 'error' } })
    return undefined
  }
}

export function clearIngest() {
  set({ result: null, error: null, progress: null })
}
