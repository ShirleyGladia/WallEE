// VLM review: a vision-language model looks at a few frames of sampled episodes and says whether the task
// was done and whether the camera view looks right. Talks to any OpenAI-compatible server, e.g. vLLM on the
// team's RTX 4090:   vllm serve Qwen/Qwen2.5-VL-3B-Instruct --port 8001 --gpu-memory-utilization 0.35
// The dev server proxies /vlm to VLM_TARGET (default http://localhost:8001), so the browser needs no CORS setup.
import { useSyncExternalStore } from 'react'
import { grabFrames } from '../ingest/grab'
import type { IngestResult } from '../ingest/types'

export interface VlmSettings { url: string; model: string; episodes: number; frames: number }
export interface VlmEpisode { episode: number; verdict: 'ok' | 'problem' | 'unsure'; taskDone: boolean | 'unsure'; cameraOk: boolean | 'unsure'; problems: string[]; summary: string; thumbs: string[]; raw?: string }
export interface VlmReview { dataset: string; model: string; at: string; episodes: VlmEpisode[]; error?: string }

const SKEY = 'vlm-settings'
export const VLM_DEFAULTS: VlmSettings = { url: import.meta.env.VITE_VLM_URL ?? '/vlm/v1', model: 'Qwen/Qwen2.5-VL-3B-Instruct', episodes: 6, frames: 4 }
export function getVlmSettings(): VlmSettings {
  try { return { ...VLM_DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) ?? '{}') } } catch { return { ...VLM_DEFAULTS } }
}
export function saveVlmSettings(s: VlmSettings) {
  try { localStorage.setItem(SKEY, JSON.stringify(s)) } catch { /* ignore */ }
}

// ---- results, per dataset, remembered in this browser ----
const listeners = new Set<() => void>()
const mem = new Map<string, VlmReview | null>()
const RKEY = (d: string) => `vlm:${d}`
export function getVlmReview(d: string): VlmReview | null {
  if (!mem.has(d)) {
    let v: VlmReview | null = null
    try { v = JSON.parse(localStorage.getItem(RKEY(d)) ?? 'null') } catch { /* none */ }
    mem.set(d, v)
  }
  return mem.get(d)!
}
function putVlmReview(d: string, v: VlmReview | null) {
  mem.set(d, v)
  try { v ? localStorage.setItem(RKEY(d), JSON.stringify({ ...v, episodes: v.episodes.map((e) => ({ ...e, thumbs: e.thumbs.slice(0, 1) })) })) : localStorage.removeItem(RKEY(d)) } catch { /* quota */ }
  listeners.forEach((l) => l())
}
export const clearVlmReview = (d: string) => putVlmReview(d, null)
export function useVlmReview(d: string) {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => getVlmReview(d))
}

export async function testVlm(s: VlmSettings): Promise<string[]> {
  const res = await fetch(`${s.url.replace(/\/$/, '')}/models`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const j = await res.json()
  return (j.data ?? []).map((m: { id: string }) => m.id)
}

const PROMPT = (task: string, n: number) =>
  `These are ${n} camera frames, in time order, from one robot demonstration of the task: "${task}".
Judge only what you can see.
Reply with JSON only, no other text:
{"task_done": true | false | "unsure", "camera_ok": true | false, "problems": ["short phrase", ...], "summary": "one sentence"}
camera_ok is false if the picture is upside down, rotated, black, frozen or shows the wrong scene.`

function parse(text: string): Omit<VlmEpisode, 'episode' | 'thumbs'> {
  const m = text.match(/\{[\s\S]*\}/)
  try {
    const j = JSON.parse(m ? m[0] : text)
    const taskDone = j.task_done === true || j.task_done === false ? j.task_done : 'unsure'
    const cameraOk = j.camera_ok === true || j.camera_ok === false ? j.camera_ok : 'unsure'
    const problems: string[] = Array.isArray(j.problems) ? j.problems.map(String).filter(Boolean) : []
    const verdict = taskDone === true && cameraOk === true && problems.length === 0 ? 'ok' : taskDone === false || cameraOk === false ? 'problem' : 'unsure'
    return { verdict, taskDone, cameraOk, problems, summary: String(j.summary ?? ''), raw: text }
  } catch {
    return { verdict: 'unsure', taskDone: 'unsure', cameraOk: 'unsure', problems: ['Answer was not JSON'], summary: text.slice(0, 160), raw: text }
  }
}

// Evenly spread episodes that have video, preferring ones that passed the checks (the checks already caught the others).
export function sampleEpisodes(r: IngestResult, n: number, cam?: string) {
  const withVideo = r.episodes.filter((e) => !cam || r.segments[e.episode]?.[cam])
  const pool = withVideo.filter((e) => e.errors.length === 0)
  const list = pool.length >= n ? pool : withVideo
  if (!list.length) return []
  return Array.from({ length: Math.min(n, list.length) }, (_, k) => list[Math.floor(((k + 0.5) / Math.min(n, list.length)) * list.length)].episode)
}

export async function runVlmReview(r: IngestResult, s: VlmSettings, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<VlmReview> {
  const cam = r.cameras.find((c) => c.key.includes('external') && c.playable) ?? r.cameras.find((c) => c.playable)
  if (!cam) throw new Error('No playable camera video in this dataset (open the page in Chrome, with the videos loaded).')
  const eps = sampleEpisodes(r, s.episodes, cam.key)
  if (!eps.length) throw new Error('No episode has a playable video for this camera.')
  try { await testVlm(s) } catch (e) { throw new Error(`Can’t reach the VLM at ${s.url} (${(e as Error).message}).`) }
  const task = r.tasks[0] ?? 'the task'
  const out: VlmEpisode[] = []
  onProgress(0, eps.length)
  for (const [k, episode] of eps.entries()) {
    if (signal?.aborted) break
    const seg = r.segments[episode]?.[cam.key]
    if (!seg) continue
    const times = Array.from({ length: s.frames }, (_, i) => seg.from + ((i + 0.5) / s.frames) * (seg.to - seg.from))
    const grabs = await grabFrames(cam.fileUrls[seg.fi], times, { width: 224, thumbs: true, signal })
    const thumbs = grabs.map((g) => g.url!).filter(Boolean)
    const res = await fetch(`${s.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: 'system', content: 'You check robot demonstrations before they are used to train a robot policy. Be strict and brief.' },
          { role: 'user', content: [{ type: 'text', text: PROMPT(task, thumbs.length) }, ...thumbs.map((url) => ({ type: 'image_url', image_url: { url } }))] },
        ],
      }),
    })
    if (!res.ok) throw new Error(`VLM server answered ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    out.push({ episode, thumbs, ...parse(j.choices?.[0]?.message?.content ?? '') })
    onProgress(k + 1, eps.length)
  }
  const review = { dataset: r.name, model: s.model, at: new Date().toISOString(), episodes: out }
  if (out.length) putVlmReview(r.name, review)
  return review
}

export function vlmSummary(v: VlmReview | null) {
  if (!v || !v.episodes.length) return null
  const ok = v.episodes.filter((e) => e.verdict === 'ok').length
  const problem = v.episodes.filter((e) => e.verdict === 'problem').length
  const verdict: 'ok' | 'problem' | 'unsure' = problem > 0 ? 'problem' : ok === v.episodes.length ? 'ok' : 'unsure'
  return { ok, problem, unsure: v.episodes.length - ok - problem, total: v.episodes.length, verdict }
}
