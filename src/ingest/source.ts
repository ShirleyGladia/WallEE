// A file the reader can pull byte ranges from: either a File the user picked, or a file served by the dev server.
export interface Source {
  name: string
  size: number
  slice(start: number, end?: number): Promise<ArrayBuffer>
  text(): Promise<string>
  url(): string // something a <video> element can play
}

export function fromFile(file: File): Source {
  let objectUrl: string | null = null
  return {
    name: file.name,
    size: file.size,
    slice: (s, e) => file.slice(s, e).arrayBuffer(),
    text: () => file.text(),
    url: () => (objectUrl ??= URL.createObjectURL(file)),
  }
}

// Reads only the requested bytes over HTTP Range, so a 2 GB dataset never has to be downloaded whole.
export function fromUrl(url: string, size: number, name: string): Source {
  return {
    name,
    size,
    url: () => url,
    text: async () => (await fetch(url)).text(),
    async slice(s, e = size) {
      if (e <= s) return new ArrayBuffer(0)
      const res = await fetch(url, { headers: { Range: `bytes=${s}-${e - 1}` } })
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
      const body = await res.arrayBuffer()
      return res.status === 206 ? body : body.slice(s, e)
    },
  }
}
