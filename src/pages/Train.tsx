import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Loading, Panel, StageHeader, Stat } from '../components/ui'
import { api, useApi } from '../data/api'
import { lossCurve } from '../data/mock'
import { Link } from 'react-router-dom'
import { downloadManifest, useManifests } from '../select/manifest'
import type { LossPoint } from '../data/types'

const MODELS = [
  { id: 'pi0', label: 'π0 (openpi) · LoRA', why: 'Pretrained VLA with language input; LoRA fits on one A100.' },
  { id: 'gr00t', label: 'NVIDIA GR00T N1.5', why: 'Humanoid-oriented VLA; needs an action-space adapter for the dual arm.' },
  { id: 'act', label: 'ACT', why: 'Small imitation-learning baseline. Fast to train, no language.' },
]

function useLiveLoss(runId: string, running: boolean) {
  const initial = useApi(() => api.loss(runId), [runId])
  const [points, setPoints] = useState<LossPoint[]>([])
  useEffect(() => { if (initial.data) setPoints(initial.data) }, [initial.data])
  useEffect(() => {
    if (!running) return
    // Demo stream. With a backend, swap for a WebSocket / SSE subscription.
    const id = window.setInterval(() => {
      setPoints((p) => {
        const last = p.at(-1)?.step ?? 0
        if (last >= 5000) return p
        return lossCurve(5000, last + 50)
      })
    }, 500)
    return () => window.clearInterval(id)
  }, [running])
  return points
}

export default function Train() {
  const { data: runs, error } = useApi(api.runs)
  const [model, setModel] = useState('pi0')
  const [cfg, setCfg] = useState({ dataset: 'v2', steps: 5000, lr: '2e-5', batch: 32, resume: 'v1' })
  const [toast, setToast] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const points = useLiveLoss('#7', true)
  const manifest = useManifests()[0]

  if (!runs) return <Loading error={error} />
  const live = runs.find((r) => r.status === 'running')
  const step = points.at(-1)?.step ?? 0
  const m = MODELS.find((x) => x.id === model)!

  async function start() {
    setStarting(true)
    const res = await api.startRun({ model, ...cfg })
    setStarting(false)
    setToast(`Run ${res.id} queued`)
    window.setTimeout(() => setToast(null), 2500)
  }

  return (
    <>
      <StageHeader id="train" />

      <Panel title="Training data" hint={manifest ? `from Select · ${new Date(manifest.created).toLocaleString()}` : 'from Select'} className="mb">
        {manifest ? (
          <div className="train-manifest">
            <div>
              <div style={{ fontWeight: 700 }}>{manifest.id}</div>
              <div className="small muted">by {manifest.author} · “{manifest.reason}”</div>
              <div className="small" style={{ marginTop: 6 }}>
                Train <b>{manifest.counts.train}</b> episodes ({manifest.splits.train.map((s) => s.dataset).join(', ')}) · validation <b>{manifest.counts.validation}</b> · test <b>{manifest.counts.test}</b> held back for Evaluate
              </div>
            </div>
            <pre className="code small">{`# openpi / LeRobot: train only on the manifest's episodes
m = json.load(open("${manifest.id}.json"))
for part in m["splits"]["train"]:
    ds = LeRobotDataset(part["dataset"], episodes=part["episodes"])
# recompute norm stats on these episodes before training`}</pre>
            <button className="btn" onClick={() => downloadManifest(manifest)}>Download manifest</button>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>No training manifest yet. <Link to="/select">Choose the training data</Link> first, so every run records exactly which episodes it learned from.</p>
        )}
      </Panel>
      <div className="banner small">The runs below are example data until the training job on the GPU reports to the console (see README, “Connecting the backend”).</div>

      <div className="stats">
        <Stat label="Live run" value={live?.id ?? '—'} sub={live?.model} />
        <Stat label="Progress" value={`${Math.round((step / 5000) * 100)}%`} sub={`Step ${step.toLocaleString()} of 5,000`} />
        <Stat label="Train loss" value={points.at(-1)?.train.toFixed(3) ?? '—'} sub={`Validation ${points.at(-1)?.val.toFixed(3) ?? '—'}`} />
        <Stat label="GPU" value="A100" sub="80 GB · 71% used" />
      </div>

      <div className="grid g-21" style={{ marginBottom: 16 }}>
        <Panel title={`Run ${live?.id ?? ''} loss`} hint="Updates live">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 56, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="step" type="number" domain={[0, 5000]} tick={{ fontSize: 12, fill: 'var(--ink-3)' }} tickLine={false} axisLine={{ stroke: 'var(--line)' }}
                  tickFormatter={(v: number) => (v ? `${v / 1000}k` : "0")} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--ink-3)' }} tickLine={false} axisLine={false} domain={[0, 0.7]} ticks={[0, 0.2, 0.4, 0.6]} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }}
                  labelFormatter={(v) => `Step ${Number(v).toLocaleString()}`} formatter={(v: number, n: string) => [v.toFixed(3), n === 'train' ? 'Train' : 'Validation']} />
                <Line type="monotone" dataKey="train" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false}
                  label={(p: { index: number; x: number; y: number }) => (p.index === points.length - 1 ? <text x={p.x + 6} y={p.y - 6} fontSize={12} fill="var(--ink-2)">Train</text> : <g />)} />
                <Line type="monotone" dataKey="val" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false}
                  label={(p: { index: number; x: number; y: number }) => (p.index === points.length - 1 ? <text x={p.x + 6} y={p.y + 14} fontSize={12} fill="var(--ink-2)">Validation</text> : <g />)} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="row small muted" style={{ gap: 16 }}>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 16, height: 2, background: 'var(--chart-1)', display: 'inline-block' }} />Train loss</span>
            <span className="row" style={{ gap: 6 }}><i style={{ width: 16, height: 0, borderTop: '2px dashed var(--chart-2)', display: 'inline-block' }} />Validation loss</span>
          </div>
        </Panel>

        <Panel title="New run">
          <div className="grid" style={{ gap: 12 }}>
            <label className="small">
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)} style={fieldStyle}>
                {MODELS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </label>
            <p className="small muted" style={{ marginTop: -6 }}>{m.why}</p>
            <div className="grid g-2" style={{ gap: 10 }}>
              <label className="small">Dataset
                <select value={cfg.dataset} onChange={(e) => setCfg({ ...cfg, dataset: e.target.value })} style={fieldStyle}>
                  <option value="v2">v2 · 528 episodes</option><option value="v1">v1 · 441 episodes</option>
                </select>
              </label>
              <label className="small">Start from
                <select value={cfg.resume} onChange={(e) => setCfg({ ...cfg, resume: e.target.value })} style={fieldStyle}>
                  <option value="v1">Model v1</option><option value="base">Base weights</option>
                </select>
              </label>
              <label className="small">Steps
                <input type="number" value={cfg.steps} min={100} step={100} onChange={(e) => setCfg({ ...cfg, steps: Number(e.target.value) })} style={fieldStyle} />
              </label>
              <label className="small">Learning rate
                <input value={cfg.lr} onChange={(e) => setCfg({ ...cfg, lr: e.target.value })} style={fieldStyle} />
              </label>
            </div>
            <button className="btn primary" onClick={start} disabled={starting} style={{ justifyContent: 'center' }}>
              {starting ? 'Queuing…' : 'Start run'}
            </button>
          </div>
        </Panel>
      </div>

      <Panel title="Runs" hint="Every run keeps its config, so results are reproducible">
        <table className="table">
          <thead><tr><th>Run</th><th>Model</th><th>Dataset</th><th>Why</th><th style={{ width: 150 }}>Progress</th><th>Status</th></tr></thead>
          <tbody>
            {runs.map((r) => {
              const s = r.status === 'running' ? step : r.step
              return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.id}</td>
                  <td>{r.model}</td>
                  <td>{r.dataset}</td>
                  <td className="small muted">{r.why}</td>
                  <td>
                    <div className="small">{Math.round((s / r.totalSteps) * 100)}%</div>
                    <div className={`bar${r.status === 'running' ? ' orange' : ''}`}><span style={{ width: `${(s / r.totalSteps) * 100}%` }} /></div>
                  </td>
                  <td>
                    <span className={`badge ${r.status === 'finished' ? 'pass' : r.status === 'failed' ? 'fail' : r.status === 'running' ? 'warn' : 'muted'}`}>{r.status}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  )
}

const fieldStyle: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 4, height: 36, padding: '0 10px', borderRadius: 7,
  border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', fontSize: 14,
}
