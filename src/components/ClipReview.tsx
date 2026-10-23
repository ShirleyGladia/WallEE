import { useEffect, useMemo, useRef, useState } from 'react'
import { shortCam } from '../ingest/analyze'
import { loadEpisodeFrames, type EpisodeFrames } from '../ingest/frames'
import { ARMS, isDuo } from '../ingest/kinematics'
import type { IngestResult, MomentKind } from '../ingest/types'
import { KIND_LABEL, findMoments, momentId } from '../review/moments'
import { useThresholds } from '../review/settings'
import { editList, getReviewer, removeClip, saveClip, setReviewer, useReview, type Clip, type Fix, type Verdict } from '../review/store'
import { ArmSide, track } from './WorkspaceInspector'

// The supervisor's idea: instead of reading graphs, look at the few seconds that matter.
// Each suspicious moment becomes a short clip with every camera and the arm view; a person says OK, Wrong or Unsure.

const VERDICTS: { v: Verdict; label: string; key: string }[] = [
  { v: 'ok', label: 'OK', key: '1' },
  { v: 'wrong', label: 'Wrong', key: '2' },
  { v: 'unsure', label: 'Unsure', key: '3' },
]
const verdictTone = (v?: Verdict) => (v === 'ok' ? 'pass' : v === 'wrong' ? 'fail' : v === 'unsure' ? 'warn' : 'muted')

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ClipPlayer({ result, clip }: { result: IngestResult; clip: Clip }) {
  const th = useThresholds()
  const fps = result.fps
  const seg = result.segments[clip.episode]
  const cams = result.cameras.filter((c) => seg?.[c.key] && c.playable)
  const refs = useRef(new Map<string, HTMLVideoElement>())
  const [frames, setFrames] = useState<EpisodeFrames | null>(null)
  const [f, setF] = useState(clip.from)
  const [playing, setPlaying] = useState(true)
  const [rate, setRate] = useState(1)
  const last = Math.max(clip.from, clip.to - 1)

  useEffect(() => {
    let live = true
    setFrames(null)
    loadEpisodeFrames(result, clip.episode).then((fr) => live && setFrames(fr)).catch(() => live && setFrames(null))
    return () => { live = false }
  }, [result, clip.episode])
  const tracks = useMemo(() => {
    if (!frames) return []
    return (isDuo(frames.q[0]?.length ?? 0) ? ARMS : ARMS.slice(0, 1)).map((a) => track(frames, a.offset, a.name, th.horizon))
  }, [frames, th.horizon])

  // Load each camera's file at the start of the clip.
  useEffect(() => {
    setF(clip.from)
    setPlaying(true)
    for (const c of cams) {
      const v = refs.current.get(c.key)
      if (!v) continue
      const s = seg[c.key]
      const url = c.fileUrls[s.fi]
      const go = () => { v.currentTime = s.from + clip.from / fps }
      if (v.dataset.src !== url) { v.dataset.src = url; v.src = url; v.addEventListener('loadedmetadata', go, { once: true }) }
      else go()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, result])

  // Loop the clip; the first camera is the clock.
  useEffect(() => {
    const vids = cams.map((c) => ({ v: refs.current.get(c.key), s: seg[c.key] })).filter((x): x is { v: HTMLVideoElement; s: typeof x.s } => !!x.v)
    vids.forEach(({ v }) => { v.playbackRate = rate })
    if (!playing) { vids.forEach(({ v }) => v.pause()); return }
    if (!vids.length) {
      const id = window.setInterval(() => setF((x) => (x >= last ? clip.from : x + 1)), 1000 / (fps * rate))
      return () => window.clearInterval(id)
    }
    vids.forEach(({ v }) => v.play().catch(() => setPlaying(false)))
    let raf = 0
    const loop = () => {
      const lead = vids[0]
      let fr = Math.round((lead.v.currentTime - lead.s.from) * fps)
      if (fr >= last || fr < clip.from - 1) {
        fr = clip.from
        for (const { v, s } of vids) v.currentTime = s.from + clip.from / fps
      } else {
        for (const { v, s } of vids.slice(1)) {
          const target = s.from + fr / fps
          if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target
        }
      }
      setF(fr)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, clip.id])

  const seek = (x: number) => {
    setPlaying(false)
    setF(x)
    for (const c of cams) { const v = refs.current.get(c.key); if (v) v.currentTime = seg[c.key].from + x / fps }
  }
  const tableZ = -th.tableMm / 1000
  const fi = frames ? Math.min(frames.q.length - 1, Math.max(0, f)) : 0

  return (
    <div className="clip-player">
      <div className="clip-media">
        {cams.map((c) => (
          <figure key={c.key}>
            <video ref={(el) => { if (el) refs.current.set(c.key, el); else refs.current.delete(c.key) }} muted playsInline preload="auto" />
            <figcaption className="small" style={{ textTransform: 'capitalize' }}>{shortCam(c.key)}</figcaption>
          </figure>
        ))}
        {!cams.length && <p className="small muted">No playable video for this episode, so only the arm view is shown.</p>}
      </div>
      {frames && tracks.length > 0 && (
        <div className="clip-arms" style={{ gridTemplateColumns: `repeat(${tracks.length}, minmax(0, 1fr))` }}>
          {tracks.map((a) => <ArmSide key={a.name} frames={frames} f={fi} arm={a} tableZ={tableZ} horizon={th.horizon} path={false} />)}
        </div>
      )}
      <div className="scrub">
        <button className="btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40, justifyContent: 'center', padding: 0 }}>{playing ? '❚❚' : '▶'}</button>
        <input type="range" min={clip.from} max={last} value={Math.min(last, Math.max(clip.from, f))} onChange={(e) => seek(Number(e.target.value))} aria-label="Frame in clip" />
        <span className="small" style={{ minWidth: 150, textAlign: 'right' }}>{(f / fps).toFixed(1)} s · frame {f}</span>
        <div className="row" role="group" aria-label="Playback speed">
          {[0.5, 1, 2].map((r) => (
            <button key={r} className={`badge ${rate === r ? 'info' : 'muted'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setRate(r)}>{r}×</button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function ClipReview({ result, onOpenEpisode }: { result: IngestResult; onOpenEpisode: (e: number) => void }) {
  const th = useThresholds()
  const saved = useReview(result.name)
  const [filter, setFilter] = useState<'todo' | 'all' | 'done'>('todo')
  const [kind, setKind] = useState<MomentKind | 'any'>('any')
  const [current, setCurrent] = useState<string | null>(null)
  const [reviewer, setName] = useState(getReviewer)
  const [note, setNote] = useState('')

  // Auto-found moments, merged with what people have already decided and the clips picked by hand.
  const clips = useMemo(() => {
    const out = new Map<string, Clip>()
    for (const e of result.episodes) {
      for (const m of findMoments(e, result.fps, th)) {
        const id = momentId(result.name, e.episode, m)
        out.set(id, { id, dataset: result.name, episode: e.episode, ...m, source: 'auto' })
      }
    }
    for (const c of Object.values(saved)) out.set(c.id, { ...out.get(c.id), ...c })
    return [...out.values()].sort((a, b) => a.episode - b.episode || a.from - b.from)
  }, [result, th, saved])

  const counts = useMemo(() => {
    const k = new Map<MomentKind, number>()
    for (const c of clips) k.set(c.kind, (k.get(c.kind) ?? 0) + 1)
    return k
  }, [clips])
  const shown = clips.filter((c) => (kind === 'any' || c.kind === kind) && (filter === 'all' || (filter === 'todo' ? !c.verdict : !!c.verdict)))
  const clip = clips.find((c) => c.id === current) ?? shown[0]
  useEffect(() => { setNote(clip?.note ?? '') }, [clip?.id])

  const decided = clips.filter((c) => c.verdict)
  const tally = (v: Verdict) => decided.filter((c) => c.verdict === v).length

  const decide = (v: Verdict, fix?: Fix) => {
    if (!clip) return
    saveClip({ ...clip, verdict: v, fix: v === 'wrong' ? fix ?? 'trim' : undefined, note: note.trim() || undefined, by: reviewer || undefined, at: new Date().toISOString() })
    // move on to the next clip that still needs a look
    const i = shown.findIndex((c) => c.id === clip.id)
    const next = shown.slice(i + 1).find((c) => !c.verdict && c.id !== clip.id) ?? shown.find((c) => !c.verdict && c.id !== clip.id)
    setCurrent(next?.id ?? clip.id)
  }
  const undo = () => {
    if (!clip) return
    if (clip.source === 'manual') saveClip({ ...clip, verdict: undefined, fix: undefined, at: undefined })
    else removeClip(result.name, clip.id)
  }

  // keyboard: 1 OK, 2 Wrong (trim), 3 Unsure, D wrong (drop episode), ←/→ previous/next
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      const i = clip ? shown.findIndex((c) => c.id === clip.id) : -1
      if (e.key === '1') decide('ok')
      else if (e.key === '2') decide('wrong', 'trim')
      else if (e.key === '3') decide('unsure')
      else if (e.key.toLowerCase() === 'd') decide('wrong', 'drop')
      else if (e.key === 'ArrowRight' && i < shown.length - 1) setCurrent(shown[i + 1].id)
      else if (e.key === 'ArrowLeft' && i > 0) setCurrent(shown[i - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const exportJson = () => download(`${result.name}-edits.json`, JSON.stringify({ dataset: result.name, fps: result.fps, created: new Date().toISOString(), edits: editList(result.name, result.fps) }, null, 2), 'application/json')
  const exportCsv = () => {
    const rows = editList(result.name, result.fps)
    const head = ['dataset', 'episode', 'start_s', 'end_s', 'verdict', 'action', 'reason', 'note', 'reviewer', 'at'] as const
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`
    download(`${result.name}-edits.csv`, [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'), 'text/csv')
  }

  return (
    <div className="review">
      <div className="review-bar">
        <div className="row" role="group" aria-label="Show">
          {(['todo', 'all', 'done'] as const).map((k) => (
            <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
              {k === 'todo' ? `To review · ${clips.length - decided.length}` : k === 'all' ? `All · ${clips.length}` : `Decided · ${decided.length}`}
            </button>
          ))}
        </div>
        <div className="row" role="group" aria-label="Kind of moment" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className={`chip${kind === 'any' ? ' on' : ''}`} onClick={() => setKind('any')}>Any kind</button>
          {[...counts.entries()].map(([k, n]) => (
            <button key={k} className={`chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{KIND_LABEL[k]} · {n}</button>
          ))}
        </div>
        <span className="spacer" />
        <span className="small"><b style={{ color: 'var(--pass)' }}>{tally('ok')}</b> OK · <b style={{ color: 'var(--fail)' }}>{tally('wrong')}</b> wrong · <b style={{ color: 'var(--warn)' }}>{tally('unsure')}</b> unsure</span>
        <button className="btn" onClick={exportJson} disabled={!decided.length}>Edit list (JSON)</button>
        <button className="btn" onClick={exportCsv} disabled={!decided.length}>CSV</button>
      </div>

      {clips.length === 0 ? (
        <div className="empty-note">
          <b>Nothing suspicious found.</b> No check failed, and every arm stays under {Math.round(th.speed * 100)}% of its speed limit, {th.tcp} mm/s at the gripper and {Math.round(th.reach * 100)}% of its reach
          {th.tableMm ? `, above the table at ${th.tableMm} mm` : ''}. You can still pick seconds by hand: open an episode, drag across a chart, then “Add to clip review”.
          {!th.tableMm && ' Set the table level in the episode view to also find moments where an arm goes under the table.'}
        </div>
      ) : (
        <div className="review-grid">
          <ol className="clip-list" aria-label="Clips">
            {shown.slice(0, 400).map((c) => (
              <li key={c.id}>
                <button className={`clip-row${clip?.id === c.id ? ' on' : ''}`} onClick={() => setCurrent(c.id)}>
                  <span className="clip-ep">Ep {c.episode}</span>
                  <span className="clip-time">{(c.from / result.fps).toFixed(1)}–{(c.to / result.fps).toFixed(1)} s</span>
                  <span className={`badge ${verdictTone(c.verdict)}`}>{c.verdict ? (c.verdict === 'wrong' ? (c.fix === 'drop' ? 'Drop' : 'Trim') : c.verdict === 'ok' ? 'OK' : 'Unsure') : KIND_LABEL[c.kind]}</span>
                  <span className="clip-reason small muted">{c.reason}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="small muted" style={{ padding: 12 }}>Nothing here. Switch to “All”.</li>}
          </ol>

          {clip && (
            <div className="clip-detail">
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Episode {clip.episode} · {(clip.from / result.fps).toFixed(1)}–{(clip.to / result.fps).toFixed(1)} s <span className="badge muted">{KIND_LABEL[clip.kind]}</span></div>
                  <div className="small muted">{clip.reason}</div>
                </div>
                <button className="linklike small" onClick={() => onOpenEpisode(clip.episode)}>Open the whole episode</button>
              </div>
              <ClipPlayer result={result} clip={clip} />
              <div className="verdict-bar">
                <span className="small" style={{ fontWeight: 600 }}>Is this right?</span>
                {VERDICTS.map((x) => (
                  <button key={x.v} className={`btn verdict ${x.v}${clip.verdict === x.v && (x.v !== 'wrong' || clip.fix !== 'drop') ? ' on' : ''}`} onClick={() => decide(x.v, 'trim')} title={`Key ${x.key}`}>
                    {x.v === 'wrong' ? 'Wrong — cut these seconds' : x.label} <kbd>{x.key}</kbd>
                  </button>
                ))}
                <button className={`btn verdict wrong${clip.verdict === 'wrong' && clip.fix === 'drop' ? ' on' : ''}`} onClick={() => decide('wrong', 'drop')} title="Key D">Wrong — drop episode <kbd>D</kbd></button>
                {clip.verdict && <button className="linklike small" onClick={undo}>Undo</button>}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input className="field-text" style={{ flex: '1 1 260px' }} placeholder="Note (optional), e.g. “camera upside down”" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
                <input className="field-text" style={{ width: 160 }} placeholder="Your name" value={reviewer} onChange={(e) => { setName(e.target.value); setReviewer(e.target.value) }} aria-label="Reviewer" />
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                “Cut these seconds” splits the episode at this window when the training set is built; single frames aren’t removed, because the policy
                learns from continuous motion. Keys: 1 OK · 2 cut · D drop · 3 unsure · ←/→ previous/next.
                {clip.source === 'manual' && <> <button className="linklike small" onClick={() => removeClip(result.name, clip.id)}>Delete this clip</button></>}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
