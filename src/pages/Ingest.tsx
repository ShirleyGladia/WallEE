import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel, StageHeader, Stat } from '../components/ui'
import { formatDuration, shortCam } from '../ingest/analyze'
import { fromDrop, fromFileList } from '../ingest/collect'
import { clearIngest, ingestFiles, ingestProjectDataset, listProjectDatasets, useIngest, type ProjectDataset } from '../ingest/store'
import type { EpisodeReport, FileReport, IngestResult } from '../ingest/types'

const STATUS_BADGE: Record<string, string> = { ok: 'pass', warn: 'warn', error: 'fail', skipped: 'muted' }
const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`)

function LoadPanel({ compact }: { compact: boolean }) {
  const { running, progress, error } = useIngest()
  const [over, setOver] = useState(false)
  const dirProps = { webkitdirectory: '', directory: '' } as Record<string, string>
  const [project, setProject] = useState<ProjectDataset[]>([])
  useEffect(() => { listProjectDatasets().then(setProject) }, [])

  return (
    <Panel title={compact ? 'Load another dataset' : 'Load your dataset'} hint="Read in your browser, never uploaded">
      {project.length > 0 && (
        <div className="project-sets">
          <div className="small muted" style={{ marginBottom: 8 }}>Datasets in this project (src/datasets)</div>
          {project.map((d) => (
            <div key={d.name} className="project-set">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                <div className="small muted">{mb(d.bytes)} · {d.files.length} files · reads only what it needs</div>
              </div>
              <button className="btn primary" disabled={running} onClick={() => ingestProjectDataset(d)}>Load</button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault()
          setOver(false)
          await ingestFiles(await fromDrop(e.dataTransfer))
        }}
      >
        <p style={{ fontWeight: 600, color: 'var(--ink)' }}>Drop the dataset folder here</p>
        <p className="small" style={{ marginTop: 4 }}>
          A LeRobot dataset: the folder with <code>data/</code>, <code>videos/</code> and <code>meta/</code> inside. Loose <code>.parquet</code> and <code>.mp4</code> files work too.
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <label className={`btn${project.length ? '' : ' primary'}`}>
            Choose folder
            <input type="file" hidden {...dirProps} onChange={(e) => { ingestFiles(fromFileList(e.target.files)); e.target.value = '' }} />
          </label>
          <label className="btn">
            Choose files
            <input type="file" hidden multiple accept=".parquet,.mp4,.json,.jsonl" onChange={(e) => { ingestFiles(fromFileList(e.target.files)); e.target.value = '' }} />
          </label>
        </div>
      </div>

      {running && progress && (
        <div style={{ marginTop: 14 }} role="status">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span>Reading {progress.label}</span>
            <span className="muted">{progress.done} of {progress.total}</span>
          </div>
          <div className="bar orange" style={{ marginTop: 6 }}><span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
        </div>
      )}
      {error && <p className="small" style={{ marginTop: 12, color: 'var(--fail)' }}>{error}</p>}

      {!compact && (
        <details style={{ marginTop: 14 }}>
          <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>What the folder should contain</summary>
          <pre className="tree">{`pi05_fr3_duo_rand500/
├── meta/
│   ├── info.json            fps, cameras, episode count
│   ├── tasks.parquet        the language instruction
│   └── episodes/…parquet    where each episode starts and ends
├── data/chunk-000/
│   └── file-000.parquet …   joint states, actions, timestamps
└── videos/<camera>/chunk-000/
    └── file-000.mp4 …       one set of videos per camera`}</pre>
        </details>
      )}
    </Panel>
  )
}

function EpisodeStatus({ e }: { e: EpisodeReport }) {
  if (!e.errors.length && !e.warnings.length) return <span className="badge pass">Valid</span>
  return (
    <span className="status-list">
      {e.errors.map((x) => <span key={x} className="badge fail">{x}</span>)}
      {e.warnings.map((x) => <span key={x} className="badge warn">{x}</span>)}
    </span>
  )
}

function Episodes({ result, selected, onSelect }: { result: IngestResult; selected: number; onSelect: (e: number) => void }) {
  const [filter, setFilter] = useState<'all' | 'failed' | 'problems'>('all')
  const [all, setAll] = useState(false)
  const rows = result.episodes.filter((e) => filter === 'all' || e.errors.length > 0 || (filter === 'problems' && e.warnings.length > 0))
  const shown = all ? rows : rows.slice(0, 12)
  const problems = result.episodes.filter((e) => e.errors.length || e.warnings.length).length
  const failed = result.episodes.filter((e) => e.errors.length).length
  const kin = result.kinematics !== 'none'
  return (
    <Panel title="Episodes" hint={
      <span className="row" style={{ gap: 6 }}>
        <button className={`badge ${filter === 'all' ? 'info' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setFilter('all')}>All {result.episodes.length}</button>
        <button className={`badge ${filter === 'failed' ? 'fail' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setFilter('failed')}>Failed {failed}</button>
        <button className={`badge ${filter === 'problems' ? 'info' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setFilter('problems')}>Needs a look {problems}</button>
      </span>
    }>
      {rows.length === 0 ? <p className="small muted">No problems found in any episode.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Episode</th><th className="num">Frames</th><th className="num">Length</th>
              {kin && <><th className="num" title="Fastest joint, rad/s (share of its FR3 limit)">Peak velocity</th><th className="num" title="Largest joint acceleration">Peak accel</th><th className="num" title="Furthest shoulder-to-flange distance, share of 855 mm">Max reach</th></>}
              <th>Success</th><th>Video</th><th>Check</th></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.episode} className={`clickable${e.episode === selected ? ' selected' : ''}`} onClick={() => onSelect(e.episode)}
                  tabIndex={0} onKeyDown={(k) => { if (k.key === 'Enter') onSelect(e.episode) }} aria-label={`Show episode ${e.episode}`}>
                  <td style={{ fontWeight: 600 }}>{e.episode}</td>
                  <td className="num">{e.frames}</td>
                  <td className="num">{e.durationS.toFixed(1)} s</td>
                  {kin && <>
                    <td className="num">{e.peakSpeed.toFixed(2)} rad/s <span className="muted small">{Math.round(e.peakSpeedPct * 100)}%</span></td>
                    <td className="num">{e.peakAccel.toFixed(2)} rad/s²</td>
                    <td className="num" style={{ color: e.maxReach >= 0.9 ? 'var(--fail)' : e.maxReach >= 0.8 ? 'var(--orange)' : undefined }}>{Math.round(e.maxReach * 100)}%</td>
                  </>}
                  <td>{e.success === null ? <span className="muted">—</span> : e.success ? 'Yes' : <span style={{ color: 'var(--fail)' }}>No</span>}</td>
                  <td>{e.videoCovered === null ? <span className="muted">—</span> : e.videoCovered ? 'Yes' : <span className="muted">Missing</span>}</td>
                  <td><EpisodeStatus e={e} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        {rows.length > 12 ? (
          <button className="btn" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>
        ) : <span />}
        <span className="small muted">
          {kin && (result.kinematics === 'data' ? 'Velocity and acceleration from the dataset. ' : 'Velocity and acceleration worked out from joint angles. ')}
          {Object.keys(result.segments).length > 0 && 'Click an episode to watch it'}
        </span>
      </div>
    </Panel>
  )
}

function Cameras({ result }: { result: IngestResult }) {
  if (!result.cameras.length) return null
  return (
    <Panel title="Cameras" hint={`${result.cameras.length} camera${result.cameras.length === 1 ? '' : 's'}`}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {result.cameras.map((c) => {
          const share = result.episodes.length ? c.coveredEpisodes / result.episodes.length : 0
          return (
            <div key={c.key} className="camera">
              {c.previewUrl
                ? <video src={`${c.previewUrl}#t=2`} controls muted loop playsInline preload="metadata" aria-label={`Video from camera ${c.key}`} />
                : <div className="camera-none small muted">This browser can’t play these videos. Open the page in Chrome to watch them.</div>}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{shortCam(c.key)}</div>
                <div className="small muted">
                  {c.width && c.height ? `${c.width}×${c.height} · ` : ''}
                  {c.expectedFiles ? `${c.files.length} of ${c.expectedFiles} files` : `${c.files.length} file${c.files.length === 1 ? '' : 's'}`} · {formatDuration(c.durationS)}
                </div>
                {c.matchedFrom && <div className="small muted" style={{ marginTop: 4 }}>Folder “{c.matchedFrom}” recognised as this camera by its length</div>}
                <div className="small" style={{ marginTop: 10 }}>Covers {c.coveredEpisodes} of {result.episodes.length} episodes</div>
                <div className={`bar${share < 1 ? ' orange' : ''}`} style={{ marginTop: 6 }}><span style={{ width: `${share * 100}%` }} /></div>
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function EpisodeViewer({ result, episode, onPick }: { result: IngestResult; episode: number; onPick: (e: number) => void }) {
  const seg = result.segments[episode]
  const cams = result.cameras.filter((c) => seg?.[c.key] && c.playable)
  const refs = useRef(new Map<string, HTMLVideoElement>())
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(2)
  const dur = seg ? Math.max(...Object.values(seg).map((s) => s.to - s.from)) : 0
  const ids = result.episodes.map((e) => e.episode)
  const pos = ids.indexOf(episode)
  const info = result.episodes[pos]

  // Load the right file for each camera and jump to where this episode starts.
  useEffect(() => {
    setPlaying(false)
    setT(0)
    for (const c of cams) {
      const v = refs.current.get(c.key)
      const sg = seg[c.key]
      if (!v) continue
      const url = c.fileUrls[sg.fi]
      const seek = () => { v.currentTime = sg.from + 0.01 }
      if (v.dataset.src !== url) {
        v.dataset.src = url
        v.src = url
        v.addEventListener('loadedmetadata', seek, { once: true })
      } else if (v.readyState >= 1) seek()
      else v.addEventListener('loadedmetadata', seek, { once: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode, result])

  // Play all cameras together; the first camera is the clock, the others follow it.
  useEffect(() => {
    const vids = cams.map((c) => ({ v: refs.current.get(c.key), s: seg[c.key] })).filter((x): x is { v: HTMLVideoElement; s: typeof x.s } => !!x.v)
    vids.forEach(({ v }) => { v.playbackRate = rate })
    if (!playing || !vids.length) { vids.forEach(({ v }) => v.pause()); return }
    vids.forEach(({ v }) => v.play().catch(() => setPlaying(false)))
    let raf = 0
    const loop = () => {
      const lead = vids[0]
      const now = lead.v.currentTime - lead.s.from
      if (now >= dur - 0.02) { setPlaying(false); setT(dur); return }
      setT(now)
      for (const { v, s } of vids.slice(1)) {
        const target = s.from + now
        if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, episode])

  const seekTo = (x: number) => {
    setT(x)
    for (const c of cams) {
      const v = refs.current.get(c.key)
      if (v) v.currentTime = seg[c.key].from + x
    }
  }

  if (!seg) return null
  return (
    <Panel title={`Episode ${episode}`} hint={info ? `${info.frames} frames · ${info.durationS.toFixed(1)} s · ${result.tasks[0] ?? ''}` : ''}>
      {cams.length === 0 ? (
        <p className="small muted">This browser can’t play these videos. Open the page in Chrome to watch the episode.</p>
      ) : (
        <div className="viewer">
          {cams.map((c) => (
            <figure key={c.key}>
              <video ref={(el) => { if (el) refs.current.set(c.key, el); else refs.current.delete(c.key) }} muted playsInline preload="auto" />
              <figcaption className="small"><span style={{ textTransform: 'capitalize' }}>{shortCam(c.key)}</span> <span className="muted">· file {seg[c.key].fi}, {seg[c.key].from.toFixed(1)}–{seg[c.key].to.toFixed(1)} s</span></figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="scrub">
        <button className="btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40, justifyContent: 'center', padding: 0 }} disabled={!cams.length}>
          {playing ? '❚❚' : '▶'}
        </button>
        <input type="range" min={0} max={Math.max(0, dur)} step={1 / result.fps} value={Math.min(t, dur)} onChange={(e) => seekTo(Number(e.target.value))} aria-label="Time in episode" />
        <span className="small" style={{ minWidth: 120, textAlign: 'right' }}>frame {Math.round(t * result.fps)} · {t.toFixed(1)} s</span>
      </div>
      <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        <div className="row" role="group" aria-label="Playback speed">
          {[1, 2, 4].map((r) => (
            <button key={r} className={`badge ${rate === r ? 'info' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setRate(r)}>{r}×</button>
          ))}
        </div>
        <div className="row">
          <button className="btn" disabled={pos <= 0} onClick={() => onPick(ids[pos - 1])}>Previous</button>
          <button className="btn" disabled={pos >= ids.length - 1} onClick={() => onPick(ids[pos + 1])}>Next episode</button>
        </div>
      </div>
    </Panel>
  )
}

function FileGroups({ result }: { result: IngestResult }) {
  const groups: { label: string; files: FileReport[] }[] = [
    { label: 'Metadata', files: result.files.filter((f) => ['info', 'tasks', 'episodes-meta', 'stats'].includes(f.kind)) },
    { label: 'Frame data', files: result.files.filter((f) => f.kind === 'data') },
    ...result.cameras.map((c) => ({ label: `Video · ${shortCam(c.key)}`, files: result.files.filter((f) => f.kind === 'video' && f.camera === c.key) })),
    { label: 'Other', files: result.files.filter((f) => f.kind === 'other') },
  ].filter((g) => g.files.length)
  return (
    <Panel title="Files" hint={`${result.files.length} read · ${mb(result.files.reduce((s, f) => s + f.bytes, 0))}`}>
      {groups.map((g) => {
        const bad = g.files.filter((f) => f.status === 'error').length
        const warn = g.files.filter((f) => f.status === 'warn').length
        return (
          <details key={g.label} className="file-group">
            <summary>
              <span style={{ fontWeight: 600 }}>{g.label}</span>
              <span className="small muted">{g.files.length} file{g.files.length === 1 ? '' : 's'} · {mb(g.files.reduce((s, f) => s + f.bytes, 0))}</span>
              <span className={`badge ${bad ? 'fail' : warn ? 'warn' : 'pass'}`}>{bad ? `${bad} failed` : warn ? `${warn} to check` : 'All OK'}</span>
            </summary>
            <table className="table" style={{ marginTop: 6 }}>
              <tbody>
                {g.files.map((f) => (
                  <tr key={f.path}>
                    <td style={{ wordBreak: 'break-all' }}>{f.path}<div className="small muted">{f.detail}</div></td>
                    <td className="num small">{mb(f.bytes)}</td>
                    <td><span className={`badge ${STATUS_BADGE[f.status]}`}>{f.status === 'ok' ? 'OK' : f.status === 'warn' ? 'Check' : f.status === 'error' ? 'Failed' : 'Skipped'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )
      })}
    </Panel>
  )
}

function Results({ result }: { result: IngestResult }) {
  const n = result.episodes.length
  const cams = result.cameras
  const hasSegments = Object.keys(result.segments).length > 0
  const [episode, setEpisode] = useState(() => result.episodes[0]?.episode ?? 0)
  useEffect(() => { setEpisode(result.episodes[0]?.episode ?? 0) }, [result])
  const lengths = result.episodes.map((e) => e.durationS)
  const viewerRef = useRef<HTMLDivElement>(null)
  const pick = (e: number) => {
    setEpisode(e)
    viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  return (
    <>
      <p className="small muted" style={{ margin: '0 0 12px' }}>
        <b style={{ color: 'var(--ink)' }}>{result.name}</b> · {result.format}{result.robotType ? ` · ${result.robotType}` : ''}
        {result.tasks[0] ? <> · “{result.tasks[0]}”</> : null}
        {' · '}<button className="linklike" onClick={clearIngest}>Clear</button>
      </p>

      <div className="stats">
        <Stat label="Valid episodes" value={`${result.totals.valid} / ${n}`}
          sub={`${result.totals.invalid ? `${result.totals.invalid} failed a check` : 'All passed'}${result.expectedEpisodes && result.expectedEpisodes > n ? ` · ${result.expectedEpisodes} in the dataset` : ''}`} />
        <Stat label="Frames" value={result.totals.frames.toLocaleString()} sub={`${formatDuration(result.totals.durationS)} of robot motion`} />
        <Stat label="Frame rate" value={`${result.fps} fps`} sub={result.fpsSource === 'timestamps' ? 'Worked out from timestamps' : 'From info.json'} />
        <Stat label="Episode length" value={`${Math.round(result.totals.durationS / Math.max(1, n))} s`} sub={n ? `Average · ${Math.min(...lengths).toFixed(0)}–${Math.max(...lengths).toFixed(0)} s` : ''} />
        <Stat label="Cameras" value={cams.length || '—'} sub={cams.length ? `${formatDuration(cams[0].durationS)} of video each · ${Math.min(...cams.map((c) => c.coveredEpisodes))} of ${n} episodes covered` : 'No videos loaded'} />
      </div>

      <div className="grid g-21" style={{ marginBottom: 16 }}>
        <Episodes result={result} selected={episode} onSelect={pick} />
        <div className="grid" style={{ alignContent: 'start' }}>
          <Panel title="Data gaps" hint="The “No” branch">
            {result.gaps.length ? (
              <ul className="list">{result.gaps.map((g) => <li key={g} className="small">{g}</li>)}</ul>
            ) : <p className="small muted">Nothing missing.</p>}
            <Link to="/dataset" className="btn" style={{ marginTop: 10 }}>Continue to dataset intelligence</Link>
          </Panel>
        </div>
      </div>

      <div ref={viewerRef} style={{ marginBottom: 16, scrollMarginTop: 16 }}>
        {hasSegments ? <EpisodeViewer result={result} episode={episode} onPick={setEpisode} /> : <Cameras result={result} />}
      </div>

      <div className="grid g-2">
        <FileGroups result={result} />

        <Panel title="What each frame contains">
          <table className="table">
            <thead><tr><th>Column</th><th>Type</th><th>Meaning</th></tr></thead>
            <tbody>
              {result.schema.map((s) => (
                <tr key={s.column}>
                  <td><code>{s.column}</code></td>
                  <td className="small">{s.type}</td>
                  <td className="small muted">{s.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  )
}

export default function Ingest() {
  const { result } = useIngest()
  const n = result?.episodes.length ?? 0
  const share = n ? result!.totals.valid / n : 0
  return (
    <>
      <StageHeader
        id="ingest"
        gate={result
          ? { question: 'Is this file valid?', verdict: n && share >= 0.95 ? 'pass' : 'fail', detail: `${result.totals.valid} of ${n} episodes passed` }
          : { question: 'Is this file valid?', verdict: 'pending', detail: 'Load a dataset to check it' }}
      />
      {result ? (
        <>
          <Results result={result} />
          <div style={{ marginTop: 16 }}><LoadPanel compact /></div>
        </>
      ) : <LoadPanel compact={false} />}
    </>
  )
}
