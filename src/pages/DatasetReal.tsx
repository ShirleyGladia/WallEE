import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ClipReview from '../components/ClipReview'
import WorkspaceInspector from '../components/WorkspaceInspector'
import { Panel, StageHeader, Stat } from '../components/ui'
import { formatDuration, shortCam } from '../ingest/analyze'
import { diversity } from '../ingest/diversity'
import { FR3 } from '../ingest/kinematics'
import { cachedLighting, lightingVerdict, measureLighting, type LightingResult } from '../ingest/lighting'
import type { IngestResult } from '../ingest/types'
import { findMoments } from '../review/moments'
import { useThresholds } from '../review/settings'
import { useReview } from '../review/store'

const pct = (x: number) => `${Math.round(x * 100)}%`
type Tab = 'episodes' | 'review' | 'vla'

type Tone = 'ok' | 'warn' | 'fail' | 'wait'
interface Check { group: string; check: string; tone: Tone; note: ReactNode; why: string }
const MARK: Record<Tone, string> = { ok: '✓', warn: '!', fail: '✕', wait: '…' }
const COLOR: Record<Tone, string> = { ok: 'var(--pass)', warn: 'var(--warn)', fail: 'var(--fail)', wait: 'var(--ink-3)' }

// 2-D map of what each episode did (first two principal components of the gripper paths).
function BehaviourMap({ map, picked, onPick, bad }: { map: { episode: number; x: number; y: number }[]; picked: number; onPick: (e: number) => void; bad: Set<number> }) {
  const W = 420, H = 280, pad = 16
  const xs = map.map((p) => p.x), ys = map.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const X = (v: number) => pad + ((v - x0) / (x1 - x0 || 1)) * (W - 2 * pad)
  const Y = (v: number) => H - pad - ((v - y0) / (y1 - y0 || 1)) * (H - 2 * pad)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ws-chart" role="img" aria-label="Behaviour map: each dot is an episode, close dots did similar things">
      <rect x={1} y={1} width={W - 2} height={H - 2} rx="8" fill="var(--surface-2)" stroke="var(--line)" />
      {map.map((p) => (
        <circle key={p.episode} cx={X(p.x)} cy={Y(p.y)} r={p.episode === picked ? 6 : 3.2} style={{ cursor: 'pointer' }}
          fill={bad.has(p.episode) ? 'none' : 'var(--petrol)'} stroke={bad.has(p.episode) ? 'var(--fail)' : p.episode === picked ? 'var(--ink)' : 'var(--surface)'}
          strokeWidth={bad.has(p.episode) ? 1.6 : 1} opacity={0.85} onClick={() => onPick(p.episode)}>
          <title>Episode {p.episode}</title>
        </circle>
      ))}
    </svg>
  )
}

function LightingPanel({ result, onPick, onDone }: { result: IngestResult; onPick: (e: number) => void; onDone: () => void }) {
  const cams = result.cameras.filter((c) => c.playable)
  const [cam, setCam] = useState(() => (cams.find((c) => c.key.includes('external')) ?? cams[0])?.key ?? '')
  const [res, setRes] = useState<LightingResult | null>(() => (cam ? cachedLighting(result, cam) ?? null : null))
  const [prog, setProg] = useState<[number, number] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const run = (key: string) => {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setErr(null)
    setRes(cachedLighting(result, key) ?? null)
    if (cachedLighting(result, key)) return
    setProg([0, 1])
    measureLighting(result, key, (d, t) => setProg([d, t]), ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) { setRes(r); setProg(null); onDone() } })
      .catch((e: Error) => { setErr(e.message); setProg(null) })
  }
  useEffect(() => { if (cam && !res) run(cam); return () => abort.current?.abort() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cams.length) return <p className="small muted">No playable videos loaded, so lighting can’t be measured. Load the dataset with its videos, in Chrome.</p>
  const v = res && res.lights.length ? lightingVerdict(res.lights) : null
  const sorted = res ? [...res.lights].sort((a, b) => a.brightness - b.brightness) : []
  const picks = sorted.length ? [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]] : []
  // brightness histogram, 0–255 in 16 bins
  const bins = new Array(32).fill(0)
  for (const l of res?.lights ?? []) bins[Math.min(31, Math.floor(l.brightness / 8))]++
  const top = Math.max(1, ...bins)
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <label className="small row" style={{ gap: 6 }}>
          Camera
          <select className="field-select" value={cam} onChange={(e) => { setCam(e.target.value); run(e.target.value) }}>
            {cams.map((c) => <option key={c.key} value={c.key}>{shortCam(c.key)}</option>)}
          </select>
        </label>
        {prog && <span className="small muted">Reading one frame per episode… {prog[0]} of {prog[1]}</span>}
        {err && <span className="small" style={{ color: 'var(--fail)' }}>{err}</span>}
      </div>
      {prog && <div className="bar" style={{ marginTop: 8 }}><span style={{ width: `${(prog[0] / Math.max(1, prog[1])) * 100}%` }} /></div>}
      {v && (
        <>
          <p className="small" style={{ margin: '10px 0' }}>
            {v.uniform
              ? <><b style={{ color: 'var(--warn)' }}>The light is the same in every episode.</b> Brightness {v.mean.toFixed(0)} ± {v.std.toFixed(1)} (out of 255), colour barely changes. A policy trained only under this light can fail under the operating-room lamps; add episodes with randomised lighting in the simulator.</>
              : <><b style={{ color: 'var(--pass)' }}>Lighting varies.</b> Brightness {v.mean.toFixed(0)} ± {v.std.toFixed(1)} (out of 255); the middle 90% of episodes span {v.range.toFixed(0)} levels.</>}
          </p>
          <svg viewBox="0 0 320 70" className="ws-chart" role="img" aria-label={`Brightness of ${res!.lights.length} episodes, from dark (left) to bright (right)`}>
            {bins.map((n, i) => <rect key={i} x={i * 10} y={60 - (n / top) * 56} width={9} height={(n / top) * 56} rx="1.5" fill="var(--petrol)" />)}
            <line x1={0} x2={320} y1={60.5} y2={60.5} stroke="var(--line)" />
            <text x={0} y={69} fontSize="8" fill="var(--ink-3)">dark</text>
            <text x={320} y={69} fontSize="8" fill="var(--ink-3)" textAnchor="end">bright</text>
          </svg>
          <div className="thumbs">
            {picks.map((l, k) => (
              <button key={l.episode} className="thumb" onClick={() => onPick(l.episode)} title={`Open episode ${l.episode}`}>
                {l.thumb && <img src={l.thumb} alt={`Episode ${l.episode}, ${['darkest', 'typical', 'brightest'][k]} frame`} />}
                <span className="small">{['Darkest', 'Typical', 'Brightest'][k]} · ep {l.episode} · {l.brightness.toFixed(0)}</span>
              </button>
            ))}
          </div>
          {res!.failed > 0 && <p className="small muted">{res!.failed} episodes couldn’t be read.</p>}
        </>
      )}
    </div>
  )
}

// Data intelligence on the dataset loaded in Ingest.
export default function DatasetReal({ result }: { result: IngestResult }) {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'episodes'
  const setTab = (t: Tab) => setParams((p) => { p.set('tab', t); return p }, { replace: true })
  const th = useThresholds()
  const saved = useReview(result.name)
  const [, setLightTick] = useState(0)
  const eps = result.episodes
  const byReach = useMemo(() => [...eps].sort((a, b) => b.maxReach - a.maxReach), [eps])
  const [episode, setEpisode] = useState(() => byReach[0]?.episode ?? 0)
  useEffect(() => { setEpisode(byReach[0]?.episode ?? 0) }, [byReach])
  const ids = eps.map((e) => e.episode)
  const pos = ids.indexOf(episode)
  const kin = result.kinematics !== 'none'
  const open = (e: number) => { setEpisode(e); setTab('episodes'); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  // Motion limits over the episodes that will be trained on (broken ones would only show their glitches).
  const good = eps.filter((e) => e.errors.length === 0)
  const peakSpeed = Math.max(...good.map((e) => e.peakSpeedPct), 0)
  const peakAccel = Math.max(...good.map((e) => e.peakAccel), 0)
  const peakTcp = Math.max(...good.map((e) => (e.trace ? Math.max(...e.trace.tcp) : 0)), 0)
  const maxReach = Math.max(...good.map((e) => e.maxReach), 0)
  const near = good.filter((e) => e.maxReach >= th.reach).length
  const div = useMemo(() => diversity(eps), [eps])
  const bad = useMemo(() => new Set(eps.filter((e) => e.errors.length).map((e) => e.episode)), [eps])
  const clipCount = useMemo(() => eps.reduce((s, e) => s + findMoments(e, result.fps, th).length, 0), [eps, result.fps, th])
  const manual = Object.values(saved).filter((c) => c.source === 'manual').length
  const decided = Object.values(saved).filter((c) => c.verdict).length
  const lightRes = result.cameras.length ? cachedLighting(result, (result.cameras.find((c) => c.key.includes('external')) ?? result.cameras[0]).key) : undefined
  const light = lightRes?.lights.length ? lightingVerdict(lightRes.lights) : null

  const split = /^(\d+):(\d+)$/.exec(result.splits?.train ?? '')
  const splitN = split ? Number(split[2]) - Number(split[1]) : null
  const statsShare = result.stats?.count ? result.stats.count / Math.max(1, result.totals.frames) : null
  const taskSet = new Set(eps.map((e) => e.task).filter((t) => t !== null && t !== undefined))

  const checks: Check[] = [
    // the data itself
    { group: 'Clean data', check: 'Every episode passes the ingest checks', tone: result.totals.invalid === 0 ? 'ok' : result.totals.invalid / eps.length < 0.05 ? 'warn' : 'fail',
      note: `${result.totals.valid} of ${eps.length} valid${result.totals.invalid ? ` · ${result.totals.invalid} will be left out` : ''}`, why: 'Broken episodes teach the policy broken motion.' },
    { group: 'Clean data', check: 'Every camera covers every episode', tone: result.cameras.length > 0 && result.cameras.every((c) => c.coveredEpisodes === eps.length) ? 'ok' : 'fail',
      note: result.cameras.length
        ? `${result.cameras.length} camera${result.cameras.length === 1 ? '' : 's'}, ${Math.min(...result.cameras.map((c) => c.coveredEpisodes))} of ${eps.length} episodes covered`
        : 'No videos loaded. Load the dataset from “Datasets in this project” on the Ingest page, or include the videos folder.',
      why: 'π0.5 sees the world only through the cameras.' },
    { group: 'Clean data', check: 'Suspicious moments looked at by a person', tone: clipCount + manual === 0 ? 'ok' : decided >= clipCount + manual ? 'ok' : 'warn',
      note: clipCount + manual === 0 ? 'Nothing suspicious found' : <>{decided} of {clipCount + manual} clips decided · <button className="linklike small" onClick={() => setTab('review')}>open clip review</button></>,
      why: 'Some problems (swapped cameras, wrong grasp) only a person spots.' },
    // what training will read
    { group: 'Ready to train', check: 'Normalisation stats cover the whole dataset', tone: statsShare === null ? 'wait' : statsShare > 0.98 ? 'ok' : 'fail',
      note: result.stats ? (result.stats.count ? `${result.stats.file} was computed on ${result.stats.count.toLocaleString()} of ${result.totals.frames.toLocaleString()} frames (${pct(statsShare ?? 0)}). Recompute it before training.` : `${result.stats.file} has no frame count`) : 'No meta/stats.json loaded',
      why: 'The policy’s inputs are scaled with these numbers; stats from a slice skew everything else.' },
    { group: 'Ready to train', check: 'Training split covers the dataset', tone: splitN === null ? 'wait' : splitN >= (result.expectedEpisodes ?? eps.length) ? 'ok' : 'fail',
      note: splitN === null ? 'No splits in info.json' : `info.json: train = episodes ${result.splits?.train} (${splitN} of ${result.expectedEpisodes ?? eps.length}). Selection writes a proper train/validation/test split.`,
      why: 'A trainer that reads splits would silently use a fraction of the data.' },
    // diversity
    { group: 'Variety', check: 'More than one way to say the task', tone: result.tasks.length > 1 ? 'ok' : result.tasks.length === 1 ? 'warn' : 'fail',
      note: result.tasks.length ? `${result.tasks.length} instruction${result.tasks.length === 1 ? '' : 's'}: “${result.tasks[0]}”${taskSet.size > 1 ? ` · used across ${taskSet.size} task indices` : ''}` : 'No task text found',
      why: 'With a single sentence, the language part of a VLA learns nothing. Paraphrases (“hand me the…”, “pass the…”) make it follow a nurse’s words.' },
    { group: 'Variety', check: 'Episodes do different things', tone: !div ? 'wait' : div.nnMedianMm > 10 ? 'ok' : 'warn',
      note: div ? `Each episode is typically ${div.nnMedianMm.toFixed(0)} mm (RMS gripper path) from its closest neighbour${div.nearCopies.length ? ` · ${div.nearCopies.length} near-copies` : ' · no near-copies'}` : 'Needs joint angles',
      why: 'Many near-identical demonstrations add hours, not skill.' },
    { group: 'Variety', check: 'Arm starts from different poses', tone: !div ? 'wait' : div.startSpreadDeg > 2 ? 'ok' : 'warn',
      note: div ? `Start joint angles vary by ${div.startSpreadDeg.toFixed(2)}° on average${div.startSpreadDeg <= 2 ? ': every episode starts from the same pose' : ''}` : 'Needs joint angles',
      why: 'If the arm always starts in one pose, the policy may fail when it starts anywhere else, e.g. after a handover.' },
    { group: 'Variety', check: 'Lighting varies between episodes', tone: !light ? 'wait' : light.uniform ? 'warn' : 'ok',
      note: light ? `Brightness ${light.mean.toFixed(0)} ± ${light.std.toFixed(1)} of 255${light.uniform ? ': one lighting setup' : ''}` : <>Not measured yet · see “Lighting” below</>,
      why: 'Operating-room light changes all the time (surgical lamps, monitors).' },
    // safety
    { group: 'Safe motion', check: `Arms stay inside ${pct(th.reach)} of maximum reach`, tone: !kin ? 'wait' : near === 0 ? 'ok' : 'warn',
      note: kin ? `Furthest: ${pct(maxReach)} of 855 mm${near ? ` · ${near} episodes above ${pct(th.reach)}` : ''}` : 'Needs joint angles',
      why: 'Near full stretch the arm loses dexterity and is close to its singularity.' },
    { group: 'Safe motion', check: `Joint speeds under ${pct(th.speed)} of the FR3 limit`, tone: !kin ? 'wait' : peakSpeed < th.speed ? 'ok' : 'warn',
      note: kin ? `Peak ${pct(peakSpeed)} of limit` : 'Needs joint angles', why: 'The policy copies the speeds it sees.' },
    { group: 'Safe motion', check: `Gripper under ${th.tcp} mm/s`, tone: !kin ? 'wait' : peakTcp < th.tcp ? 'ok' : 'warn',
      note: kin ? `Peak ${Math.round(peakTcp)} mm/s` : 'Needs joint angles', why: 'ISO 10218 reduced speed for working next to people.' },
  ]
  const counted = checks.filter((c) => c.tone !== 'wait')
  const failing = counted.filter((c) => c.tone === 'fail').length
  const warn = counted.filter((c) => c.tone === 'warn').length
  const groups = [...new Set(checks.map((c) => c.group))]

  return (
    <>
      <StageHeader
        id="dataset"
        gate={{
          question: 'Is the dataset good as a whole?',
          verdict: failing === 0 && warn === 0 ? 'pass' : failing === 0 ? 'pending' : 'fail',
          detail: `${counted.length - failing - warn} of ${counted.length} checks green · ${failing} failing`,
        }}
        actions={<Link to="/select" className="btn primary">Choose training data</Link>}
      />
      <p className="small muted" style={{ margin: '-8px 0 14px' }}>
        <b style={{ color: 'var(--ink)' }}>{result.name}</b> · {eps.length} episodes · {formatDuration(result.totals.durationS)} · loaded in Ingest
      </p>

      <div className="stats">
        <Stat label="Episodes" value={eps.length} sub={`${result.totals.valid} valid · limits below use these`} />
        <Stat label="Furthest reach" value={kin ? pct(maxReach) : '—'} sub={kin ? `of 855 mm · safety factor ${(1 / maxReach).toFixed(2)}` : 'Needs joint angles'} />
        <Stat label="Peak joint speed" value={kin ? pct(peakSpeed) : '—'} sub="of the FR3 limit" />
        <Stat label="Peak gripper speed" value={kin ? `${Math.round(peakTcp)}` : '—'} sub="mm/s · reduced speed 250" />
        <Stat label="Peak acceleration" value={kin ? `${peakAccel.toFixed(2)}` : '—'} sub={`rad/s² · FR3 limit ${FR3.aMax[0]}`} />
      </div>

      <div className="tabs" role="tablist" aria-label="Data intelligence">
        {([['episodes', 'Episodes'], ['review', `Clip review · ${clipCount + manual}`], ['vla', `Ready for a VLA? · ${failing + warn ? `${failing + warn} to fix` : 'all green'}`]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'episodes' && (
        <>
          <Panel
            title={`Episode ${episode}`}
            hint={
              <span className="row" style={{ gap: 8 }}>
                <button className="btn" disabled={pos <= 0} onClick={() => setEpisode(ids[pos - 1])}>Previous</button>
                <label className="small row" style={{ gap: 6 }}>
                  Episode
                  <select value={episode} onChange={(e) => setEpisode(Number(e.target.value))} className="field-select">
                    {ids.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>
                <button className="btn" disabled={pos >= ids.length - 1} onClick={() => setEpisode(ids[pos + 1])}>Next</button>
              </span>
            }
          >
            {kin ? <WorkspaceInspector result={result} episode={episode} /> : <p className="small muted">This dataset has no joint angles, so reach, speed and acceleration can’t be shown.</p>}
          </Panel>
          <Panel title="Closest to the reach limit" hint="Click to inspect" className="mt">
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead><tr><th>Episode</th><th className="num">Max reach</th><th className="num">Peak speed</th><th className="num">Peak accel</th><th className="num">Length</th></tr></thead>
                <tbody>
                  {byReach.slice(0, 10).map((e) => (
                    <tr key={e.episode} className={`clickable${e.episode === episode ? ' selected' : ''}`} onClick={() => setEpisode(e.episode)}
                      tabIndex={0} onKeyDown={(k) => { if (k.key === 'Enter') setEpisode(e.episode) }}>
                      <td style={{ fontWeight: 600 }}>{e.episode}</td>
                      <td className="num" style={{ color: e.maxReach >= 0.9 ? 'var(--fail)' : e.maxReach >= 0.8 ? 'var(--orange)' : undefined }}>{pct(e.maxReach)}</td>
                      <td className="num">{e.peakSpeed.toFixed(2)} rad/s</td>
                      <td className="num">{e.peakAccel.toFixed(2)} rad/s²</td>
                      <td className="num">{e.durationS.toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      {tab === 'review' && (
        <Panel title="Clip review" hint="A few seconds per problem, every camera, a human verdict">
          <ClipReview result={result} onOpenEpisode={open} />
        </Panel>
      )}

      {tab === 'vla' && (
        <>
          <Panel title="Ready for a VLA?" hint="What π0.5 needs before training">
            <div className="checks">
              {groups.map((g) => (
                <div key={g} className="check-group">
                  <h3>{g}</h3>
                  <ul className="list">
                    {checks.filter((c) => c.group === g).map((c) => (
                      <li key={c.check} className="check-row">
                        <span style={{ color: COLOR[c.tone], fontWeight: 700 }} aria-label={c.tone}>{MARK[c.tone]}</span>
                        <span>
                          <span className="small" style={{ fontWeight: 600 }}>{c.check}</span>
                          <div className="small">{c.note}</div>
                          <div className="small muted">{c.why}</div>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Panel>
          <div className="grid g-2 mt">
            <Panel title="Behaviour map" hint="Each dot is an episode; close dots did similar things">
              {div ? (
                <>
                  <BehaviourMap map={div.map} picked={episode} onPick={open} bad={bad} />
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    Built from the gripper paths of both arms ({pct(div.explained)} of the variation shown). Hollow red dots failed a check. A tight clump means
                    the demonstrations repeat each other; gaps show situations the robot has never seen. Click a dot to open the episode.
                  </p>
                  {div.nearCopies.length > 0 && (
                    <p className="small">Near-copies: {div.nearCopies.slice(0, 8).map((n) => `${n.a} ≈ ${n.b}`).join(', ')}{div.nearCopies.length > 8 ? ' …' : ''}</p>
                  )}
                </>
              ) : <p className="small muted">Needs joint angles.</p>}
            </Panel>
            <Panel title="Lighting" hint="One frame from the middle of each episode">
              <LightingPanel result={result} onPick={open} onDone={() => setLightTick((x) => x + 1)} />
            </Panel>
          </div>
        </>
      )}
    </>
  )
}
