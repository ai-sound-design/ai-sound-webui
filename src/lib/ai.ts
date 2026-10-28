import { useStore, videoPiecesIn, workRange, type NewAudio, type VideoPiece } from '../store';
import type { AiMode, AudioClip, Marker, Range, SearchResult, SoundKind } from '../types';
import * as api from '../api/services';
import * as mock from '../api/mock';
import { videoForPiece } from './cut';
import { bounceRange } from './bounce';
import { assignLanes, type LaneItem } from './lanes';
import { formatTime, uid } from './util';

/**
 * The four workflows of the Pro Tools plugin, carried over to the web timeline.
 * The working range is the selection (else the selected clip, else all videos);
 * every video clip beneath it is handled on its own, as the plugin does.
 */

export const KINDS: { id: SoundKind; label: string }[] = [
  { id: 'ambience', label: 'Ambience' },
  { id: 'foley', label: 'Foley' },
  { id: 'sfx', label: 'SFX' },
  { id: 'music', label: 'Music' },
  { id: 'dialogue', label: 'Dialogue' },
];

/** What the plugin sends as negative prompt when the field is empty (Generation only) */
export const DEFAULT_NEGATIVE = 'voices, music, melody, singing, speech, interference';

const CATEGORY_RE = /^\s*(dialogue|dialog|foley|sfx|ambience|ambiance|atmo|music)\s*:\s*/i;
const SCENE_RE = /^Scene (\d+):\s*(.*)$/;

const st = () => useStore.getState();
const randomSeed = () => Math.floor(Math.random() * 2 ** 30);

// ── Run control ─────────────────────────────────────────────────────────────

let controller: AbortController | null = null;
let stopped = false;

/** Stops the running workflow after the current request */
export function stopRun() {
  stopped = true;
  controller?.abort();
}

export const isRunning = () => controller !== null;

function begin(): AbortSignal {
  stopped = false;
  controller = new AbortController();
  return controller.signal;
}

function end() {
  controller = null;
}

function pieceTitle(p: VideoPiece) {
  return `${p.clip.name} ${formatTime(p.start, false)}–${formatTime(p.end, false)}`;
}

async function withJob<T>(mode: AiMode, title: string, fn: (progress: api.ProgressFn) => Promise<T>): Promise<T | undefined> {
  const id = st().addJob({ mode, title });
  try {
    const r = await fn((progress, detail) => st().updateJob(id, { progress, detail }));
    st().updateJob(id, { status: 'done', progress: 1, detail: st().jobs.find((j) => j.id === id)?.detail });
    return r;
  } catch (e) {
    st().updateJob(id, { status: 'error', error: stopped ? 'stopped' : (e as Error).message });
    return undefined;
  }
}

function failJob(mode: AiMode, e: unknown) {
  const id = st().addJob({ mode, title: 'Not started' });
  st().updateJob(id, { status: 'error', error: (e as Error).message });
}

function requirePieces(range: Range | null): VideoPiece[] {
  if (!range) throw new Error('No videos in the timeline.');
  const pieces = videoPiecesIn(range);
  if (!pieces.length) throw new Error('There is no video under the selection.');
  return pieces;
}

/** The whole video track */
function entireRange(): Range | null {
  const clips = st().videoClips;
  if (!clips.length) return null;
  return { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map((c) => c.start + c.length)) };
}

const sessionStart = () => st().session?.startSeconds ?? 0;
const timecode = (t: number) => api.toTimecode(t + sessionStart(), st().settings.fps);

/** Where results go: the chosen track, else the mode's own track */
function target(defaultName: string): Pick<NewAudio, 'trackId' | 'trackName'> {
  const s = st();
  const t = s.audioTracks.find((x) => x.id === s.params.targetTrackId);
  return t ? { trackId: t.id, trackName: t.name } : { trackName: defaultName };
}

function kindsHint(kinds: SoundKind[]): string | undefined {
  if (kinds.length === 0 || kinds.length === KINDS.length) return undefined;
  return `Only these kinds of sound are needed: ${kinds.join(', ')}`;
}

/** Short clips are sampled more densely, as in the plugin (up to 8 frames per second) */
function sampleFps(len: number): number | undefined {
  const f = Math.min(8, 8 / Math.max(0.1, len));
  return f > 2 ? +f.toFixed(2) : undefined;
}

/** Cuts every piece once per run */
function cutter(signal: AbortSignal) {
  const cache = new Map<string, Promise<File>>();
  return (p: VideoPiece, progress: api.ProgressFn) => {
    const key = `${p.clip.id}|${p.srcStart.toFixed(3)}|${(p.end - p.start).toFixed(3)}`;
    if (signal.aborted) throw new api.ServiceError('stopped');
    let f = cache.get(key);
    if (!f) {
      f = videoForPiece(p, (d, fr) => progress((fr ?? 0) * 0.1, d));
      cache.set(key, f);
    }
    return f;
  };
}

// ── Markers ↔ events ────────────────────────────────────────────────────────

function eventMarker(p: VideoPiece, e: api.SpotEvent, suffix: string): Omit<Marker, 'id'> {
  const conf = e.confidence !== undefined ? ` (confidence ${e.confidence.toFixed(2)})` : '';
  return {
    start: p.start + e.start_seconds,
    end: p.start + e.end_seconds,
    label: e.label.slice(0, 31),
    category: e.category,
    description: `${e.category}: ${e.description ?? e.label}${suffix || conf}`,
  };
}

/** The memory locations inside a piece as events, as the plugin reads them (scene and clip markers left out) */
function markersAsEvents(p: VideoPiece): api.SpotEvent[] {
  const len = p.end - p.start;
  const inside = st()
    .markers.filter((m) => m.start >= p.start - 1e-3 && m.start < p.end && !SCENE_RE.test(m.label) && m.category !== 'clip' && m.category !== 'scene')
    .sort((a, b) => a.start - b.start);
  return inside.map((m, i) => {
    const text = m.description ?? '';
    const cm = text.match(CATEGORY_RE);
    const raw = cm ? cm[1].toLowerCase() : m.category ?? 'sfx';
    const category = ({ dialog: 'dialogue', ambiance: 'ambience', atmo: 'ambience' } as Record<string, string>)[raw] ?? raw;
    const description = text
      .replace(CATEGORY_RE, '')
      .replace(/\s*\((confidence [\d.]+|hybrid run|reference)\)/gi, '')
      .trim();
    const next = inside.slice(i + 1).find((n) => n.start > m.start + 1e-3);
    const endAbs = m.end ?? next?.start ?? p.end;
    return {
      label: m.label,
      description: description || m.label,
      category: KINDS.some((k) => k.id === category) ? category : 'sfx',
      start_seconds: +Math.max(0, m.start - p.start).toFixed(3),
      end_seconds: +Math.min(len, Math.max(m.start - p.start + 0.05, endAbs - p.start)).toFixed(3),
    };
  });
}

interface SceneSpan {
  index: number;
  name: string;
  description?: string;
  start: number;
  end: number;
}

/** The session's "Scene n: name" markers, if they cover every piece */
function scenesFromMarkers(pieces: VideoPiece[]): SceneSpan[] | null {
  const spans = st()
    .markers.filter((m) => SCENE_RE.test(m.label) && m.end !== undefined)
    .map((m) => {
      const [, n, name] = m.label.match(SCENE_RE)!;
      return { index: Number(n), name: name.trim() || `Scene ${n}`, description: m.description, start: m.start, end: m.end! };
    });
  if (!spans.length) return null;
  const covered = pieces.every((p) => spans.some((s) => s.start <= (p.start + p.end) / 2 && (p.start + p.end) / 2 < s.end));
  return covered ? spans : null;
}

function sceneAt(spans: SceneSpan[], p: VideoPiece): SceneSpan | undefined {
  const mid = (p.start + p.end) / 2;
  return spans.find((s) => s.start <= mid && mid < s.end);
}

/** Scenes from the backend become markers "Scene n: name" over the clips they cover */
function sceneSpans(pieces: VideoPiece[], r: { scenes: api.Scene[] }): SceneSpan[] {
  return r.scenes.map((s) => {
    const first = pieces[Math.max(0, Math.min(pieces.length - 1, s.first_clip))];
    const last = pieces[Math.max(0, Math.min(pieces.length - 1, s.last_clip))];
    return { index: s.index, name: s.name, description: s.description, start: first.start, end: last.end };
  });
}

function writeSceneMarkers(spans: SceneSpan[], range: Range) {
  const s = st();
  // Replace earlier scene markers of the range
  for (const m of s.markers) if (SCENE_RE.test(m.label) && m.start < range.end && (m.end ?? m.start) > range.start) s.removeMarker(m.id);
  st().addMarkers(
    spans.map((sc) => ({
      start: sc.start,
      end: sc.end,
      label: `Scene ${sc.index}: ${sc.name}`.slice(0, 31),
      category: 'scene',
      description: `Scene ${sc.index}: ${sc.name}.${sc.description ? ' ' + sc.description : ''}`,
    })),
  );
}

async function detectScenes(pieces: VideoPiece[], cut: ReturnType<typeof cutter>, signal: AbortSignal, viaHybrid: boolean): Promise<SceneSpan[] | undefined> {
  const { settings } = st();
  return withJob(viaHybrid ? 'hybrid' : 'spotting', `Scenes · ${pieces.length} clip${pieces.length === 1 ? '' : 's'}`, async (progress) => {
    const files: File[] = [];
    for (const [i, p] of pieces.entries()) files.push(await cut(p, (f, d) => progress(((i + (f ?? 0)) / pieces.length) * 0.2, d)));
    const names = pieces.map((p) => p.clip.name.replace(/\.[^.]+$/, ''));
    const r = settings.mock ? await mock.mockScenes(names, (f, d) => progress(0.2 + f * 0.8, d)) : await api.scenes(settings.urls, files, names, { jobId: api.jobId('scenes'), viaHybrid, signal }, (f, d) => progress(0.2 + f * 0.8, d));
    const spans = sceneSpans(pieces, r);
    writeSceneMarkers(spans, { start: pieces[0].start, end: pieces[pieces.length - 1].end });
    progress(1, `${spans.length} scene${spans.length === 1 ? '' : 's'}`);
    return spans;
  });
}

// ── Spotting ────────────────────────────────────────────────────────────────

export async function runSpotting(entire = false) {
  const { settings, params } = st();
  let pieces: VideoPiece[];
  try {
    pieces = requirePieces(entire ? entireRange() : workRange());
  } catch (e) {
    return failJob('spotting', e);
  }
  const signal = begin();
  const cut = cutter(signal);
  try {
    if (params.detectScenes) await detectScenes(pieces, cut, signal, false);
    if (params.detectEvents) {
      for (const p of pieces) {
        if (stopped) break;
        const len = p.end - p.start;
        if (len < 1) continue;
        await withJob('spotting', `Spotting · ${pieceTitle(p)}`, async (progress) => {
          const categories = params.kinds.length && params.kinds.length < KINDS.length ? params.kinds : undefined;
          const hints = [params.hints, kindsHint(params.kinds)].filter(Boolean).join('. ');
          const events = settings.mock
            ? await mock.mockSpot(p.clip.name, len, progress)
            : await api.spot(settings.urls, await cut(p, progress), { fps: settings.fps, startTimecode: timecode(p.start), hints, categories, sampleFps: sampleFps(len), jobId: api.jobId('spot'), signal }, progress);
          const kept = events.filter((e) => !params.kinds.length || params.kinds.includes(e.category as SoundKind));
          st().addMarkers(kept.map((e) => eventMarker(p, e, '')));
          progress(1, `${kept.length} event${kept.length === 1 ? '' : 's'}`);
        });
      }
    }
    if (params.clipMarkers && !stopped) {
      st().addMarkers([
        ...pieces.map((p, i) => ({
          start: p.start,
          end: p.end,
          label: p.clip.name.replace(/\.[^.]+$/, '').slice(0, 31),
          category: 'clip',
          description: `Clip ${i + 1}/${pieces.length}: ${p.clip.name}, source ${p.srcStart.toFixed(2)}–${(p.srcStart + p.end - p.start).toFixed(2)} s`,
        })),
        { start: pieces[pieces.length - 1].end, label: 'end of spotting range', category: 'clip' },
      ]);
    }
  } finally {
    end();
  }
}

// ── Generation ──────────────────────────────────────────────────────────────

/** Takes the accepted lengths from the service, as the plugin reads them from /health */
export async function refreshLimits(): Promise<void> {
  const { settings } = st();
  if (settings.mock) return;
  try {
    const l = await api.generationLimits(settings.urls);
    if (l.min !== settings.genMin || l.max !== settings.genMax) st().setSettings({ ...st().settings, genMin: l.min, genMax: l.max });
  } catch {
    /* keep the stored values */
  }
}

export async function runGeneration() {
  await refreshLimits();
  const { settings, params } = st();
  const baseSeed = params.seed < 0 ? randomSeed() : params.seed;
  const negative = params.negativePrompt.trim() || DEFAULT_NEGATIVE;
  const signal = begin();
  try {
    if (params.textOnly) {
      const sel = st().selection;
      const at = sel?.start ?? st().currentTime;
      let duration = params.t2aDuration;
      if (duration <= 0) {
        const selLen = sel && sel.end - sel.start > 0.05 ? sel.end - sel.start : 0;
        duration = selLen ? Math.max(settings.genMin, selLen) : 8;
      }
      if (duration > settings.genMax) return failJob('generation', new Error(`The range is longer than the service accepts (${settings.genMax} s).`));
      await withJob('generation', `T2A · “${params.prompt || '…'}” ${duration.toFixed(1)} s`, async (progress) => {
        if (!params.prompt.trim()) throw new Error('Text-to-audio needs a prompt.');
        const buffer = settings.mock
          ? await mock.mockGenerate(params.prompt, baseSeed, duration, progress)
          : await estimate(progress, api.generate(settings.urls, null, { prompt: params.prompt, negativePrompt: negative, seed: baseSeed, duration, jobId: api.jobId('gen'), signal }, progress));
        st().addAudio([{ ...target('Generation'), name: `${params.prompt.slice(0, 30)} AI`, buffer, start: at }]);
        progress(1, `${buffer.duration.toFixed(1)} s · seed ${baseSeed}`);
      });
      return;
    }

    let pieces: VideoPiece[];
    try {
      pieces = requirePieces(workRange());
    } catch (e) {
      return failJob('generation', e);
    }
    const cut = cutter(signal);
    // Pieces longer than the service accepts are split into equal parts; shorter ones are
    // extended to the minimum from within the clip and the result is trimmed afterwards.
    let n = 0;
    for (const p of pieces) {
      if (stopped) break;
      const len = p.end - p.start;
      if (len < 1) continue;
      const parts = Math.max(1, Math.ceil(len / settings.genMax));
      for (let i = 0; i < parts; i++) {
        if (stopped) break;
        const wantStart = p.start + (len * i) / parts;
        const wantLen = len / parts;
        const genLen = Math.max(settings.genMin, wantLen);
        if (genLen > p.clip.length + 1e-3) {
          failJob('generation', new Error(`${p.clip.name}: clip shorter than ${settings.genMin} s, skipped.`));
          continue;
        }
        const clipEnd = p.clip.start + p.clip.length;
        const cutStart = Math.max(p.clip.start, Math.min(wantStart, clipEnd - genLen));
        const piece: VideoPiece = { clip: p.clip, start: cutStart, end: cutStart + genLen, srcStart: p.clip.offset + (cutStart - p.clip.start) };
        const seed = baseSeed + n++;
        await withJob('generation', `Generation · ${pieceTitle(piece)}`, async (progress) => {
          const buffer = settings.mock
            ? await mock.mockGenerate(params.prompt, seed, genLen, progress)
            : await estimate(
                progress,
                cut(piece, progress).then((file) => api.generate(settings.urls, file, { prompt: params.prompt, negativePrompt: negative, seed, jobId: api.jobId('gen'), signal }, (f, d) => progress(0.2 + f * 0.75, d))),
              );
          const name = `${p.clip.name.replace(/\.[^.]+$/, '')} AI`;
          const skip = wantStart - cutStart;
          st().addAudio([{ ...target('Generation'), name, buffer, start: wantStart, offset: skip, length: Math.min(wantLen, buffer.duration - skip), linkedVideoId: p.clip.id }]);
          progress(1, `${wantLen.toFixed(1)} s · seed ${seed}`);
        });
      }
    }
  } finally {
    end();
  }
}

/** Generation may report no progress: show an estimate until the answer arrives */
async function estimate<T>(progress: api.ProgressFn, work: Promise<T>): Promise<T> {
  const t0 = performance.now();
  let reported = false;
  const wrapped = work;
  const timer = setInterval(() => {
    if (reported) return;
    const s = (performance.now() - t0) / 1000;
    progress(0.2 + 0.75 * (1 - Math.exp(-s / 40)), `waiting for the service … ${Math.round(s)} s`);
  }, 500);
  try {
    return await wrapped;
  } finally {
    reported = true;
    clearInterval(timer);
  }
}

// ── Recommendation (from the DB) ────────────────────────────────────────────

export async function runSearch() {
  const { settings, params } = st();
  const signal = begin();
  try {
    await withJob('search', `Recommendation · ${params.searchSource === 'video' ? 'from video' : params.searchSource === 'sound' ? 'from sound' : 'from sketch'}${params.prompt ? ` · “${params.prompt}”` : ''}`, async (progress) => {
      let results: SearchResult[];
      if (params.searchSource === 'video') {
        const range = workRange();
        const piece = range ? videoPiecesIn(range)[0] : undefined;
        if (!piece && !params.prompt.trim()) throw new Error('Select a video range or enter a search text.');
        const textWeight = piece && params.prompt ? params.textWeight : piece ? 0 : 1;
        results = settings.mock
          ? await mock.mockSearch(params.prompt, !!piece, params.searchLimit)
          : await api.search(settings.urls, { video: piece ? await cutter(signal)(piece, progress) : null, text: params.prompt, limit: params.searchLimit, textWeight, library: params.library, signal });
      } else {
        const s = st();
        const sel = s.selection && s.selection.end - s.selection.start > 0.05 ? s.selection : null;
        const clip = s.selectedClip?.kind === 'audio' ? s.audioClips.find((c) => c.id === s.selectedClip!.id) : undefined;
        const range = sel ?? (clip ? { start: clip.start, end: clip.start + clip.length } : null);
        if (!range) throw new Error('Select a range or an audio clip to search with its sound.');
        if (params.searchSource === 'sketch' && !params.prompt.trim()) throw new Error('A sketch search needs a search text saying what the sound is.');
        progress(0.05, 'bouncing the selection …');
        const audio = await bounceRange(range, clip && !sel ? [clip.trackId] : undefined);
        progress(0.2, 'searching …');
        if (settings.mock) {
          results = await mock.mockSearchByAudio(params.prompt, params.searchLimit, range.end - range.start);
        } else if (params.searchSource === 'sketch') {
          const words = await api.search(settings.urls, { video: null, text: params.prompt, limit: Math.max(2 * params.searchLimit, 8), textWeight: 1, library: params.library, signal });
          results = await api.searchByAudio(settings.urls, { audio, text: params.prompt, limit: params.searchLimit, textWeight: 1, envelopeWeight: 0.9, only: words.map((w) => w.id), library: params.library, signal });
        } else {
          results = await api.searchByAudio(settings.urls, { audio, text: params.prompt, limit: params.searchLimit, textWeight: params.prompt ? 0.5 : 0, library: params.library, signal });
        }
      }
      st().setSearchResults(results);
      progress(1, `${results.length} result${results.length === 1 ? '' : 's'}`);
    });
  } finally {
    end();
  }
}

/** Preview: the matched stretch of a recording (at most 15 s), else the whole file */
export async function loadPreview(r: SearchResult): Promise<AudioBuffer> {
  if (r.buffer) return r.buffer;
  const urls = st().settings.urls;
  if (r.offset_seconds !== undefined) return api.fetchAudio(api.soundSnippetUrl(urls, r.id, r.offset_seconds, Math.min(15, r.length_seconds ?? 15)));
  return api.fetchAudio(api.soundPreviewUrl(urls, r.id));
}

/** Places a recommendation as the plugin imports it: cut to the selection with handles and fades, or whole */
export async function importSearchResult(r: SearchResult) {
  const { settings, params } = st();
  await withJob('search', `Import · ${r.description}`, async (progress) => {
    const s = st();
    const sel = s.selection && s.selection.end - s.selection.start > 0.05 ? s.selection : null;
    const at = sel?.start ?? s.currentTime;
    const matched = r.offset_seconds !== undefined;
    const item: NewAudio = { ...target('DB'), name: r.description.slice(0, 40), start: at };

    if (params.cutToSelection && sel) {
      const want = sel.end - sel.start;
      const handle = params.keepHandles ? settings.ambienceHandle : 0;
      let before = 0;
      let buffer: AudioBuffer;
      if (r.buffer) {
        buffer = r.buffer;
      } else if (matched) {
        before = Math.min(handle, r.offset_seconds!);
        const length = (r.length_seconds ?? want) + before + handle;
        progress(0.3, 'fetching the stretch …');
        buffer = await api.fetchAudio(api.soundSnippetUrl(settings.urls, r.id, r.offset_seconds! - before, length));
      } else {
        progress(0.3, 'fetching …');
        buffer = await api.fetchAudio(api.soundDownloadUrl(settings.urls, r.id));
      }
      item.buffer = buffer;
      item.offset = before;
      item.length = Math.min(want, buffer.duration - before);
      if (params.autoFade && settings.fadeSeconds > 0) applyFades(item, buffer.duration, settings.fadeSeconds, settings.fadeInside);
    } else {
      progress(0.3, 'fetching …');
      item.buffer = r.buffer ?? (await api.fetchAudio(api.soundDownloadUrl(settings.urls, r.id)));
    }
    st().addAudio([item]);
  });
}

/** Fades of `fade` seconds: outside the event over the handles (the clip grows into them), or inside it */
function applyFades(item: NewAudio, sourceDuration: number, fade: number, inside: boolean) {
  const offset = item.offset ?? 0;
  const length = item.length ?? sourceDuration - offset;
  if (!inside) {
    const before = Math.min(fade, offset);
    const after = Math.min(fade, Math.max(0, sourceDuration - offset - length));
    item.start -= before;
    item.offset = offset - before;
    item.length = length + before + after;
    item.fadeIn = before;
    item.fadeOut = after;
  } else {
    const f = Math.min(fade, length / 2);
    item.fadeIn = f;
    item.fadeOut = f;
  }
}

// ── Hybrid ──────────────────────────────────────────────────────────────────

const HYBRID_TRACK_RE = /\((gen|db)\)$/;

/** Clears the pieces' ranges on every track of an earlier hybrid run */
function clearEarlier(pieces: VideoPiece[]) {
  const s = st();
  const tracks = new Set(s.audioTracks.filter((t) => HYBRID_TRACK_RE.test(t.name)).map((t) => t.id));
  if (!tracks.size) return;
  let clips: AudioClip[] = s.audioClips;
  let changed = false;
  for (const p of pieces) {
    const next: AudioClip[] = [];
    for (const c of clips) {
      const cEnd = c.start + c.length;
      if (!tracks.has(c.trackId) || cEnd <= p.start + 1e-3 || c.start >= p.end - 1e-3) {
        next.push(c);
        continue;
      }
      changed = true;
      if (c.start < p.start - 1e-3) next.push({ ...c, length: p.start - c.start, fadeOut: 0 });
      if (cEnd > p.end + 1e-3) next.push({ ...c, id: uid('aclip'), start: p.end, offset: c.offset + (p.end - c.start), length: cEnd - p.end, fadeIn: 0 });
    }
    clips = next;
  }
  if (changed) {
    s.checkpoint();
    useStore.setState({ audioClips: clips });
  }
}

interface Placement {
  item: NewAudio;
}

export async function runHybrid(entire = false) {
  const { settings, params } = st();
  let pieces: VideoPiece[];
  try {
    pieces = requirePieces(entire ? entireRange() : workRange());
  } catch (e) {
    return failJob('hybrid', e);
  }
  const signal = begin();
  const cut = cutter(signal);
  const baseSeed = params.seed < 0 ? randomSeed() : params.seed;
  try {
    // Scenes: the session's markers, else detected by the backend and written as markers
    let spans = scenesFromMarkers(pieces);
    if (!spans) spans = (await detectScenes(pieces, cut, signal, true)) ?? [];
    if (stopped) return;
    if (params.replaceEarlier) clearEarlier(pieces);

    for (const [n, p] of pieces.entries()) {
      if (stopped) break;
      const events = params.hybridEvents !== 'spot' ? markersAsEvents(p) : [];
      if (!events.length && params.hybridEvents === 'markers-only') {
        const id = st().addJob({ mode: 'hybrid', title: `Hybrid · ${pieceTitle(p)}` });
        st().updateJob(id, { status: 'done', progress: 1, detail: 'skipped: no memory locations in the clip' });
        continue;
      }
      await withJob('hybrid', `Hybrid · ${pieceTitle(p)}`, async (progress) => {
        const len = p.end - p.start;
        let answer: api.HybridAnswer;
        let load: (url: string) => Promise<AudioBuffer>;
        if (settings.mock) {
          const r = await mock.mockHybrid(p.clip.name, len, events.length ? events : undefined, progress);
          answer = r.answer;
          load = async (u) => r.buffers.get(u)!;
        } else {
          const file = await cut(p, progress);
          answer = await api.hybrid(
            settings.urls,
            file,
            {
              fps: settings.fps,
              startTimecode: timecode(p.start),
              prompt: params.prompt,
              negativePrompt: params.negativePrompt,
              seed: baseSeed + n * 100,
              events: events.length ? events : undefined,
              categories: !events.length && params.kinds.length && params.kinds.length < KINDS.length ? params.kinds : undefined,
              jobId: api.jobId('hybrid'),
              match: params.useDatabase,
              piecesPer10s: settings.piecesPer10s,
              minPieceSeconds: settings.minPieceSeconds,
              layers: settings.layers,
              textWeight: settings.textWeight,
              library: params.library,
              minSimilarity: settings.minSimilarity,
              ambienceHandleSeconds: params.hybridHandles ? settings.ambienceHandle : 0,
              splitGain: settings.splitGain,
              signal,
            },
            (f, d) => progress(0.1 + f * 0.8, d),
          );
          load = (u) => api.fetchAudio(api.joinUrl(settings.urls.hybrid, u), signal);
        }

        const sounds = answer.sounds ?? [];
        if (answer.events_source === 'spotting') st().addMarkers(sounds.map((s) => eventMarker(p, s, ' (hybrid run)')));
        progress(0.92, `loading ${sounds.length} sound${sounds.length === 1 ? '' : 's'}`);

        const scene = sceneAt(spans ?? [], p);
        const sceneName = scene?.name ?? 'Hybrid';
        const items: LaneItem<Placement>[] = [];
        let fallbacks = 0;
        const matchErrors = new Set<string>();
        for (const s of sounds) {
          const start = p.start + s.start_seconds;
          const matches = params.useDatabase ? (s.match?.pieces ?? []) : [];
          if (s.match?.error) matchErrors.add(s.match.error);
          const keepGen = !params.useDatabase || !matches.length || params.keepGenerated;
          if (!matches.length && params.useDatabase) fallbacks++;
          if (keepGen) {
            const gen = await load(s.audio_url);
            items.push({
              kind: 'gen',
              label: s.label,
              category: s.category,
              start,
              end: start + gen.duration,
              priority: 0,
              similarity: 1,
              payload: { item: { trackName: '', name: s.label.slice(0, 31), buffer: gen, start, linkedVideoId: p.clip.id } },
            });
          }
          for (const m of matches) {
            const buffer = await load(m.audio_url);
            const before = m.handle_before_seconds ?? 0;
            const item: NewAudio = {
              trackName: '',
              name: (m.description || m.external_id || 'library sound').slice(0, 31),
              buffer,
              start: start + m.start_seconds,
              offset: before,
              length: Math.min(m.length_seconds, Math.max(0.05, buffer.duration - before)),
              linkedVideoId: p.clip.id,
            };
            if (params.hybridAutoFade && settings.fadeSeconds > 0) applyFades(item, buffer.duration, settings.fadeSeconds, settings.fadeInside);
            items.push({
              kind: 'db',
              label: s.label,
              category: m.category ?? s.category,
              start: item.start,
              end: item.start + (item.length ?? buffer.duration),
              priority: m.layer > 1 ? m.layer : 0,
              similarity: m.similarity ?? 0,
              payload: { item },
            });
          }
        }

        // Tracks per scene, named after the scene
        const lanes = assignLanes(items, settings.tracksPerScene);
        const placed: NewAudio[] = [];
        for (const lane of lanes) {
          const trackName = `${sceneName.slice(0, 20)} ${lane.index} (${lane.kind})`;
          for (const li of lane.items) placed.push({ ...li.payload.item, trackName, trackMuted: lane.kind === 'gen' && params.useDatabase });
        }
        st().addAudio(placed);
        const notes = [
          `${sounds.length} event${sounds.length === 1 ? '' : 's'}`,
          `scene “${sceneName}”`,
          fallbacks && `${fallbacks} without DB match (AI sound kept)`,
          items.length - placed.length > 0 && `${items.length - placed.length} layer(s) dropped (track budget)`,
          ...matchErrors,
        ].filter(Boolean);
        progress(1, notes.join(' · '));
      });
    }
  } finally {
    end();
  }
}

export const runners: Record<AiMode, (entire?: boolean) => Promise<void>> = {
  spotting: runSpotting,
  generation: () => runGeneration(),
  search: () => runSearch(),
  hybrid: runHybrid,
};
