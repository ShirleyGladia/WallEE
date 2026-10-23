import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading, Panel, StageHeader, pct } from '../components/ui'
import { api, useApi } from '../data/api'

const KIND_LABEL = { data: 'New data', check: 'New check', training: 'Training' } as const

export default function Diagnose() {
  const { data, error } = useApi(() => api.diagnosis('v1'))
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [started, setStarted] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (data) setChosen(new Set(data.recommendations.map((r) => r.title))) }, [data])
  if (!data) return <Loading error={error} />

  const toggle = (t: string) => setChosen((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })

  async function startCycle() {
    setBusy(true)
    const res = await api.startNextCycle([...chosen])
    setBusy(false)
    setStarted(res.cycle)
  }

  return (
    <>
      <StageHeader
        id="diagnose"
        gate={{ question: 'What failed? What needs improving?', verdict: 'fail', detail: `Model ${data.model} below target` }}
      />

      <div className="grid g-2" style={{ marginBottom: 16 }}>
        <Panel title="What failed" hint={`Model ${data.model} · by phase`}>
          <ul className="list">
            {data.findings.map((f) => (
              <li key={f.phase}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{f.phase}</span>
                  <span className="small">{pct(f.share)} of failures</span>
                </div>
                <div className="bar" style={{ margin: '6px 0 8px' }}><span style={{ width: `${f.share * 100}%`, background: 'var(--fail)' }} /></div>
                <div className="small"><b>{f.cause}.</b> <span className="muted">{f.evidence}</span></div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="What to do next" hint={`${chosen.size} of ${data.recommendations.length} selected`}>
          {data.recommendations.map((r) => (
            <label key={r.title} className="rec">
              <input type="checkbox" checked={chosen.has(r.title)} onChange={() => toggle(r.title)} />
              <span>
                <span style={{ fontWeight: 600 }}>{r.title}</span>
                <div className="small muted">{r.detail}</div>
              </span>
              <span style={{ textAlign: 'right' }}>
                <span className={`badge ${r.kind === 'data' ? 'info' : r.kind === 'check' ? 'warn' : 'muted'}`}>{KIND_LABEL[r.kind]}</span>
                <div className="small muted" style={{ marginTop: 4 }}>{r.impact}</div>
              </span>
            </label>
          ))}
        </Panel>
      </div>

      <div className="callout">
        {started ? (
          <>
            <div>
              <div className="hand">Cycle {started} started</div>
              <p style={{ fontSize: 14, marginTop: 4 }}>New demos are being generated in simulation. Dataset intelligence will re-run its checks before training.</p>
            </div>
            <Link to="/dataset" className="btn">Go to dataset intelligence</Link>
          </>
        ) : (
          <>
            <div>
              <div className="hand">Feed this back into 02 · dataset intelligence</div>
              <p style={{ fontSize: 14, marginTop: 4 }}>Generates the selected data, adds the new checks, and retrains from the current model.</p>
            </div>
            <button className="btn primary" onClick={startCycle} disabled={busy || chosen.size === 0}>
              {busy ? 'Starting…' : 'Start next cycle'}
            </button>
          </>
        )}
      </div>
    </>
  )
}
