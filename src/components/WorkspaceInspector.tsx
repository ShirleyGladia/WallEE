import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadEpisodeFrames, type EpisodeFrames } from '../ingest/frames'
import { ARMS, FR3, fk, isDuo } from '../ingest/kinematics'
import type { IngestResult } from '../ingest/types'
import { setThresholds, useThresholds } from '../review/settings'
import { getReviewer, saveClip } from '../review/store'
import { momentId } from '../review/moments'

// Episode inspector on real data: camera, the FR3 maximum reachable space with the arm drawn at the current
// frame, table clearance, a short-horizon prediction of where the arm is heading, and joint speed /
// acceleration / gripper speed over time with thresholds. One scrubber and one time window drive everything.

// Same scale on both axes so the reach sphere stays round. Room below the base for the table.
const SCALE = 200 // px per metre
const Z_MIN = -0.32
const Z_MAX = 1.22
const SIDE = { w: 380, h: Math.round((Z_MAX - Z_MIN) * SCALE + 24), xMin: -0.95 }
const sx = (m: number) => (m - SIDE.xMin) * SCALE
const sz = (m: number) => SIDE.h - 14 - (m - Z_MIN) * SCALE

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}

// Collapsible block that remembers whether it was open.
export function Section({ id, title, summary, children }: { id: string; title: ReactNode; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => store.get(`ws-open-${id}`, '1') === '1')
  return (
    <details className="ws-section" open={open} onToggle={(e) => {
      const o = (e.currentTarget as HTMLDetailsElement).open
      setOpen(o)
      store.set(`ws-open-${id}`, o ? '1' : '0')
    }}>
      <summary>
        <span className="ws-section-title">{title}</span>
        {summary && <span className="small muted">{summary}</span>}
      </summary>
      <div className="ws-section-body">{children}</div>
    </details>
  )
}

export interface ArmTrack {
  name: string
  offset: number
  reach: number[] // shoulder-to-flange distance as a share of 855 mm, per frame
  side: { h: number; z: number }[] // gripper tip in the side view, per frame
  lowest: number[] // lowest point of the moving arm (joint 2 to gripper tip), per frame (m)
  predLowest: number[] // the same for the predicted pose `horizon` seconds ahead
  tcp: number[] // gripper tip speed, mm/s
  iMax: number
}

// Where the joints will be in h seconds if speed and acceleration stay as they are: q + v·h + ½·a·h².
export function predictQ(frames: EpisodeFrames, i: number, h: number) {
  const q = frames.q[i], v = frames.v[i], a = frames.a[i]
  return q.map((x, d) => x + (v[d] ?? 0) * h + 0.5 * (a[d] ?? 0) * h * h)
}

export function track(frames: EpisodeFrames, offset: number, name: string, horizon: number): ArmTrack {
  const all = frames.q.map((q) => fk(q, offset))
  const tips = all.map((p) => p[9])
  const mx = tips.reduce((s, p) => s + p[0], 0)
  const my = tips.reduce((s, p) => s + p[1], 0)
  const n = Math.hypot(mx, my) || 1
  const u = [mx / n, my / n]
  const [sxs, sys, szs] = FR3.shoulder
  const reach = all.map((p) => Math.hypot(p[8][0] - sxs, p[8][1] - sys, p[8][2] - szs) / FR3.reach)
  const side = tips.map((p) => ({ h: Math.sign(p[0] * u[0] + p[1] * u[1] || 1) * Math.hypot(p[0], p[1]), z: p[2] }))
  const low = (p: [number, number, number][]) => Math.min(...p.slice(2).map((x) => x[2]))
  const lowest = all.map(low)
  const predLowest = frames.q.map((_, i) => low(fk(predictQ(frames, i, horizon), offset)))
  const tcp = tips.map((_, i) => {
    const j = i === 0 ? 1 : i
    const dt = frames.t[j] - frames.t[j - 1]
    const a = tips[j - 1], b = tips[j]
    return dt > 0 && a && b ? (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt) * 1000 : 0
  })
  let iMax = 0
  reach.forEach((r, i) => { if (r > reach[iMax]) iMax = i })
  return { name, offset, reach, side, lowest, predLowest, tcp, iMax }
}

const tone = (r: number) => (r >= 0.9 ? 'var(--fail)' : r >= 0.8 ? 'var(--orange)' : 'var(--pass)')

export function ArmSide({ frames, f, arm, tableZ, horizon, path = true }: { frames: EpisodeFrames; f: number; arm: ArmTrack; tableZ: number; horizon: number; path?: boolean }) {
  const joints = fk(frames.q[f], arm.offset)
  const tip = joints[9]
  const az = Math.hypot(tip[0], tip[1]) || 1
  const u = [tip[0] / az, tip[1] / az]
  const proj = joints.map((p) => ({ h: p[0] * u[0] + p[1] * u[1], z: p[2] }))
  const ghost = fk(predictQ(frames, f, horizon), arm.offset).map((p) => ({ h: p[0] * u[0] + p[1] * u[1], z: p[2] }))
  const now = arm.reach[f]
  const max = arm.reach[arm.iMax]
  const below = arm.lowest.map((z) => z < tableZ - 0.001)
  const belowCount = below.filter(Boolean).length
  const deepest = Math.min(...arm.lowest)
  const belowNow = below[f]
  const heading = !belowNow && arm.predLowest[f] < tableZ - 0.001
  // The table cuts the reach sphere.
  const dz = FR3.shoulder[2] - tableZ
  const half = Math.sqrt(Math.max(0, FR3.reach ** 2 - dz ** 2))

  return (
    <figure className="ws-arm">
      <svg viewBox={`0 0 ${SIDE.w} ${SIDE.h}`} role="img"
        aria-label={`${arm.name}: side view with the maximum reachable space. Reach now ${Math.round(now * 100)}%, episode maximum ${Math.round(max * 100)}%. ${belowCount ? `Below the table in ${belowCount} frames.` : 'Stays above the table.'}${heading ? ' Heading below the table.' : ''}`}>
        {/* zone 1: maximum space, a sphere of 855 mm around the shoulder, cut by the table */}
        <path d={`M ${sx(-half)} ${sz(tableZ)} A ${FR3.reach * SCALE} ${FR3.reach * SCALE} 0 1 1 ${sx(half)} ${sz(tableZ)} Z`}
          fill="var(--fail)" fillOpacity="0.07" stroke="var(--fail)" strokeWidth="1.6" strokeDasharray="7 5" />
        <text x={sx(0)} y={sz(1.06)} fontSize="11" textAnchor="middle" fill="var(--fail)">Maximum space · 855 mm</text>
        {/* robot base level and the table */}
        {tableZ !== 0 && <line x1="0" x2={SIDE.w} y1={sz(0)} y2={sz(0)} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 4" />}
        <line x1="0" x2={SIDE.w} y1={sz(tableZ)} y2={sz(tableZ)} stroke={belowNow ? 'var(--fail)' : heading ? 'var(--orange)' : 'var(--ink-3)'} strokeWidth={belowNow || heading ? 2.5 : 1.5} />
        <text x={6} y={sz(tableZ) + 14} fontSize="10" fill={belowNow ? 'var(--fail)' : 'var(--ink-3)'}>Table</text>
        <rect x={sx(-0.07)} y={sz(0.05)} width={sx(0.07) - sx(-0.07)} height={sz(0) - sz(0.05)} fill="var(--ink-3)" rx="2" />
        {/* gripper path over the whole episode; red where the arm is below the table */}
        {path && <polyline points={arm.side.map((p) => `${sx(p.h)},${sz(p.z)}`).join(' ')} fill="none" stroke="var(--petrol)" strokeWidth="1.6" strokeOpacity="0.55" strokeLinejoin="round" />}
        {path && arm.side.map((p, i) => below[i] ? <circle key={i} cx={sx(p.h)} cy={sz(p.z)} r="2.2" fill="var(--fail)" /> : null)}
        {path && <circle cx={sx(arm.side[arm.iMax].h)} cy={sz(arm.side[arm.iMax].z)} r="4.5" fill="none" stroke={tone(max)} strokeWidth="2" />}
        {/* predicted pose a moment ahead */}
        <polyline points={ghost.slice(0, 10).map((p) => `${sx(p.h)},${sz(p.z)}`).join(' ')} fill="none" stroke={heading ? 'var(--orange)' : 'var(--ink-3)'} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 6" opacity="0.9" />
        {/* arm at the current frame */}
        <polyline points={proj.slice(0, 10).map((p) => `${sx(p.h)},${sz(p.z)}`).join(' ')} fill="none" stroke="var(--ink)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
        {proj.slice(1, 9).map((p, i) => (
          <circle key={i} cx={sx(p.h)} cy={sz(p.z)} r={p.z < tableZ ? 4.5 : 3} fill={p.z < tableZ ? 'var(--fail)' : 'var(--surface)'} />
        ))}
        <circle cx={sx(proj[9].h)} cy={sz(proj[9].z)} r="5.5" fill={proj[9].z < tableZ ? 'var(--fail)' : tone(now)} stroke="var(--surface)" strokeWidth="1.5" />
        {heading && <text x={SIDE.w - 6} y={sz(tableZ) - 8} fontSize="11" textAnchor="end" fill="var(--orange)" fontWeight="700">Heading below the table in ≤ {horizon} s</text>}
      </svg>
      <figcaption>
        <div style={{ fontWeight: 600 }}>{arm.name}</div>
        <div className="small">Reach now <b style={{ color: tone(now) }}>{Math.round(now * 100)}%</b> · episode max <b style={{ color: tone(max) }}>{Math.round(max * 100)}%</b></div>
        <div className="small muted">Closest to the edge: {Math.round((1 - max) * FR3.reach * 1000)} mm short · safety factor {(1 / max).toFixed(2)}</div>
        <div className="small" style={{ color: belowCount ? 'var(--fail)' : 'var(--pass)' }}>
          {belowCount
            ? `Below the table in ${belowCount} of ${below.length} frames · up to ${Math.round((tableZ - deepest) * 1000)} mm under`
            : 'Stays above the table'}
        </div>
      </figcaption>
    </figure>
  )
}

type Range = [number, number]

// Frame index under the pointer, inside the frames on show.
function useFramePicker(W: number, padL: number, padR: number, view: Range) {
  return (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const share = (x - padL) / (W - padL - padR)
    return Math.round(view[0] + Math.max(0, Math.min(1, share)) * (view[1] - view[0]))
  }
}

// Shared pointer handling: click to seek, drag to pick a time window.
function useDrag(pick: (e: React.PointerEvent<SVGSVGElement>) => number, onSeek: (f: number) => void, onSelect: (r: Range | null) => void) {
  const start = useRef<number | null>(null)
  const moved = useRef(false)
  return {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = pick(e); moved.current = false },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      if (start.current === null) return
      const i = pick(e)
      if (Math.abs(i - start.current) >= 2) { moved.current = true; onSelect([Math.min(start.current, i), Math.max(start.current, i)]) }
    },
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => {
      if (start.current === null) return
      if (!moved.current) onSeek(pick(e))
      start.current = null
    },
  }
}

// One row per arm: red where the arm is below the table, orange where the prediction says it soon will be.
function BelowStrip({ arms, f, tableZ, view, sel, onSeek, onSelect }: { arms: ArmTrack[]; f: number; tableZ: number; view: Range; sel: Range | null; onSeek: (f: number) => void; onSelect: (r: Range | null) => void }) {
  const W = 760, row = 14, gap = 6, pad = { l: 78, r: 8 }
  const H = arms.length * (row + gap)
  const span = Math.max(1, view[1] - view[0])
  const X = (i: number) => pad.l + ((i - view[0]) / span) * (W - pad.l - pad.r)
  const w = Math.max(1, (W - pad.l - pad.r) / span)
  const drag = useDrag(useFramePicker(W, pad.l, pad.r, view), onSeek, onSelect)
  const inView = (i: number) => i >= view[0] && i <= view[1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ws-chart" role="img" aria-label="Frames where each arm is below the table (red) or predicted to go below it (orange)" {...drag}>
      {arms.map((a, k) => (
        <g key={a.name} transform={`translate(0 ${k * (row + gap)})`}>
          <text x={0} y={row - 3} fontSize="10" fill="var(--ink-3)">{a.name}</text>
          <rect x={pad.l} y={0} width={W - pad.l - pad.r} height={row} rx="3" fill="var(--surface-2)" />
          {a.predLowest.map((z, i) => (inView(i) && z < tableZ - 0.001 && a.lowest[i] >= tableZ - 0.001 ? <rect key={`p${i}`} x={X(i) - w / 2} y={row * 0.55} width={w} height={row * 0.45} fill="var(--orange)" /> : null))}
          {a.lowest.map((z, i) => (inView(i) && z < tableZ - 0.001 ? <rect key={i} x={X(i) - w / 2} y={0} width={w} height={row} fill="var(--fail)" /> : null))}
        </g>
      ))}
      {sel && (sel[0] > view[0] || sel[1] < view[1]) && <rect x={X(sel[0])} y={0} width={Math.max(1, X(sel[1]) - X(sel[0]))} height={H} fill="var(--petrol)" fillOpacity="0.14" stroke="var(--petrol)" />}
      {inView(f) && <line x1={X(f)} x2={X(f)} y1={0} y2={H} stroke="var(--ink)" strokeDasharray="3 3" />}
    </svg>
  )
}

const quantile = (xs: number[], q: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0
}

interface ChartProps {
  t: number[]
  series: number[][]
  colors: string[]
  unit: string
  fmt: (v: number) => string
  threshold: number
  p99: number
  floor: number // smallest y range
  f: number
  view: Range
  sel: Range | null
  onSeek: (f: number) => void
  onSelect: (r: Range | null) => void
  label: string
}

// Time chart with a safe threshold (red above it), the dataset's 99th percentile, and drag-to-select.
function TimeChart({ t, series, colors, unit, fmt, threshold, p99, floor, f, view, sel, onSeek, onSelect, label }: ChartProps) {
  const W = 760, H = 128, pad = { l: 48, r: 8, t: 10, b: 18 }
  const [i0, i1] = view
  const span = Math.max(1, i1 - i0)
  let peak = 0
  for (const s of series) for (let i = i0; i <= i1; i++) if (s[i] > peak) peak = s[i]
  const top = Math.max(floor, peak * 1.15, threshold * 1.1)
  const X = (i: number) => pad.l + ((i - i0) / span) * (W - pad.l - pad.r)
  const Y = (v: number) => pad.t + (1 - Math.min(v, top) / top) * (H - pad.t - pad.b)
  const w = Math.max(1, (W - pad.l - pad.r) / span)
  const drag = useDrag(useFramePicker(W, pad.l, pad.r, view), onSeek, onSelect)
  const ticks = [0, top / 2, top]
  const idx = Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ws-chart drag" role="img" aria-label={label} {...drag}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" />
          <text x={pad.l - 6} y={Y(v) + 4} fontSize="10" textAnchor="end" fill="var(--ink-3)">{fmt(v)}</text>
        </g>
      ))}
      {/* red where a value is above the threshold */}
      {series.map((s, k) => idx.map((i) => (s[i] > threshold ? <rect key={`${k}-${i}`} x={X(i) - w / 2} y={Y(s[i])} width={w} height={Y(threshold) - Y(s[i])} fill="var(--fail)" fillOpacity="0.35" /> : null)))}
      {series.map((s, k) => (
        <polyline key={k} points={idx.map((i) => `${X(i)},${Y(s[i])}`).join(' ')} fill="none" stroke={colors[k]} strokeWidth="1.8" strokeLinejoin="round" />
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={Y(threshold)} y2={Y(threshold)} stroke="var(--fail)" strokeWidth="1.5" />
      <text x={W - pad.r - 4} y={Y(threshold) - 4} fontSize="10" textAnchor="end" fill="var(--fail)">limit {fmt(threshold)}{unit}</text>
      {p99 > 0 && p99 < top && (
        <>
          <line x1={pad.l} x2={W - pad.r} y1={Y(p99)} y2={Y(p99)} stroke="var(--orange)" strokeWidth="1" strokeDasharray="5 4" />
          <text x={pad.l + 4} y={Y(p99) - 4} fontSize="10" fill="var(--orange)">99% of frames below {fmt(p99)}{unit}</text>
        </>
      )}
      {sel && (sel[0] > i0 || sel[1] < i1) && <rect x={X(Math.max(i0, sel[0]))} y={pad.t} width={Math.max(1, X(Math.min(i1, sel[1])) - X(Math.max(i0, sel[0])))} height={H - pad.t - pad.b} fill="var(--petrol)" fillOpacity="0.14" stroke="var(--petrol)" />}
      {f >= i0 && f <= i1 && <line x1={X(f)} x2={X(f)} y1={pad.t - 4} y2={H - pad.b} stroke="var(--ink)" strokeDasharray="3 3" />}
      <text x={pad.l} y={H - 4} fontSize="10" fill="var(--ink-3)">{t[i0]?.toFixed(1)} s</text>
      <text x={W - pad.r} y={H - 4} fontSize="10" fill="var(--ink-3)" textAnchor="end">{t[i1]?.toFixed(1)} s</text>
    </svg>
  )
}

function NumField({ value, onChange, min, max, step, unit, label }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit: string; label: string }) {
  return (
    <label className="row small" style={{ gap: 6 }}>
      {label}
      <input type="number" className="field-num" min={min} max={max} step={step} value={value}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))) }} />
      <span className="muted">{unit}</span>
    </label>
  )
}

const above = (series: number[][], thr: number, view: Range) => {
  let c = 0
  for (let i = view[0]; i <= view[1]; i++) if (series.some((s) => s[i] > thr)) c++
  return c
}

export default function WorkspaceInspector({ result, episode }: { result: IngestResult; episode: number }) {
  const th = useThresholds()
  const [frames, setFrames] = useState<EpisodeFrames | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [f, setF] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState<Range>([0, 1])
  const [sel, setSel] = useState<Range | null>(null)
  const [note, setNote] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const cam = result.cameras.find((c) => c.key.includes('external') && c.playable) ?? result.cameras.find((c) => c.playable)
  const seg = cam ? result.segments[episode]?.[cam.key] : undefined
  const fps = result.fps
  const tableZ = -th.tableMm / 1000

  useEffect(() => {
    let live = true
    setFrames(null)
    setError(null)
    setF(0)
    setPlaying(false)
    setSel(null)
    setSent(null)
    loadEpisodeFrames(result, episode)
      .then((fr) => {
        if (!live) return
        if (fr) { setFrames(fr); setView([0, fr.t.length - 1]) } else setError('This episode’s frames can’t be located in the data files.')
      })
      .catch((e: Error) => live && setError(e.message))
    return () => { live = false }
  }, [result, episode])

  const tracks = useMemo(() => {
    if (!frames) return []
    const n = frames.q[0]?.length ?? 0
    return (isDuo(n) ? ARMS : ARMS.slice(0, 1)).map((a) => track(frames, a.offset, a.name, th.horizon))
  }, [frames, th.horizon])

  // per-arm series for the charts
  const charts = useMemo(() => {
    if (!frames) return null
    const of = (kind: 'speed' | 'accel') => tracks.map((arm) => frames.t.map((_, i) => {
      let m = 0
      for (let j = 0; j < 7; j++) {
        const d = arm.offset + j
        const v = kind === 'speed' ? (Math.abs(frames.v[i][d]) / FR3.vMax[j]) * 100 : Math.abs(frames.a[i][d])
        if (v > m) m = v
      }
      return m
    }))
    return { speed: of('speed'), accel: of('accel'), tcp: tracks.map((a) => a.tcp) }
  }, [frames, tracks])

  // dataset-wide 99th percentiles from the ingest traces
  const p99 = useMemo(() => {
    const sp: number[] = [], tc: number[] = []
    for (const e of result.episodes) {
      if (!e.trace) continue
      for (let i = 0; i < e.trace.speed.length; i += 3) { sp.push(e.trace.speed[i] * 100); tc.push(e.trace.tcp[i]) }
    }
    return { speed: quantile(sp, 0.99), tcp: quantile(tc, 0.99) }
  }, [result])

  // Velocity columns in the data: add them up over 1 s and compare with how far the joints actually moved.
  const integration = useMemo(() => {
    if (!frames?.fromData) return null
    const k = Math.max(1, Math.round(fps))
    const dims = tracks.flatMap((a) => [0, 1, 2, 3, 4, 5, 6].map((j) => a.offset + j))
    let worstV = 0, worstA = 0, moveQ = 0, moveV = 0
    const cumV = dims.map(() => [0])
    const cumA = dims.map(() => [0])
    for (let i = 1; i < frames.t.length; i++) {
      const dt = frames.t[i] - frames.t[i - 1]
      dims.forEach((d, j) => {
        cumV[j].push(cumV[j][i - 1] + 0.5 * (frames.v[i][d] + frames.v[i - 1][d]) * dt)
        cumA[j].push(cumA[j][i - 1] + 0.5 * (frames.a[i][d] + frames.a[i - 1][d]) * dt)
      })
    }
    for (let i = 0; i + k < frames.t.length; i++) {
      dims.forEach((d, j) => {
        worstV = Math.max(worstV, Math.abs(cumV[j][i + k] - cumV[j][i] - (frames.q[i + k][d] - frames.q[i][d])))
        worstA = Math.max(worstA, Math.abs(cumA[j][i + k] - cumA[j][i] - (frames.v[i + k][d] - frames.v[i][d])))
        moveQ = Math.max(moveQ, Math.abs(frames.q[i + k][d] - frames.q[i][d]))
        moveV = Math.max(moveV, Math.abs(frames.v[i + k][d] - frames.v[i][d]))
      })
    }
    // as a share of the largest 1-s change, so a fast episode isn't penalised for its size
    return { worstV, worstA, relV: worstV / Math.max(1e-6, moveQ), relA: worstA / Math.max(1e-6, moveV) }
  }, [frames, tracks, fps])

  // Keep the video on the episode and frame being shown.
  useEffect(() => {
    const v = video.current
    if (!v || !seg || !cam) return
    const url = cam.fileUrls[seg.fi]
    const seek = () => { v.currentTime = seg.from + f / fps }
    if (v.dataset.src !== url) { v.dataset.src = url; v.src = url; v.addEventListener('loadedmetadata', seek, { once: true }) }
    else if (!playing) seek()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode, f, seg?.fi, frames])

  // Play at 2×; with a time window picked, play just that window.
  const end = sel ? sel[1] : (frames?.t.length ?? 1) - 1
  useEffect(() => {
    if (!playing || !frames) return
    const v = video.current
    if (v && seg) {
      v.playbackRate = 2
      v.play().catch(() => setPlaying(false))
      let raf = 0
      const loop = () => {
        const next = Math.round((v.currentTime - seg.from) * fps)
        if (next >= end) { setPlaying(false); v.pause(); setF(end); return }
        setF(Math.max(0, next))
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => { cancelAnimationFrame(raf); v.pause() }
    }
    const id = window.setInterval(() => setF((x) => (x >= end ? (setPlaying(false), x) : x + 1)), 1000 / (fps * 2))
    return () => window.clearInterval(id)
  }, [playing, frames, seg, fps, end])

  if (error) return <div className="error">{error}</div>
  if (!frames || !charts) return <div className="skeleton" aria-busy="true" aria-label="Loading episode" />
  const last = frames.t.length - 1
  const seek = (x: number) => { setPlaying(false); setF(Math.max(0, Math.min(last, x))) }
  const pick = (r: Range | null) => { setSel(r); setSent(null); if (r) seek(r[0]) }
  const maxReach = Math.max(...tracks.map((a) => a.reach[a.iMax]))
  const belowFrames = tracks.reduce((s, a) => s + a.lowest.filter((z) => z < tableZ - 0.001).length, 0)
  const speedPeak = Math.max(...charts.speed.flat())
  const accelPeak = Math.max(...charts.accel.flat())
  const tcpPeak = Math.max(...charts.tcp.flat())

  // How early the prediction warned before each time an arm went under the table.
  const leads: number[] = []
  for (const a of tracks) {
    for (let i = 1; i < a.lowest.length; i++) {
      if (a.lowest[i] < tableZ - 0.001 && a.lowest[i - 1] >= tableZ - 0.001) {
        let k = i - 1
        while (k >= 0 && a.predLowest[k] < tableZ - 0.001 && a.lowest[k] >= tableZ - 0.001) k--
        leads.push((i - 1 - k) / fps)
      }
    }
  }
  const leadAvg = leads.length ? leads.reduce((s, x) => s + x, 0) / leads.length : 0

  const chartBase = { t: frames.t, colors: ['var(--petrol)', 'var(--chart-2)'], f, view, sel, onSeek: seek, onSelect: pick }
  const legend = (
    <div className="row small muted" style={{ gap: 12 }}>
      {tracks.map((a, k) => <span key={a.name} className="row" style={{ gap: 6 }}><i className="legend-line" style={{ background: k ? 'var(--chart-2)' : 'var(--petrol)' }} />{a.name}</span>)}
      <span className="row" style={{ gap: 6 }}><i className="legend-line" style={{ background: 'var(--fail)' }} />limit</span>
      <span className="row" style={{ gap: 6 }}><i className="legend-line dashed" style={{ borderColor: 'var(--orange)' }} />99th percentile of the dataset</span>
    </div>
  )
  const zoomed = view[0] > 0 || view[1] < last
  const secs = (i: number) => frames.t[Math.max(0, Math.min(last, i))]
  const toFrame = (s: number) => {
    let best = 0
    frames.t.forEach((x, i) => { if (Math.abs(x - s) < Math.abs(frames.t[best] - s)) best = i })
    return best
  }

  const sendToReview = () => {
    if (!sel) return
    const m = { from: sel[0], to: sel[1] + 1, kind: 'manual' as const }
    saveClip({
      id: momentId(result.name, episode, m), dataset: result.name, episode, ...m, source: 'manual',
      reason: note.trim() || `Picked by hand: ${secs(sel[0]).toFixed(1)}–${secs(sel[1]).toFixed(1)} s`, by: getReviewer() || undefined,
    })
    setSent(`Added ${secs(sel[0]).toFixed(1)}–${secs(sel[1]).toFixed(1)} s to clip review`)
    setNote('')
  }

  return (
    <div className="ws">
      <Section id="reach" title="Maximum reachable space"
        summary={`furthest ${Math.round(maxReach * 100)}% of 855 mm · ${th.tableMm ? (belowFrames ? `${belowFrames} frames below the table` : 'never below the table') : 'set the table level'}`}>
        <div className="row small" style={{ justifyContent: 'flex-end', marginBottom: 8, gap: 18, flexWrap: 'wrap' }}>
          <NumField label="Table level" value={th.tableMm} min={0} max={400} step={10} unit="mm below the robot base" onChange={(v) => setThresholds({ tableMm: v })} />
          <NumField label="Look ahead" value={th.horizon} min={0.1} max={2} step={0.1} unit="s" onChange={(v) => setThresholds({ horizon: v })} />
        </div>
        <div className={`ws-top${seg && cam ? ' has-cam' : ''}`}>
          {seg && cam ? (
            <figure className="ws-cam">
              <video ref={video} muted playsInline preload="auto" />
              <figcaption className="small muted" style={{ textTransform: 'capitalize' }}>{cam.key.replace('observation.images.', '').replace(/_/g, ' ')}</figcaption>
            </figure>
          ) : null}
          <div className="ws-arms" style={{ gridTemplateColumns: `repeat(${tracks.length}, minmax(0, 1fr))` }}>
            {tracks.map((a) => <ArmSide key={a.name} frames={frames} f={f} arm={a} tableZ={tableZ} horizon={th.horizon} />)}
          </div>
        </div>
        <div className="small" style={{ margin: '10px 0 4px' }}>
          <b>Below the table</b> <span className="muted">· red where any part of the arm is under the table line, orange where the prediction ({th.horizon} s ahead) says it soon will be</span>
        </div>
        <BelowStrip arms={tracks} f={f} tableZ={tableZ} view={view} sel={sel} onSeek={seek} onSelect={pick} />
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Dotted arm: where the arm will be in {th.horizon} s if its speed and acceleration stay the same (position + speed × time + ½ × acceleration × time²).
          {leads.length ? ` It warned ${leadAvg.toFixed(1)} s ahead on average, over ${leads.length} time${leads.length === 1 ? '' : 's'} an arm went under the table.` : ''}
        </p>
      </Section>

      <div className="scrub ws-scrub">
        <button className="btn" onClick={() => { if (!playing && f >= end) setF(sel ? sel[0] : 0); setPlaying((p) => !p) }} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40, justifyContent: 'center', padding: 0 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input type="range" min={view[0]} max={view[1]} step={1} value={f} onChange={(e) => seek(Number(e.target.value))} aria-label="Frame" />
        <span className="small" style={{ minWidth: 120, textAlign: 'right' }}>frame {f} · {frames.t[f].toFixed(1)} s</span>
      </div>

      <div className="ws-window">
        <span className="small" style={{ fontWeight: 600 }}>Time window</span>
        <label className="row small" style={{ gap: 6 }}>
          from
          <input type="number" className="field-num" step={0.5} min={0} max={frames.t[last]} value={sel ? +secs(sel[0]).toFixed(1) : ''} placeholder={secs(view[0]).toFixed(1)}
            onChange={(e) => { const a = toFrame(Number(e.target.value)); pick([Math.min(a, sel?.[1] ?? last), sel?.[1] ?? last]) }} />
          to
          <input type="number" className="field-num" step={0.5} min={0} max={frames.t[last]} value={sel ? +secs(sel[1]).toFixed(1) : ''} placeholder={secs(view[1]).toFixed(1)}
            onChange={(e) => { const b = toFrame(Number(e.target.value)); pick([sel?.[0] ?? 0, Math.max(b, sel?.[0] ?? 0)]) }} />
          s
        </label>
        <button className="btn" disabled={!sel} onClick={() => sel && setView([sel[0], Math.max(sel[1], sel[0] + 2)])}>Zoom in</button>
        <button className="btn" disabled={!zoomed && !sel} onClick={() => { setView([0, last]); setSel(null) }}>Show all</button>
        <input className="field-text" placeholder="What’s wrong here? (optional)" value={note} onChange={(e) => setNote(e.target.value)} disabled={!sel} aria-label="Note for the clip" />
        <button className="btn primary" disabled={!sel} onClick={sendToReview}>Add to clip review</button>
        <span className="small muted">{sent ?? (sel ? `${(secs(sel[1]) - secs(sel[0])).toFixed(1)} s picked` : 'Drag across any chart to pick seconds')}</span>
      </div>

      <Section id="speed" title="Joint speed"
        summary={`fastest joint, % of its FR3 limit · peak ${Math.round(speedPeak)}% · ${above(charts.speed, th.speed * 100, view)} frames over ${Math.round(th.speed * 100)}%`}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          {legend}
          <NumField label="Limit" value={Math.round(th.speed * 100)} min={5} max={100} step={5} unit="% of FR3 limit" onChange={(v) => setThresholds({ speed: v / 100 })} />
        </div>
        <TimeChart {...chartBase} series={charts.speed} unit="%" fmt={(v) => `${Math.round(v)}`} threshold={th.speed * 100} p99={p99.speed} floor={40}
          label={`Joint speed as a share of the FR3 limit, peak ${speedPeak.toFixed(0)}%, limit line at ${Math.round(th.speed * 100)}%`} />
      </Section>

      <Section id="accel" title="Joint acceleration"
        summary={`largest joint · peak ${accelPeak.toFixed(2)} rad/s² · ${above(charts.accel, th.accel, view)} frames over ${th.accel} rad/s²`}>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <NumField label="Limit" value={th.accel} min={0.5} max={10} step={0.5} unit="rad/s² (FR3 max 10)" onChange={(v) => setThresholds({ accel: v })} />
        </div>
        <TimeChart {...chartBase} series={charts.accel} unit=" rad/s²" fmt={(v) => v.toFixed(1)} threshold={th.accel} p99={0} floor={1}
          label={`Joint acceleration, peak ${accelPeak.toFixed(2)} rad/s², limit line at ${th.accel}`} />
      </Section>

      <Section id="tcp" title="Gripper speed"
        summary={`fingertip point, mm/s · peak ${Math.round(tcpPeak)} mm/s · ${above(charts.tcp, th.tcp, view)} frames over ${th.tcp} mm/s`}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span className="small muted">250 mm/s is the reduced speed ISO 10218 sets for a robot working next to people.</span>
          <NumField label="Limit" value={th.tcp} min={50} max={2000} step={10} unit="mm/s" onChange={(v) => setThresholds({ tcp: v })} />
        </div>
        <TimeChart {...chartBase} series={charts.tcp} unit=" mm/s" fmt={(v) => `${Math.round(v)}`} threshold={th.tcp} p99={p99.tcp} floor={100}
          label={`Gripper speed, peak ${Math.round(tcpPeak)} mm/s, limit line at ${th.tcp} mm/s`} />
      </Section>

      <Section id="integrate" title="Do the speed columns add up?"
        summary={integration ? (integration.relV < 0.2 && integration.relA < 0.2 ? 'yes' : 'no — check the velocity and acceleration columns') : 'no velocity columns in this dataset'}>
        {integration ? (
          <>
          <ul className="list small">
            <li><b style={{ color: integration.relV < 0.2 ? 'var(--pass)' : 'var(--fail)' }}>{integration.relV < 0.2 ? '✓' : '!'}</b> Velocity added up over 1 s vs how far the joints really moved: largest gap <b>{(integration.worstV * 1000).toFixed(1)} mrad</b> ({Math.round(integration.relV * 100)}% of the largest 1-s movement)</li>
            <li><b style={{ color: integration.relA < 0.2 ? 'var(--pass)' : 'var(--fail)' }}>{integration.relA < 0.2 ? '✓' : '!'}</b> Acceleration added up over 1 s vs the change in velocity: largest gap <b>{(integration.worstA * 1000).toFixed(1)} mrad/s</b> ({Math.round(integration.relA * 100)}% of the largest 1-s change)</li>
          </ul>
          <p className="small muted" style={{ margin: 0 }}>At {fps} fps, columns that were worked out from the angles never add up exactly; gaps under 20% are normal. Larger gaps mean the columns don’t belong to these joint readings.</p>
          </>
        ) : (
          <p className="small muted">Speed and acceleration here are worked out from the joint angles, so there is nothing separate to cross-check. Datasets with <code>observation.velocity</code> get this check.</p>
        )}
      </Section>

      <p className="small muted" style={{ marginTop: 8 }}>
        Speed and acceleration are {frames.fromData ? 'read from the dataset' : 'worked out from the joint angles and timestamps'}.
        Reach is the shoulder-to-flange distance from FR3 forward kinematics; the dashed zone is the robot’s 855 mm maximum space.
        The gripper path and gripper speed use the fingertip point of the Franka Hand.
      </p>
    </div>
  )
}
