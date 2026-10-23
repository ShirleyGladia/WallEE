import type { ReactNode } from 'react'
import type { Gate as GateT, StageId } from '../data/types'
import { stageById } from '../pipeline'

export function Panel({ title, hint, children, className = '' }: { title?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-head">
          <h2>{title}</h2>
          {hint && <span className="hint">{hint}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Diamond({ verdict, size = 54 }: { verdict: GateT['verdict']; size?: number }) {
  const color = verdict === 'pass' ? 'var(--pass)' : verdict === 'fail' ? 'var(--fail)' : 'var(--warn)'
  const mark = verdict === 'pass' ? 'M19 27 l6 6 l11 -12' : verdict === 'fail' ? 'M21 21 l12 12 M33 21 l-12 12' : 'M27 19 v10 M27 34 v1'
  return (
    <svg className="gate-diamond" viewBox="0 0 54 54" width={size} height={size} aria-hidden="true">
      <path d="M27 3 L51 27 L27 51 L3 27 Z" fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
      <path d={mark} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function GateCard({ gate }: { gate: GateT }) {
  const word = gate.verdict === 'pass' ? 'Yes' : gate.verdict === 'fail' ? 'No' : 'Not yet'
  return (
    <div className={`gate ${gate.verdict}`} role="status">
      <Diamond verdict={gate.verdict} />
      <div>
        <div className="gate-q">{gate.question}</div>
        <div className="gate-v">
          <b>{word}</b> · {gate.detail}
        </div>
      </div>
    </div>
  )
}

export function StageHeader({ id, gate, actions }: { id: StageId; gate?: GateT; actions?: ReactNode }) {
  const s = stageById(id)
  return (
    <header className="stage-head">
      <div>
        <div className="stage-title">
          <span className="stage-tag" style={{ background: `var(${s.color})` }}>{s.index}</span>
          <h1>{s.name}</h1>
        </div>
        <p className="stage-asks">{s.asks}</p>
        {actions && <div className="row" style={{ marginTop: 14 }}>{actions}</div>}
      </div>
      {gate && <GateCard gate={gate} />}
    </header>
  )
}

export function Loading({ error }: { error: string | null }) {
  if (error) return <div className="error">Couldn’t load this stage: {error}. Check that the backend is running, or unset VITE_API_URL to use demo data.</div>
  return <div className="skeleton" aria-busy="true" aria-label="Loading" />
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
