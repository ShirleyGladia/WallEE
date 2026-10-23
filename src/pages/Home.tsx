import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import HeroScene from '../components/HeroScene'

function useNarrow(px = 820) {
  const q = `(max-width: ${px}px)`
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(q).matches ?? false)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [q])
  return narrow
}

// Landing: the team and one idea, nothing else. The loop lives on its own page.
export default function Home() {
  const narrow = useNarrow()
  return (
    <section className="landing-hero">
      <div className="hero-art">
        <HeroScene viewBox={narrow ? '430 150 770 470' : '0 0 1200 640'} />
      </div>
      <div className="hero-copy">
        <p className="team">
          <svg className="team-face" viewBox="0 0 64 50" aria-hidden="true">
            <rect x="0" y="0" width="64" height="50" rx="17" fill="#f3f5f6" />
            <rect x="6" y="6" width="52" height="38" rx="12" fill="#050607" />
            <rect x="15" y="20" width="13" height="7" rx="3.5" fill="#2ee6c8" />
            <rect x="36" y="20" width="13" height="7" rx="3.5" fill="#2ee6c8" />
          </svg>
          Wallee
        </p>
        <h1>A robot that learns what the OR team needs.</h1>
        <p className="lede">Demonstrations in. A tested, served skill out. Better every cycle.</p>
        <div className="row" style={{ marginTop: 26 }}>
          <Link to="/loop" className="btn primary">See the loop</Link>
        </div>
      </div>
      <p className="hero-credit">Robotics and AI Hackathon 2026 · Siemens Healthineers challenge</p>
    </section>
  )
}
