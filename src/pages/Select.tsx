import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel, StageHeader } from '../components/ui'
import { formatDuration } from '../ingest/analyze'
import { checkProjectDataset, listProjectDatasets, useIngest, type ProjectDataset } from '../ingest/store'
import type { IngestResult } from '../ingest/types'
import { downloadManifest, nextVersion, saveManifest, useManifests, type Manifest, type ManifestGroup, type Role } from '../select/manifest'
import { getVlmSettings, runVlmReview, saveVlmSettings, testVlm, useVlmReview, vlmSummary, type VlmSettings } from '../select/vlm'
import { editList, getReview, getReviewer } from '../review/store'

// 03 Select data: after the checks, people decide which dataset groups are used to train, validate and test.
// Three opinions per group: the automatic checks, a VLM looking at sample frames, and the humans, who decide.

type Elig = { verdict: ManifestGroup['eligibility']; reasons: string[]; auto: { episode: number; reason: string }[] }

function eligibility(r: IngestResult): Elig {
  const eps = r.episodes
  const auto = eps.filter((e) => e.errors.length).map((e) => ({ episode: e.episode, reason: e.errors[0] }))
  const share = auto.length / Math.max(1, eps.length)
  const badVideo = r.files.filter((f) => f.kind === 'video' && f.status === 'error').length
  const reasons: string[] = []
  let hard = false
  if (!eps.length) { reasons.push('No episodes'); hard = true }
  if (r.kinematics === 'none') { reasons.push('No joint angles'); hard = true }
  if (!r.cameras.length) { reasons.push('No camera videos'); hard = true }
  if (badVideo) { reasons.push(`${badVideo} broken video file${badVideo === 1 ? '' : 's'} (rotated, cut or wrong format)`); hard = true }
  const uncovered = r.cameras.filter((c) => c.coveredEpisodes < eps.length)
  if (uncovered.length) reasons.push(`${uncovered.length} camera${uncovered.length === 1 ? ' misses' : 's miss'} some episodes`)
  if (share > 0.02) { reasons.push(`${auto.length} of ${eps.length} episodes failed a check (${(share * 100).toFixed(1)}%, over 2%: something systematic)`); hard = true }
  else if (auto.length) reasons.push(`${auto.length} episode${auto.length === 1 ? '' : 's'} failed a check and will be left out`)
  return { verdict: hard ? 'not-eligible' : auto.length || uncovered.length ? 'eligible-with-exclusions' : 'eligible', reasons, auto }
}

const ELIG_LABEL = { eligible: 'Eligible', 'eligible-with-exclusions': 'Eligible, with exclusions', 'not-eligible': 'Not eligible' } as const
const ELIG_TONE = { eligible: 'pass', 'eligible-with-exclusions': 'warn', 'not-eligible': 'fail' } as const
const ROLES: { r: Role; label: string }[] = [
  { r: 'train', label: 'Train' }, { r: 'validation', label: 'Validation' }, { r: 'test', label: 'Test' }, { r: 'exclude', label: 'Exclude' },
]

// "12, 40-45" -> [12, 40, 41, …, 45]
function parseList(text: string) {
  const out = new Set<number>()
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) continue
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - a < 5000; i++) out.add(i)
  }
  return [...out]
}

interface Choice { roles: Record<string, Role>; manual: Record<string, string>; holdout: number; author: string; reason: string }
const SKEY = 'select-state'
function loadChoice(): Choice {
  try { return { roles: {}, manual: {}, holdout: 10, author: getReviewer(), reason: '', ...JSON.parse(localStorage.getItem(SKEY) ?? '{}') } } catch { return { roles: {}, manual: {}, holdout: 10, author: '', reason: '' } }
}

function VlmBlock({ result }: { result: IngestResult }) {
  const review = useVlmReview(result.name)
  const sum = vlmSummary(review)
  const [settings, setSettings] = useState<VlmSettings>(getVlmSettings)
  const [busy, setBusy] = useState<[number, number] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const ctl = useRef<AbortController | null>(null)
  const run = () => {
    ctl.current = new AbortController()
    setErr(null)
    setBusy([0, settings.episodes])
    runVlmReview(result, settings, (d, t) => setBusy([d, t]), ctl.current.signal)
      .then(() => setBusy(null))
      .catch((e: Error) => { setBusy(null); setErr(e.name === 'AbortError' ? null : e.message) })
  }
  return (
    <div className="sel-block">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="sel-label">VLM review</span>
        {sum ? <span className={`badge ${sum.verdict === 'ok' ? 'pass' : sum.verdict === 'problem' ? 'fail' : 'warn'}`}>{sum.ok} OK · {sum.problem} problem · {sum.unsure} unsure</span> : <span className="badge muted">Not run</span>}
      </div>
      {busy ? (
        <div className="small muted">Asking {settings.model.split('/').pop()} about episode {busy[0] + 1} of {busy[1]}… <button className="linklike small" onClick={() => ctl.current?.abort()}>Stop</button></div>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={run}>{sum ? 'Run again' : `Review ${settings.episodes} episodes`}</button>
          {review && <button className="linklike small" onClick={() => setOpen((o) => !o)}>{open ? 'Hide answers' : 'See answers'}</button>}
        </div>
      )}
      {err && <div className="small" style={{ color: 'var(--fail)' }}>{err} <VlmHelp settings={settings} setSettings={setSettings} /></div>}
      {open && review && (
        <ul className="vlm-list">
          {review.episodes.map((e) => (
            <li key={e.episode}>
              {e.thumbs[0] && <img src={e.thumbs[0]} alt={`Episode ${e.episode}`} />}
              <div>
                <div className="small"><b>Episode {e.episode}</b> <span className={`badge ${e.verdict === 'ok' ? 'pass' : e.verdict === 'problem' ? 'fail' : 'warn'}`}>{e.verdict}</span></div>
                <div className="small muted">{e.summary}{e.problems.length ? ` · ${e.problems.join(', ')}` : ''}</div>
              </div>
            </li>
          ))}
          <li className="small muted">{review.model} · {new Date(review.at).toLocaleString()}</li>
        </ul>
      )}
    </div>
  )
}

function VlmHelp({ settings, setSettings }: { settings: VlmSettings; setSettings: (s: VlmSettings) => void }) {
  const [models, setModels] = useState<string | null>(null)
  const upd = (p: Partial<VlmSettings>) => { const s = { ...settings, ...p }; setSettings(s); saveVlmSettings(s) }
  return (
    <details className="vlm-help">
      <summary className="small">Connect the VLM</summary>
      <p className="small muted">Start an OpenAI-compatible server on the GPU machine, then point the console at it:</p>
      <pre className="code">vllm serve {settings.model} --port 8001 --max-model-len 8192 --gpu-memory-utilization 0.35{'\n'}VLM_TARGET=http://&lt;gpu-host&gt;:8001 npm run dev</pre>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="field-text" value={settings.url} onChange={(e) => upd({ url: e.target.value })} aria-label="Server URL" style={{ width: 160 }} />
        <input className="field-text" value={settings.model} onChange={(e) => upd({ model: e.target.value })} aria-label="Model" style={{ width: 240 }} />
        <label className="small row" style={{ gap: 4 }}>episodes <input type="number" className="field-num" min={1} max={40} value={settings.episodes} onChange={(e) => upd({ episodes: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} /></label>
        <button className="btn" onClick={() => testVlm(settings).then((m) => setModels(m.join(', ') || 'connected, no models listed')).catch((e: Error) => setModels(`not reachable: ${e.message}`))}>Test</button>
      </div>
      {models && <div className="small muted">{models}</div>}
    </details>
  )
}

export default function Select() {
  const { results, checking, result: current } = useIngest()
  const manifests = useManifests()
  const [project, setProject] = useState<ProjectDataset[] | null>(null)
  const [choice, setChoice] = useState<Choice>(loadChoice)
  const [saved, setSaved] = useState<Manifest | null>(null)
  useEffect(() => { listProjectDatasets().then(setProject) }, [])
  useEffect(() => { try { localStorage.setItem(SKEY, JSON.stringify(choice)) } catch { /* ignore */ } }, [choice])

  // Groups: the project datasets, plus anything uploaded in Ingest this session.
  const names = useMemo(() => {
    const n = (project ?? []).map((p) => p.name).sort()
    for (const k of Object.keys(results)) if (!n.includes(k)) n.push(k)
    if (current && !n.includes(current.name)) n.push(current.name)
    return n
  }, [project, results, current])
  const res = (name: string) => results[name] ?? (current?.name === name ? current : undefined)
  const checkAll = () => (project ?? []).forEach((p) => { if (!res(p.name)) checkProjectDataset(p) })

  const groups = names.map((name, i) => {
    const r = res(name)
    const el = r ? eligibility(r) : null
    const role: Role = choice.roles[name] ?? (el ? (el.verdict === 'not-eligible' ? 'exclude' : 'train') : 'exclude')
    const fps = r?.fps ?? 6
    const edits = r ? editList(name, fps) : []
    const drops = edits.filter((e) => e.action === 'drop_episode').map((e) => ({ episode: e.episode, reason: `Clip review: ${e.note || e.reason}` }))
    const trims = edits.filter((e) => e.action === 'trim').map((e) => ({ episode: e.episode, start_s: e.start_s, end_s: e.end_s, reason: e.note || e.reason }))
    const manual = parseList(choice.manual[name] ?? '').map((episode) => ({ episode, reason: 'Excluded by hand' }))
    const excludedMap = new Map<number, string>()
    for (const x of [...(el?.auto ?? []), ...drops, ...manual]) if (!excludedMap.has(x.episode)) excludedMap.set(x.episode, x.reason)
    const known = new Set(r?.episodes.map((e) => e.episode) ?? [])
    const excluded = [...excludedMap.entries()].filter(([e]) => known.has(e)).map(([episode, reason]) => ({ episode, reason }))
    const used = (r?.episodes ?? []).map((e) => e.episode).filter((e) => !excludedMap.has(e))
    const pending = r ? Object.values(getReview(name)).filter((c) => !c.verdict).length : 0
    return { name, label: `Group ${i + 1}`, r, el, role, excluded, trims, used, pending }
  })

  // Episodes used in validation are held out from the training groups when no group is set aside for it.
  const hasValGroup = groups.some((g) => g.role === 'validation' && g.r)
  const holdEvery = !hasValGroup && choice.holdout > 0 ? Math.max(2, Math.round(100 / choice.holdout)) : 0
  const split = (g: (typeof groups)[number]) => {
    if (g.role !== 'train' || !holdEvery) return { main: g.used, val: [] as number[] }
    return { main: g.used.filter((_, k) => k % holdEvery !== holdEvery - 1), val: g.used.filter((_, k) => k % holdEvery === holdEvery - 1) }
  }

  // ---- rules ----
  const rules: { rule: string; ok: boolean; detail: string; level: 'error' | 'warn' }[] = []
  const active = groups.filter((g) => g.r && g.role !== 'exclude')
  const trainG = active.filter((g) => g.role === 'train')
  rules.push({ rule: 'At least one group is used for training', ok: trainG.length > 0, detail: trainG.length ? trainG.map((g) => g.label).join(', ') : 'Pick a group for Train', level: 'error' })
  const notElig = trainG.filter((g) => g.el?.verdict === 'not-eligible')
  rules.push({ rule: 'No group that failed the checks is trained on', ok: notElig.length === 0, detail: notElig.length ? `${notElig.map((g) => g.label).join(', ')} is not eligible` : 'OK', level: 'error' })
  // the same demonstration in two places: fingerprints of the first 60 frames
  const where = new Map<string, { g: string; role: Role }[]>()
  for (const g of active) {
    const usedSet = new Set(g.used)
    for (const e of g.r!.episodes) if (e.fingerprint && usedSet.has(e.episode)) where.set(e.fingerprint, [...(where.get(e.fingerprint) ?? []), { g: g.label, role: g.role }])
  }
  let leak = 0, doubled = 0
  const leakPairs = new Set<string>()
  for (const list of where.values()) {
    const roles = new Set(list.map((x) => x.role))
    if (roles.has('train') && (roles.has('test') || roles.has('validation'))) { leak++; leakPairs.add([...new Set(list.map((x) => x.g))].join(' and ')) }
    if (list.filter((x) => x.role === 'train').length > 1) doubled++
  }
  rules.push({ rule: 'Test and validation never share an episode with training', ok: leak === 0, detail: leak ? `${leak} demonstrations are in both (${[...leakPairs].join('; ')} hold the same episodes). The score would look better than the robot is.` : 'No shared episodes found', level: 'error' })
  rules.push({ rule: 'Each episode has one role', ok: doubled === 0, detail: doubled ? `${doubled} demonstrations appear in two training groups and would count twice` : 'OK', level: 'warn' })
  const testG = active.filter((g) => g.role === 'test')
  rules.push({ rule: 'A test set is held back for Evaluate', ok: testG.length > 0, detail: testG.length ? testG.map((g) => g.label).join(', ') : 'No group for Test: Evaluate will only use simulator seeds', level: 'warn' })
  rules.push({ rule: 'There is a validation set', ok: hasValGroup || holdEvery > 0, detail: hasValGroup ? 'Validation group chosen' : holdEvery ? `Every ${holdEvery}th training episode is held out (${choice.holdout}%)` : 'None', level: 'warn' })
  const pending = trainG.reduce((s, g) => s + g.pending, 0)
  rules.push({ rule: 'Clip review finished for the training groups', ok: pending === 0, detail: pending ? `${pending} clips still to look at` : 'OK', level: 'warn' })
  const unchecked = groups.filter((g) => !g.r)
  const errors = rules.filter((r) => !r.ok && r.level === 'error').length
  const warns = rules.filter((r) => !r.ok && r.level === 'warn').length

  const build = (): Manifest => {
    const now = new Date()
    const version = nextVersion()
    const mg: ManifestGroup[] = groups.filter((g) => g.r).map((g) => {
      const s = vlmSummary(JSON.parse(localStorage.getItem(`vlm:${g.name}`) ?? 'null'))
      const v = JSON.parse(localStorage.getItem(`vlm:${g.name}`) ?? 'null')
      return {
        group: g.label, dataset: g.name, role: g.role, eligibility: g.el!.verdict, episodes_total: g.r!.episodes.length,
        episodes: g.role === 'exclude' ? [] : split(g).main, excluded: g.excluded, trims: g.trims,
        vlm: s && v ? { model: v.model, ok: s.ok, problem: s.problem, unsure: s.unsure, at: v.at } : undefined,
      }
    })
    const pick = (role: 'train' | 'validation' | 'test') => [
      ...groups.filter((g) => g.r && g.role === role).map((g) => ({ dataset: g.name, episodes: split(g).main })),
      ...(role === 'validation' ? groups.filter((g) => g.r && g.role === 'train' && split(g).val.length).map((g) => ({ dataset: g.name, episodes: split(g).val })) : []),
    ]
    const splits = { train: pick('train'), validation: pick('validation'), test: pick('test') }
    const count = (k: keyof typeof splits) => splits[k].reduce((s, x) => s + x.episodes.length, 0)
    return {
      schema: 'loop-console/training-manifest@1',
      id: `manifest-v${version}-${now.toISOString().slice(0, 10)}`,
      version, created: now.toISOString(), author: choice.author.trim(), reason: choice.reason.trim(),
      task: [...new Set(groups.flatMap((g) => g.r?.tasks ?? []))], fps: groups.find((g) => g.r)?.r?.fps ?? 0,
      groups: mg, splits,
      counts: { train: count('train'), validation: count('validation'), test: count('test'), excluded: mg.reduce((s, g) => s + (g.role === 'exclude' ? g.episodes_total : g.excluded.length), 0) },
      checks: rules.map(({ rule, ok, detail }) => ({ rule, ok, detail })),
      notes: { recompute_norm_stats: true, held_out_validation: !hasValGroup && holdEvery ? `every ${holdEvery}th episode of each training group` : null },
    }
  }
  const preview = useMemo(build, [JSON.stringify(groups.map((g) => [g.name, g.role, g.used.length, g.excluded.length])), choice, holdEvery]) // eslint-disable-line react-hooks/exhaustive-deps
  const canSave = errors === 0 && unchecked.length === 0 && choice.author.trim() && choice.reason.trim()
  const save = () => { const m = build(); saveManifest(m); setSaved(m) }
  const setRole = (name: string, role: Role) => setChoice((c) => ({ ...c, roles: { ...c.roles, [name]: role } }))

  return (
    <>
      <StageHeader
        id="select"
        gate={{
          question: 'Which data do we train on?',
          verdict: manifests[0] && !saved ? 'pass' : saved ? 'pass' : errors ? 'fail' : 'pending',
          detail: manifests[0] ? `Manifest v${manifests[0].version} · ${manifests[0].counts.train} training episodes` : errors ? `${errors} rule${errors === 1 ? '' : 's'} broken` : 'No manifest saved yet',
        }}
        actions={<>
          <button className="btn" onClick={checkAll} disabled={!project?.length}>Check all groups</button>
          {manifests[0] && <Link to="/train" className="btn primary">Train on manifest v{manifests[0].version}</Link>}
        </>}
      />

      <div className="sel-steps small muted">
        <span><b>1</b> The checks decide what’s eligible</span><span>→</span>
        <span><b>2</b> A VLM looks at sample frames</span><span>→</span>
        <span><b>3</b> People decide each group’s role</span><span>→</span>
        <span><b>4</b> A versioned manifest goes to training</span>
      </div>

      {project === null && <div className="skeleton" aria-busy="true" aria-label="Loading datasets" />}
      {project !== null && names.length === 0 && (
        <div className="empty-note">No datasets yet. Put LeRobot datasets in <code>src/datasets/&lt;name&gt;/</code> (each one becomes a group), or load one on the <Link to="/ingest">Ingest</Link> page.</div>
      )}

      <div className="sel-groups">
        {groups.map((g) => {
          const c = checking[g.name]
          const p = project?.find((x) => x.name === g.name)
          return (
            <section key={g.name} className={`sel-card role-${g.role}`} aria-label={`${g.label}: ${g.name}`}>
              <header>
                <div className="sel-group">{g.label}</div>
                <div className="sel-name" title={g.name}>{g.name}</div>
                <div className="small muted">
                  {g.r ? `${g.r.episodes.length} episodes · ${formatDuration(g.r.totals.durationS)} · ${g.r.cameras.length} cameras` : p ? `${(p.bytes / 1e9).toFixed(2)} GB · not checked yet` : ''}
                </div>
              </header>

              <div className="sel-block">
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <span className="sel-label">Automatic checks</span>
                  {g.el ? <span className={`badge ${ELIG_TONE[g.el.verdict]}`}>{ELIG_LABEL[g.el.verdict]}</span> : <span className="badge muted">Not checked</span>}
                </div>
                {g.el ? (
                  <ul className="sel-reasons small">
                    {g.el.reasons.length ? g.el.reasons.map((x) => <li key={x}>{x}</li>) : <li>All episodes and videos pass</li>}
                  </ul>
                ) : typeof c === 'object' ? (
                  <div className="bar"><span style={{ width: `${(c.done / Math.max(1, c.total)) * 100}%` }} /></div>
                ) : p ? (
                  <button className="btn" onClick={() => checkProjectDataset(p)}>{c === 'error' ? 'Failed, try again' : 'Check'}</button>
                ) : null}
              </div>

              {g.r && <VlmBlock result={g.r} />}

              <div className="sel-block">
                <span className="sel-label">Decision</span>
                <div className="seg" role="radiogroup" aria-label={`Role of ${g.label}`}>
                  {ROLES.map((x) => (
                    <button key={x.r} role="radio" aria-checked={g.role === x.r} className={`seg-btn ${x.r}${g.role === x.r ? ' on' : ''}`} onClick={() => setRole(g.name, x.r)} disabled={!g.r}>{x.label}</button>
                  ))}
                </div>
                {g.r && g.role !== 'exclude' && (
                  <>
                    <div className="small">
                      <b>{split(g).main.length}</b> episodes {g.role === 'train' ? 'to train on' : `for ${g.role}`}
                      {split(g).val.length ? <> · <b>{split(g).val.length}</b> held out for validation</> : null}
                      {g.excluded.length ? <> · <b>{g.excluded.length}</b> left out</> : null}
                      {g.trims.length ? <> · <b>{g.trims.length}</b> cuts from clip review</> : null}
                    </div>
                    <input className="field-text" placeholder="Also leave out episodes, e.g. 12, 40-45" value={choice.manual[g.name] ?? ''}
                      onChange={(e) => setChoice((c) => ({ ...c, manual: { ...c.manual, [g.name]: e.target.value } }))} aria-label={`Episodes to leave out of ${g.label}`} />
                    {g.excluded.length > 0 && (
                      <details>
                        <summary className="small">Left out: {g.excluded.slice(0, 8).map((x) => x.episode).join(', ')}{g.excluded.length > 8 ? ' …' : ''}</summary>
                        <ul className="sel-reasons small">{g.excluded.map((x) => <li key={x.episode}><b>{x.episode}</b> · {x.reason}</li>)}</ul>
                      </details>
                    )}
                  </>
                )}
                {g.role === 'train' && g.el?.verdict === 'not-eligible' && <div className="small" style={{ color: 'var(--fail)' }}>This group failed the checks. Pick Exclude, or fix the data first.</div>}
              </div>
            </section>
          )
        })}
      </div>

      <div className="grid g-21 mt">
        <Panel title="Rules" hint={errors ? `${errors} must be fixed` : warns ? `${warns} worth a look` : 'All good'}>
          <ul className="list">
            {rules.map((r) => (
              <li key={r.rule} className="check-row">
                <span style={{ color: r.ok ? 'var(--pass)' : r.level === 'error' ? 'var(--fail)' : 'var(--warn)', fontWeight: 700 }}>{r.ok ? '✓' : r.level === 'error' ? '✕' : '!'}</span>
                <span><span className="small" style={{ fontWeight: 600 }}>{r.rule}</span><div className="small muted">{r.detail}</div></span>
              </li>
            ))}
            {unchecked.length > 0 && <li className="small muted">{unchecked.length} group{unchecked.length === 1 ? ' is' : 's are'} not checked yet.</li>}
          </ul>
        </Panel>

        <Panel title={`Training manifest v${nextVersion()}`} hint="Who, when, why">
          <div className="manifest-counts">
            {(['train', 'validation', 'test'] as const).map((k) => (
              <div key={k}><div className="stat-label">{k === 'train' ? 'Train' : k === 'validation' ? 'Validation' : 'Test'}</div><div className="stat-value">{preview.counts[k]}</div></div>
            ))}
            <div><div className="stat-label">Left out</div><div className="stat-value">{preview.counts.excluded}</div></div>
          </div>
          {!hasValGroup && (
            <label className="small row" style={{ gap: 6, margin: '10px 0' }}>
              Hold out
              <select className="field-select" value={choice.holdout} onChange={(e) => setChoice((c) => ({ ...c, holdout: Number(e.target.value) }))}>
                {[0, 5, 10, 20].map((v) => <option key={v} value={v}>{v}%</option>)}
              </select>
              of the training episodes for validation
            </label>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <input className="field-text" style={{ width: 160 }} placeholder="Your name" value={choice.author} onChange={(e) => setChoice((c) => ({ ...c, author: e.target.value }))} aria-label="Decided by" />
            <input className="field-text" style={{ flex: '1 1 220px' }} placeholder="Why this split? e.g. “Group 3 has rotated cameras”" value={choice.reason} onChange={(e) => setChoice((c) => ({ ...c, reason: e.target.value }))} aria-label="Reason" />
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={!canSave} onClick={save}>Save manifest v{nextVersion()}</button>
            <button className="btn" onClick={() => downloadManifest(build())} disabled={!groups.some((g) => g.r)}>Download draft</button>
            <span className="small muted">{errors ? 'Fix the rules marked ✕ first' : unchecked.length ? 'Check every group first' : !choice.author.trim() || !choice.reason.trim() ? 'Add your name and a reason' : 'Ready'}</span>
          </div>
          {saved && <p className="small" style={{ color: 'var(--pass)' }}>Saved {saved.id}. <button className="linklike small" onClick={() => downloadManifest(saved)}>Download JSON</button> · <Link to="/train">Go to Train</Link></p>}
          {manifests.length > 0 && (
            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>Version</th><th>When</th><th>By</th><th className="num">Train</th><th className="num">Val</th><th className="num">Test</th><th /></tr></thead>
              <tbody>
                {manifests.slice(0, 6).map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }} title={m.reason}>v{m.version}</td>
                    <td className="small">{new Date(m.created).toLocaleString()}</td>
                    <td className="small">{m.author}</td>
                    <td className="num">{m.counts.train}</td><td className="num">{m.counts.validation}</td><td className="num">{m.counts.test}</td>
                    <td><button className="linklike small" onClick={() => downloadManifest(m)}>JSON</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            The training script reads <code>splits.train</code> (dataset + episode list) and should recompute the normalisation stats on exactly those episodes.
          </p>
        </Panel>
      </div>
    </>
  )
}
