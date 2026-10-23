import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import EpisodeInspector from '../components/EpisodeInspector'
import { Loading, Panel, StageHeader, Stat } from '../components/ui'
import { api, useApi } from '../data/api'
import type { Episode, EpisodeFlag } from '../data/types'
import { useIngest } from '../ingest/store'
import DatasetReal from './DatasetReal'

function CoverageMap({ episodes, onPick, picked }: { episodes: Episode[]; onPick: (e: Episode) => void; picked?: number }) {
  const W = 420, H = 260, pad = 18
  const X = (v: number) => pad + v * (W - 2 * pad)
  const Y = (v: number) => pad + v * (H - 2 * pad)
  return (
    <div className="coverage">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Top-down map of where the catheter pack starts on the tray in each episode, with an empty region in the back-left corner">
        <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} rx="6" fill="var(--surface-2)" stroke="var(--line)" />
        <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="var(--ink-3)">Robot side</text>
        <rect x={X(0.01)} y={Y(0.63)} width={X(0.27) - X(0.01)} height={Y(0.99) - Y(0.63)} fill="none" stroke="var(--fail)" strokeDasharray="5 4" rx="4" />
        <text x={X(0.03)} y={Y(0.6)} fontFamily="var(--hand)" fontSize="15" fill="var(--fail)">gap</text>
        {episodes.map((e) => {
          const flagged = e.flags.length > 0
          return (
            <circle key={e.id} cx={X(e.objectX)} cy={Y(e.objectY)} r={picked === e.id ? 6 : 3.4}
              fill={flagged ? 'none' : 'var(--chart-1)'} stroke={flagged ? 'var(--fail)' : 'var(--surface)'} strokeWidth={flagged ? 1.5 : 1}
              opacity={flagged ? 0.9 : 0.75} style={{ cursor: 'pointer' }} onClick={() => onPick(e)}>
              <title>Episode {e.id}{flagged ? ` · ${e.flags.join(', ')}` : ''} · yaw {e.objectYawDeg}°</title>
            </circle>
          )
        })}
        {picked !== undefined && (() => {
          const e = episodes.find((x) => x.id === picked)
          return e ? <circle cx={X(e.objectX)} cy={Y(e.objectY)} r={9} fill="none" stroke="var(--orange)" strokeWidth="2" /> : null
        })()}
      </svg>
      <div className="row small muted" style={{ gap: 16, marginTop: 6 }}>
        <span className="row" style={{ gap: 6 }}><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--chart-1)" /></svg>Clean episode</span>
        <span className="row" style={{ gap: 6 }}><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--fail)" strokeWidth="1.5" /></svg>Flagged</span>
        <span>Click a dot to inspect it</span>
      </div>
    </div>
  )
}

function YawHistogram({ episodes }: { episodes: Episode[] }) {
  const buckets = [-45, -30, -15, 0, 15, 30]
  const counts = buckets.map((b) => episodes.filter((e) => e.objectYawDeg >= b && e.objectYawDeg < b + 15).length)
  const max = Math.max(...counts)
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${buckets.length}, 1fr)`, gap: 6, alignItems: 'end', height: 110 }}>
        {counts.map((c, i) => (
          <div key={i} title={`${c} episodes`} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', alignItems: 'center', gap: 4 }}>
            <span className="small">{c}</span>
            <div style={{ width: '70%', height: `${(c / max) * 80}%`, minHeight: 2, background: c < 25 ? 'var(--fail)' : 'var(--chart-1)', borderRadius: '4px 4px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${buckets.length}, 1fr)`, gap: 6, borderTop: '1px solid var(--line)', paddingTop: 4 }}>
        {buckets.map((b) => <span key={b} className="small muted" style={{ textAlign: 'center' }}>{b}°</span>)}
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>Pack rotation at the start of each episode. Red buckets have fewer than 25 demos.</p>
    </div>
  )
}

// Real data when a dataset is loaded in Ingest; otherwise the example page.
export default function Dataset() {
  const { result } = useIngest()
  return result ? <DatasetReal result={result} /> : <DatasetDemo />
}

function DatasetDemo() {
  const { data, error } = useApi(api.dataset)
  const [filter, setFilter] = useState<EpisodeFlag | 'all' | 'clean'>('all')
  const [picked, setPicked] = useState<Episode | null>(null)

  const rows = useMemo(() => {
    if (!data) return []
    return data.episodes.filter((e) => (filter === 'all' ? true : filter === 'clean' ? e.flags.length === 0 : e.flags.includes(filter)))
  }, [data, filter])

  if (!data) return <Loading error={error} />
  const flagged = data.episodes.filter((e) => e.flags.length).length
  const failing = data.readiness.filter((r) => !r.ok)
  const current = picked ?? data.episodes.find((e) => e.flags.includes('misaligned')) ?? data.episodes[0]

  return (
    <>
      <StageHeader
        id="dataset"
        gate={{
          question: 'Is the dataset good as a whole?',
          verdict: failing.length === 0 ? 'pass' : failing.length === 1 ? 'pass' : 'fail',
          detail: failing.length ? `${data.readiness.length - failing.length} of ${data.readiness.length} checks green, 1 warning` : 'All checks green',
        }}
        actions={<Link to="/train" className="btn primary">Train on dataset {data.version}</Link>}
      />

      <p className="small" style={{ margin: '-8px 0 14px' }}>
        <span className="badge warn">Example data</span> <Link to="/ingest">Load a dataset in Ingest</Link> to see your real episodes, reach and joint speeds here.
      </p>
      <div className="stats">
        <Stat label="Health score" value={data.health} sub="Out of 100" />
        <Stat label="Episodes" value={data.episodes.length} sub={`Dataset ${data.version}`} />
        <Stat label="Flagged" value={flagged} sub="Excluded from training" />
        <Stat label="Coverage gaps" value={1} sub="Back-left corner" />
      </div>

      <div className="grid g-21" style={{ marginBottom: 16 }}>
        <Panel title="Where the pack starts" hint="Workspace coverage">
          <CoverageMap episodes={data.episodes} onPick={setPicked} picked={current.id} />
        </Panel>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Panel title="What’s wrong with flagged episodes">
            <ul className="list">
              {data.breakdown.map((b) => (
                <li key={b.flag}>
                  <button onClick={() => setFilter(filter === b.flag ? 'all' : b.flag)}
                    style={{ all: 'unset', cursor: 'pointer', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, width: '100%' }}
                    aria-pressed={filter === b.flag}>
                    <span className="small" style={{ fontWeight: filter === b.flag ? 700 : 400 }}>{b.label}</span>
                    <span className="badge fail">{b.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Rotation coverage"><YawHistogram episodes={data.episodes} /></Panel>
        </div>
      </div>

      <Panel title={`Episode ${current.id}`} hint={current.flags.length ? `Flagged: ${current.flags.join(', ')}` : 'Clean episode'} className="">
        <EpisodeInspector episode={current} />
      </Panel>

      <div className="grid g-21" style={{ marginTop: 16 }}>
        <Panel title="Episodes" hint={
          <span className="row" style={{ gap: 6 }}>
            {(['all', 'clean'] as const).map((f) => (
              <button key={f} className={`badge ${filter === f ? 'info' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : 'Clean only'}
              </button>
            ))}
            {filter !== 'all' && filter !== 'clean' && <span className="badge fail">{filter}</span>}
          </span>
        }>
          <table className="table">
            <thead><tr><th>#</th><th className="num">Length</th><th className="num">Yaw</th><th>Flags</th></tr></thead>
            <tbody>
              {rows.slice(0, 10).map((e) => (
                <tr key={e.id} className={`clickable${e.id === current.id ? ' selected' : ''}`} onClick={() => setPicked(e)}>
                  <td>{e.id}</td>
                  <td className="num">{e.durationS.toFixed(1)} s</td>
                  <td className="num">{e.objectYawDeg}°</td>
                  <td>{e.flags.length ? e.flags.map((f) => <span key={f} className="badge fail">{f}</span>) : <span className="badge pass">clean</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>Showing 10 of {rows.length}</p>
        </Panel>

        <Panel title="Ready for a VLA?" hint="Checks before training">
          <ul className="list">
            {data.readiness.map((r) => (
              <li key={r.check} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 8 }}>
                <span style={{ color: r.ok ? 'var(--pass)' : 'var(--warn)', fontWeight: 700 }}>{r.ok ? '✓' : '!'}</span>
                <span>
                  <span className="small" style={{ fontWeight: 600 }}>{r.check}</span>
                  <div className="small muted">{r.note}</div>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  )
}
