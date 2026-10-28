import { create } from 'zustand';
import type { AiParams, AudioClip, AudioSource, AudioTrack, ClipRef, Job, Marker, Range, SearchResult, SessionInfo, Settings, Tool, VideoClip } from './types';
import { registerBuffer } from './lib/sources';
import { uid } from './lib/util';

const TRACK_COLORS = ['#4fb3ff', '#ffb547', '#7ee081', '#ff6f91', '#b18cff', '#4de0d0', '#ff8a4c', '#e3e36a'];
const SETTINGS_KEY = 'ai-sound-webui.settings.v3';
const PARAMS_KEY = 'ai-sound-webui.params.v4';
const UI_KEY = 'ai-sound-webui.ui.v1';

// The /svc/* paths are forwarded to the ai-services by the Vite server (vite.config.ts),
// because spotting-api and hybrid-api send no CORS headers.
export const defaultSettings: Settings = {
  mock: false,
  urls: {
    generation: '/svc/generation',
    search: '/svc/search',
    spotting: '/svc/spotting',
    hybrid: '/svc/hybrid',
  },
  genMin: 4,
  genMax: 600,
  fps: 25,
  // The plugin's shipped hybrid profile
  piecesPer10s: 0,
  minPieceSeconds: 1,
  layers: 1,
  minSimilarity: 0.5,
  textWeight: 0.5,
  splitGain: 0,
  ambienceHandle: 10,
  tracksPerScene: 8,
  fadeSeconds: 1,
  fadeInside: false,
};

const defaultParams: AiParams = {
  mode: 'generation',
  prompt: '',
  negativePrompt: '',
  seed: -1,
  targetTrackId: '',
  textOnly: false,
  t2aDuration: 0,
  searchSource: 'video',
  searchLimit: 10,
  textWeight: 0.65,
  library: '',
  cutToSelection: true,
  keepHandles: true,
  autoFade: true,
  detectScenes: true,
  detectEvents: true,
  kinds: ['ambience', 'foley', 'sfx'],
  clipMarkers: false,
  hints: '',
  hybridEvents: 'markers-rest',
  replaceEarlier: true,
  useDatabase: false,
  keepGenerated: false,
  hybridHandles: true,
  hybridAutoFade: true,
};

interface UiPrefs {
  sidebar: boolean;
  sections: Record<string, boolean>;
}
const defaultUi: UiPrefs = { sidebar: true, sections: { edit: true, clip: true, ai: true, jobs: true } };

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const out = { ...fallback, ...parsed };
      if ('urls' in fallback) out.urls = { ...(fallback.urls as object), ...parsed.urls };
      return out;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** The browser mock is a developer switch: ?mock=1 in the URL, never remembered */
const MOCK_FROM_URL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1';

function loadSettings(): Settings {
  return { ...load(SETTINGS_KEY, defaultSettings), mock: MOCK_FROM_URL };
}

export interface Snapshot {
  videoClips: VideoClip[];
  audioTracks: AudioTrack[];
  audioClips: AudioClip[];
  markers: Marker[];
}

export interface NewAudio {
  trackName: string;
  name: string;
  /** A decoded sound (kept in memory) or a source that is already registered */
  buffer?: AudioBuffer;
  source?: AudioSource;
  start: number;
  /** In-point and length within the source; default: the whole source */
  offset?: number;
  length?: number;
  linkedVideoId?: string;
  fadeIn?: number;
  fadeOut?: number;
  gain?: number;
  /** If the track has to be created, it starts muted */
  trackMuted?: boolean;
  /** Existing track to use instead of looking one up by name */
  trackId?: string;
}

interface State extends Snapshot {
  selection: Range | null;
  selectedClip: ClipRef | null;
  tool: Tool;
  pxPerSec: number;
  currentTime: number;
  playing: boolean;
  loop: boolean;
  videoAudio: boolean;
  settings: Settings;
  params: AiParams;
  ui: UiPrefs;
  jobs: Job[];
  searchResults: SearchResult[];
  past: Snapshot[];
  future: Snapshot[];
  /** Unsaved changes since the last save/open */
  dirty: boolean;
  projectName: string;
  /** The Pro Tools session this project was opened from, if any */
  session: SessionInfo | null;

  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  /** Replaces the whole project (New / Open) */
  replaceProject: (p: Snapshot & { name: string; pxPerSec?: number; session?: SessionInfo | null }) => void;
  markSaved: (name: string) => void;

  addVideoClips: (clips: VideoClip[]) => void;
  setVideoClip: (id: string, patch: Partial<VideoClip>) => void;
  moveVideoClip: (id: string, start: number) => void;
  setAudioClip: (id: string, patch: Partial<AudioClip>) => void;
  addAudio: (items: NewAudio[]) => void;
  deleteClip: (ref: ClipRef) => void;
  /** Split one clip (blade tool) or, without a ref, the selected clip / all clips under `t` */
  splitAt: (t: number, ref?: ClipRef) => void;

  addTrack: (name?: string) => string;
  updateTrack: (id: string, patch: Partial<AudioTrack>) => void;
  removeTrack: (id: string) => void;

  addMarkers: (m: Omit<Marker, 'id'>[]) => void;
  updateMarker: (id: string, patch: Partial<Marker>) => void;
  removeMarker: (id: string) => void;

  setSelection: (r: Range | null) => void;
  selectClip: (ref: ClipRef | null) => void;
  setTool: (tool: Tool) => void;
  setZoom: (pxPerSec: number) => void;
  setLoop: (on: boolean) => void;
  setVideoAudio: (on: boolean) => void;
  setSettings: (s: Settings) => void;
  setParams: (p: Partial<AiParams>) => void;
  setUi: (p: Partial<UiPrefs>) => void;
  toggleSection: (id: string) => void;

  addJob: (job: Omit<Job, 'id' | 'startedAt' | 'status' | 'progress'>) => string;
  updateJob: (id: string, patch: Partial<Job>) => void;
  clearJobs: () => void;
  setSearchResults: (r: SearchResult[]) => void;
}

function newTrack(tracks: AudioTrack[], name: string): AudioTrack {
  return {
    id: uid('track'),
    name,
    color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
    volume: 0.8,
    muted: false,
    solo: false,
  };
}

const snapshot = (s: Snapshot): Snapshot => ({ videoClips: s.videoClips, audioTracks: s.audioTracks, audioClips: s.audioClips, markers: s.markers });

export const useStore = create<State>((set, get) => ({
  videoClips: [],
  audioTracks: [],
  audioClips: [],
  markers: [],
  selection: null,
  selectedClip: null,
  tool: 'smart',
  pxPerSec: 40,
  currentTime: 0,
  playing: false,
  loop: false,
  videoAudio: false,
  settings: loadSettings(),
  params: load(PARAMS_KEY, defaultParams),
  ui: load(UI_KEY, defaultUi),
  jobs: [],
  searchResults: [],
  past: [],
  future: [],
  dirty: false,
  projectName: 'Untitled',
  session: null,

  checkpoint: () => set((s) => ({ past: [...s.past.slice(-99), snapshot(s)], future: [], dirty: true })),
  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return { ...prev, past: s.past.slice(0, -1), future: [...s.future, snapshot(s)], selectedClip: null, dirty: true };
    }),
  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return {};
      return { ...next, future: s.future.slice(0, -1), past: [...s.past, snapshot(s)], selectedClip: null, dirty: true };
    }),
  replaceProject: (p) => {
    const keep = new Set(p.videoClips.map((c) => c.url));
    for (const c of get().videoClips) if (!keep.has(c.url)) URL.revokeObjectURL(c.url);
    set({
      ...snapshot(p),
      projectName: p.name,
      session: p.session ?? null,
      pxPerSec: p.pxPerSec ?? get().pxPerSec,
      past: [],
      future: [],
      dirty: false,
      selection: null,
      selectedClip: null,
      currentTime: 0,
      searchResults: [],
    });
  },
  markSaved: (projectName) => set({ dirty: false, projectName }),

  addVideoClips: (clips) => {
    get().checkpoint();
    set((s) => ({ videoClips: [...s.videoClips, ...clips] }));
  },
  setVideoClip: (id, patch) => set((s) => ({ videoClips: s.videoClips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  moveVideoClip: (id, start) =>
    set((s) => {
      const clip = s.videoClips.find((c) => c.id === id);
      if (!clip) return {};
      const delta = start - clip.start;
      return {
        videoClips: s.videoClips.map((c) => (c.id === id ? { ...c, start } : c)),
        audioClips: s.audioClips.map((a) => (a.linkedVideoId === id ? { ...a, start: Math.max(0, a.start + delta) } : a)),
      };
    }),
  setAudioClip: (id, patch) =>
    set((s) => ({
      audioClips: s.audioClips.map((c) => {
        if (c.id !== id) return c;
        const n = { ...c, ...patch };
        // Fades never exceed the clip
        n.fadeIn = Math.max(0, Math.min(n.fadeIn, n.length));
        n.fadeOut = Math.max(0, Math.min(n.fadeOut, n.length - n.fadeIn));
        return n;
      }),
    })),

  addAudio: (items) => {
    if (!items.length) return;
    get().checkpoint();
    set((s) => {
      const tracks = [...s.audioTracks];
      const clips = [...s.audioClips];
      for (const it of items) {
        let track = (it.trackId && tracks.find((t) => t.id === it.trackId)) || tracks.find((t) => t.name === it.trackName);
        if (!track) {
          track = { ...newTrack(tracks, it.trackName), muted: !!it.trackMuted };
          tracks.push(track);
        }
        const source = it.source ?? (it.buffer ? registerBuffer(it.buffer) : undefined);
        if (!source) continue;
        const offset = it.offset ?? 0;
        clips.push({
          id: uid('aclip'),
          trackId: track.id,
          name: it.name,
          source,
          start: it.start,
          offset,
          length: it.length ?? Math.max(0.01, source.duration - offset),
          gain: it.gain ?? 0,
          fadeIn: it.fadeIn ?? 0,
          fadeOut: it.fadeOut ?? 0,
          linkedVideoId: it.linkedVideoId,
        });
      }
      return { audioTracks: tracks, audioClips: clips };
    });
  },

  deleteClip: (ref) => {
    get().checkpoint();
    set((s) => ({
      videoClips: ref.kind === 'video' ? s.videoClips.filter((c) => c.id !== ref.id) : s.videoClips,
      audioClips:
        ref.kind === 'audio'
          ? s.audioClips.filter((c) => c.id !== ref.id)
          : s.audioClips.map((a) => (a.linkedVideoId === ref.id ? { ...a, linkedVideoId: undefined } : a)),
      selectedClip: null,
    }));
  },

  splitAt: (t, ref) => {
    const s = get();
    const inside = (c: { start: number; length: number }) => t > c.start + 0.01 && t < c.start + c.length - 0.01;
    const target = ref ?? s.selectedClip;
    let vids = s.videoClips.filter(inside);
    let auds = s.audioClips.filter(inside);
    // A given or selected clip under `t` is split on its own, otherwise everything under `t`
    if (target && (target.kind === 'video' ? vids : auds).some((c) => c.id === target.id)) {
      vids = vids.filter((c) => target.kind === 'video' && c.id === target.id);
      auds = auds.filter((c) => target.kind === 'audio' && c.id === target.id);
    } else if (ref) return;
    if (!vids.length && !auds.length) return;
    s.checkpoint();
    const cut = <T extends { id: string; start: number; offset: number; length: number; fadeIn?: number; fadeOut?: number }>(list: T[], hit: T[], prefix: string) =>
      list.flatMap((c) => {
        if (!hit.includes(c)) return [c];
        const d = t - c.start;
        const left = { ...c, length: d };
        const right = { ...c, id: uid(prefix), start: t, offset: c.offset + d, length: c.length - d };
        if ('fadeIn' in c) {
          Object.assign(left, { fadeIn: Math.min(c.fadeIn ?? 0, d), fadeOut: 0 });
          Object.assign(right, { fadeIn: 0, fadeOut: Math.min(c.fadeOut ?? 0, c.length - d) });
        }
        return [left, right];
      });
    set({ videoClips: cut(s.videoClips, vids, 'clip'), audioClips: cut(s.audioClips, auds, 'aclip') });
  },

  addTrack: (name) => {
    get().checkpoint();
    const s = get();
    const t = newTrack(s.audioTracks, name ?? `Audio ${s.audioTracks.length + 1}`);
    set({ audioTracks: [...s.audioTracks, t] });
    return t.id;
  },
  updateTrack: (id, patch) => set((s) => ({ audioTracks: s.audioTracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  removeTrack: (id) => {
    get().checkpoint();
    set((s) => ({ audioTracks: s.audioTracks.filter((t) => t.id !== id), audioClips: s.audioClips.filter((a) => a.trackId !== id) }));
  },

  addMarkers: (m) => {
    if (!m.length) return;
    get().checkpoint();
    set((s) => ({ markers: [...s.markers, ...m.map((x) => ({ ...x, id: uid('mk') }))].sort((a, b) => a.start - b.start) }));
  },
  updateMarker: (id, patch) => set((s) => ({ markers: s.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  removeMarker: (id) => {
    get().checkpoint();
    set((s) => ({ markers: s.markers.filter((m) => m.id !== id) }));
  },

  setSelection: (selection) => set({ selection }),
  selectClip: (selectedClip) => set({ selectedClip }),
  setTool: (tool) => set({ tool }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(400, Math.max(4, pxPerSec)) }),
  setLoop: (loop) => set({ loop }),
  setVideoAudio: (videoAudio) => set({ videoAudio }),
  setSettings: (settings) => {
    save(SETTINGS_KEY, { ...settings, mock: false });
    set({ settings: { ...settings, mock: MOCK_FROM_URL } });
  },
  setParams: (p) => {
    const params = { ...get().params, ...p };
    save(PARAMS_KEY, params);
    set({ params });
  },
  setUi: (p) => {
    const ui = { ...get().ui, ...p };
    save(UI_KEY, ui);
    set({ ui });
  },
  toggleSection: (id) => {
    const ui = get().ui;
    get().setUi({ sections: { ...ui.sections, [id]: !(ui.sections[id] ?? true) } });
  },

  addJob: (job) => {
    const id = uid('job');
    set((s) => ({ jobs: [{ ...job, id, status: 'running' as const, progress: 0, startedAt: Date.now() }, ...s.jobs].slice(0, 30) }));
    return id;
  },
  updateJob: (id, patch) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
  clearJobs: () => set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running') })),
  setSearchResults: (searchResults) => set({ searchResults }),
}));

export function projectEnd(s: Pick<State, 'videoClips' | 'audioClips'> = useStore.getState()): number {
  let end = 0;
  for (const c of s.videoClips) end = Math.max(end, c.start + c.length);
  for (const c of s.audioClips) end = Math.max(end, c.start + c.length);
  return end;
}

/** On overlap the clip added last (drawn on top) wins */
export function activeClipAt(clips: VideoClip[], t: number): VideoClip | undefined {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (t >= c.start && t < c.start + c.length) return c;
  }
  return undefined;
}

/** Position closest to `desired` where a clip of `length` overlaps no other video clip */
export function freePosition(clips: VideoClip[], length: number, desired: number, excludeId?: string): number {
  const others = clips.filter((c) => c.id !== excludeId);
  const eps = 1e-6;
  const fits = (s: number) => s >= -eps && others.every((c) => s + length <= c.start + eps || s >= c.start + c.length - eps);
  desired = Math.max(0, desired);
  if (fits(desired)) return desired;
  const candidates = others.flatMap((c) => [c.start - length, c.start + c.length]).filter(fits);
  if (!candidates.length) return others.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return candidates.reduce((best, c) => (Math.abs(c - desired) < Math.abs(best - desired) ? c : best));
}

export function selectedClipObj(): VideoClip | AudioClip | undefined {
  const s = useStore.getState();
  const ref = s.selectedClip;
  if (!ref) return undefined;
  return ref.kind === 'video' ? s.videoClips.find((c) => c.id === ref.id) : s.audioClips.find((c) => c.id === ref.id);
}

/** Working range for the AI tools: the selection, else the selected clip, else all videos */
export function workRange(): Range | null {
  const s = useStore.getState();
  if (s.selection && s.selection.end - s.selection.start > 0.05) return s.selection;
  const c = selectedClipObj();
  if (c) return { start: c.start, end: c.start + c.length };
  if (!s.videoClips.length) return null;
  return {
    start: Math.min(...s.videoClips.map((v) => v.start)),
    end: Math.max(...s.videoClips.map((v) => v.start + v.length)),
  };
}

/** The pieces of video clips inside a range; like the plugin, every clip is handled on its own */
export interface VideoPiece {
  clip: VideoClip;
  /** Timeline time */
  start: number;
  end: number;
  /** Time in the source file */
  srcStart: number;
}

export function videoPiecesIn(range: Range): VideoPiece[] {
  return useStore
    .getState()
    .videoClips.map((clip) => {
      const start = Math.max(range.start, clip.start);
      const end = Math.min(range.end, clip.start + clip.length);
      return { clip, start, end, srcStart: clip.offset + (start - clip.start) };
    })
    .filter((p) => p.end - p.start > 0.05)
    .sort((a, b) => a.start - b.start);
}

// Handy for debugging and browser tests
if (import.meta.env.DEV) (window as unknown as { __store: typeof useStore }).__store = useStore;
