import { Link } from 'react-router-dom'
import LoopBoard from '../components/LoopBoard'
import { Loading, Stat } from '../components/ui'
import { api, useApi } from '../data/api'

export default function Loop() {
  const { data, error } = useApi(api.loop)
  const diag = useApi(() => api.diagnosis('v1'))

  return (
    <>
      <header className="stage-head" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <div>
          <h1 className="page-title">The learning loop</h1>
          <p className="stage-asks">
            Raw demonstrations in. A served, evaluated and reproducible robot model out.
            {data && <> Cycle {data.cycle} · click a stage to open it.</>}
          </p>
        </div>
      </header>

      {!data ? <Loading error={error} /> : (
        <>
          <div className="board"><LoopBoard status={data} /></div>

          <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Stat label="Demonstrations" value="500" sub="488 valid after ingest" />
            <Stat label="Grasp success" value={<span>58% <span className="muted" style={{ fontWeight: 400 }}>→</span> <span style={{ color: 'var(--pass)' }}>80%</span></span>} sub="Model v1 → v2 on 50 seeds" />
            <Stat label="Live model" value="v1" sub="92 ms per action · v2 waiting to ship" />
          </div>

          {diag.data && (
            <div className="callout">
              <div>
                <div className="hand">What failed? What needs improving?</div>
                <p style={{ marginTop: 6, fontSize: 14 }}>
                  {Math.round(diag.data.findings[0].share * 100)}% of v1 failures are at the {diag.data.findings[0].phase}: {diag.data.findings[0].cause.toLowerCase()}.
                </p>
              </div>
              <Link to="/diagnose" className="btn primary">Plan next cycle</Link>
            </div>
          )}
        </>
      )}
    </>
  )
}
