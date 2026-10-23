// Grabs still frames from a video at given times, through a hidden <video> and a canvas.
// Works for any codec the browser can play (Chrome plays the AV1 files).

export interface Grab { t: number; image: ImageData; url?: string }

export async function grabFrames(src: string, times: number[], opts: { width?: number; thumbs?: boolean; signal?: AbortSignal } = {}): Promise<Grab[]> {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.playsInline = true
  v.src = src
  await new Promise<void>((ok, fail) => {
    const timer = window.setTimeout(() => fail(new Error('Video took too long to open')), 15000)
    v.onloadeddata = () => { window.clearTimeout(timer); ok() }
    v.onerror = () => { window.clearTimeout(timer); fail(new Error('This browser can’t decode the video')) }
  })
  const w = opts.width ?? 96
  const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const out: Grab[] = []
  for (const t of times) {
    if (opts.signal?.aborted) break
    await new Promise<void>((ok) => {
      const timer = window.setTimeout(ok, 4000)
      v.onseeked = () => { window.clearTimeout(timer); ok() }
      v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05))
    })
    ctx.drawImage(v, 0, 0, w, h)
    out.push({ t, image: ctx.getImageData(0, 0, w, h), url: opts.thumbs ? canvas.toDataURL('image/jpeg', 0.8) : undefined })
  }
  v.removeAttribute('src')
  v.load()
  return out
}

// Brightness (0–255 luma), contrast (spread of luma) and colour cast of one frame.
export function lightOf(img: ImageData) {
  const d = img.data
  let s = 0, s2 = 0, r = 0, g = 0, b = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    s += y; s2 += y * y; r += d[i]; g += d[i + 1]; b += d[i + 2]
  }
  const mean = s / n
  return { brightness: mean, contrast: Math.sqrt(Math.max(0, s2 / n - mean * mean)), warmth: (r - b) / n, rgb: [r / n, g / n, b / n] as [number, number, number] }
}
