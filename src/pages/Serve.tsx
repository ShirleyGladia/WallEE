import { useEffect, useState } from 'react'
import { Loading, Panel, StageHeader, Stat, pct } from '../components/ui'
import { api, useApi } from '../data/api'
import type { Endpoint, ModelVersion } from '../data/types'
import { useManifests } from '../select/manifest'

const STATUS_BADGE: Record<ModelVersion['status'], string> = { live: 'pass', candidate: 'warn', staging: 'info', archived: 'muted' }

function Lineage({ v }: { v: ModelVersion }) {
  const manifest = useManifests()[0]
  const nodes = [`Demos`, manifest && v.status !== 'archived' ? manifest.id : `Dataset ${v.dataset}`, `Run ${v.run}`, `Model ${v.version}`, `Eval ${pct(v.successRate)}`]
  return (
    <div className="row" style={{ gap: 6 }}>
      {nodes.map((n, i) => (
        <span key={n} className="row" style={{ gap: 6 }}>
          <span className="badge muted" style={{ fontWeight: 500 }}>{n}</span>
          {i < nodes.length - 1 && <span className="muted">→</span>}
        </span>
      ))}
    </div>
  )
}

export default function Serve() {
  const { data: versions, error } = useApi(api.versions)
  const eps = useApi(api.endpoints)
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [selected, setSelected] = useState('v2')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { if (eps.data) setEndpoints(eps.data) }, [eps.data])

  if (!versions || !eps.data) return <Loading error={error ?? eps.error} />
  const v = versions.find((x) => x.version === selected)!
  const live = versions.find((x) => x.status === 'live')!

  async function deploy(ep: string, version: string) {
    setBusy(ep)
    await api.deploy(version, ep)
    setEndpoints((list) => list.map((e) => (e.id === ep ? { ...e, version } : e)))
    setBusy(null)
  }

  return (
    <>
      <StageHeader id="serve" />

      <div className="stats">
        <Stat label="Live model" value={live.version} sub={`${pct(live.successRate)} success`} />
        <Stat label="Candidate" value="v2" sub={`+${Math.round((versions[0].successRate - live.successRate) * 100)} pts vs live`} />
        <Stat label="Endpoints" value={endpoints.length} sub={`${endpoints.filter((e) => e.healthy).length} healthy`} />
        <Stat label="Latency p50" value={`${live.latencyP50} ms`} sub="Live model" />
      </div>

      <div className="grid g-21" style={{ marginBottom: 16 }}>
        <Panel title="Model registry" hint="Every version is traceable to its data and run">
          <table className="table">
            <thead><tr><th>Version</th><th>Run</th><th>Dataset</th><th className="num">Success</th><th className="num">p50</th><th>Status</th></tr></thead>
            <tbody>
              {versions.map((x) => (
                <tr key={x.version} className={`clickable${x.version === selected ? ' selected' : ''}`} onClick={() => setSelected(x.version)}>
                  <td style={{ fontWeight: 600 }}>{x.version}</td>
                  <td>{x.run}</td>
                  <td>{x.dataset}</td>
                  <td className="num">{pct(x.successRate)}</td>
                  <td className="num">{x.latencyP50} ms</td>
                  <td><span className={`badge ${STATUS_BADGE[x.status]}`}>{x.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title={`Model card · ${v.version}`} hint={v.createdAt}>
          <p className="small" style={{ marginBottom: 12 }}>{v.note}</p>
          <Lineage v={v} />
          <div className="grid g-2" style={{ gap: 10, marginTop: 14 }}>
            <div><div className="small muted">Success</div><div style={{ fontWeight: 700, fontSize: 20 }}>{pct(v.successRate)}</div></div>
            <div><div className="small muted">Latency p50</div><div style={{ fontWeight: 700, fontSize: 20 }}>{v.latencyP50} ms</div></div>
          </div>
          {v.version !== live.version && (
            <div className="small" style={{ marginTop: 12 }}>
              Compared with live {live.version}:{' '}
              <b style={{ color: v.successRate >= live.successRate ? 'var(--pass)' : 'var(--fail)' }}>
                {v.successRate >= live.successRate ? '+' : ''}{Math.round((v.successRate - live.successRate) * 100)} pts success
              </b>
              , {v.latencyP50 - live.latencyP50 >= 0 ? '+' : ''}{v.latencyP50 - live.latencyP50} ms latency
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Endpoints" hint="Where each version is served">
        <div className="grid g-3">
          {endpoints.map((e) => (
            <div key={e.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="hand" style={{ fontSize: 22 }}>{e.id}</span>
                <span className={`badge ${e.healthy ? 'pass' : 'warn'}`}>{e.healthy ? 'Healthy' : 'Offline'}</span>
              </div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{e.target}</div>
              <div className="small muted">Serving {e.version} · {e.requestsPerMin.toLocaleString()} actions/min</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy === e.id || e.version === selected} onClick={() => deploy(e.id, selected)}>
                  {busy === e.id ? 'Deploying…' : e.version === selected ? `${selected} deployed` : `Deploy ${selected}`}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}
