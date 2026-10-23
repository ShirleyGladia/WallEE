// Dev/preview-server plugin: makes the datasets in src/datasets loadable from the Ingest page
// (and, mounted again at /__evals, the evaluation runs in src/evals).
//   GET /__datasets                     -> [{ name, bytes, files: [{ path, size }] }]
//   GET /__datasets/<name>/<file path>  -> the file, with HTTP Range support
// The browser then reads only the bytes it needs (Parquet footers, MP4 headers), not the whole 2 GB.
// Nothing here is part of the production build.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jsonl': 'application/json', '.parquet': 'application/octet-stream',
}

function walk(dir: string, root: string, out: { path: string; size: number }[]) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full) // follows symlinks
    if (st.isDirectory()) walk(full, root, out)
    else if (st.isFile()) out.push({ path: relative(root, full).split(sep).join('/'), size: st.size })
  }
}

function handler(root: string, prefix: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (url !== prefix && !url.startsWith(prefix + '/')) return next()
    if (!existsSync(root)) {
      res.setHeader('Content-Type', 'application/json')
      return res.end('[]')
    }
    const rest = url.slice(prefix.length).replace(/^\/+/, '')
    if (!rest) {
      const list = readdirSync(root)
        .filter((name) => !name.startsWith('.') && statSync(join(root, name)).isDirectory())
        .map((name) => {
          const files: { path: string; size: number }[] = []
          walk(join(root, name), join(root, name), files)
          return { name, bytes: files.reduce((s, f) => s + f.size, 0), files }
        })
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify(list))
    }
    const file = resolve(root, rest)
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      return res.end('Not found')
    }
    const size = statSync(file).size
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        return res.end()
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      return createReadStream(file, { start, end }).pipe(res)
    }
    res.setHeader('Content-Length', String(size))
    createReadStream(file).pipe(res)
  }
}

export function datasets(dir = 'src/datasets', prefix = '/__datasets'): Plugin {
  const root = resolve(dir)
  return {
    name: `loop-console${prefix.replace(/\W+/g, '-')}`,
    configureServer(server) { server.middlewares.use(handler(root, prefix)) },
    configurePreviewServer(server) { server.middlewares.use(handler(root, prefix)) },
  }
}
