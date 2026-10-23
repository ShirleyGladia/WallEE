// Evaluation runs written by tools/eval_writer.py on the GPU machine: <EVALS_DIR>/<run>/eval.json + videos/.
// The dev server serves them at /__evals (see vite-datasets.ts).
import { fk, isDuo } from '../ingest/kinematics'

export interface Rollout {
  seed: number
  episode: number | null // demonstration with the same start
  success: boolean
  duration_s: number
  failure: { t: number; reason: string } | null
  t: number[]
  state: number[][]
  demo_state?: number[][]
  video?: string
}
export interface OpenLoop { episode: number; t: number[]; demo: number[][]; pred: number[][] }
export interface EvalRun {
  schema: string
  name: string
  model: string
  checkpoint?: string | null
  manifest?: string | null
  dataset?: string | null
  task: string
  fps: number
  simulator?: string | null
  gpu?: string | null
  notes?: string | null
  created: string
  example?: boolean
  open_loop: OpenLoop[]
  rollouts: Rollout[]
  base: string // URL of the run folder
}

const API = `${import.meta.env.BASE_URL}__evals`

export async function listEvalRuns(): Promise<EvalRun[]> {
  try {
    const res = await fetch(API)
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return []
    const dirs = (await res.json()) as { name: string; files: { path: string }[] }[]
    const runs = await Promise.all(dirs.filter((d) => d.files.some((f) => f.path === 'eval.json')).map(async (d) => {
      const base = `${API}/${encodeURIComponent(d.name)}`
      try {
        const j = await (await fetch(`${base}/eval.json`)).json()
        return { open_loop: [], rollouts: [], ...j, name: j.name ?? d.name, base } as EvalRun
      } catch { return null }
    }))
    return runs.filter((r): r is EvalRun => !!r).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
  } catch {
    return []
  }
}

// Gripper tips of both arms per frame (x, y, z for each arm, metres).
export function tips(state: number[][]) {
  const duo = isDuo(state[0]?.length ?? 0)
  return state.map((q) => (duo ? [...fk(q, 0)[9], ...fk(q, 8)[9]] : [...fk(q, 0)[9]]))
}

// Dynamic time warping between two gripper paths: how far apart they are once timing is ignored (mm, mean per step).
export function dtw(a: number[][], b: number[][]) {
  const n = a.length, m = b.length
  if (!n || !m) return NaN
  const arms = a[0].length / 3
  const d = (i: number, j: number) => {
    let s = 0
    for (let k = 0; k < arms; k++) s += Math.hypot(a[i][3 * k] - b[j][3 * k], a[i][3 * k + 1] - b[j][3 * k + 1], a[i][3 * k + 2] - b[j][3 * k + 2])
    return s / arms
  }
  let prev = new Float64Array(m + 1).fill(Infinity)
  let len = new Float64Array(m + 1).fill(0)
  prev[0] = 0
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(Infinity)
    const cl = new Float64Array(m + 1)
    for (let j = 1; j <= m; j++) {
      const c = d(i - 1, j - 1)
      let best = prev[j - 1], bl = len[j - 1]
      if (prev[j] < best) { best = prev[j]; bl = len[j] }
      if (cur[j - 1] < best) { best = cur[j - 1]; bl = cl[j - 1] }
      cur[j] = c + best
      cl[j] = bl + 1
    }
    prev = cur
    len = cl
  }
  return (prev[m] / Math.max(1, len[m])) * 1000
}

export function openLoopError(o: OpenLoop) {
  const dims = o.demo[0]?.length ?? 0
  const perDim = new Array(dims).fill(0)
  const overTime = o.demo.map((row, i) => {
    let s = 0
    for (let d = 0; d < dims; d++) { const e = Math.abs((o.pred[i]?.[d] ?? NaN) - row[d]); perDim[d] += e; s += e }
    return s / dims
  })
  return { perDim: perDim.map((x) => x / Math.max(1, o.demo.length)), overTime, mean: overTime.reduce((s, x) => s + x, 0) / Math.max(1, overTime.length) }
}
