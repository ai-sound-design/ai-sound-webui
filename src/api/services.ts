import type { SearchResult, ServiceUrls } from '../types';
import { engine } from '../lib/engine';
import { sleep } from '../lib/util';

/**
 * HTTP clients for https://github.com/ai-sound-design/ai-services
 * (the same contracts the Pro Tools plugin uses).
 */

export type ProgressFn = (fraction: number, detail?: string) => void;

export interface SpotEvent {
  label: string;
  category: string;
  description?: string;
  start_seconds: number;
  end_seconds: number;
  confidence?: number;
}

export interface Scene {
  index: number;
  name: string;
  description?: string;
  first_clip: number;
  last_clip: number;
}

export interface HybridPiece {
  layer: number;
  start_seconds: number;
  length_seconds: number;
  handle_before_seconds?: number;
  handle_after_seconds?: number;
  description?: string;
  external_id?: string;
  category?: string;
  similarity?: number;
  audio_url: string;
}

export interface HybridSound {
  label: string;
  category: string;
  description?: string;
  start_seconds: number;
  end_seconds: number;
  audio_url: string;
  match?: { pieces?: HybridPiece[]; error?: string };
}

export interface HybridAnswer {
  sounds: HybridSound[];
  events_source?: string;
}

export interface GenerationLimits {
  min: number;
  max: number;
  modes: string[];
}

export interface Library {
  library: string;
  sounds: number;
  hours?: number;
}

export class ServiceError extends Error {}

export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

function errorDetail(text: string): string {
  try {
    const j = JSON.parse(text);
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || 'no answer';
}

async function post(url: string, form: FormData, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ServiceError('stopped');
    throw new ServiceError(`${url} not reachable (is the service running? CORS/proxy?)`);
  }
  if (!res.ok) throw new ServiceError(`${res.status}: ${errorDetail(await res.text())}`);
  return res;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    throw new ServiceError(`${url} not reachable`);
  }
  if (!res.ok) throw new ServiceError(`${res.status}: ${errorDetail(await res.text())}`);
  return (await res.json()) as T;
}

export async function fetchAudio(url: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new ServiceError(`Audio ${res.status}: ${url}`);
  return engine.context().decodeAudioData(await res.arrayBuffer());
}

/** Polls an optional progress endpoint every 2 s until `stop()` is called */
function pollProgress(url: string, onProgress: ProgressFn, scale = 1) {
  let done = false;
  const loop = (async () => {
    while (!done) {
      await sleep(2000);
      if (done) break;
      try {
        const r = await fetch(url);
        if (r.ok) {
          const p = await r.json();
          onProgress(Number(p.fraction ?? 0) * scale, p.detail || p.stage);
        }
      } catch {
        /* optional */
      }
    }
  })();
  return async () => {
    done = true;
    await loop;
  };
}

export const jobId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** "HH:MM:SS:FF" (non-drop) of a timeline position */
export function toTimecode(seconds: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, Math.round(seconds * f));
  const ff = total % f;
  const s = Math.floor(total / f);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(ff)}`;
}

export async function health(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(joinUrl(url, '/health'));
  } catch {
    throw new ServiceError('not reachable');
  }
  const text = await res.text();
  if (!res.ok) throw new ServiceError(`${res.status}: ${errorDetail(text)}`);
  return text;
}

/** The lengths the generation service accepts, from its /health answer */
export async function generationLimits(urls: ServiceUrls): Promise<GenerationLimits> {
  const h = await getJson<Record<string, unknown>>(joinUrl(urls.generation, '/health'));
  const caps = (h.capabilities as Record<string, unknown> | undefined) ?? h;
  const min = Number(caps.min_seconds ?? h.min_seconds ?? 4);
  const max = Number(caps.max_seconds ?? h.max_seconds ?? 12);
  const modes = (caps.modes as string[] | undefined) ?? ['v2a'];
  return { min, max, modes };
}

export interface HybridHealth {
  spotting: boolean;
  scenes: boolean;
  database: boolean;
  databaseReason?: string;
}

export async function hybridHealth(urls: ServiceUrls): Promise<HybridHealth> {
  const h = await getJson<Record<string, unknown>>(joinUrl(urls.hybrid, '/health'));
  const db = (h.database_match as Record<string, unknown> | undefined) ?? {};
  return { spotting: !!h.spotting_available, scenes: !!h.scenes_available, database: !!db.available, databaseReason: (db.reason as string) || undefined };
}

export async function libraries(urls: ServiceUrls): Promise<Library[]> {
  const r = await getJson<{ libraries?: Library[] }>(joinUrl(urls.search, '/libraries'));
  return r.libraries ?? [];
}

// ── Spotting: POST /spot ─────────────────────────────────────────────────────

export interface SpotOptions {
  fps: number;
  startTimecode: string;
  hints: string;
  categories?: string[];
  sampleFps?: number;
  jobId: string;
  signal?: AbortSignal;
}

export async function spot(urls: ServiceUrls, video: File, opts: SpotOptions, onProgress: ProgressFn): Promise<SpotEvent[]> {
  const form = new FormData();
  form.append('video', video, video.name);
  form.append('start_timecode', opts.startTimecode);
  form.append('fps', String(opts.fps));
  if (opts.hints) form.append('hints', opts.hints);
  if (opts.categories?.length) form.append('categories', opts.categories.join(','));
  if (opts.sampleFps) form.append('sample_fps', String(opts.sampleFps));
  form.append('job_id', opts.jobId);
  const stop = pollProgress(joinUrl(urls.spotting, `/spot/progress/${opts.jobId}`), onProgress);
  try {
    const body = await (await post(joinUrl(urls.spotting, '/spot'), form, opts.signal)).json();
    return body.events ?? [];
  } finally {
    await stop();
  }
}

// ── Scenes: POST /scenes (spotting) or /hybrid/scenes ────────────────────────

export async function scenes(urls: ServiceUrls, videos: File[], names: string[], opts: { jobId: string; viaHybrid?: boolean; signal?: AbortSignal }, onProgress: ProgressFn): Promise<{ scenes: Scene[]; clip_scenes: number[] }> {
  const form = new FormData();
  for (const v of videos) form.append('videos', v, v.name);
  form.append('names', JSON.stringify(names));
  form.append('job_id', opts.jobId);
  const base = opts.viaHybrid ? joinUrl(urls.hybrid, '/hybrid/scenes') : joinUrl(urls.spotting, '/scenes');
  const progressUrl = opts.viaHybrid ? joinUrl(urls.hybrid, `/hybrid/progress/${opts.jobId}`) : joinUrl(urls.spotting, `/spot/progress/${opts.jobId}`);
  const stop = pollProgress(progressUrl, onProgress);
  try {
    const body = await (await post(base, form, opts.signal)).json();
    return { scenes: body.scenes ?? [], clip_scenes: body.clip_scenes ?? [] };
  } finally {
    await stop();
  }
}

// ── Generation: POST /generate ───────────────────────────────────────────────

export async function generate(
  urls: ServiceUrls,
  video: File | null,
  opts: { prompt: string; negativePrompt: string; seed: number; duration?: number; jobId: string; signal?: AbortSignal },
  onProgress?: ProgressFn,
): Promise<AudioBuffer> {
  const form = new FormData();
  if (video) form.append('video', video, video.name);
  form.append('prompt', opts.prompt);
  form.append('negative_prompt', opts.negativePrompt);
  form.append('seed', String(opts.seed));
  if (opts.duration !== undefined) form.append('duration', opts.duration.toFixed(2));
  form.append('output_format', 'wav');
  form.append('job_id', opts.jobId);
  const stop = onProgress ? pollProgress(joinUrl(urls.generation, `/generate/progress/${opts.jobId}`), onProgress) : null;
  try {
    const res = await post(joinUrl(urls.generation, '/generate'), form, opts.signal);
    return engine.context().decodeAudioData(await res.arrayBuffer());
  } finally {
    if (stop) await stop();
  }
}

// ── Search: POST /search/sounds and /search/by_audio ─────────────────────────

export interface SearchOpts {
  video: File | null;
  text: string;
  limit: number;
  textWeight: number;
  library: string;
  signal?: AbortSignal;
}

export async function search(urls: ServiceUrls, opts: SearchOpts): Promise<SearchResult[]> {
  const form = new FormData();
  if (opts.video) form.append('video', opts.video, opts.video.name);
  if (opts.text) form.append('text', opts.text);
  form.append('limit', String(opts.limit));
  form.append('text_weight', String(opts.textWeight));
  form.append('num_frames', '16');
  if (opts.library) form.append('library', opts.library);
  const body = await (await post(joinUrl(urls.search, '/search/sounds'), form, opts.signal)).json();
  return body.results ?? [];
}

export interface AudioSearchOpts {
  audio: File;
  text: string;
  limit: number;
  textWeight: number;
  envelopeWeight?: number;
  only?: (string | number)[];
  library: string;
  signal?: AbortSignal;
}

/** Search by sound (CLAP): the results name the stretch of each recording that matches */
export async function searchByAudio(urls: ServiceUrls, opts: AudioSearchOpts): Promise<SearchResult[]> {
  const form = new FormData();
  form.append('audio', opts.audio, opts.audio.name);
  if (opts.text) form.append('text', opts.text);
  form.append('limit', String(opts.limit));
  form.append('text_weight', String(opts.textWeight));
  form.append('refine', 'true');
  if (opts.envelopeWeight !== undefined) form.append('envelope_weight', String(opts.envelopeWeight));
  if (opts.only?.length) form.append('only', opts.only.join(','));
  if (opts.library) form.append('library', opts.library);
  let res: Response;
  try {
    res = await post(joinUrl(urls.search, '/search/by_audio'), form, opts.signal);
  } catch (e) {
    if (e instanceof ServiceError && e.message.startsWith('503')) throw new ServiceError('The search service has no audio index yet (503).');
    throw e;
  }
  const body = await res.json();
  return body.results ?? [];
}

export const soundDownloadUrl = (urls: ServiceUrls, id: SearchResult['id']) => joinUrl(urls.search, `/sounds/${id}/download`);
export const soundPreviewUrl = (urls: ServiceUrls, id: SearchResult['id']) => joinUrl(urls.search, `/sounds/${id}/preview`);
/** A stretch of a recording as 48 kHz WAV with short fades */
export const soundSnippetUrl = (urls: ServiceUrls, id: SearchResult['id'], start: number, length: number) =>
  joinUrl(urls.search, `/sounds/${id}/snippet?start=${Math.max(0, start).toFixed(3)}&length=${Math.max(0.1, length).toFixed(3)}`);

// ── Hybrid: POST /hybrid ─────────────────────────────────────────────────────

export interface HybridOpts {
  fps: number;
  startTimecode: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  events?: SpotEvent[];
  categories?: string[];
  jobId: string;
  match: boolean;
  piecesPer10s: number;
  minPieceSeconds: number;
  layers: number;
  textWeight: number;
  library: string;
  minSimilarity: number;
  ambienceHandleSeconds: number;
  splitGain: number;
  signal?: AbortSignal;
}

export async function hybrid(urls: ServiceUrls, video: File, opts: HybridOpts, onProgress: ProgressFn): Promise<HybridAnswer> {
  const form = new FormData();
  form.append('video', video, video.name);
  form.append('start_timecode', opts.startTimecode);
  form.append('fps', String(opts.fps));
  if (opts.prompt) form.append('prompt', opts.prompt);
  if (opts.negativePrompt) form.append('negative_prompt', opts.negativePrompt);
  form.append('seed', String(opts.seed));
  form.append('job_id', opts.jobId);
  if (opts.events?.length) form.append('events', JSON.stringify(opts.events));
  else if (opts.categories?.length) form.append('categories', opts.categories.join(','));
  form.append('match', String(opts.match));
  if (opts.match) {
    form.append('pieces_per_10s', String(opts.piecesPer10s));
    form.append('min_piece_seconds', String(opts.minPieceSeconds));
    form.append('layers', String(opts.layers));
    form.append('text_weight', String(opts.textWeight));
    if (opts.library) form.append('library', opts.library);
    form.append('category_filter', 'false');
    form.append('min_similarity', String(opts.minSimilarity));
    form.append('ambience_handle_seconds', String(opts.ambienceHandleSeconds));
    form.append('split_gain', String(opts.splitGain));
  }
  const stop = pollProgress(joinUrl(urls.hybrid, `/hybrid/progress/${opts.jobId}`), onProgress);
  try {
    return await (await post(joinUrl(urls.hybrid, '/hybrid'), form, opts.signal)).json();
  } finally {
    await stop();
  }
}
