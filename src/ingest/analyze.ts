// Reads a LeRobot dataset (v3.0 or v2.x, full folder or loose files) entirely in the browser
// and checks every episode. Nothing is uploaded anywhere.
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { ARMS, FR3, armJointDims, fk, gradient, isDuo } from './kinematics'
import { canPlay, readMp4, type Mp4Info } from './mp4'
import type { Source } from './source'
import type { CameraReport, EpisodeReport, Moment, FileKind, FileReport, IngestResult, InputFile, Progress, SchemaRow, Segments } from './types'

type Row = Record<string, unknown>
type Info = {
  codebase_version?: string
  robot_type?: string
  fps?: number
  total_episodes?: number
  features?: Record<string, { dtype?: string; shape?: number[]; names?: unknown }>
  splits?: { train?: string }
}

export const shortCam = (k: string) => k.replace(/^observation\.images\./, '').replace(/_/g, ' ')

const buf = (f: Source) => ({ byteLength: f.size, slice: (s: number, e?: number) => f.slice(s, e) })
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v))
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path, undefined, { numeric: true })
const fileIndex = (path: string) => {
  const m = /(?:file|episode)[-_](\d+)\.\w+$/.exec(path)
  return m ? Number(m[1]) : NaN
}

export function classify(path: string): FileKind {
  const p = path.toLowerCase()
  if (p.endsWith('info.json')) return 'info'
  if (p.endsWith('stats.json') || p.endsWith('stats.jsonl')) return 'stats'
  if (p.endsWith('tasks.parquet') || p.endsWith('tasks.jsonl')) return 'tasks'
  if ((p.includes('meta/episodes') && p.endsWith('.parquet')) || p.endsWith('episodes.jsonl')) return 'episodes-meta'
  if (p.endsWith('.parquet')) return 'data'
  if (/\.(mp4|m4v|mov)$/.test(p)) return 'video'
  return 'other'
}

function cameraKey(path: string) {
  const seg = path.split('/')
  const i = seg.indexOf('videos')
  if (i >= 0 && seg[i + 1]) return seg[i + 1].startsWith('chunk-') && seg[i + 2] && !seg[i + 2].includes('.') ? seg[i + 2] : seg[i + 1]
  return seg.length > 1 ? seg[seg.length - 2] : 'camera'
}

async function readParquet(f: Source, columns?: string[] | ((name: string) => boolean)) {
  const file = buf(f)
  const metadata = await parquetMetadataAsync(file)
  const tree = parquetSchema(metadata)
  const names = tree.children.map((c) => c.element.name)
  const leaf = (n: typeof tree): string | undefined => n.element.type ?? (n.children[0] ? leaf(n.children[0]) : undefined)
  const physical = Object.fromEntries(tree.children.map((c) => [c.element.name, leaf(c)]))
  const cols = !columns ? undefined : typeof columns === 'function' ? names.filter(columns) : columns.filter((c) => names.includes(c))
  const rows = (await parquetReadObjects({ file, metadata, columns: cols, compressors })) as Row[]
  return { names, rows, physical, numRows: Number(metadata.num_rows) }
}

interface Acc {
  episode: number
  file: string
  frames: number
  firstTs: number
  lastTs: number
  minDt: number
  maxDt: number
  frameBreak: boolean
  bad: number
  stateDims: Set<number>
  actionDims: Set<number>
  success: boolean | null
  min: number[]
  max: number[]
  split: boolean
  // kinematics: frames of the episode chunk being read, then the per-episode peaks
  buf: { t: number[]; q: number[][]; v: number[][]; a: number[][]; cmd: number[][] }
  health: Health
  peakSpeed: number
  peakSpeedPct: number
  peakAccel: number
  maxReach: number
  kinFromData: boolean
  // per-frame summaries for clip review, and markers of where problems are
  trace: { speed: number[]; reach: number[]; lowest: number[]; tcp: number[] }
  marks: Marks
  start: number[] | null
  intErr: number
  task: number | null
  path: number[][] // gripper tips (both arms) every third frame, for the behaviour signature
  rowStart: number
  rowEnd: number
}

const newAcc = (episode: number, file: string): Acc => ({
  episode, file, frames: 0, firstTs: NaN, lastTs: NaN, minDt: Infinity, maxDt: -Infinity, frameBreak: false, bad: 0,
  stateDims: new Set(), actionDims: new Set(), success: null, min: [], max: [], split: false,
  buf: { t: [], q: [], v: [], a: [], cmd: [] }, health: newHealth(), peakSpeed: 0, peakSpeedPct: 0, peakAccel: 0, maxReach: 0, kinFromData: false, rowStart: 0, rowEnd: 0,
  trace: { speed: [], reach: [], lowest: [], tcp: [] }, marks: { peakAt: 0 }, start: null, intErr: NaN, task: null, path: [],
})

// Per-episode signal health, compared with the rest of the dataset afterwards.
interface ArmHealth {
  rough: number // typical frame-to-frame jitter (median of the largest second difference), rad
  jump: number // largest single-frame jump (second difference), rad
  lag: number // frames by which readings follow commands (NaN if not measurable)
  residual: number // mean |command - reading| at that lag, rad
  stuck: { joint: number; frames: number; from: number; to: number } | null // reading frozen while its command moves
  jumpAt: number // frame of the largest jump
}
interface Health {
  arms: ArmHealth[]
  limits: string[] // joints beyond their FR3 limit
  grippers: string[] // grippers outside their normal range
  fingerprint: string
}
interface Marks {
  peakAt: number // frame of the fastest joint
  limit?: [number, number] // frames [from, to) where a joint is past its limit
  gripper?: [number, number]
  nonFinite?: [number, number]
}
const newHealth = (): Health => ({ arms: [], limits: [], grippers: [], fingerprint: '' })
const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : NaN
}

function armHealth(q: number[][], cmd: number[][], offset: number, moving: boolean): ArmHealth {
  const n = q.length
  const J = [0, 1, 2, 3, 4, 5, 6].map((j) => j + offset)
  // jitter
  const d2: number[] = []
  for (let i = 2; i < n; i++) {
    let m = 0
    for (const d of J) { const v = Math.abs(q[i][d] - 2 * q[i - 1][d] + q[i - 2][d]); if (v > m) m = v }
    d2.push(m)
  }
  // how commands relate to readings
  let lag = NaN, residual = NaN
  if (moving && cmd.length === n && cmd[0]?.length === q[0].length) {
    // Only frames where the arm is moving say anything about lag; sample them to keep this fast.
    const active: number[] = []
    for (let i = 1; i < n; i++) if (J.some((d) => Math.abs(q[i][d] - q[i - 1][d]) > 1e-4)) active.push(i)
    const step = Math.max(1, Math.floor(active.length / 80))
    const sample = active.filter((_, k) => k % step === 0)
    let best = Infinity
    for (let k = 0; k <= 20 && k < n - 10; k++) {
      let s = 0, c = 0
      for (const i0 of sample) {
        const i = i0 - k
        if (i < 0) continue
        for (const d of J) { const e = Math.abs(cmd[i][d] - q[i0][d]); if (Number.isFinite(e)) { s += e; c++ } }
      }
      const err = c ? s / c : Infinity
      if (err < best - 1e-9) { best = err; lag = k }
    }
    residual = best
  }
  // a reading that stays exactly the same while its command keeps changing
  let stuck: ArmHealth['stuck'] = null
  if (cmd.length === n && cmd[0]?.length === q[0].length) {
    for (const d of J) {
      let start = 0
      for (let i = 1; i <= n; i++) {
        if (i < n && q[i][d] === q[i - 1][d]) continue
        if (i - start >= 10) {
          // frames in this frozen stretch where the command is clearly somewhere else
          let off = 0
          for (let k = start; k < i; k++) if (Math.abs(cmd[k][d] - q[start][d]) > 0.02) off++
          if (off >= 10 && (!stuck || off > stuck.frames)) stuck = { joint: d - offset + 1, frames: off, from: start, to: i }
        }
        start = i
      }
    }
  }
  let jumpAt = 0, jump = 0
  d2.forEach((v, k) => { if (Number.isFinite(v) && v > jump) { jump = v; jumpAt = k + 1 } })
  return { rough: median(d2), jump, lag, residual, stuck, jumpAt }
}

// Turn the buffered frames of an episode into peak joint speed, acceleration, reach and signal health.
function finishKinematics(a: Acc) {
  const { t, q } = a.buf
  if (q.length && q[0].length >= 7) {
    const n = q[0].length
    const dims = armJointDims(n)
    const fromData = a.buf.v.length === q.length
    const V = fromData ? a.buf.v : gradient(q, t)
    const A = a.buf.a.length === q.length ? a.buf.a : gradient(V, t)
    a.kinFromData ||= fromData
    const base = a.trace.speed.length // frames already traced (episode split across files)
    if (!a.start) a.start = q[0].slice()
    const armList = isDuo(n) ? ARMS : ARMS.slice(0, 1)
    const tipsPrev: ([number, number, number] | null)[] = armList.map(() => null)
    for (let i = 0; i < V.length; i++) {
      let fs = 0
      for (const d of dims) {
        const sp = Math.abs(V[i][d])
        if (sp > a.peakSpeed) a.peakSpeed = sp
        const pct = sp / FR3.vMax[isDuo(n) ? d % 8 : d]
        if (pct > a.peakSpeedPct) { a.peakSpeedPct = pct; a.marks.peakAt = base + i }
        if (pct > fs) fs = pct
        const ac = Math.abs(A[i]?.[d] ?? 0)
        if (ac > a.peakAccel) a.peakAccel = ac
      }
      let fr = 0, low = Infinity, tcp = 0
      const keep = (base + i) % 3 === 0
      const row: number[] = []
      armList.forEach((arm, k) => {
        const pts = fk(q[i], arm.offset)
        const f = pts[8]
        const r = Math.hypot(f[0] - FR3.shoulder[0], f[1] - FR3.shoulder[1], f[2] - FR3.shoulder[2]) / FR3.reach
        if (r > a.maxReach) a.maxReach = r
        if (r > fr) fr = r
        for (let p = 2; p < pts.length; p++) if (pts[p][2] < low) low = pts[p][2]
        const tip = pts[9], prev = tipsPrev[k]
        const dt = i > 0 ? t[i] - t[i - 1] : 0
        if (prev && dt > 0) tcp = Math.max(tcp, Math.hypot(tip[0] - prev[0], tip[1] - prev[1], tip[2] - prev[2]) / dt * 1000)
        tipsPrev[k] = tip
        if (keep) row.push(tip[0], tip[1], tip[2])
      })
      if (keep && row.every(Number.isFinite)) a.path.push(row)
      a.trace.speed.push(Number.isFinite(fs) ? fs : 0)
      a.trace.reach.push(Number.isFinite(fr) ? fr : 0)
      a.trace.lowest.push(Number.isFinite(low) ? low : 0)
      a.trace.tcp.push(Number.isFinite(tcp) ? tcp : 0)
    }
    if (a.trace.tcp.length > base + 1) a.trace.tcp[base] = a.trace.tcp[base + 1]
    // Velocity columns in the data: integrate them over 1 s and compare with how far the joints really moved.
    if (fromData) {
      const k = Math.max(1, Math.round(1 / Math.max(1e-6, (t[t.length - 1] - t[0]) / Math.max(1, t.length - 1))))
      const cum: number[][] = [dims.map(() => 0)]
      for (let i = 1; i < V.length; i++) {
        const dt = t[i] - t[i - 1]
        cum.push(dims.map((d, j) => cum[i - 1][j] + 0.5 * (V[i][d] + V[i - 1][d]) * dt))
      }
      let worst = 0
      for (let i = 0; i + k < q.length; i += Math.max(1, Math.floor(k / 2))) {
        dims.forEach((d, j) => {
          const e = Math.abs((cum[i + k][j] - cum[i][j]) - (q[i + k][d] - q[i][d]))
          if (Number.isFinite(e) && e > worst) worst = e
        })
      }
      a.intErr = Math.max(Number.isFinite(a.intErr) ? a.intErr : 0, worst)
    }
    // signal health per arm
    const arms = isDuo(n) ? ARMS : ARMS.slice(0, 1)
    a.health.arms = arms.map((arm) => {
      let lo = Infinity, hi = -Infinity
      for (const row of q) for (let j = 0; j < 7; j++) { const v = row[arm.offset + j]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
      const h = armHealth(q, a.buf.cmd, arm.offset, hi - lo > 1e-3)
      h.jumpAt += base
      if (h.stuck) { h.stuck.from += base; h.stuck.to += base }
      return h
    })
    // first and last frame where a test fails
    const span = (test: (row: number[]) => boolean): [number, number] | undefined => {
      let s = -1, e = -1
      q.forEach((row, i) => { if (test(row)) { if (s < 0) s = i; e = i } })
      return s < 0 ? undefined : [base + s, base + e + 1]
    }
    for (const arm of arms) {
      for (let j = 0; j < 7; j++) {
        const d = arm.offset + j
        const w = span((row) => row[d] < FR3.qMin[j] - 0.01 || row[d] > FR3.qMax[j] + 0.01)
        if (w) { a.health.limits.push(`${arm.name} joint ${j + 1}`); a.marks.limit ??= w }
      }
      if (isDuo(n)) {
        const g = arm.offset + 7
        const w = span((row) => row[g] < -0.05 || row[g] > 1.1)
        if (w) { a.health.grippers.push(arm.name.replace(' arm', '').toLowerCase()); a.marks.gripper ??= w }
      }
    }
    const nf = span((row) => row.some((v) => !Number.isFinite(v)))
    if (nf) a.marks.nonFinite ??= nf
    // fingerprint for duplicate detection
    // fingerprint of the first 60 frames: catches exact and cut-short copies of another episode
    const head = q.slice(0, 60)
    let h = 0
    for (let i = 0; i < head.length; i++) for (let d = 0; d < head[i].length; d++) if (Number.isFinite(head[i][d])) h += head[i][d] * (((i * 31 + d) % 97) + 1)
    a.health.fingerprint = head.length >= 30 ? `${head[0].length}:${h.toFixed(5)}` : ''
  }
  a.buf = { t: [], q: [], v: [], a: [], cmd: [] }
}

// Gripper paths resampled to 16 moments in time: two episodes with close signatures did the same thing.
function signature(path: number[][]): number[] | undefined {
  if (path.length < 4) return undefined
  const out: number[] = []
  for (let k = 0; k < 16; k++) {
    const x = (k / 15) * (path.length - 1)
    const i = Math.floor(x), w = x - i
    const a = path[i], b = path[Math.min(path.length - 1, i + 1)]
    for (let d = 0; d < a.length; d++) out.push(Math.round((a[d] * (1 - w) + b[d] * w) * 1e4) / 1e4)
  }
  return out
}

const MEANINGS: Record<string, string> = {
  'observation.state': 'Robot joint positions in each frame',
  action: 'Joint targets the expert commanded in each frame',
  success: 'Whether the frame belongs to a successful demonstration',
  timestamp: 'Seconds since the start of the episode',
  frame_index: 'Frame number within the episode',
  episode_index: 'Which episode the frame belongs to',
  index: 'Frame number across the whole dataset',
  task_index: 'Which language instruction the episode follows',
  'observation.velocity': 'Joint speeds in each frame (rad/s)',
  'observation.acceleration': 'Joint accelerations in each frame (rad/s²)',
}

function describeVector(n: number, min: number[], max: number[]) {
  const looksGripper = (d: number) => min[d] >= -0.05 && max[d] <= 1.1
  if (n === 16 && looksGripper(7) && looksGripper(15)) return '16 values: 2 arms × (7 joints + gripper)'
  if (n === 8 && looksGripper(7)) return '8 values: 7 joints + gripper'
  return `${n} values`
}

const PHYSICAL: Record<string, string> = { FLOAT: 'float32', DOUBLE: 'float64', INT64: 'int64', INT32: 'int32', BOOLEAN: 'bool', BYTE_ARRAY: 'text' }

function typeOf(v: unknown, physical?: string): string {
  const t = physical ? PHYSICAL[physical] ?? physical.toLowerCase() : undefined
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const arr = v as ArrayLike<unknown>
    return `${arr.length} × ${t ?? (typeof arr[0] === 'bigint' ? 'int' : 'float')}`
  }
  if (t) return t
  if (typeof v === 'bigint') return 'int64'
  if (typeof v === 'number') return Number.isInteger(v) ? 'number' : 'float'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'text'
  return typeof v
}

export async function analyzeDataset(name: string, input: InputFile[], source: 'project' | 'upload', onProgress: Progress): Promise<IngestResult> {
  const files = [...input].sort(byPath)
  const kinds = files.map((f) => ({ ...f, kind: classify(f.path) }))
  const of = (k: FileKind) => kinds.filter((f) => f.kind === k)
  const dataFiles = of('data')
  const videoFiles = of('video')
  const total = dataFiles.length + videoFiles.length + 2
  let step = 0
  const tick = (label: string) => onProgress(label, ++step, total)

  const reports: FileReport[] = []
  const gaps: string[] = []

  // ---- metadata ----
  let info: Info | null = null
  for (const f of of('info')) {
    try {
      info = JSON.parse(await f.file.text())
      reports.push({ path: f.path, kind: 'info', bytes: f.file.size, status: 'ok', detail: `${info?.codebase_version ?? 'unknown version'} · ${info?.total_episodes ?? '?'} episodes · ${info?.fps ?? '?'} fps` })
    } catch {
      reports.push({ path: f.path, kind: 'info', bytes: f.file.size, status: 'error', detail: 'Not valid JSON' })
    }
  }

  const tasks: string[] = []
  for (const f of of('tasks')) {
    try {
      if (f.path.endsWith('.jsonl')) {
        for (const line of (await f.file.text()).split('\n').filter(Boolean)) tasks.push(String(JSON.parse(line).task))
      } else {
        const { rows } = await readParquet(f.file)
        for (const r of rows) {
          const text = Object.values(r).find((v) => typeof v === 'string')
          if (text) tasks.push(text as string)
        }
      }
      reports.push({ path: f.path, kind: 'tasks', bytes: f.file.size, status: 'ok', detail: `${tasks.length} task${tasks.length === 1 ? '' : 's'}` })
    } catch (e) {
      reports.push({ path: f.path, kind: 'tasks', bytes: f.file.size, status: 'error', detail: `Couldn’t read: ${(e as Error).message}` })
    }
  }

  const epMeta = new Map<number, Row>()
  for (const f of of('episodes-meta')) {
    try {
      const rows: Row[] = f.path.endsWith('.jsonl')
        ? (await f.file.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : (await readParquet(f.file, (n) => !n.startsWith('stats/'))).rows
      for (const r of rows) epMeta.set(num(r.episode_index), r)
      reports.push({ path: f.path, kind: 'episodes-meta', bytes: f.file.size, status: 'ok', detail: `${rows.length} episode records` })
    } catch (e) {
      reports.push({ path: f.path, kind: 'episodes-meta', bytes: f.file.size, status: 'error', detail: `Couldn’t read: ${(e as Error).message}` })
    }
  }
  let stats: IngestResult['stats']
  for (const f of of('stats')) {
    if (!f.path.endsWith('stats.json') || f.path.includes('norm_stats')) continue
    try {
      const j = JSON.parse(await f.file.text()) as Record<string, { count?: number[] | number }>
      const c = j['observation.state']?.count ?? Object.values(j).find((x) => x?.count !== undefined)?.count
      stats = { file: f.path, count: c === undefined ? null : Number(Array.isArray(c) ? c[0] : c) }
    } catch { /* reported below as skipped */ }
  }
  for (const f of [...of('stats'), ...of('other')]) {
    reports.push({ path: f.path, kind: f.kind, bytes: f.file.size, status: 'skipped', detail: f.kind === 'stats' ? 'Normalisation stats (used by training)' : 'Not part of a LeRobot dataset' })
  }
  tick('Read metadata')

  // ---- frame data ----
  const accs = new Map<number, Acc>()
  const schema = new Map<string, SchemaRow>()
  const gMin: number[] = []
  const gMax: number[] = []
  const NEEDED = ['episode_index', 'frame_index', 'timestamp', 'observation.state', 'action', 'success', 'task_index', 'index', 'observation.velocity', 'observation.acceleration']
  const dataSources: Record<string, Source> = {}

  for (const f of dataFiles) {
    try {
      const { names, rows, physical } = await readParquet(f.file, NEEDED)
      const missing = ['episode_index', 'timestamp', 'observation.state', 'action'].filter((c) => !names.includes(c))
      if (rows[0]) for (const c of names) if (!schema.has(c)) schema.set(c, { column: c, type: c in rows[0] ? typeOf(rows[0][c], physical[c]) : PHYSICAL[physical[c] ?? ''] ?? 'other', meaning: MEANINGS[c] ?? '' })
      if (missing.includes('episode_index')) {
        reports.push({ path: f.path, kind: 'data', bytes: f.file.size, status: 'error', detail: 'No episode_index column, so this isn’t LeRobot frame data', rows: rows.length })
        tick(f.path)
        continue
      }
      dataSources[f.path] = f.file
      let cur: Acc | null = null
      let prevTs = NaN
      let prevFrame = NaN
      let lo = Infinity
      let hi = -Infinity
      for (let ri = 0; ri < rows.length; ri++) {
        const r = rows[ri]
        const ep = num(r.episode_index)
        if (!cur || cur.episode !== ep) {
          if (cur) finishKinematics(cur)
          cur = accs.get(ep) ?? null
          if (cur) cur.split = cur.file !== f.path || cur.split
          else { cur = newAcc(ep, f.path); cur.rowStart = ri; accs.set(ep, cur) }
          prevTs = NaN
          prevFrame = NaN
          lo = Math.min(lo, ep)
          hi = Math.max(hi, ep)
        }
        const ts = num(r.timestamp)
        const fr = r.frame_index === undefined ? NaN : num(r.frame_index)
        if (cur.frames === 0) {
          cur.firstTs = ts
          if (!Number.isNaN(fr) && fr !== 0) cur.frameBreak = true
        } else {
          const dt = ts - prevTs
          if (dt < cur.minDt) cur.minDt = dt
          if (dt > cur.maxDt) cur.maxDt = dt
          if (!Number.isNaN(fr) && fr !== prevFrame + 1) cur.frameBreak = true
        }
        prevTs = ts
        prevFrame = fr
        cur.lastTs = ts
        cur.frames++
        cur.rowEnd = ri + 1
        if (!Number.isFinite(ts)) cur.bad++
        const st = r['observation.state'] as ArrayLike<number> | undefined
        const ac = r.action as ArrayLike<number> | undefined
        if (st) {
          cur.stateDims.add(st.length)
          for (let d = 0; d < st.length; d++) {
            const v = st[d]
            if (!Number.isFinite(v)) { cur.bad++; continue }
            if (cur.min[d] === undefined || v < cur.min[d]) cur.min[d] = v
            if (cur.max[d] === undefined || v > cur.max[d]) cur.max[d] = v
            if (gMin[d] === undefined || v < gMin[d]) gMin[d] = v
            if (gMax[d] === undefined || v > gMax[d]) gMax[d] = v
          }
        } else cur.bad++
        if (ac) {
          cur.actionDims.add(ac.length)
          for (let d = 0; d < ac.length; d++) if (!Number.isFinite(ac[d])) cur.bad++
        } else cur.bad++
        if (typeof r.success === 'boolean') cur.success = (cur.success ?? true) && r.success
        if (cur.task === null && r.task_index !== undefined && r.task_index !== null) cur.task = num(r.task_index)
        if (st) {
          cur.buf.t.push(ts)
          cur.buf.q.push(Array.from(st))
          if (ac) cur.buf.cmd.push(Array.from(ac))
          const vel = r['observation.velocity'] as ArrayLike<number> | undefined
          const acc = r['observation.acceleration'] as ArrayLike<number> | undefined
          if (vel) cur.buf.v.push(Array.from(vel))
          if (acc) cur.buf.a.push(Array.from(acc))
        }
      }
      if (cur) finishKinematics(cur)
      const n = hi >= lo ? hi - lo + 1 : 0
      reports.push({
        path: f.path, kind: 'data', bytes: f.file.size, rows: rows.length, episodeRange: n ? [lo, hi] : undefined,
        status: missing.length ? 'warn' : 'ok',
        detail: missing.length ? `Missing ${missing.join(', ')}` : `${rows.length.toLocaleString()} frames · episodes ${lo}–${hi}`,
      })
    } catch (e) {
      reports.push({ path: f.path, kind: 'data', bytes: f.file.size, status: 'error', detail: `Couldn’t read: ${(e as Error).message}` })
    }
    tick(f.path)
  }

  // ---- fps ----
  const list = [...accs.values()].sort((a, b) => a.episode - b.episode)
  let fps = info?.fps ?? NaN
  let fpsSource: IngestResult['fpsSource'] = 'info.json'
  if (!fps) {
    const rates = list.filter((a) => a.frames > 2 && a.lastTs > a.firstTs).map((a) => (a.frames - 1) / (a.lastTs - a.firstTs)).sort((a, b) => a - b)
    fps = rates.length ? Math.round(rates[Math.floor(rates.length / 2)] * 100) / 100 : 30
    fpsSource = 'timestamps'
  }

  // ---- expected vector sizes ----
  const mode = (sets: Set<number>[]) => {
    const count = new Map<number, number>()
    for (const s of sets) for (const v of s) count.set(v, (count.get(v) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  }
  const stateN = info?.features?.['observation.state']?.shape?.[0] ?? mode(list.map((a) => a.stateDims))
  const actionN = info?.features?.action?.shape?.[0] ?? mode(list.map((a) => a.actionDims))

  // ---- videos ----
  // Cameras the dataset declares (info.json features, or the episode index columns).
  const firstMeta = epMeta.values().next().value as Row | undefined
  const declared = [...new Set([
    ...Object.entries(info?.features ?? {}).filter(([, f]) => f.dtype === 'video').map(([k]) => k),
    ...Object.keys(firstMeta ?? {}).filter((c) => /^videos\/.+\/to_timestamp$/.test(c)).map((c) => c.slice(7, -13)),
  ])]
  // Where each video file should end, per camera, according to the episode index.
  const fileEnd = new Map<string, number>()
  const filesPerCam = new Map<string, Set<number>>()
  for (const r of epMeta.values()) {
    for (const cam of declared) {
      const fi = r[`videos/${cam}/file_index`]
      const to = r[`videos/${cam}/to_timestamp`]
      if (fi === undefined || to === undefined) continue
      const k = `${cam}|${num(fi)}`
      fileEnd.set(k, Math.max(fileEnd.get(k) ?? 0, num(to)))
      filesPerCam.set(cam, (filesPerCam.get(cam) ?? new Set()).add(num(fi)))
    }
  }

  type Probe = { path: string; size: number; fi: number; meta: Mp4Info | null; playable: boolean; url: string }
  const groups = new Map<string, Probe[]>()
  // Read MP4 headers a few files at a time; each needs only a couple of small byte ranges.
  const probed: Probe[] = new Array(videoFiles.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(6, videoFiles.length) }, async () => {
    while (next < videoFiles.length) {
      const i = next++
      const v = videoFiles[i]
      const meta = await readMp4(v.file).catch(() => null)
      probed[i] = { path: v.path, size: v.file.size, fi: fileIndex(v.path), meta, playable: false, url: v.file.url() }
      tick(v.path)
    }
  }))
  for (const p of probed) {
    const k = cameraKey(p.path)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  // Whether the browser can decode a camera's videos is the same for all its files, so test one.
  for (const probes of groups.values()) {
    const ok = probes[0] ? await canPlay(probes[0].url) : false
    for (const p of probes) p.playable = ok
  }
  // A folder that isn't named after a camera (e.g. "video/") is matched to one by its file lengths.
  const byCam = new Map<string, { probes: Probe[]; matchedFrom?: string }>()
  for (const [raw, probes] of groups) {
    let key = raw
    let matchedFrom: string | undefined
    if (declared.length && !declared.includes(raw)) {
      const fits = declared.filter((cam) => probes.every((p) => {
        const end = fileEnd.get(`${cam}|${p.fi}`)
        return end !== undefined && !!p.meta && Math.abs(p.meta.durationS - end) <= 1.5 / fps
      }))
      if (fits.length === 1) { key = fits[0]; matchedFrom = raw }
    }
    const prev = byCam.get(key)
    byCam.set(key, { probes: [...(prev?.probes ?? []), ...probes], matchedFrom: prev?.matchedFrom ?? matchedFrom })
  }

  const cameras: CameraReport[] = []
  const coverage = new Map<number, boolean>() // episode -> covered by every camera
  const camIssues = new Map<number, string[]>() // episode -> camera problems that affect it
  const rotated = new Map<string, number>() // "camera|file index" -> rotation in degrees
  const epDur = (a: Acc) => a.frames / fps

  for (const [key, { probes, matchedFrom }] of byCam) {
    const cam: CameraReport = {
      key, matchedFrom, files: probes.map((p) => p.path), durationS: 0, expectedS: list.reduce((s, a) => s + epDur(a), 0),
      coveredEpisodes: 0, playable: false, expectedFiles: filesPerCam.get(key)?.size, fileUrls: {},
    }
    const durations = new Map<number, number>()
    for (const p of probes) {
      if (p.playable && !cam.previewUrl) cam.previewUrl = p.url
      cam.fileUrls[p.fi] = p.url
      cam.playable ||= p.playable
      const d = p.meta?.durationS ?? NaN
      if (Number.isFinite(d)) { cam.durationS += d; durations.set(p.fi, d) }
      cam.width ??= p.meta?.width
      cam.height ??= p.meta?.height
      const end = fileEnd.get(`${key}|${p.fi}`)
      const short = end !== undefined && Number.isFinite(d) && d + 1 / fps < end
      // compare with what info.json declares for this camera
      const decl = info?.features?.[key] as { info?: Record<string, unknown> } | undefined
      const dCodec = String(decl?.info?.['video.codec'] ?? '').toLowerCase()
      const codecName: Record<string, string> = { av1: 'AV1', libaom: 'AV1', h264: 'H.264', libx264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', vp9: 'VP9' }
      const problems: string[] = []
      if (p.meta?.rotation) problems.push(`picture rotated ${p.meta.rotation}°`)
      if (p.meta && dCodec && codecName[dCodec] && p.meta.codec !== codecName[dCodec]) problems.push(`codec ${p.meta.codec}, info.json says ${codecName[dCodec]}`)
      const dw = Number(decl?.info?.['video.width']), dh = Number(decl?.info?.['video.height'])
      if (p.meta && dw && dh && (p.meta.width !== dw || p.meta.height !== dh)) problems.push(`${p.meta.width}×${p.meta.height}, info.json says ${dw}×${dh}`)
      if (p.meta?.rotation) rotated.set(`${key}|${p.fi}`, p.meta.rotation)
      reports.push({
        path: p.path, kind: 'video', bytes: p.size, camera: key, durationS: d, width: p.meta?.width, height: p.meta?.height,
        status: !p.meta || short || problems.length ? 'error' : p.playable ? 'ok' : 'warn',
        detail: !p.meta
          ? 'Not a readable MP4'
          : `${shortCam(key)} · ${p.meta.codec} · ${p.meta.width}×${p.meta.height} · ${formatDuration(d)}`
            + (short ? ` · ends ${(end! - d).toFixed(1)} s early` : '')
            + (problems.length ? ` · ${problems.join(' · ')}` : '')
            + (p.playable ? '' : ' · this browser can’t play it'),
      })
    }
    // Which loaded episodes does this camera cover?
    const hasMeta = list.some((a) => epMeta.get(a.episode)?.[`videos/${key}/to_timestamp`] !== undefined)
    let cumulative = 0
    for (const a of list) {
      let ok: boolean
      const m = epMeta.get(a.episode)
      if (hasMeta && m) {
        const fi = num(m[`videos/${key}/file_index`])
        const d = durations.get(fi)
        ok = d !== undefined && num(m[`videos/${key}/to_timestamp`]) <= d + 1 / fps
        const rot = rotated.get(`${key}|${fi}`)
        if (rot) camIssues.set(a.episode, [...(camIssues.get(a.episode) ?? []), `${shortCam(key)} picture rotated ${rot}°`])
      } else {
        cumulative += epDur(a) // v3 video files hold whole episodes back to back
        ok = cumulative <= cam.durationS + 1 / fps
      }
      if (ok) cam.coveredEpisodes++
      coverage.set(a.episode, (coverage.get(a.episode) ?? true) && ok)
    }
    cameras.push(cam)
  }
  cameras.sort((a, b) => a.key.localeCompare(b.key))

  // Where each loaded episode sits in each camera's files, for the episode viewer.
  const segments: Segments = {}
  for (const a of list) {
    const m = epMeta.get(a.episode)
    if (!m) continue
    for (const c of cameras) {
      const fi = m[`videos/${c.key}/file_index`]
      if (fi === undefined || c.fileUrls[num(fi)] === undefined) continue
      ;(segments[a.episode] ??= {})[c.key] = { fi: num(fi), from: num(m[`videos/${c.key}/from_timestamp`]), to: num(m[`videos/${c.key}/to_timestamp`]) }
    }
  }
  for (const k of declared) {
    if (!schema.has(k)) schema.set(k, { column: k, type: 'video', meaning: 'Camera frames, stored as MP4 in videos/' })
  }

  // ---- per-episode verdicts ----
  const minFrames = Math.max(10, Math.round(2 * fps))
  // What "normal" looks like in this dataset, to judge each episode against.
  const allArms = list.flatMap((a) => a.health.arms)
  const moving = allArms.filter((h) => h.rough > 1e-6)
  const roughMed = median(moving.map((h) => h.rough))
  const jumpMed = median(moving.map((h) => h.jump))
  const resMed = median(allArms.map((h) => h.residual))
  const lagCounts = new Map<number, number>()
  for (const h of allArms) if (Number.isFinite(h.lag)) lagCounts.set(h.lag, (lagCounts.get(h.lag) ?? 0) + 1)
  const lagMode = [...lagCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? NaN
  const seen = new Map<string, number>()
  const episodes: EpisodeReport[] = list.map((a) => {
    const errors: string[] = []
    const warnings: string[] = []
    const armNames = a.health.arms.length === 2 ? ARMS.map((x) => x.name) : ['Arm']
    for (const l of a.health.limits) errors.push(`${l} beyond its FR3 limit`)
    for (const g of a.health.grippers) errors.push(`${g[0].toUpperCase()}${g.slice(1)} gripper outside its range`)
    if (a.peakSpeedPct > 1) errors.push(`Joint speed ${Math.round(a.peakSpeedPct * 100)}% of the FR3 limit (sensor glitch?)`)
    a.health.arms.forEach((h, k) => {
      const name = armNames[k]
      if (Number.isFinite(h.lag) && Number.isFinite(lagMode) && Math.abs(h.lag - lagMode) >= 2) {
        errors.push(`${name} readings lag its commands by ${((h.lag - lagMode) / fps).toFixed(1)} s (out of sync)`)
      } else if (h.stuck && h.stuck.frames >= 3 * fps) {
        errors.push(`${name} joint ${h.stuck.joint} stuck for ${(h.stuck.frames / fps).toFixed(0)} s`)
      } else if (Number.isFinite(roughMed) && h.rough > Math.max(3 * roughMed, roughMed + 0.005)) {
        warnings.push(`Noisy joint readings (${name.toLowerCase()}): jitter ${(h.rough * 1000).toFixed(0)} mrad per frame`)
      } else if (Number.isFinite(jumpMed) && h.jump > Math.max(0.15, 10 * jumpMed)) {
        errors.push(`${name} readings jump ${h.jump.toFixed(2)} rad in one frame (sensor spike)`)
      } else if (Number.isFinite(h.residual) && h.residual > Math.max(0.01, 10 * (resMed || 0))) {
        errors.push(`${name} readings drift away from its commands`)
      }
    })
    if (a.health.fingerprint) {
      const twin = seen.get(a.health.fingerprint)
      if (twin !== undefined) errors.push(`Duplicate of episode ${twin}`)
      else seen.set(a.health.fingerprint, a.episode)
    }
    for (const w of camIssues.get(a.episode) ?? []) warnings.push(w)
    if (a.bad) errors.push(`${a.bad} missing or non-numeric values`)
    if (a.frameBreak) errors.push('Frame numbers skip or restart')
    if (a.minDt <= 0) errors.push('Timestamps go backwards or repeat')
    else if (a.maxDt > 2 / fps) errors.push(`Gap of ${a.maxDt.toFixed(2)} s between frames`)
    if (a.frames < minFrames) errors.push(`Only ${a.frames} frames (under 2 s)`)
    if (stateN && [...a.stateDims].some((d) => d !== stateN)) errors.push(`State size differs from ${stateN}`)
    if (actionN && [...a.actionDims].some((d) => d !== actionN)) errors.push(`Action size differs from ${actionN}`)
    const metaLen = epMeta.get(a.episode)?.length
    if (metaLen !== undefined && num(metaLen) !== a.frames) errors.push(`Metadata says ${num(metaLen)} frames, data has ${a.frames}`)
    const motion = a.min.reduce((m, lo, d) => Math.max(m, (a.max[d] ?? lo) - lo), 0)
    if (motion < 1e-3) warnings.push('Robot never moves')
    if (a.success === false) warnings.push('Marked unsuccessful')
    if (a.split) warnings.push('Split across files')
    const covered = byCam.size ? coverage.get(a.episode) ?? false : null
    if (covered === false) warnings.push('No video for this episode')
    if (Number.isFinite(a.intErr) && a.intErr > 0.05) warnings.push(`Velocity column doesn’t add up to the joint movement (${a.intErr.toFixed(2)} rad off over 1 s)`)
    // Where in the episode each problem is, for clip review.
    const armsH = a.health.arms
    const big = armsH.reduce((b, h, k) => (h.jump > (armsH[b]?.jump ?? -1) ? k : b), 0)
    const stuckArm = armsH.find((h) => h.stuck)
    const moments: Moment[] = []
    const fr = (s: number, e: number) => ({ from: Math.max(0, s), to: Math.min(a.frames, e) })
    const pad = Math.round(2 * fps)
    for (const msg of errors) {
      if (/jump .* rad in one frame/.test(msg) && armsH[big]) moments.push({ ...fr(armsH[big].jumpAt - pad, armsH[big].jumpAt + pad), kind: 'spike', reason: msg })
      else if (/stuck for/.test(msg) && stuckArm?.stuck) moments.push({ ...fr(stuckArm.stuck.from - pad / 2, Math.min(stuckArm.stuck.to, stuckArm.stuck.from + 4 * fps) + pad / 2), kind: 'stuck', reason: msg })
      else if (/FR3 limit$/.test(msg) && a.marks.limit) moments.push({ ...fr(a.marks.limit[0] - pad, a.marks.limit[0] + pad), kind: 'limit', reason: msg })
      else if (/gripper outside/.test(msg) && a.marks.gripper) moments.push({ ...fr(a.marks.gripper[0] - pad, a.marks.gripper[0] + pad), kind: 'gripper', reason: msg })
      else if (/non-numeric/.test(msg) && a.marks.nonFinite) moments.push({ ...fr(a.marks.nonFinite[0] - pad, a.marks.nonFinite[0] + pad), kind: 'missing', reason: msg })
      else if (/sensor glitch/.test(msg)) moments.push({ ...fr(a.marks.peakAt - pad, a.marks.peakAt + pad), kind: 'spike', reason: msg })
      else if (/out of sync|drift away/.test(msg)) moments.push({ ...fr(a.marks.peakAt - pad, a.marks.peakAt + pad), kind: 'sync', reason: msg })
    }
    for (const w of camIssues.get(a.episode) ?? []) moments.push({ ...fr(0, 3 * pad), kind: 'camera', reason: w })
    return {
      episode: a.episode, file: a.file, frames: a.frames, durationS: a.frames / fps, success: a.success,
      motion, errors, warnings, videoCovered: covered,
      peakSpeed: a.peakSpeed, peakSpeedPct: a.peakSpeedPct, peakAccel: a.peakAccel, maxReach: a.maxReach,
      rows: a.split ? undefined : { file: a.file, start: a.rowStart, end: a.rowEnd },
      trace: a.trace.speed.length ? {
        speed: Float32Array.from(a.trace.speed), reach: Float32Array.from(a.trace.reach),
        lowest: Float32Array.from(a.trace.lowest), tcp: Float32Array.from(a.trace.tcp),
      } : undefined,
      moments, start: a.start ?? undefined, fingerprint: a.health.fingerprint || undefined,
      intErr: Number.isFinite(a.intErr) ? a.intErr : undefined,
      task: a.task,
      sig: signature(a.path),
    }
  })

  // ---- gaps ----
  const valid = episodes.filter((e) => e.errors.length === 0).length
  const invalid = episodes.length - valid
  if (!info) gaps.push(`No meta/info.json, so the frame rate (${fps} fps) was worked out from the timestamps.`)
  const notLoaded = [...epMeta.keys()].filter((e) => !accs.has(e))
  if (notLoaded.length) {
    const missingFiles = [...new Set(notLoaded.map((e) => num(epMeta.get(e)!['data/file_index'])).filter(Number.isFinite))].sort((a, b) => a - b)
    const name = (i: number) => `file-${String(i).padStart(3, '0')}`
    const range = missingFiles.length > 1 && missingFiles.at(-1)! - missingFiles[0] === missingFiles.length - 1
      ? `${name(missingFiles[0])} to ${name(missingFiles.at(-1)!)}`
      : missingFiles.map(name).join(', ')
    gaps.push(`Loaded ${episodes.length} of ${epMeta.size} episodes. The other ${notLoaded.length} are in data/chunk-000/${range}.parquet.`)
  } else if (info?.total_episodes && info.total_episodes > episodes.length) {
    gaps.push(`Loaded ${episodes.length} of the ${info.total_episodes} episodes listed in info.json.`)
  }
  const split = /^(\d+):(\d+)$/.exec(info?.splits?.train ?? '')
  const totalEps = info?.total_episodes ?? epMeta.size
  if (split && totalEps && Number(split[2]) - Number(split[1]) < totalEps) {
    gaps.push(`info.json marks only episodes ${split[1]}–${Number(split[2]) - 1} as the training split (${Number(split[2]) - Number(split[1])} of ${totalEps}). A trainer that reads splits will skip the rest.`)
  }
  if (!videoFiles.length) gaps.push('No videos loaded. A VLA learns from the camera frames, so add the videos folder.')
  for (const k of declared) if (videoFiles.length && !byCam.has(k)) gaps.push(`No videos loaded for ${shortCam(k)}.`)
  for (const c of cameras) {
    const files = c.expectedFiles ? `${c.files.length} of ${c.expectedFiles} video files` : `${c.files.length} video file${c.files.length === 1 ? '' : 's'}`
    if (c.coveredEpisodes < episodes.length || (c.expectedFiles && c.files.length < c.expectedFiles)) {
      gaps.push(`${shortCam(c.key)}: ${files} loaded, covering ${c.coveredEpisodes} of the ${episodes.length} loaded episodes.`)
    }
    if (!c.playable) gaps.push(`This browser can’t play the ${shortCam(c.key)} videos. The files are fine; open the page in Chrome to preview them.`)
  }
  const badVideos = reports.filter((r) => r.kind === 'video' && r.status === 'error')
  if (badVideos.length) gaps.push(`${badVideos.length} video file${badVideos.length === 1 ? ' has' : 's have'} problems: ${badVideos.slice(0, 3).map((r) => `${r.path.split('/').slice(-3, -2)[0]?.replace('observation.images.', '') ?? ''} ${r.path.split('/').pop()} (${r.detail.split(' · ').slice(4).join(', ') || 'unreadable'})`).join('; ')}${badVideos.length > 3 ? '; …' : ''}.`)
  if (invalid) gaps.push(`${invalid} episode${invalid === 1 ? '' : 's'} failed a check and will be left out of training.`)
  if (!tasks.length && dataFiles.length) gaps.push('No task text found (meta/tasks). π0.5 needs the language instruction for each episode.')

  // vector meanings
  for (const key of ['observation.state', 'action']) {
    const row = schema.get(key)
    const n = key === 'action' ? actionN : stateN
    if (row && n) row.meaning = `${MEANINGS[key]}. ${describeVector(n, gMin, gMax)}`
  }

  const format = info?.codebase_version
    ? `LeRobot ${info.codebase_version}`
    : dataFiles.some((f) => /file-\d+\.parquet$/.test(f.path))
      ? 'LeRobot v3 layout (no info.json)'
      : dataFiles.some((f) => /episode_\d+\.parquet$/.test(f.path))
        ? 'LeRobot v2 layout (no info.json)'
        : 'Parquet frame data'

  tick('Checked episodes')
  return {
    name, source, format, fps, fpsSource, robotType: info?.robot_type, tasks, expectedEpisodes: info?.total_episodes,
    episodes, files: reports, cameras, schema: [...schema.values()], gaps, segments, dataSources, stats,
    splits: info?.splits as Record<string, string> | undefined,
    kinematics: !list.length || !list[0].stateDims.size || [...list[0].stateDims][0] < 7 ? 'none' : list.some((a) => a.kinFromData) ? 'data' : 'derived',
    totals: {
      frames: episodes.reduce((s, e) => s + e.frames, 0),
      durationS: episodes.reduce((s, e) => s + e.durationS, 0),
      valid, invalid, warned: episodes.filter((e) => e.errors.length === 0 && e.warnings.length > 0).length,
    },
    stateRange: gMin.length ? { min: gMin, max: gMax } : undefined,
  }
}

export function formatDuration(s: number) {
  if (!Number.isFinite(s)) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.round(s % 60)
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`
}
