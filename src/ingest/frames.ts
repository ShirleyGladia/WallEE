// Loads the full frame-by-frame data of one episode on demand (for the episode inspector).
import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type FileMetaData } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { gradient } from './kinematics'
import type { IngestResult } from './types'

export interface EpisodeFrames {
  t: number[] // seconds since episode start
  q: number[][] // joint state per frame
  v: number[][] // joint velocity per frame
  a: number[][] // joint acceleration per frame
  fromData: boolean // velocity/acceleration came from the files rather than being derived
}

const metaCache = new Map<string, Promise<FileMetaData>>()
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v))

export async function loadEpisodeFrames(result: IngestResult, episode: number): Promise<EpisodeFrames | null> {
  const e = result.episodes.find((x) => x.episode === episode)
  if (!e?.rows) return null
  const src = result.dataSources[e.rows.file]
  if (!src) return null
  const file = { byteLength: src.size, slice: (s: number, end?: number) => src.slice(s, end) }
  const key = `${result.name}|${e.rows.file}`
  if (!metaCache.has(key)) metaCache.set(key, parquetMetadataAsync(file))
  const metadata = await metaCache.get(key)!
  const names = parquetSchema(metadata).children.map((c) => c.element.name)
  const columns = ['timestamp', 'observation.state', 'observation.velocity', 'observation.acceleration'].filter((c) => names.includes(c))
  const rows = await parquetReadObjects({ file, metadata, columns, rowStart: e.rows.start, rowEnd: e.rows.end, compressors })
  const t0 = num(rows[0]?.timestamp ?? 0)
  const t = rows.map((r) => num(r.timestamp) - t0)
  const q = rows.map((r) => Array.from(r['observation.state'] as ArrayLike<number>))
  const hasV = names.includes('observation.velocity')
  const v = hasV ? rows.map((r) => Array.from(r['observation.velocity'] as ArrayLike<number>)) : gradient(q, t)
  const a = names.includes('observation.acceleration') ? rows.map((r) => Array.from(r['observation.acceleration'] as ArrayLike<number>)) : gradient(v, t)
  return { t, q, v, a, fromData: hasV }
}
