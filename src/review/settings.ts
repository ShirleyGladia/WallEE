// Thresholds shared by the charts, clip review and Selection. Remembered per browser.
import { useSyncExternalStore } from 'react'

export interface Thresholds {
  speed: number // joint speed, share of the FR3 limit (0.5 = half)
  accel: number // joint acceleration, rad/s² (FR3 limit is 10)
  tcp: number // gripper tip speed, mm/s (ISO 10218 reduced speed is 250 mm/s)
  reach: number // share of the 855 mm maximum reach
  tableMm: number // table top below the robot base, mm (0 = not set)
  horizon: number // how far ahead the prediction looks, s
}

export const DEFAULTS: Thresholds = { speed: 0.5, accel: 5, tcp: 250, reach: 0.9, tableMm: 0, horizon: 0.5 }

const KEY = 'thresholds'
const listeners = new Set<() => void>()
let current: Thresholds = load()

function load(): Thresholds {
  try {
    const old = localStorage.getItem('ws-table-mm')
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { ...DEFAULTS, ...(old ? { tableMm: Number(old) || 0 } : {}), ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setThresholds(patch: Partial<Thresholds>) {
  current = { ...current, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* private window */ }
  listeners.forEach((l) => l())
}

export function useThresholds() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current)
}
export const getThresholds = () => current
