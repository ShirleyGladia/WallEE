import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel, StageHeader, Stat } from '../components/ui'
import { checkProjectDataset, listProjectDatasets, useIngest } from '../ingest/store'
import { dtw, openLoopError, tips, type EvalRun, type Rollout } from '../evaluate/runs'

// 05 Evaluate on real runs from the GPU machine: closed-loop rollouts in the simulator next to the
// demonstration that started the same way, and open-loop predictions against the demonstrated actions.

const JOINTS = (n: number) => (n === 16 ? [...[1, 2, 3, 4, 5, 6, 7].map((j) => `L${j}`), 'L grip', ...[1, 2, 3, 4, 5, 6, 7].map((j) => `R${j}`), 'R grip'] : Array.from({ length: n }, (_, i) => `${i + 1}`))
const fileUrl = (run: EvalRun, p: string) => `${run.base}/${p.split('/').map(encodeURIComponent).join('/')}`

function Lines({ series, t, colors, dashed = [], marker, cursor, unit, onSeek, height = 130 }: {
  series: (number | null)[][]; t: number[][]; colors: string[]; dashed?: boolean[]; marker?: number | null; cursor?: number; unit: string; onSeek?: (s: number) => void; height?: number
}) {
  const W = 760, H = height, pad = { l: 46, r: 8, t: 10, b: 18 }
  const tMax = Math.max(...t.map((x) => x.at(-1) ?? 0), 1)
  const vals = series.flat().filter((v): v is number => v !== null && Number.isFinite(v))
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1e-6)
  const X = (s: number) => pad.l + (s / tMax) * (W - pad.l - pad.r)
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ws-chart" role="img" aria-label={`Chart over time, ${unit}`}
      onClick={(e) => { if (!onSeek) return; const r = e.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * tMax)) }}>
      {[lo, (lo + hi) / 2, hi].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" />
          <text x={pad.l - 6} y={Y(v) + 4} fontSize="10" textAnchor="end" fill="var(--ink-3)">{Math.abs(hi - lo) < 3 ? v.toFixed(2) : Math.round(v)}</text>
        </g>
      ))}
      {series.map((s, k) => (
        <polyline key={k} fill="none" stroke={colors[k]} strokeWidth="1.8" strokeDasharray={dashed[k] ? '5 4' : undefined} strokeLinejoin="round"
          points={s.map((v, i) => (v === null ? '' : `${X(t[k][i])},${Y(v)}`)).filter(Boolean).join(' ')} />
      ))}
      {marker != null && (
        <g>
          <line x1={X(marker)} x2={X(marker)} y1={pad.t} y2={H - pad.b} stroke="var(--fail)" strokeWidth="2" />
          <text x={X(marker) + 4} y={pad.t + 10} fontSize="10" fill="var(--fail)">failure</text>
        </g>
      )}
      {cursor != null && <line x1={X(cursor)} x2={X(cursor)} y1={pad.t - 4} y2={H - pad.b} stroke="var(--ink)" strokeDasharray="3 3" />}
      <text x={pad.l} y={H - 4} fontSize="10" fill="var(--ink-3)">0 s</text>
      <text x={W - pad.r} y={H - 4} fontSize="10" fill="var(--ink-3)" textAnchor="end">{tMax.toFixed(0)} s · {unit}</text>
    </svg>
  )
}

function RolloutViewer({ run, r }: { run: EvalRun; r: Rollout }) {
  const { results, result, checking } = useIngest()
  const demoSet = run.dataset ? results[run.dataset] ?? (result?.name === run.dataset ? result : undefined) : undefined
  const cam = demoSet?.cameras.find((c) => c.key.includes('external') && c.playable) ?? demoSet?.cameras.find((c) => c.playable)
  const seg = demoSet && cam && r.episode != null ? demoSet.segments[r.episode]?.[cam.key] : undefined
  const demoUrl = seg && cam ? cam.fileUrls[seg.fi] : undefined
  const rv = useRef<HTMLVideoElement>(null)
  const dv = useRef<HTMLVideoElement>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const demoLen = seg ? seg.to - seg.from : (r.demo_state?.length ?? 0) / run.fps
  const total = Math.max(r.duration_s, demoLen, 0.1)
  const busy = run.dataset ? checking[run.dataset] : undefined

  const place = (s: number) => {
    if (rv.current) rv.current.currentTime = Math.min(s, Math.max(0, (rv.current.duration || r.duration_s) - 0.05))
    if (dv.current && seg) dv.current.currentTime = seg.from + Math.min(s, demoLen - 0.05)
  }
  useEffect(() => { setT(0); setPlaying(false) }, [r.seed])
  useEffect(() => {
    const v = dv.current
    if (!v || !demoUrl || !seg) return
    if (v.dataset.src !== demoUrl) { v.dataset.src = demoUrl; v.src = demoUrl; v.addEventListener('loadedmetadata', () => { v.currentTime = seg.from }, { once: true }) }
    else v.currentTime = seg.from
  }, [demoUrl, seg])
  useEffect(() => {
    if (!playing) { rv.current?.pause(); dv.current?.pause(); return }
    const start = performance.now() - t * 1000
    rv.current?.play().catch(() => {})
    dv.current?.play().catch(() => {})
    let raf = 0
    const tick = () => {
      const now = (performance.now() - start) / 1000
      if (now >= total) { setPlaying(false); setT(total); return }
      setT(now)
      // keep both videos on the shared clock; each stops at its own end
      for (const [v, off, len] of [[rv.current, 0, r.duration_s], [dv.current, seg?.from ?? 0, demoLen]] as const) {
        if (!v) continue
        if (now >= len) { if (!v.paused) v.pause(); continue }
        if (Math.abs(v.currentTime - (off + now)) > 0.3) v.currentTime = off + now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const loadDemos = async () => {
    const p = (await listProjectDatasets()).find((d) => d.name === run.dataset)
    if (p) checkProjectDataset(p)
  }

  const rt = useMemo(() => tips(r.state), [r])
  const dt = useMemo(() => (r.demo_state ? tips(r.demo_state) : null), [r])
  const zs = (arr: number[][], k: number) => arr.map((p) => (p[3 * k + 2] ?? NaN) * 1000)
  const arms = (rt[0]?.length ?? 0) / 3
  const rTime = r.t
  const dTime = r.demo_state ? r.demo_state.map((_, i) => i / run.fps) : []
  const colors = ['var(--petrol)', 'var(--chart-2)']

  return (
    <div>
      <div className="vs">
        <figure>
          <div className="vs-label"><span className={`badge ${r.success ? 'pass' : 'fail'}`}>{r.success ? 'Success' : 'Failed'}</span> Policy rollout · seed {r.seed}</div>
          {r.video ? <video ref={rv} src={fileUrl(run, r.video)} muted playsInline preload="auto" /> : <div className="vs-empty small muted">No video in this run</div>}
          {r.failure && t >= r.failure.t && <div className="vs-fail">Failed at {r.failure.t.toFixed(1)} s: {r.failure.reason}</div>}
        </figure>
        <figure>
          <div className="vs-label"><span className="badge muted">Demonstration</span> episode {r.episode ?? '—'} · same start</div>
          {demoUrl ? <video ref={dv} muted playsInline preload="auto" /> : (
            <div className="vs-empty small muted">
              {!run.dataset ? 'This run doesn’t name the dataset of its demonstrations.'
                : demoSet ? `Episode ${r.episode ?? '—'} has no playable video in ${run.dataset}.`
                  : busy && typeof busy === 'object' ? `Reading ${run.dataset}… ${busy.done}/${busy.total}`
                    : <>The demonstration video comes from <b>{run.dataset}</b>. <button className="linklike small" onClick={loadDemos}>Load it</button></>}
            </div>
          )}
        </figure>
      </div>
      <div className="scrub">
        <button className="btn" onClick={() => { if (!playing && t >= total - 0.05) { setT(0); place(0) } setPlaying((p) => !p) }} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40, justifyContent: 'center', padding: 0 }}>{playing ? '❚❚' : '▶'}</button>
        <div className="vs-track">
          <input type="range" min={0} max={total} step={1 / run.fps} value={t} onChange={(e) => { setPlaying(false); const s = Number(e.target.value); setT(s); place(s) }} aria-label="Time" />
          {r.failure && <span className="vs-mark" style={{ left: `${(r.failure.t / total) * 100}%` }} title={`Failure: ${r.failure.reason}`} />}
        </div>
        <span className="small" style={{ minWidth: 120, textAlign: 'right' }}>{t.toFixed(1)} s of {total.toFixed(0)}</span>
      </div>
      <div className="small muted" style={{ margin: '4px 0 12px' }}>
        Rollout {r.duration_s.toFixed(1)} s · demonstration {demoLen ? `${demoLen.toFixed(1)} s` : '—'}{r.failure ? <> · <span style={{ color: 'var(--fail)' }}>red mark: failure</span></> : null}
      </div>
      {dt && (
        <>
          <div className="small" style={{ fontWeight: 600 }}>Gripper height over time <span className="muted" style={{ fontWeight: 400 }}>· solid: rollout, dashed: demonstration</span></div>
          <Lines
            series={[...Array.from({ length: arms }, (_, k) => zs(rt, k)), ...Array.from({ length: arms }, (_, k) => zs(dt, k))]}
            t={[...Array.from({ length: arms }, () => rTime), ...Array.from({ length: arms }, () => dTime)]}
            colors={[...colors.slice(0, arms), ...colors.slice(0, arms)]} dashed={[...Array(arms).fill(false), ...Array(arms).fill(true)]}
            marker={r.failure?.t} cursor={t} unit="mm above the base" onSeek={(s) => { setPlaying(false); setT(s); place(s) }} />
        </>
      )}
    </div>
  )
}

function OpenLoopPanel({ run }: { run: EvalRun }) {
  const [i, setI] = useState(0)
  const [joint, setJoint] = useState<number | null>(null)
  const o = run.open_loop[i]
  const err = useMemo(() => (o ? openLoopError(o) : null), [o])
  if (!o || !err) return null
  const names = JOINTS(o.demo[0]?.length ?? 0)
  const worst = err.perDim.indexOf(Math.max(...err.perDim))
  const j = joint ?? worst
  const top = Math.max(...err.perDim, 1e-6)
  return (
    <Panel title="Open loop: predicted vs demonstrated actions" hint="The policy sees the demonstration’s observations; does it command what the expert did?" className="mt">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="small row" style={{ gap: 6 }}>
          Episode
          <select className="field-select" value={i} onChange={(e) => { setI(Number(e.target.value)); setJoint(null) }}>
            {run.open_loop.map((x, k) => <option key={k} value={k}>{x.episode}</option>)}
          </select>
        </label>
        <span className="small muted">Mean error {(err.mean * 1000).toFixed(1)} mrad per joint · worst joint {names[worst]}</span>
      </div>
      <div className="grid g-21">
        <div>
          <div className="small" style={{ fontWeight: 600 }}>{names[j]}: demonstrated (dashed) vs predicted (solid)</div>
          <Lines series={[o.pred.map((r) => r[j]), o.demo.map((r) => r[j])]} t={[o.t, o.t]} colors={['var(--orange)', 'var(--ink-3)']} dashed={[false, true]} unit="rad" />
          <div className="small" style={{ fontWeight: 600, marginTop: 8 }}>Error over time <span className="muted" style={{ fontWeight: 400 }}>· mean over joints</span></div>
          <Lines series={[err.overTime.map((x) => x * 1000)]} t={[o.t]} colors={['var(--fail)']} unit="mrad" height={100} />
        </div>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Mean error per joint <span className="muted" style={{ fontWeight: 400 }}>· click a joint</span></div>
          <div className="bars">
            {err.perDim.map((e, d) => (
              <button key={d} className={`bar-row${d === j ? ' on' : ''}`} onClick={() => setJoint(d)}>
                <span className="small">{names[d]}</span>
                <span className="bar-track"><span style={{ width: `${(e / top) * 100}%`, background: d === worst ? 'var(--fail)' : 'var(--petrol)' }} /></span>
                <span className="small num">{(e * 1000).toFixed(1)}</span>
              </button>
            ))}
          </div>
          <div className="small muted">mrad (grippers: thousandths of the opening)</div>
        </div>
      </div>
    </Panel>
  )
}

export default function EvaluateReal({ runs }: { runs: EvalRun[] }) {
  const [name, setName] = useState(runs[0].name)
  const run = runs.find((r) => r.name === name) ?? runs[0]
  const [seed, setSeed] = useState(run.rollouts[0]?.seed ?? 0)
  const [target, setTarget] = useState(() => { try { return Number(localStorage.getItem('eval-target')) || 75 } catch { return 75 } })
  useEffect(() => { setSeed(run.rollouts[0]?.seed ?? 0) }, [run])
  useEffect(() => { try { localStorage.setItem('eval-target', String(target)) } catch { /* ignore */ } }, [target])

  const rows = useMemo(() => run.rollouts.map((r) => {
    const demoLen = r.demo_state ? r.demo_state.length / run.fps : null
    return { r, demoLen, sim: r.demo_state ? dtw(tips(r.state), tips(r.demo_state)) : NaN }
  }), [run])
  const n = run.rollouts.length
  const ok = run.rollouts.filter((r) => r.success)
  const rate = n ? ok.length / n : 0
  const meanTime = ok.length ? ok.reduce((s, r) => s + r.duration_s, 0) / ok.length : NaN
  const sims = rows.map((x) => x.sim).filter(Number.isFinite).sort((a, b) => a - b)
  const sim = sims.length ? sims[Math.floor(sims.length / 2)] : NaN
  const ol = run.open_loop.map(openLoopError)
  const olMean = ol.length ? ol.reduce((s, x) => s + x.mean, 0) / ol.length : NaN
  const reasons = new Map<string, number>()
  for (const r of run.rollouts) if (r.failure) reasons.set(r.failure.reason, (reasons.get(r.failure.reason) ?? 0) + 1)
  const r = run.rollouts.find((x) => x.seed === seed) ?? run.rollouts[0]

  return (
    <>
      <StageHeader
        id="evaluate"
        gate={{ question: 'Good enough?', verdict: rate * 100 >= target ? 'pass' : 'fail', detail: `${Math.round(rate * 100)}% success · target ${target}%` }}
        actions={<>
          <label className="small row" style={{ gap: 6 }}>
            Run
            <select className="field-select" value={run.name} onChange={(e) => setName(e.target.value)}>
              {runs.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          <label className="small row" style={{ gap: 6 }}>
            Target
            <input type="number" className="field-num" min={10} max={100} step={5} value={target} onChange={(e) => setTarget(Math.max(10, Math.min(100, Number(e.target.value) || 75)))} /> %
          </label>
          {rate * 100 >= target ? <Link to="/serve" className="btn primary">Version &amp; serve</Link> : <Link to="/diagnose" className="btn primary">Diagnose</Link>}
        </>}
      />
      {run.example && <div className="banner small"><b>Example run.</b> {run.notes}</div>}
      <p className="small muted" style={{ margin: '-8px 0 14px' }}>
        <b style={{ color: 'var(--ink)' }}>{run.model}</b>{run.checkpoint ? ` · ${run.checkpoint}` : ''}{run.manifest ? ` · trained on ${run.manifest}` : ''} · {run.simulator ?? 'simulator'}{run.gpu ? ` · ${run.gpu}` : ''} · “{run.task}”
      </p>

      <div className="stats">
        <Stat label="Success" value={`${Math.round(rate * 100)}%`} sub={`${ok.length} of ${n} rollouts`} />
        <Stat label="Time to finish" value={Number.isFinite(meanTime) ? `${meanTime.toFixed(1)} s` : '—'} sub="successful rollouts" />
        <Stat label="Path vs demonstration" value={Number.isFinite(sim) ? `${sim.toFixed(0)} mm` : '—'} sub="median gripper distance, timing ignored" />
        <Stat label="Open-loop error" value={Number.isFinite(olMean) ? `${(olMean * 1000).toFixed(0)} mrad` : '—'} sub="per joint, vs the expert" />
      </div>

      <div className="grid g-21">
        <Panel title={`Rollout · seed ${r?.seed ?? ''}`} hint="Same start as the demonstration, side by side">
          {r ? <RolloutViewer run={run} r={r} /> : <p className="small muted">This run has no rollouts.</p>}
        </Panel>
        <Panel title="Rollouts" hint="Success is the score; the path is context">
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>Seed</th><th>Demo</th><th>Result</th><th className="num">Time</th><th className="num">Path</th></tr></thead>
              <tbody>
                {rows.map(({ r: x, demoLen, sim: s }) => (
                  <tr key={x.seed} className={`clickable${x.seed === r?.seed ? ' selected' : ''}`} onClick={() => setSeed(x.seed)} tabIndex={0} onKeyDown={(k) => { if (k.key === 'Enter') setSeed(x.seed) }}>
                    <td style={{ fontWeight: 600 }}>{x.seed}</td>
                    <td>{x.episode ?? '—'}</td>
                    <td>{x.success ? <span className="badge pass">Success</span> : <span className="badge fail" title={x.failure?.reason}>Failed {x.failure ? `${x.failure.t.toFixed(0)} s` : ''}</span>}</td>
                    <td className="num">{x.duration_s.toFixed(1)} s{demoLen ? <span className="muted"> / {demoLen.toFixed(0)}</span> : null}</td>
                    <td className="num">{Number.isFinite(s) ? `${s.toFixed(0)} mm` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reasons.size > 0 && (
            <>
              <h3 className="small" style={{ margin: '14px 0 6px' }}>Why rollouts failed</h3>
              <ul className="list small">{[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k}><b>{v}×</b> {k}</li>)}</ul>
            </>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>Time: rollout / demonstration. Path: how far the grippers were from the demonstration’s, on average, after lining up the timing (dynamic time warping).</p>
        </Panel>
      </div>

      <OpenLoopPanel run={run} />
    </>
  )
}
