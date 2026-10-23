import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api, DEMO_MODE, useApi } from '../data/api'
import { STAGES } from '../pipeline'

function LoopMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 30 30" aria-hidden="true">
      <path d="M6 15a9 9 0 0 1 15.4-6.4" fill="none" stroke="var(--petrol)" strokeWidth="3" strokeLinecap="round" />
      <path d="M24 15a9 9 0 0 1-15.4 6.4" fill="none" stroke="var(--orange)" strokeWidth="3" strokeLinecap="round" />
      <path d="M19 5l3 3.8-4.6 1" fill="none" stroke="var(--petrol)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 25l-3-3.8 4.6-1" fill="none" stroke="var(--orange)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PanelIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7.5" y1="3.5" x2="7.5" y2="16.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="10" y1="2.5" x2="10" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" transform={`rotate(${a} 10 10)`} />
      ))}
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => {
    try { return localStorage.getItem('theme') } catch { return null }
  })
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { theme ? localStorage.setItem('theme', theme) : localStorage.removeItem('theme') } catch { /* ignore */ }
  }, [theme])
  const dark = theme !== 'light' // black is the default theme
  return { dark, toggle: () => setTheme(dark ? 'light' : 'dark') }
}

// Sidebar open/closed, remembered per browser. Starts closed so the landing page gets the full width.
function useSidebar() {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('sidebar') === 'open' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('sidebar', open ? 'open' : 'closed') } catch { /* ignore */ }
  }, [open])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { open, toggle: () => setOpen((o) => !o) }
}

export default function Layout() {
  const { data } = useApi(api.loop)
  const { dark, toggle: toggleTheme } = useTheme()
  const sidebar = useSidebar()
  const { pathname } = useLocation()
  const main = STAGES.filter((s) => s.id !== 'diagnose')
  const diag = STAGES.find((s) => s.id === 'diagnose')!
  const item = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`
  const landing = pathname === '/'

  return (
    <div className={`app${sidebar.open ? '' : ' collapsed'}`}>
      <aside className="rail" aria-label="Sidebar">
        <div className="rail-top">
          <NavLink to="/" className="brand" end title="Wallee · Loop Console">
            <LoopMark />
            <span className="brand-text">
              <div className="brand-name">Loop Console</div>
              <div className="brand-sub">Team Wallee</div>
            </span>
          </NavLink>
          <button className="rail-toggle" onClick={sidebar.toggle} aria-expanded={sidebar.open}
            aria-label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'} title={`${sidebar.open ? 'Hide' : 'Show'} sidebar (Ctrl+B)`}>
            <PanelIcon />
          </button>
        </div>

        {data && (
          <div className="cycle-chip">
            <strong>Cycle {data.cycle}</strong> · {data.robot}
          </div>
        )}

        <nav className="nav" aria-label="Pages">
          <NavLink to="/" end className={item} title="Home">
            <span className="nav-note nav-icon">⌂</span>
            <span className="nav-label">Home</span>
          </NavLink>
          <NavLink to="/loop" className={item} title="The learning loop">
            <span className="nav-note nav-icon">↻</span>
            <span className="nav-label">The loop</span>
          </NavLink>
          <div className="nav-split" />
          {main.map((s) => {
            const gate = data?.stages[s.id]?.gate
            return (
              <NavLink key={s.id} to={s.path} className={item} title={s.name}>
                <span className="nav-note" style={{ background: `var(${s.color})` }}>
                  {s.index}
                  {gate && <span className={`nav-gate ${gate.verdict}`} />}
                </span>
                <span className="nav-label">{s.name}</span>
              </NavLink>
            )
          })}
          <div className="nav-split" />
          <NavLink to={diag.path} className={item} title={diag.name}>
            <span className="nav-note" style={{ background: `var(${diag.color})` }}>{diag.index}</span>
            <span className="nav-label">{diag.name}</span>
          </NavLink>
          <div className="nav-back">feeds back into 02</div>
        </nav>

        <div className="rail-foot">
          <span className="mode-pill" title={DEMO_MODE ? 'Demo data' : 'Connected to backend'}>
            <span className={`mode-dot${DEMO_MODE ? '' : ' live'}`} />
            <span className="nav-label">{DEMO_MODE ? 'Demo data' : 'Connected to backend'}</span>
          </span>
          <button className="theme-btn" onClick={toggleTheme} title={dark ? 'Light mode' : 'Dark mode'}>
            <ThemeIcon dark={dark} />
            <span className="nav-label">{dark ? 'Light mode' : 'Dark mode'}</span>
          </button>
        </div>
      </aside>
      <main className={`main${landing ? ' flush' : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}
