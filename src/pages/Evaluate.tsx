import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading, Panel, StageHeader, Stat, pct } from '../components/ui'
import { api, useApi } from '../data/api'
import type { Phase, Rollout } from '../data/types'
import { listEvalRuns, type EvalRun } from '../evaluate/runs'
import EvaluateReal from './EvaluateReal'

const PHASES: Phase[] = ['approach', 'grasp', 'lift', 'place']

function Funnel({ rollouts }: { rollouts: Rollout[] }) {
  const n = rollouts.length
  const order = (p: Phase) => PHASES.indexOf(p)
  // A rollout "passed" a phase if it got beyond it, or finished successfully.
  const passed = PHASES.map((p) => rollouts.filter((r) => r.success || order(r.reached) > order(p)).length)
  return (
    <div className="funnel">
      <div className="funnel-row">
        <span className="small muted">Started</span>
        <div className="funnel-track"><div className="funnel-fill" style={{ width: '100%', opacity: 0.35 }} /></div>
        <span className="small" style={{ textAlign: 'right' }}>{n}</span>
      </div>
      {PHASES.map((p, i) => {
        const prev = i === 0 ? n : passed[i - 1]
        const lost = prev - passed[i]
        return (
          <div className="funnel-row" key={p}>
            <span className="small" style={{ textTransform: 'capitalize' }}>{p}</span>
            <div className="funnel-track">
              <div className="funnel-fill" style={{ width: `${(passed[i] / n) * 100}%` }} />
            </div>
            <span className="small" style={{ textAlign: 'right' }}>
              {passed[i]} {lost > 0 && <span className="funnel-drop">−{lost}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Real runs from src/evals (written by tools/eval_writer.py) when there are any, otherwise the demo page.
export default function Evaluate() {
  const [runs, setRuns] = useState<EvalRun[] | null>(null)
  useEffect(() => { listEvalRuns().then(setRuns) }, [])
  if (runs === null) return <div className="skeleton" aria-busy="true" aria-label="Loading evaluation runs" />
  return runs.length ? <EvaluateReal runs={runs} /> : <EvaluateDemo />
}

function EvaluateDemo() {
  const [version, setVersion] = useState('v1')
  const { data, error } = useApi(() => api.evaluation(version), [version])
  const [threshold, setThreshold] = useState(75)
  const [sel, setSel] = useState<number | null>(null)
  if (!data) return <Loading error={error} />

  const n = data.rollouts.length
  const ok = data.rollouts.filter((r) => r.success).length
  const rate = ok / n
  const good = rate * 100 >= threshold
  const lat = [...data.rollouts].map((r) => r.latencyMs).sort((a, b) => a - b)
  const p50 = lat[Math.floor(n * 0.5)]
  const p95 = lat[Math.floor(n * 0.95)]
  const reasons = Object.entries(
    data.rollouts.filter((r) => !r.success).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.failure!]: (acc[r.failure!] ?? 0) + 1 }), {}),
  ).sort((a, b) => b[1] - a[1])
  const maxReason = reasons[0]?.[1] ?? 1
  const selected = data.rollouts.find((r) => r.id === sel)
  const bins = [60, 80, 100, 120, 140, 160, 180]
  const hist = bins.map((b) => data.rollouts.filter((r) => r.latencyMs >= b && r.latencyMs < b + 20).length)
  const histMax = Math.max(...hist, 1)

  return (
    <>
      <StageHeader
        id="evaluate"
        gate={{ question: 'Good enough?', verdict: good ? 'pass' : 'fail', detail: `${pct(rate)} success vs ${threshold}% target` }}
        actions={
          <div className="row" role="group" aria-label="Model version">
            {['v1', 'v2'].map((v) => (
              <button key={v} className={`btn${v === version ? ' primary' : ''}`} onClick={() => { setVersion(v); setSel(null) }} aria-pressed={v === version}>
                Model {v}
              </button>
            ))}
          </div>
        }
      />
      <p className="small" style={{ margin: '-8px 0 14px' }}>
        <span className="badge warn">Example data</span> Real runs appear here when the GPU machine writes them to <code>src/evals/</code> with <code>tools/eval_writer.py</code>.
      </p>

      <div className="stats">
        <Stat label="Success rate" value={pct(rate)} sub={`${ok} of ${n} seeds`} />
        <Stat label={`vs ${data.baseline.model}`} value={`${rate >= data.baseline.successRate ? '+' : ''}${Math.round((rate - data.baseline.successRate) * 100)} pts`} sub={`Baseline ${pct(data.baseline.successRate)}`} />
        <Stat label="Latency p50" value={`${p50} ms`} sub={`p95 ${p95} ms`} />
        <Stat label="Most common failure" value={reasons[0] ? reasons[0][1] : 0} sub={reasons[0]?.[0] ?? 'None'} />
      </div>

      <Panel title="Pass threshold" hint="What “good enough” means for this task">
        <div className="threshold">
          <span className="small muted">50%</span>
          <input type="range" min={50} max={95} step={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Success threshold" />
          <span className="small muted">95%</span>
          <b style={{ minWidth: 44 }}>{threshold}%</b>
          {good
            ? <Link to="/serve" className="btn primary">Yes — version and serve</Link>
            : <Link to="/diagnose" className="btn primary">No — diagnose failures</Link>}
        </div>
      </Panel>

      <div className="grid g-2" style={{ margin: '16px 0' }}>
        <Panel title="Where rollouts fail" hint="Rollouts that got past each phase">
          <Funnel rollouts={data.rollouts} />
        </Panel>
        <Panel title="Failure reasons">
          <div className="funnel">
            {reasons.map(([why, c]) => (
              <div key={why} className="funnel-row" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) 30px' }}>
                <span className="small">{why}</span>
                <div className="funnel-track" style={{ height: 14 }}><div className="funnel-fill" style={{ width: `${(c / maxReason) * 100}%`, background: 'var(--fail)' }} /></div>
                <span className="small" style={{ textAlign: 'right' }}>{c}</span>
              </div>
            ))}
            {reasons.length === 0 && <p className="small muted">No failures in this evaluation.</p>}
          </div>
        </Panel>
      </div>

      <div className="grid g-21">
        <Panel title="Rollouts" hint="One tile per seed · click to inspect">
          <div className="rollouts">
            {data.rollouts.map((r) => (
              <button key={r.id} className={`rollout ${r.success ? 'ok' : 'bad'}${sel === r.id ? ' sel' : ''}`} onClick={() => setSel(r.id)}
                aria-label={`Seed ${r.seed}: ${r.success ? 'success' : `failed at ${r.reached}`}`}>
                {r.success ? '✓' : r.reached[0].toUpperCase()}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>✓ success · A approach · G grasp · L lift · P place (phase where it failed)</p>
        </Panel>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Panel title={selected ? `Seed ${selected.seed}` : 'Rollout detail'}>
            {selected ? (
              <div className="grid" style={{ gap: 8 }}>
                <div>{selected.success ? <span className="badge pass">Success</span> : <span className="badge fail">Failed at {selected.reached}</span>}</div>
                {selected.failure && <p className="small">{selected.failure}</p>}
                <p className="small muted">Inference latency {selected.latencyMs} ms</p>
                <div className="skeleton" style={{ height: 120, display: 'grid', placeItems: 'center' }}>
                  <span className="small muted">Rollout video goes here</span>
                </div>
              </div>
            ) : <p className="small muted">Pick a tile to see what happened in that rollout.</p>}
          </Panel>
          <Panel title="Latency" hint="Per action chunk">
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bins.length}, 1fr)`, gap: 4, alignItems: 'end', height: 80 }}>
              {hist.map((c, i) => (
                <div key={i} title={`${bins[i]}–${bins[i] + 20} ms: ${c}`} style={{ height: `${(c / histMax) * 100}%`, minHeight: 2, background: 'var(--chart-1)', borderRadius: '4px 4px 0 0' }} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bins.length}, 1fr)`, gap: 4, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
              {bins.map((b) => <span key={b} className="small muted" style={{ textAlign: 'center', fontSize: 11 }}>{b}</span>)}
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}
