// What the Ingest stage produces after reading a LeRobot dataset in the browser.

import type { Source } from './source'

export interface InputFile {
  path: string // relative path inside the chosen folder, e.g. "data/chunk-000/file-000.parquet"
  file: Source
}

export type FileKind = 'info' | 'episodes-meta' | 'tasks' | 'stats' | 'data' | 'video' | 'other'
export type Status = 'ok' | 'warn' | 'error' | 'skipped'

export interface FileReport {
  path: string
  kind: FileKind
  bytes: number
  status: Status
  detail: string
  rows?: number
  episodeRange?: [number, number]
  camera?: string
  durationS?: number
  width?: number
  height?: number
}

export interface EpisodeReport {
  episode: number
  file: string
  frames: number
  durationS: number
  success: boolean | null // null when the dataset has no success column
  motion: number // largest joint range over the episode (radians); ~0 means the robot never moved
  errors: string[] // make the episode invalid
  warnings: string[] // worth a look, still usable
  videoCovered: boolean | null // null when no video was provided
  peakSpeed: number // fastest joint speed in the episode (rad/s)
  peakSpeedPct: number // the same as a share of that joint's FR3 limit
  peakAccel: number // largest joint acceleration (rad/s²)
  maxReach: number // furthest the gripper gets, as a share of the FR3 maximum reach (0.855 m)
  rows?: { file: string; start: number; end: number } // where the episode's frames are in its data file
  trace?: Trace // per-frame summaries (for clip review and thresholds)
  moments?: Moment[] // where in the episode the problems found by the checks are
  start?: number[] // state in the first frame
  fingerprint?: string // of the first 60 frames, to find the same demonstration in another dataset
  intErr?: number // only with velocity columns: largest 1-s gap between integrated velocity and joint movement (rad)
  task?: number | null // task_index
  sig?: number[] // gripper tips (x, y, z per arm, metres) at 16 moments through the episode
}

// One value per frame, across both arms.
export interface Trace {
  speed: Float32Array // fastest joint, as a share of its FR3 limit
  reach: Float32Array // furthest arm, shoulder-to-flange as a share of 855 mm
  lowest: Float32Array // lowest point of either arm (m, robot base = 0)
  tcp: Float32Array // fastest gripper tip (mm/s)
}

export type MomentKind = 'spike' | 'stuck' | 'limit' | 'gripper' | 'missing' | 'sync' | 'camera' | 'fast' | 'reach' | 'table' | 'tcp' | 'noise' | 'manual'
export interface Moment {
  from: number // first frame
  to: number // frame after the last
  kind: MomentKind
  reason: string
}

export interface CameraReport {
  key: string
  matchedFrom?: string // folder name, when the camera was recognised by its file lengths
  expectedFiles?: number
  files: string[]
  durationS: number
  expectedS: number
  coveredEpisodes: number
  width?: number
  height?: number
  playable: boolean
  previewUrl?: string
  fileUrls: Record<number, string> // video file index -> playable URL
}

// Where an episode sits inside each camera's video files (from the episode index).
export type Segments = Record<number, Record<string, { fi: number; from: number; to: number }>>

export interface SchemaRow {
  column: string
  type: string
  meaning: string
}

export interface IngestResult {
  name: string
  source: 'project' | 'upload'
  format: string
  fps: number
  fpsSource: 'info.json' | 'timestamps'
  robotType?: string
  tasks: string[]
  expectedEpisodes?: number
  episodes: EpisodeReport[]
  files: FileReport[]
  cameras: CameraReport[]
  schema: SchemaRow[]
  gaps: string[]
  segments: Segments
  dataSources: Record<string, Source>
  kinematics: 'data' | 'derived' | 'none' // velocity/acceleration read from the files, or worked out from joint angles
  totals: { frames: number; durationS: number; valid: number; invalid: number; warned: number }
  stateRange?: { min: number[]; max: number[] }
  stats?: { file: string; count: number | null } // meta/stats.json and how many frames it was computed on
  splits?: Record<string, string>
}

export type Progress = (label: string, done: number, total: number) => void
