import { useEffect, useState } from 'react'

// Operating-theatre scene: an assistant robot picks a catheter pack from the supply trolley
// and hands it to the surgeon. Original illustration, drawn in SVG so it stays crisp and themeable.

type P = { x: number; y: number }
const L1 = 58
const L2 = 58

// Two-link inverse kinematics; `down` picks the elbow below the shoulder-target line.
function elbowFor(s: P, t: P, down: boolean): P {
  const dx = t.x - s.x
  const dy = t.y - s.y
  const d = Math.min(L1 + L2 - 0.5, Math.hypot(dx, dy))
  const a = Math.atan2(dy, dx)
  const alpha = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))
  const e1 = { x: s.x + L1 * Math.cos(a + alpha), y: s.y + L1 * Math.sin(a + alpha) }
  const e2 = { x: s.x + L1 * Math.cos(a - alpha), y: s.y + L1 * Math.sin(a - alpha) }
  return (e1.y > e2.y) === down ? e1 : e2
}

function wristFor(s: P, t: P): P {
  const dx = t.x - s.x
  const dy = t.y - s.y
  const d = Math.hypot(dx, dy)
  const k = Math.min(1, (L1 + L2 - 0.5) / d)
  return { x: s.x + dx * k, y: s.y + dy * k }
}

function Arm({ shoulder, target, down, holding }: { shoulder: P; target: P; down: boolean; holding?: boolean }) {
  const w = wristFor(shoulder, target)
  const e = elbowFor(shoulder, w, down)
  const ux = (w.x - e.x) / L2
  const uy = (w.y - e.y) / L2
  const px = -uy
  const py = ux
  const tip = { x: w.x + ux * 14, y: w.y + uy * 14 }
  return (
    <g>
      <path d={`M${shoulder.x} ${shoulder.y} L${e.x} ${e.y} L${w.x} ${w.y}`} fill="none" stroke="#e7ebed" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
      <path d={`M${shoulder.x} ${shoulder.y} L${e.x} ${e.y} L${w.x} ${w.y}`} fill="none" stroke="#c4ccd0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
      <circle cx={shoulder.x} cy={shoulder.y} r="10" fill="#cfd6da" />
      <circle cx={shoulder.x} cy={shoulder.y} r="5" fill="var(--orange)" />
      <circle cx={e.x} cy={e.y} r="7.5" fill="var(--orange)" />
      {holding && (
        <g transform={`translate(${tip.x} ${tip.y})`}>
          <rect x="-17" y="-12" width="34" height="22" rx="3" fill="#eef2f3" />
          <rect x="-17" y="-12" width="34" height="5" rx="2" fill="var(--orange)" />
          <path d="M-10 2 h18 M-10 6 h12" stroke="#9aa6ab" strokeWidth="1.4" strokeLinecap="round" />
        </g>
      )}
      <path d={`M${w.x + px * 6} ${w.y + py * 6} l${ux * 14} ${uy * 14} M${w.x - px * 6} ${w.y - py * 6} l${ux * 14} ${uy * 14}`}
        stroke="#9aa6ab" strokeWidth="4" strokeLinecap="round" />
      <circle cx={w.x} cy={w.y} r="6" fill="#cfd6da" />
    </g>
  )
}

function useReach(duration = 1700, delay = 500) {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [t, setT] = useState(reduce ? 1 : 0)
  useEffect(() => {
    if (reduce) return
    let raf = 0
    const start = performance.now() + delay
    const tick = (now: number) => {
      const k = Math.max(0, Math.min(1, (now - start) / duration))
      setT(1 - Math.pow(1 - k, 3))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduce, duration, delay])
  return t
}

export default function HeroScene({ viewBox = '0 0 1200 640' }: { viewBox?: string }) {
  const t = useReach()
  const from = { x: 912, y: 470 }
  const to = { x: 846, y: 346 }
  // Slight arc so the hand rises, then extends.
  const target = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 26 }
  const done = t > 0.98

  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid slice" role="img" aria-labelledby="hero-t hero-d" className="hero-svg">
      <title id="hero-t">Assistant robot in an operating theatre</title>
      <desc id="hero-d">
        A white assistant robot with a screen face takes a catheter pack from the supply trolley and hands it to a surgeon at
        the operating table, under the surgical lamp.
      </desc>
      <defs>
        <linearGradient id="cone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff6e8" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff6e8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="body" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.65" stopColor="#e9eef0" />
          <stop offset="1" stopColor="#bfc8cc" />
        </linearGradient>
        <radialGradient id="floorGlow" cx="0.65" cy="0" r="0.7">
          <stop offset="0" stopColor="#22b8ab" stopOpacity="0.10" />
          <stop offset="1" stopColor="#22b8ab" stopOpacity="0" />
        </radialGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* room */}
      <rect x="-1200" y="-800" width="3600" height="1440" fill="#050607" />
      {[-180, -20, 140, 300, 420, 580, 740, 900, 1060].map((x) => <line key={x} x1={x} y1="-800" x2={x} y2="536" stroke="#0d1113" strokeWidth="2" />)}
      <rect x="-1200" y="536" width="3600" height="400" fill="#0a0d0f" />
      <rect y="536" width="1200" height="104" fill="url(#floorGlow)" />
      <line x1="-1200" y1="536" x2="2400" y2="536" stroke="#171c1f" strokeWidth="2" />

      {/* vitals monitor */}
      <line x1="1100" y1="-800" x2="1100" y2="88" stroke="#20272b" strokeWidth="6" />
      <rect x="1012" y="88" width="176" height="104" rx="8" fill="#0a0e10" stroke="#252c30" strokeWidth="2" />
      <path className="ecg" d="M1022 142 h22 l6 -4 l5 4 h8 l4 -26 l5 38 l4 -12 h20 l6 -5 l5 5 h8 l4 -26 l5 38 l4 -12 h14"
        fill="none" stroke="#2ee6c8" strokeWidth="2" strokeLinejoin="round" />
      <text x="1178" y="118" textAnchor="end" fontSize="22" fontWeight="700" fill="#2ee6c8" fontFamily="var(--sans)">72</text>
      <text x="1178" y="176" textAnchor="end" fontSize="15" fontWeight="700" fill="var(--orange)" fontFamily="var(--sans)">98%</text>
      <text x="1022" y="176" fontSize="11" fill="#6f7a80" fontFamily="var(--sans)">SpO₂</text>

      {/* surgical lamp */}
      <line x1="600" y1="-800" x2="600" y2="44" stroke="#2a3034" strokeWidth="8" />
      <ellipse cx="600" cy="58" rx="98" ry="22" fill="#cdd3d6" />
      <ellipse cx="600" cy="66" rx="86" ry="15" fill="#fff8ec" />
      {[-56, -28, 0, 28, 56].map((dx) => <circle key={dx} cx={600 + dx} cy="66" r="6" fill="#ffffff" />)}

      {/* second doctor, at the head end */}
      <g>
        <path d="M502 282 Q540 268 578 282 L590 420 L492 420 Z" fill="#0d6b63" />
        <circle cx="540" cy="250" r="25" fill="#a9785a" />
        <path d="M514 250 Q540 214 566 250 Z" fill="#17988b" />
        <rect x="522" y="254" width="36" height="17" rx="6" fill="#d6e2e4" />
        <path d="M584 300 Q600 360 572 404" fill="none" stroke="#0d6b63" strokeWidth="15" strokeLinecap="round" />
        <circle cx="571" cy="404" r="7" fill="#8fb6cc" />
      </g>

      {/* surgeon, reaching for the pack */}
      <g>
        <path d="M712 270 Q745 258 778 270 L792 420 L700 420 Z" fill="#12857a" />
        <path d="M733 266 L745 286 L757 266" fill="none" stroke="#0d6b63" strokeWidth="2.5" />
        <circle cx="745" cy="234" r="26" fill="#c08a68" />
        <path d="M718 236 Q745 196 772 236 Z" fill="#1fae9f" />
        <rect x="727" y="240" width="38" height="18" rx="6" fill="#dce6e8" />
        <path d="M731 233 h8 M751 233 h8" stroke="#2b1d16" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M716 282 Q704 330 712 372" fill="none" stroke="#12857a" strokeWidth="16" strokeLinecap="round" />
        <path d="M774 282 L798 318" fill="none" stroke="#12857a" strokeWidth="16" strokeLinecap="round" />
        <path d="M798 318 L818 334" fill="none" stroke="#8fb6cc" strokeWidth="12" strokeLinecap="round" />
        <circle cx="822" cy="336" r="7" fill="#8fb6cc" />
      </g>

      {/* light cone over the table */}
      <path d="M520 74 L680 74 L790 412 L440 412 Z" fill="url(#cone)" />

      {/* operating table and draped patient */}
      <rect x="470" y="318" width="14" height="94" rx="3" fill="#127a71" />
      <path d="M452 412 C456 384 480 374 520 372 L708 370 C742 370 758 388 766 412 Z" fill="#0e6f68" />
      <path d="M560 380 C600 374 640 374 690 380 M520 392 C580 386 660 386 740 394" stroke="#1a8f84" strokeWidth="2" fill="none" />
      <rect x="440" y="410" width="340" height="14" rx="4" fill="#3a4246" />
      <rect x="590" y="424" width="34" height="100" fill="#262d31" />
      <ellipse cx="607" cy="528" rx="72" ry="10" fill="#1d2326" />

      {/* supply trolley */}
      <g>
        <rect x="1058" y="444" width="190" height="8" rx="2" fill="#8e999f" />
        <rect x="1058" y="526" width="190" height="6" rx="2" fill="#6b757b" />
        <rect x="1064" y="452" width="5" height="138" fill="#5a6469" />
        <circle cx="1067" cy="594" r="6" fill="#222" />
        {/* top shelf: the pack being picked, then others */}
        <rect x="1076" y="426" width="34" height="18" rx="3" fill="#eef2f3" />
        <rect x="1076" y="426" width="34" height="4" rx="2" fill="var(--orange)" />
        <rect x="1118" y="422" width="30" height="22" rx="3" fill="#eef2f3" />
        <rect x="1118" y="422" width="30" height="4" rx="2" fill="#22b8ab" />
        {[1158, 1170, 1182].map((x) => <rect key={x} x={x} y="428" width="9" height="16" rx="2" fill="#9fd6e6" opacity="0.75" />)}
        <rect x="1080" y="500" width="48" height="26" rx="2" fill="#20272b" />
        <rect x="1136" y="506" width="44" height="20" rx="2" fill="#20272b" />
        <rect x="1086" y="508" width="20" height="4" fill="#22b8ab" opacity="0.7" />
        {/* target brackets */}
        <path d="M1070 430 V420 H1080 M1106 420 H1116 V430 M1116 440 V450 H1106 M1080 450 H1070 V440"
          fill="none" stroke="var(--orange)" strokeWidth="2.2" strokeLinecap="round" />
        <text x="1074" y="476" fontSize="13" fill="var(--orange)" fontFamily="var(--sans)" fontWeight="600">next: guidewire</text>
      </g>

      {/* robot */}
      <ellipse cx="960" cy="596" rx="92" ry="10" fill="#000" opacity="0.7" />
      <rect x="900" y="552" width="120" height="38" rx="16" fill="#22282c" />
      <rect x="896" y="532" width="128" height="18" rx="9" fill="var(--orange)" />
      <path d="M898 536 L898 374 Q898 318 960 318 Q1022 318 1022 374 L1022 536 Z" fill="url(#body)" />
      <rect x="918" y="374" width="84" height="128" rx="14" fill="#07090a" stroke="#1d2327" />
      <circle cx="960" cy="420" r="18" fill="none" stroke="#1d2327" strokeWidth="5" />
      <path d="M960 402 A18 18 0 1 1 942.9 425.6" fill="none" stroke="#22b8ab" strokeWidth="5" strokeLinecap="round" />
      <path d="M942.9 425.6 A18 18 0 0 1 960 402" fill="none" stroke="var(--orange)" strokeWidth="5" strokeLinecap="round" />
      <text x="960" y="466" textAnchor="middle" fontSize="16" fontWeight="700" fill="#f2f4f5" fontFamily="var(--sans)">80%</text>
      <text x="960" y="484" textAnchor="middle" fontSize="10" fill="#7f8a90" fontFamily="var(--sans)">grasp success</text>
      <rect x="945" y="306" width="30" height="16" fill="#c4ccd0" />
      <rect x="948" y="214" width="24" height="10" rx="5" fill="#2a3034" />
      <rect x="904" y="222" width="112" height="90" rx="30" fill="#f3f5f6" />
      <rect x="915" y="233" width="90" height="68" rx="20" fill="#050607" />
      <g className="eyes" filter="url(#glow)">
        <rect x="931" y="261" width="23" height="11" rx="5.5" fill="#2ee6c8" />
        <rect x="966" y="261" width="23" height="11" rx="5.5" fill="#2ee6c8" />
      </g>

      <Arm shoulder={{ x: 1018, y: 372 }} target={{ x: 1092, y: 412 }} down={false} />
      <Arm shoulder={{ x: 902, y: 372 }} target={target} down holding />

      {/* handover callout */}
      <g style={{ opacity: done ? 1 : 0, transition: 'opacity 400ms ease' }}>
        <path d="M826 334 L838 206" stroke="#2ec4a0" strokeWidth="1.5" strokeDasharray="3 4" />
        <rect x="768" y="180" width="146" height="28" rx="14" fill="#06120f" stroke="#2ec4a0" strokeWidth="1.5" />
        <text x="841" y="199" textAnchor="middle" fontSize="13" fontWeight="600" fill="#2ec4a0" fontFamily="var(--sans)">Handed over · 2.4 s</text>
      </g>

      <style>{`
        .hero-svg .eyes { transform-box: fill-box; transform-origin: center; animation: blink 5s infinite; }
        @keyframes blink { 0%, 94%, 100% { transform: scaleY(1) } 96% { transform: scaleY(0.1) } }
        .hero-svg .ecg { stroke-dasharray: 210; animation: ecg 2.4s linear infinite; }
        @keyframes ecg { from { stroke-dashoffset: 420 } to { stroke-dashoffset: 0 } }
      `}</style>
    </svg>
  )
}
