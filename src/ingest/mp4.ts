// Minimal MP4 reader: duration, codec and frame size straight from the container boxes.
// Works for any codec (AV1 included), even when the browser can't play the video.

export interface Mp4Info {
  durationS: number
  codec: string
  width: number
  height: number
  rotation: number // degrees the player turns the picture (from the track's display matrix)
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
const CODECS: Record<string, string> = { av01: 'AV1', avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', vp09: 'VP9' }

const fourcc = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))

type Bytes = { size: number; slice(start: number, end?: number): Promise<ArrayBuffer> }

async function readBytes(file: Bytes, start: number, end: number) {
  return new DataView(await file.slice(start, end))
}

export async function readMp4(file: Bytes): Promise<Mp4Info | null> {
  // Walk top-level boxes until we find 'moov' (it can sit at the start or the end of the file).
  let off = 0
  while (off + 8 <= file.size) {
    const h = await readBytes(file, off, Math.min(off + 16, file.size))
    let size = h.getUint32(0)
    const type = fourcc(h, 4)
    let header = 8
    if (size === 1) { size = Number(h.getBigUint64(8)); header = 16 }
    if (size === 0) size = file.size - off
    if (size < header) return null
    if (type === 'moov') {
      const moov = await readBytes(file, off, off + size)
      return parseMoov(moov)
    }
    off += size
  }
  return null
}

function parseMoov(v: DataView): Mp4Info {
  const info: Mp4Info = { durationS: NaN, codec: 'unknown', width: 0, height: 0, rotation: 0 }
  const walk = (start: number, end: number) => {
    let o = start
    while (o + 8 <= end) {
      const size = v.getUint32(o)
      const type = fourcc(v, o + 4)
      if (size < 8 || o + size > end) break
      if (type === 'mvhd') {
        const version = v.getUint8(o + 8)
        const ts = version === 1 ? v.getUint32(o + 28) : v.getUint32(o + 20)
        const dur = version === 1 ? Number(v.getBigUint64(o + 32)) : v.getUint32(o + 24)
        if (ts) info.durationS = dur / ts
      } else if (type === 'tkhd') {
        const w = v.getUint32(o + size - 8) / 65536
        const h = v.getUint32(o + size - 4) / 65536
        if (w && h && !info.width) {
          info.width = Math.round(w)
          info.height = Math.round(h)
          // display matrix [a b u; c d v; x y w] sits just before width/height
          const a = v.getInt32(o + size - 44) / 65536
          const b = v.getInt32(o + size - 40) / 65536
          info.rotation = (Math.round((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360
        }
      } else if (type === 'stsd') {
        const entryType = fourcc(v, o + 20)
        if (CODECS[entryType] && info.codec === 'unknown') info.codec = CODECS[entryType]
      } else if (CONTAINERS.has(type)) {
        walk(o + 8, o + size)
      }
      o += size
    }
  }
  walk(8, v.byteLength)
  return info
}

// Can this browser actually show the frames? Resolves quickly from metadata only.
export function canPlay(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const done = (ok: boolean) => {
      window.clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(ok)
    }
    const timer = window.setTimeout(() => done(false), 8000)
    v.onloadedmetadata = () => done(v.videoWidth > 0)
    v.onerror = () => done(false)
    v.src = url
  })
}
