// The only file that knows where data comes from.
// No VITE_API_URL → mock data (demo mode). With VITE_API_URL → real backend.
import { useEffect, useState } from 'react'
import * as mock from './mock'
import type {
  DatasetReport, Diagnosis, Endpoint, EvalReport, IngestReport, LoopStatus, LossPoint, ModelVersion, TrainRun,
} from './types'

const BASE: string = import.meta.env.VITE_API_URL ?? ''
export const DEMO_MODE = BASE === ''

async function get<T>(path: string, fallback: () => T): Promise<T> {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 150)) // feel like a network call
    return fallback()
  }
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown, fallback: () => T): Promise<T> {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 400))
    return fallback()
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json() as Promise<T>
}

// Suggested endpoints — rename to match the backend.
export const api = {
  loop: () => get<LoopStatus>('/loop', () => mock.loopStatus),
  ingest: () => get<IngestReport>('/ingest/report', () => mock.ingestReport),
  dataset: () => get<DatasetReport>('/dataset/report', () => mock.datasetReport),
  runs: () => get<TrainRun[]>('/train/runs', () => mock.trainRuns),
  loss: (runId: string) => get<LossPoint[]>(`/train/runs/${encodeURIComponent(runId)}/loss`, () => mock.lossCurve(5000, 3150)),
  startRun: (cfg: Record<string, unknown>) => post<{ id: string }>('/train/runs', cfg, () => ({ id: '#8' })),
  evaluation: (version: string) => get<EvalReport>(`/eval/${version}`, () => mock.evalReports[version] ?? mock.evalReports.v1),
  versions: () => get<ModelVersion[]>('/models', () => mock.versions),
  endpoints: () => get<Endpoint[]>('/serve/endpoints', () => mock.endpoints),
  deploy: (version: string, endpoint: string) => post<{ ok: boolean }>('/serve/deploy', { version, endpoint }, () => ({ ok: true })),
  diagnosis: (version: string) => get<Diagnosis>(`/diagnose/${version}`, () => mock.diagnosis),
  startNextCycle: (recommendations: string[]) => post<{ cycle: number }>('/loop/next', { recommendations }, () => ({ cycle: 3 })),
}

// Tiny data hook: const { data, error } = useApi(api.loop)
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    fn().then((d) => live && setData(d)).catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}
