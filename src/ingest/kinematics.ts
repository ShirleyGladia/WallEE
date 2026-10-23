// Franka Research 3 kinematics, from the published FR3 specs (same geometry as Panda).
// Used to turn joint angles into gripper positions and to compare speed and reach with the robot's limits.

const PI = Math.PI

// Modified (Craig) DH parameters per joint: [a, d, alpha] in metres / radians.
const DH: [number, number, number][] = [
  [0, 0.333, 0], [0, 0, -PI / 2], [0, 0.316, PI / 2], [0.0825, 0, PI / 2],
  [-0.0825, 0.384, -PI / 2], [0, 0, PI / 2], [0.088, 0, PI / 2],
]
const FLANGE_D = 0.107
const HAND_TCP = 0.1034 // Franka Hand: flange to the point between the fingertips

export const FR3 = {
  reach: 0.855, // maximum reach (m), measured from the shoulder (joint 2 axis)
  shoulder: [0, 0, 0.333] as const,
  qMin: [-2.7437, -1.7837, -2.9007, -3.0421, -2.8065, 0.5445, -3.0159],
  qMax: [2.7437, 1.7837, 2.9007, -0.1518, 2.8065, 4.5169, 3.0159],
  vMax: [2.62, 2.62, 2.62, 2.62, 5.26, 4.18, 5.26], // rad/s
  aMax: [10, 10, 10, 10, 10, 10, 10], // rad/s²
}

// FR3 Duo state layout: left joints 1–7, left gripper, right joints 1–7, right gripper.
export const ARMS = [
  { name: 'Left arm', offset: 0 },
  { name: 'Right arm', offset: 8 },
]
export const isDuo = (n: number) => n === 16
export const armJointDims = (n: number) =>
  isDuo(n) ? [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14] : n >= 7 ? [0, 1, 2, 3, 4, 5, 6] : []

// Positions of base, the 7 joint frames, the flange and the gripper tip (TCP), in the arm's base frame (metres).
// Index: 0 base, 1–7 joints, 8 flange, 9 gripper tip.
export function fk(q: ArrayLike<number>, offset = 0): [number, number, number][] {
  // Rolling 3×4 transform [R | p]
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  let p = [0, 0, 0]
  const pts: [number, number, number][] = [[0, 0, 0]]
  const step = (a: number, d: number, al: number, th: number) => {
    const ca = Math.cos(al), sa = Math.sin(al), ct = Math.cos(th), st = Math.sin(th)
    // Local transform rows (modified DH)
    const L = [ct, -st, 0, st * ca, ct * ca, -sa, st * sa, ct * sa, ca]
    const lp = [a, -d * sa, d * ca]
    const nr = new Array(9)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nr[i * 3 + j] = r[i * 3] * L[j] + r[i * 3 + 1] * L[3 + j] + r[i * 3 + 2] * L[6 + j]
    p = [0, 1, 2].map((i) => p[i] + r[i * 3] * lp[0] + r[i * 3 + 1] * lp[1] + r[i * 3 + 2] * lp[2])
    r = nr
    pts.push([p[0], p[1], p[2]])
  }
  for (let j = 0; j < 7; j++) step(DH[j][0], DH[j][1], DH[j][2], q[offset + j])
  step(0, FLANGE_D, 0, 0)
  step(0, HAND_TCP, 0, 0)
  return pts
}

// Distance from shoulder to flange as a share of the FR3 maximum reach (1 = fully stretched).
export function reachShare(q: ArrayLike<number>, offset = 0) {
  const f = fk(q, offset)[8]
  const [sx, sy, sz] = FR3.shoulder
  return Math.hypot(f[0] - sx, f[1] - sy, f[2] - sz) / FR3.reach
}

// numpy.gradient with uneven spacing: second-order in the middle, first-order at the ends.
export function gradient(series: number[][], t: number[]): number[][] {
  const n = series.length
  if (n === 0) return []
  const dims = series[0].length
  if (n === 1) return [new Array(dims).fill(0)]
  const out: number[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const row = new Array(dims)
    if (i === 0 || i === n - 1) {
      const a = i === 0 ? 0 : n - 2
      const h = t[a + 1] - t[a]
      for (let d = 0; d < dims; d++) row[d] = h ? (series[a + 1][d] - series[a][d]) / h : 0
    } else {
      const h0 = t[i] - t[i - 1]
      const h1 = t[i + 1] - t[i]
      const den = h0 * h1 * (h0 + h1)
      for (let d = 0; d < dims; d++) {
        row[d] = den ? (h0 * h0 * series[i + 1][d] - h1 * h1 * series[i - 1][d] + (h1 * h1 - h0 * h0) * series[i][d]) / den : 0
      }
    }
    out[i] = row
  }
  return out
}
