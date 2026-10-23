import { fromFile } from './source'
import type { InputFile } from './types'

const IGNORE = /(^|\/)(\.DS_Store|\.git|node_modules|__MACOSX|Thumbs\.db)(\/|$)/

// Files picked with <input webkitdirectory> or <input multiple>.
export function fromFileList(list: FileList | null): InputFile[] {
  if (!list) return []
  return Array.from(list)
    .map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file: fromFile(file) }))
    .filter((f) => !IGNORE.test(f.path))
}

// Files or whole folders dropped onto the page.
export async function fromDrop(dt: DataTransfer): Promise<InputFile[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e)
  if (entries.length === 0) return fromFileList(dt.files)
  const out: InputFile[] = []
  for (const e of entries) await walk(e, '', out)
  return out.filter((f) => !IGNORE.test(f.path))
}

async function walk(entry: FileSystemEntry, prefix: string, out: InputFile[]) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    out.push({ path, file: fromFile(file) })
    return
  }
  if (IGNORE.test(path)) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns batches; keep reading until it returns an empty batch.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    if (batch.length === 0) break
    for (const child of batch) await walk(child, path, out)
  }
}

// Strip a shared top-level folder name so paths look like "data/…", "videos/…", "meta/…".
export function datasetName(files: InputFile[]): { name: string; files: InputFile[] } {
  const firsts = new Set(files.map((f) => f.path.split('/')[0]))
  if (firsts.size === 1 && files.every((f) => f.path.includes('/'))) {
    const [name] = firsts
    return { name, files: files.map((f) => ({ ...f, path: f.path.slice(name.length + 1) })) }
  }
  return { name: files.length === 1 ? files[0].path : 'Selected files', files }
}
