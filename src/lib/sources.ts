import type { AudioClip, AudioSource } from '../types';
import { serverApi, serverUrl } from '../api/server';
import { computePeaks } from './audio';
import { engine } from './engine';
import { uid } from './util';

/**
 * Decoded audio and waveform peaks, kept outside the store.
 *
 * In-memory sources (generated, imported, dropped sounds) hold their whole
 * buffer and are never evicted. Session sources are files served by the web UI
 * server; playback fetches the piece a clip uses (offset + length, the clip's
 * channels) and keeps a bounded cache of such pieces around the playhead.
 * Peaks of session files come from the server once per file.
 */

export interface LoadedBuffer {
  buffer: AudioBuffer;
  /** Position of the buffer's first sample within the source (s) */
  offset: number;
}

interface Entry extends LoadedBuffer {
  key: string;
  bytes: number;
  last: number;
  pinned: boolean;
}

const BUDGET_BYTES = 1.2e9;
const PEAKS_PER_SECOND = 200;

const buffers = new Map<string, Entry>();
const pending = new Map<string, Promise<LoadedBuffer>>();
const peaks = new Map<string, Float32Array>();
const peaksPending = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** Called whenever a buffer or peaks arrive */
export function onSourcesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const bytesOf = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

/** Keeps a decoded sound in memory and returns the source describing it */
export function registerBuffer(buffer: AudioBuffer, id = uid('src')): AudioSource {
  const source: AudioSource = { id, duration: buffer.duration, channels: buffer.numberOfChannels };
  buffers.set(id, { key: id, buffer, offset: 0, bytes: bytesOf(buffer), last: performance.now(), pinned: true });
  peaks.set(id, computePeaks(buffer, PEAKS_PER_SECOND));
  return source;
}

/** The whole buffer of an in-memory source (generated/imported sounds), if there is one */
export function wholeBuffer(source: AudioSource): AudioBuffer | undefined {
  const e = buffers.get(source.id);
  return e && e.pinned ? e.buffer : undefined;
}

function sliceKey(clip: AudioClip): string {
  const s = clip.source;
  if (!s.url) return s.id;
  // Fetch a little more than the clip so small trims need no new request
  const from = Math.max(0, Math.floor(clip.offset - 2));
  const to = Math.min(s.duration, Math.ceil(clip.offset + clip.length + 2));
  return `${s.id}|${from}|${to}`;
}

/** The decoded audio of a clip, if it is loaded */
export function bufferOf(clip: AudioClip): LoadedBuffer | undefined {
  const e = buffers.get(sliceKey(clip));
  if (!e) return undefined;
  e.last = performance.now();
  return e;
}

/** Loads (and caches) the audio a clip needs */
export function loadBuffer(clip: AudioClip): Promise<LoadedBuffer> {
  const have = bufferOf(clip);
  if (have) return Promise.resolve(have);
  const key = sliceKey(clip);
  const running = pending.get(key);
  if (running) return running;
  const s = clip.source;
  if (!s.url) return Promise.reject(new Error(`${clip.name}: audio is not in memory any more`));
  const [, fromStr, toStr] = key.split('|');
  const from = Number(fromStr);
  const to = Number(toStr);
  const q = new URLSearchParams({ offset: from.toFixed(3), length: Math.max(0.01, to - from).toFixed(3) });
  if (s.channelMap?.length) q.set('channels', s.channelMap.join(','));
  const p = (async () => {
    const res = await fetch(serverUrl(`${s.url}/slice?${q}`));
    if (!res.ok) throw new Error(`${clip.name}: audio ${res.status}`);
    const buffer = await engine.context().decodeAudioData(await res.arrayBuffer());
    const entry: Entry = { key, buffer, offset: from, bytes: bytesOf(buffer), last: performance.now(), pinned: false };
    buffers.set(key, entry);
    evict();
    notify();
    return entry;
  })();
  pending.set(key, p);
  p.finally(() => pending.delete(key));
  return p;
}

/** Drops the least recently used session pieces once the budget is exceeded */
function evict() {
  let total = 0;
  for (const e of buffers.values()) total += e.bytes;
  if (total <= BUDGET_BYTES) return;
  const candidates = [...buffers.values()].filter((e) => !e.pinned).sort((a, b) => a.last - b.last);
  for (const e of candidates) {
    if (total <= BUDGET_BYTES * 0.8) break;
    buffers.delete(e.key);
    total -= e.bytes;
  }
}

/** Starts loading every clip that plays within [from, to]; nearest first */
export function ensureWindow(clips: AudioClip[], from: number, to: number) {
  const todo = clips
    .filter((c) => c.start < to && c.start + c.length > from && !bufferOf(c))
    .sort((a, b) => Math.abs(a.start - from) - Math.abs(b.start - from));
  for (const c of todo) loadBuffer(c).catch(() => {});
}

/** Waveform peaks (200/s over the whole source), loading them from the server if needed */
export function peaksOf(source: AudioSource): Float32Array | undefined {
  const p = peaks.get(source.id);
  if (p) return p;
  if (source.peaksUrl && !peaksPending.has(source.id)) {
    peaksPending.add(source.id);
    serverApi
      .peaks(source.peaksUrl)
      .then((r) => {
        peaks.set(source.id, r.peaks);
        notify();
      })
      .catch(() => {})
      .finally(() => peaksPending.delete(source.id));
  }
  return undefined;
}

export function setPeaks(sourceId: string, p: Float32Array) {
  peaks.set(sourceId, p);
  notify();
}

/** Peak level of the part of the source a clip uses, from the peaks (0..1) */
export function clipPeak(clip: AudioClip): number {
  const p = peaksOf(clip.source);
  if (!p) return 0;
  const a = Math.max(0, Math.floor(clip.offset * PEAKS_PER_SECOND));
  const b = Math.min(p.length, Math.ceil((clip.offset + clip.length) * PEAKS_PER_SECOND));
  let max = 0;
  for (let i = a; i < b; i++) if (p[i] > max) max = p[i];
  return max;
}

/** For saving: sources that have to be written into a project file */
export function isInMemory(source: AudioSource): boolean {
  return !source.url && buffers.has(source.id);
}

export function forget(sourceId: string) {
  buffers.delete(sourceId);
  peaks.delete(sourceId);
}
