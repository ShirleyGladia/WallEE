// Deterministic mock data so the UI can be built and demoed before the backend exists.
// Every function here returns the same shape the real API will (see types.ts).
import type {
  DatasetReport, Diagnosis, Endpoint, Episode, EpisodeFlag, EvalReport, IngestReport,
  LoopStatus, LossPoint, ModelVersion, Phase, Rollout, TrainRun,
} from './types'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export const TASK = 'Pick the catheter pack and place it on the prep tray'

export const loopStatus: LoopStatus = {
  cycle: 2,
  task: TASK,
  robot: 'FR3 Duo · simulation',
  stages: {
    ingest: { headline: '500 episodes', sub: '488 valid · 12 rejected', state: 'done',
      gate: { question: 'Is this file valid?', verdict: 'pass', detail: '97.6% of episodes passed' } },
    dataset: { headline: 'Health 82', sub: '47 flagged · 1 coverage gap', state: 'done',
      gate: { question: 'Is the dataset good as a whole?', verdict: 'pass', detail: '6 of 7 checks green' } },
    select: { headline: '2 groups to train', sub: '1 for test · 1 excluded', state: 'done' },
    train: { headline: 'Run #7 · 63%', sub: 'π0.5 · manifest v2', state: 'running' },
    evaluate: { headline: 'v1: 58%', sub: 'Fails at the grasp', state: 'done',
      gate: { question: 'Good enough?', verdict: 'fail', detail: 'Below the 75% target' } },
    serve: { headline: 'v1 live', sub: 'p50 92 ms · 3 endpoints', state: 'done' },
    diagnose: { headline: '3 recommendations', sub: 'Rotated packs under-represented', state: 'done' },
  },
  activity: [
    { at: '10:42', stage: 'train', text: 'Run #7 passed step 3,150 of 5,000' },
    { at: '10:05', stage: 'dataset', text: 'Dataset v2 built with 40 new rotated-pack demos' },
    { at: '09:48', stage: 'diagnose', text: 'Recommended more demos with the pack rotated over 30°' },
    { at: '09:31', stage: 'evaluate', text: 'v1 evaluated on 50 seeds: 58% success' },
    { at: '08:55', stage: 'serve', text: 'v1 deployed to the simulation endpoint' },
  ],
}

export const ingestReport: IngestReport = {
  totalEpisodes: 500,
  validEpisodes: 488,
  steps: [
    { label: 'Read raw files', detail: 'HDF5 from the team file share', done: 500, total: 500 },
    { label: 'Validate', detail: 'Required keys, NaNs, frame counts', done: 500, total: 500 },
    { label: 'Align streams', detail: 'Cameras, joint state and actions to 30 Hz', done: 488, total: 488 },
    { label: 'Convert to LeRobot', detail: 'Parquet + MP4, one task per episode', done: 488, total: 488 },
    { label: 'Enrich', detail: 'Phase labels and language instructions', done: 312, total: 488 },
  ],
  files: [
    { name: 'demos_batch_01.hdf5', episodes: 100, sizeMb: 2140, status: 'valid', issues: [] },
    { name: 'demos_batch_02.hdf5', episodes: 100, sizeMb: 2085, status: 'valid', issues: [] },
    { name: 'demos_batch_03.hdf5', episodes: 100, sizeMb: 2203, status: 'invalid', issues: ['7 episodes missing wrist camera', '2 episodes with NaN joint states'] },
    { name: 'demos_batch_04.hdf5', episodes: 100, sizeMb: 2117, status: 'valid', issues: [] },
    { name: 'demos_batch_05.hdf5', episodes: 100, sizeMb: 2166, status: 'invalid', issues: ['3 episodes shorter than 1 s'] },
  ],
  schema: [
    { key: 'observation.images.top', shape: '3 × 480 × 640', hz: 30, note: 'Overhead camera' },
    { key: 'observation.images.wrist_left', shape: '3 × 480 × 640', hz: 30, note: 'Left wrist camera' },
    { key: 'observation.images.wrist_right', shape: '3 × 480 × 640', hz: 30, note: 'Right wrist camera' },
    { key: 'observation.state', shape: '16', hz: 30, note: '2 × 7 joints + 2 grippers' },
    { key: 'action', shape: '16', hz: 30, note: 'Joint targets + gripper commands' },
    { key: 'task', shape: 'text', hz: 0, note: 'Language instruction' },
  ],
  gaps: [
    '12 episodes rejected: missing camera stream, NaN states or too short.',
    '176 episodes still need phase labels before they can feed the failure funnel.',
  ],
}

const FLAG_LABELS: Record<EpisodeFlag, string> = {
  idle: 'Idle robot for most of the episode',
  duplicate: 'Near-duplicate of another episode',
  misaligned: 'Camera and state timestamps misaligned',
  'too-short': 'Too short to complete the task',
  'gripper-noise': 'Gripper command chatter',
}

function makeEpisodes(): Episode[] {
  const r = rng(42)
  const out: Episode[] = []
  for (let id = 0; id < 488; id++) {
    let x = r()
    let y = r()
    // Leave a visible gap: almost no demos with the pack in the far-left back corner.
    if (x < 0.28 && y > 0.62 && r() > 0.08) {
      x = 0.3 + r() * 0.65
    }
    const yaw = (r() - 0.5) * (r() > 0.85 ? 90 : 40)
    const flags: EpisodeFlag[] = []
    const f = r()
    if (f < 0.03) flags.push('idle')
    else if (f < 0.06) flags.push('duplicate')
    else if (f < 0.08) flags.push('misaligned')
    else if (f < 0.09) flags.push('too-short')
    else if (f < 0.096) flags.push('gripper-noise')
    out.push({
      id,
      durationS: Math.round((8 + r() * 6) * 10) / 10,
      objectX: x,
      objectY: y,
      objectYawDeg: Math.round(yaw),
      flags,
      instruction: TASK.toLowerCase(),
    })
  }
  return out
}

const episodes = makeEpisodes()

export const datasetReport: DatasetReport = {
  version: 'v2',
  health: 82,
  breakdown: (Object.keys(FLAG_LABELS) as EpisodeFlag[]).map((flag) => ({
    flag,
    label: FLAG_LABELS[flag],
    count: episodes.filter((e) => e.flags.includes(flag)).length,
  })),
  episodes,
  readiness: [
    { check: 'Every episode has a language instruction', ok: true, note: '488 / 488' },
    { check: 'Single control frequency', ok: true, note: 'All streams at 30 Hz' },
    { check: 'Actions normalised', ok: true, note: 'Mean/std stats saved with the dataset' },
    { check: 'Train / validation split by episode', ok: true, note: '440 / 48' },
    { check: 'No timestamp misalignment', ok: true, note: 'Misaligned episodes excluded' },
    { check: 'Phase labels present', ok: true, note: 'Used by the evaluation funnel' },
    { check: 'Workspace coverage', ok: false, note: 'Back-left corner under-represented' },
  ],
  gapNote: 'Only a handful of demos start with the pack in the back-left corner of the tray.',
}

export const trainRuns: TrainRun[] = [
  { id: '#7', model: 'π0 (openpi) · LoRA', dataset: 'v2', status: 'running', step: 3150, totalSteps: 5000, loss: 0.071, gpu: 'A100 80GB', startedAt: '09:58', why: 'Same recipe as v1, plus 40 rotated-pack demos' },
  { id: '#6', model: 'ACT', dataset: 'v2', status: 'finished', step: 20000, totalSteps: 20000, loss: 0.112, gpu: 'A100 80GB', startedAt: '08:40', why: 'Cheap baseline to compare against' },
  { id: '#5', model: 'π0 (openpi) · LoRA', dataset: 'v1', status: 'finished', step: 5000, totalSteps: 5000, loss: 0.064, gpu: 'A100 80GB', startedAt: '06:10', why: 'First fine-tune → model v1' },
  { id: '#4', model: 'GR00T N1.5', dataset: 'v1', status: 'failed', step: 820, totalSteps: 6000, loss: 0.31, gpu: 'A100 80GB', startedAt: '05:02', why: 'Action dimension mismatch for the dual arm' },
]

export function lossCurve(steps = 5000, upTo = steps): LossPoint[] {
  const r = rng(7)
  const pts: LossPoint[] = []
  for (let s = 0; s <= upTo; s += 50) {
    const base = 0.06 + 0.55 * Math.exp(-s / 700)
    pts.push({
      step: s,
      train: Math.round((base + (r() - 0.5) * 0.02) * 1000) / 1000,
      val: Math.round((base * 1.08 + 0.008 + (r() - 0.5) * 0.012) * 1000) / 1000,
    })
  }
  return pts
}

const PHASES: Phase[] = ['approach', 'grasp', 'lift', 'place']

function makeRollouts(failures: Record<Phase, number>, n: number, seed: number): Rollout[] {
  const r = rng(seed)
  const reasons: Record<Phase, string[]> = {
    approach: ['Collision with tray edge'],
    grasp: ['Missed grasp on rotated pack', 'Missed grasp on rotated pack', 'Grasp slipped'],
    lift: ['Dropped during lift'],
    place: ['Placed outside target zone'],
  }
  // Exact failure counts per phase, shuffled across seeds.
  const outcomes: (Phase | null)[] = []
  for (const p of PHASES) for (let i = 0; i < failures[p]; i++) outcomes.push(p)
  while (outcomes.length < n) outcomes.push(null)
  for (let i = outcomes.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]]
  }
  return outcomes.map((failedAt, i) => ({
    id: i,
    seed: 1000 + i,
    success: failedAt === null,
    reached: failedAt ?? 'place',
    failure: failedAt ? reasons[failedAt][Math.floor(r() * reasons[failedAt].length)] : undefined,
    latencyMs: Math.round(70 + r() * 45 + (r() > 0.93 ? 60 : 0)),
  }))
}

export const evalReports: Record<string, EvalReport> = {
  v1: { model: 'v1', rollouts: makeRollouts({ approach: 3, grasp: 13, lift: 3, place: 2 }, 50, 11), threshold: 0.75, baseline: { model: 'ACT (run #6)', successRate: 0.41 } },
  v2: { model: 'v2', rollouts: makeRollouts({ approach: 2, grasp: 4, lift: 2, place: 2 }, 50, 23), threshold: 0.75, baseline: { model: 'ACT (run #6)', successRate: 0.41 } },
}

export const phases = PHASES

export const versions: ModelVersion[] = [
  { version: 'v2', run: '#7', dataset: 'v2', successRate: 0.8, latencyP50: 94, status: 'candidate', createdAt: 'Today 10:58', note: 'Retrained with rotated-pack demos' },
  { version: 'v1', run: '#5', dataset: 'v1', successRate: 0.58, latencyP50: 92, status: 'live', createdAt: 'Today 07:20', note: 'First π0 fine-tune' },
  { version: 'v0', run: '#6', dataset: 'v1', successRate: 0.41, latencyP50: 38, status: 'archived', createdAt: 'Today 06:55', note: 'ACT baseline' },
]

export const endpoints: Endpoint[] = [
  { id: 'S1', target: 'Simulation · cath lab scene', version: 'v1', healthy: true, requestsPerMin: 1800 },
  { id: 'S2', target: 'Evaluation runner', version: 'v2', healthy: true, requestsPerMin: 900 },
  { id: 'S3', target: 'Real FR3 Duo (shadow mode)', version: 'v1', healthy: false, requestsPerMin: 0 },
]

export const diagnosis: Diagnosis = {
  model: 'v1',
  findings: [
    { phase: 'grasp', share: 0.62, cause: 'Pack rotated more than 30°', evidence: '13 of 21 failures; gripper closes beside the pack' },
    { phase: 'approach', share: 0.14, cause: 'Pack in the back-left corner', evidence: 'Arm path clips the tray edge; matches the coverage gap' },
    { phase: 'lift', share: 0.14, cause: 'Grip too close to the pack edge', evidence: 'Pack slides out in the first 5 cm of lift' },
    { phase: 'place', share: 0.1, cause: 'Target zone overshoot', evidence: 'Placed 2–4 cm past the tray marker' },
  ],
  recommendations: [
    { kind: 'data', title: 'Add 40 demos with the pack rotated 30–60°', detail: 'Generate in simulation with the scripted expert, randomising yaw.', impact: 'Targets 62% of failures' },
    { kind: 'data', title: 'Add 15 demos starting in the back-left corner', detail: 'Fills the gap shown on the coverage map.', impact: 'Targets 14% of failures' },
    { kind: 'check', title: 'Add a yaw-coverage check to dataset intelligence', detail: 'Fail the gate if any 15° yaw bucket has fewer than 10 demos.', impact: 'Stops this gap recurring' },
    { kind: 'training', title: 'Resume from v1 instead of training from scratch', detail: 'Keeps what already works and shortens the cycle to about 1 hour.', impact: 'Faster next cycle' },
  ],
}
