import type { LoopStatus, StageId } from '../data/types'
import { stageById } from '../pipeline'

// The team whiteboard, redrawn: stage tiles, diamond gates, and the "No" branch that drops to
// Diagnose and loops back to the dataset. Green = yes, orange = needs attention.

const NOTE_H = 112
const Y = 64

type Note = { id: StageId; x: number; w: number; y?: number; h?: number }
const NOTES: Note[] = [
  { id: 'ingest', x: 16, w: 150 },
  { id: 'dataset', x: 258, w: 160 },
  { id: 'select', x: 510, w: 150 },
  { id: 'train', x: 676, w: 130 },
  { id: 'evaluate', x: 822, w: 140 },
  { id: 'serve', x: 1054, w: 150 },
  { id: 'diagnose', x: 640, y: 286, w: 250, h: 100 },
]

const GATES = [
  { cx: 212, q: 'Good data?', stage: 'ingest' as StageId },
  { cx: 464, q: 'Checks passed?', stage: 'dataset' as StageId },
  { cx: 1008, q: 'Good enough?', stage: 'evaluate' as StageId },
]

function Arrow({ d, dashed = false, color = 'var(--ink-3)' }: { d: string; dashed?: boolean; color?: string }) {
  return (
    <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeDasharray={dashed ? '5 5' : undefined}
      markerEnd="url(#arrow)" strokeLinecap="round" strokeLinejoin="round" />
  )
}

export default function LoopBoard({ status }: { status: LoopStatus }) {
  const cy = Y + NOTE_H / 2
  const verdict = (id: StageId) => status.stages[id].gate?.verdict ?? 'pending'
  const vColor = (v: string) => (v === 'pass' ? 'var(--pass)' : v === 'fail' ? 'var(--orange)' : 'var(--warn)')

  return (
    <svg viewBox="0 0 1220 410" role="img" aria-labelledby="board-title board-desc">
      <title id="board-title">The learning loop</title>
      <desc id="board-desc">
        Ingest, then a data validity gate, dataset intelligence, a readiness gate, data selection, train, evaluate, a good-enough gate,
        then version and serve. Failed evaluations drop to diagnose, which feeds back into the dataset.
      </desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-3)" />
        </marker>
      </defs>

      <Arrow d={`M166 ${cy} H174`} />
      <Arrow d={`M248 ${cy} H256`} />
      <Arrow d={`M418 ${cy} H426`} />
      <Arrow d={`M500 ${cy} H508`} />
      <Arrow d={`M660 ${cy} H674`} />
      <Arrow d={`M806 ${cy} H820`} />
      <Arrow d={`M962 ${cy} H970`} />
      <Arrow d={`M1044 ${cy} H1052`} />

      {GATES.map((g) => {
        const v = verdict(g.stage)
        return (
          <g key={g.cx}>
            <text x={g.cx} y={Y - 18} textAnchor="middle" fontFamily="var(--hand)" fontSize="15" fill="var(--ink-2)">{g.q}</text>
            <path d={`M${g.cx} ${cy - 36} L${g.cx + 36} ${cy} L${g.cx} ${cy + 36} L${g.cx - 36} ${cy} Z`} fill="var(--surface)" stroke={vColor(v)} strokeWidth="2.2" strokeLinejoin="round" />
            <text x={g.cx} y={cy + 5} textAnchor="middle" fontSize="13" fontWeight="700" fill={vColor(v)}>
              {v === 'pass' ? 'Yes' : v === 'fail' ? 'No' : '…'}
            </text>
          </g>
        )
      })}

      <Arrow d={`M212 ${cy + 36} V${cy + 92}`} dashed />
      <text x={212} y={cy + 112} textAnchor="middle" fontFamily="var(--hand)" fontSize="15" fill="var(--ink-3)">no: data gaps</text>
      <Arrow d={`M464 ${cy + 36} V${cy + 92}`} dashed />
      <text x={464} y={cy + 112} textAnchor="middle" fontFamily="var(--hand)" fontSize="15" fill="var(--ink-3)">no: fix &amp; re-check</text>

      <Arrow d={`M1008 ${cy + 36} V336 H892`} color="var(--orange)" />
      <text x={1019} y={cy + 80} fontFamily="var(--hand)" fontSize="15" fill="var(--orange)">No</text>
      <Arrow d={`M638 336 H338 V${Y + NOTE_H + 6}`} color="var(--orange)" />
      <text x={356} y={328} fontFamily="var(--hand)" fontSize="15" fill="var(--ink-2)">next cycle: new data &amp; checks</text>

      {[['S1', 'sim'], ['S2', 'eval'], ['S3', 'robot']].map(([id, what], i) => (
        <g key={id}>
          <Arrow d={`M${1080 + i * 50} ${Y + NOTE_H} L${1086 + i * 50} ${Y + NOTE_H + 30}`} />
          <text x={1088 + i * 50} y={Y + NOTE_H + 50} textAnchor="middle" fontFamily="var(--hand)" fontSize="16" fill="var(--ink)">{id}</text>
          <text x={1088 + i * 50} y={Y + NOTE_H + 66} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{what}</text>
        </g>
      ))}

      {NOTES.map((n) => {
        const s = stageById(n.id)
        const st = status.stages[n.id] ?? { headline: '', sub: '', state: 'idle' as const }
        const y = n.y ?? Y
        const h = n.h ?? NOTE_H
        const diag = n.id === 'diagnose'
        return (
          <a key={n.id} href={`#${s.path}`} aria-label={`${s.name}: ${st.headline}, ${st.sub}`}>
            <rect className="note-rect" x={n.x} y={y} width={n.w} height={h} rx="8" fill="var(--surface-2)"
              stroke={diag ? 'var(--orange)' : 'var(--line)'} strokeWidth="1.5" />
            <rect x={n.x + 14} y={y + 14} width="22" height="16" rx="2" fill={`var(${s.color})`} />
            <text x={n.x + 25} y={y + 26} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--note-ink)">{s.index}</text>
            <text x={n.x + 14} y={y + 50} fontSize="16" fontWeight="700" fill="var(--ink)">{s.short}</text>
            <text x={n.x + 14} y={y + 74} fontSize="15" fontWeight="600" fill={diag ? 'var(--orange)' : 'var(--petrol)'}>{st.headline}</text>
            <text x={n.x + 14} y={y + 93} fontSize="12" fill="var(--ink-3)">{st.sub}</text>
            {st.state === 'running' && (
              <g>
                <circle cx={n.x + n.w - 16} cy={y + 20} r="5" fill="var(--orange)" className="pulse" />
                <circle cx={n.x + n.w - 16} cy={y + 20} r="5" fill="var(--orange)" />
              </g>
            )}
          </a>
        )
      })}
      <style>{`
        .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 1.8s ease-out infinite; }
        @keyframes pulse { from { transform: scale(1); opacity: .6 } to { transform: scale(3); opacity: 0 } }
      `}</style>
    </svg>
  )
}
