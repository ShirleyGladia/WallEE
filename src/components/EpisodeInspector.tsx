import { useCallback, useEffect, useRef, useState } from 'react'
import type { Episode } from '../data/types'

// Synced inspector: one shared time value drives the camera view, the joint plot and the phase bar.
// With real data, replace `simulate()` with the episode's frames and state arrays.

const PHASES = [
  { name: 'approach', from: 0, to: 35, color: 'var(--st-serve)' },
  { name: 'grasp', from: 35, to: 50, color: 'var(--st-dataset)' },
  { name: 'lift', from: 50, to: 70, color: 'var(--st-ingest)' },
  { name: 'place', from: 70, to: 100, color: 'var(--st-train)' },
]
const L1 = 70
const L2 = 60

function simulate(ep: Episode) {
  const off = (ep.objectX - 0.5) * 40
  const keys = [[-40, 40], [60 + off, 110], [60 + off, 110], [60 + off, 60], [-70, 60], [-70, 105], [-70, 105]]
  const at = [0, 35, 50, 70, 85, 95, 100]
  const ee = (t: number) => {
    let i = 0
    while (i < at.length - 2 && t > at[i + 1]) i++
    const u = Math.min(1, (t - at[i]) / (at[i + 1] - at[i] || 1))
    const s = u * u * (3 - 2 * u)
    return [keys[i][0] + (keys[i + 1][0] - keys[i][0]) * s, keys[i][1] + (keys[i + 1][1] - keys[i][1]) * s]
  }
  const ik = (t: number) => {
    const [x, y0] = ee(t)
    const y = -y0 + 130
    const d = Math.min(L1 + L2 - 1, Math.hypot(x, y))
    const c2 = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)
    const q2 = Math.acos(Math.max(-1, Math.min(1, c2)))
    const q1 = Math.atan2(y, x) - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2))
    return [q1, q2]
  }
  const grip = (t: number) => (t < 42 ? 1 : t < 50 ? 1 - (t - 42) / 8 : t < 90 ? 0 : t < 96 ? (t - 90) / 6 : 1)
  return { ik, grip, off }
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'

function fit(c: HTMLCanvasElement) {
  const r = c.getBoundingClientRect()
  const d = window.devicePixelRatio || 1
  c.width = r.width * d
  c.height = r.height * d
  const ctx = c.getContext('2d')!
  ctx.setTransform(d, 0, 0, d, 0, 0)
  return { ctx, w: r.width, h: r.height }
}

export default function EpisodeInspector({ episode }: { episode: Episode }) {
  const [t, setT] = useState(20)
  const [playing, setPlaying] = useState(false)
  const cam = useRef<HTMLCanvasElement>(null)
  const plot = useRef<HTMLCanvasElement>(null)
  const sim = useRef(simulate(episode))

  useEffect(() => { sim.current = simulate(episode); setT(20) }, [episode])

  const draw = useCallback(() => {
    if (!cam.current || !plot.current) return
    const { ik, grip, off } = sim.current
    const ink = css('--ink')
    const muted = css('--ink-3')

    const { ctx: v, w, h } = fit(cam.current)
    const bx = w / 2
    const by = h - 26
    v.strokeStyle = muted
    v.lineWidth = 1
    v.beginPath(); v.moveTo(12, by + 8); v.lineTo(w - 12, by + 8); v.stroke()
    const [q1, q2] = ik(t)
    const ex = bx + L1 * Math.cos(q1), ey = by - L1 * Math.sin(q1)
    const fx = ex + L2 * Math.cos(q1 + q2), fy = ey - L2 * Math.sin(q1 + q2)
    let ox: number, oy: number
    if (t < 50) { ox = bx + 60 + off; oy = by - 10 } else if (t < 92) { ox = fx; oy = fy + 14 } else { ox = bx - 70; oy = by - 10 }
    v.save(); v.translate(ox, oy); v.rotate((episode.objectYawDeg * Math.PI) / 180 * (t < 50 ? 1 : 0.2))
    v.fillStyle = css('--orange'); v.fillRect(-8, -12, 16, 22); v.restore()
    v.strokeStyle = ink; v.lineWidth = 7; v.lineCap = 'round'
    v.beginPath(); v.moveTo(bx, by); v.lineTo(ex, ey); v.lineTo(fx, fy); v.stroke()
    const g = 4 + grip(t) * 8
    v.lineWidth = 3
    v.beginPath(); v.moveTo(fx - g, fy); v.lineTo(fx - g, fy + 14); v.moveTo(fx + g, fy); v.lineTo(fx + g, fy + 14); v.stroke()
    v.fillStyle = muted; v.font = '12px Hanken Grotesk, sans-serif'
    v.fillText(`episode ${episode.id} · frame ${Math.round((t / 100) * episode.durationS * 30)}`, 10, 18)

    const { ctx: p, w: pw, h: ph } = fit(plot.current)
    const m = 10
    const X = (u: number) => m + (u / 100) * (pw - 2 * m)
    p.strokeStyle = css('--grid'); p.lineWidth = 1
    for (const ph0 of PHASES) { p.beginPath(); p.moveTo(X(ph0.from), 0); p.lineTo(X(ph0.from), ph); p.stroke() }
    const line = (f: (u: number) => number, color: string, lo: number, hi: number) => {
      p.strokeStyle = color; p.lineWidth = 2; p.beginPath()
      for (let u = 0; u <= 100; u++) {
        const y = ph - m - ((f(u) - lo) / (hi - lo)) * (ph - 2 * m)
        if (u) p.lineTo(X(u), y); else p.moveTo(X(u), y)
      }
      p.stroke()
    }
    line((u) => ik(u)[0], css('--chart-1'), -0.5, 2.6)
    line((u) => ik(u)[1], css('--ink-3'), -0.5, 2.6)
    line(grip, css('--orange'), -0.1, 1.1)
    p.strokeStyle = ink; p.lineWidth = 1.5; p.setLineDash([4, 3])
    p.beginPath(); p.moveTo(X(t), 0); p.lineTo(X(t), ph); p.stroke(); p.setLineDash([])
  }, [t, episode])

  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => setT((v) => (v >= 100 ? 0 : v + 1)), 60)
    return () => window.clearInterval(id)
  }, [playing])

  const phase = PHASES.find((p) => t >= p.from && t <= p.to)!
  const seconds = (t / 100) * episode.durationS

  return (
    <div>
      <div className="inspector">
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Top camera</div>
          <canvas ref={cam} aria-label="Camera view of the robot at the selected time" />
          <div className="small" style={{ marginTop: 6 }}>Phase: <b>{phase.name}</b></div>
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Joint angles and gripper</div>
          <canvas ref={plot} aria-label="Joint and gripper plot with a cursor at the selected time" />
          <div className="row small" style={{ marginTop: 6, gap: 14 }}>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 14, height: 2, background: 'var(--chart-1)', display: 'inline-block' }} />Shoulder</span>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 14, height: 2, background: 'var(--ink-3)', display: 'inline-block' }} />Elbow</span>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 14, height: 2, background: 'var(--orange)', display: 'inline-block' }} />Gripper (1 = open)</span>
          </div>
        </div>
      </div>
      <div
        className="phasebar"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setT(Math.round(((e.clientX - r.left) / r.width) * 100))
        }}
        aria-hidden="true"
      >
        {PHASES.map((p) => (
          <span key={p.name} style={{ width: `${p.to - p.from}%`, background: p.color, opacity: p === phase ? 1 : 0.55 }}>{p.name}</span>
        ))}
        <i className="cursor" style={{ left: `calc(${t}% - 1.5px)` }} />
      </div>
      <div className="scrub">
        <button className="btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40, justifyContent: 'center', padding: 0 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input type="range" min={0} max={100} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label="Episode time" />
        <span className="small" style={{ minWidth: 52, textAlign: 'right' }}>{seconds.toFixed(1)} s</span>
      </div>
    </div>
  )
}
