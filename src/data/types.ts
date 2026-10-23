// Shared contract between frontend and backend.
// Agree these shapes with the team first; the mock data and the real API both return them.

export type StageId = 'ingest' | 'dataset' | 'select' | 'train' | 'evaluate' | 'serve' | 'diagnose'
export type GateVerdict = 'pass' | 'fail' | 'pending'
export type Phase = 'approach' | 'grasp' | 'lift' | 'place'

export interface Gate {
  question: string
  verdict: GateVerdict
  detail: string
}

export interface LoopStatus {
  cycle: number
  task: string
  robot: string
  stages: Record<StageId, { headline: string; sub: string; gate?: Gate; state: 'done' | 'running' | 'blocked' | 'idle' }>
  activity: { at: string; stage: StageId; text: string }[]
}

// 01 Ingest
export interface SourceFile {
  name: string
  episodes: number
  sizeMb: number
  status: 'valid' | 'invalid' | 'converting'
  issues: string[]
}

export interface IngestReport {
  totalEpisodes: number
  validEpisodes: number
  steps: { label: string; detail: string; done: number; total: number }[]
  files: SourceFile[]
  schema: { key: string; shape: string; hz: number; note: string }[]
  gaps: string[]
}

// 02 Dataset intelligence
export type EpisodeFlag = 'idle' | 'duplicate' | 'misaligned' | 'too-short' | 'gripper-noise'

export interface Episode {
  id: number
  durationS: number
  objectX: number // start position on the tray, 0..1
  objectY: number
  objectYawDeg: number
  flags: EpisodeFlag[]
  instruction: string
}

export interface DatasetReport {
  version: string
  health: number
  breakdown: { flag: EpisodeFlag; label: string; count: number }[]
  episodes: Episode[]
  readiness: { check: string; ok: boolean; note: string }[]
  gapNote: string
}

// 04 Train
export interface TrainRun {
  id: string
  model: string
  dataset: string
  status: 'running' | 'finished' | 'failed' | 'queued'
  step: number
  totalSteps: number
  loss: number
  gpu: string
  startedAt: string
  why: string
}

export interface LossPoint {
  step: number
  train: number
  val: number
}

// 05 Evaluate
export interface Rollout {
  id: number
  seed: number
  success: boolean
  reached: Phase
  failure?: string
  latencyMs: number
}

export interface EvalReport {
  model: string
  rollouts: Rollout[]
  threshold: number
  baseline: { model: string; successRate: number }
}

// 06 Version & serve
export interface ModelVersion {
  version: string
  run: string
  dataset: string
  successRate: number
  latencyP50: number
  status: 'live' | 'staging' | 'archived' | 'candidate'
  createdAt: string
  note: string
}

export interface Endpoint {
  id: string
  target: string
  version: string
  healthy: boolean
  requestsPerMin: number
}

// Diagnose (the "No" branch of "Good enough?")
export interface Diagnosis {
  model: string
  findings: { phase: Phase; share: number; cause: string; evidence: string }[]
  recommendations: { kind: 'data' | 'check' | 'training'; title: string; detail: string; impact: string }[]
}
