import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { serverApi, type PtSession } from '../api/server';
import { useStore } from '../store';
import type { AudioClip, AudioSource, AudioTrack, Marker, SessionInfo, VideoClip } from '../types';
import { encodeWav } from './audio';
import { engine } from './engine';
import { captureThumbs } from './media';
import { sessionInfoOf, sourceFor } from './ptsession';
import { isInMemory, registerBuffer, wholeBuffer } from './sources';
import { transport } from './transport';
import { downloadBlob } from './util';

/**
 * Project file (.asd): a ZIP with
 *   project.json     timeline, tracks, clips, memory locations
 *   video/<n>.<ext>  dropped video files (stored, they are compressed already)
 *   audio/<n>.wav    every in-memory audio source; split clips share one file
 * Media of a Pro Tools session is not copied: the project remembers the
 * session and the file, and the server resolves them again when it is opened.
 */

const FORMAT = 'ai-sound-webui-project';
const VERSION = 2;

interface SessionRef {
  path: string;
  fileIndex: number;
  fileName: string;
  channels?: number[];
}

interface ProjectJson {
  format: typeof FORMAT;
  version: number;
  name: string;
  savedAt: string;
  pxPerSec: number;
  session?: SessionInfo;
  videos: { id: string; file?: string; session?: SessionRef; name: string; type: string; duration: number; width: number; height: number; thumbs: string[] }[];
  audio: { id: string; file?: string; session?: SessionRef; duration: number; channels: number }[];
  videoClips: { id: string; video: string; start: number; offset: number; length: number }[];
  audioTracks: AudioTrack[];
  audioClips: { id: string; trackId: string; name: string; audio: string; start: number; offset: number; length: number; gain?: number; fadeIn?: number; fadeOut?: number; linkedVideoId?: string }[];
  markers: Marker[];
}

const ext = (name: string) => name.match(/\.[\w]+$/)?.[0] ?? '.mp4';

function sessionRefOf(source: AudioSource, session: SessionInfo | null, fileName?: string): SessionRef | undefined {
  // pt:<session id>:<file index>[:<channels>]
  const m = source.id.match(/^pt:[^:]+:(\d+)(?::([\d,]+))?$/);
  if (!m || !session) return undefined;
  return { path: session.path, fileIndex: Number(m[1]), fileName: fileName ?? '', channels: m[2] ? m[2].split(',').map(Number) : undefined };
}

export async function saveProject() {
  const s = useStore.getState();
  let name = s.projectName;
  const asked = window.prompt('Project name', name);
  if (asked === null) return;
  name = asked.trim() || name;

  const files: Zippable = {};
  // Videos: once per source (split clips point to the same file)
  const videoIds = new Map<string, string>();
  const videos: ProjectJson['videos'] = [];
  for (const c of s.videoClips) {
    const key = c.remote ? `remote:${c.remote.sessionId}:${c.remote.fileIndex}` : c.url;
    if (videoIds.has(key)) continue;
    const id = `v${videos.length + 1}`;
    videoIds.set(key, id);
    const meta = { id, name: c.name, type: c.file?.type ?? 'video/mp4', duration: c.sourceDuration, width: c.width, height: c.height, thumbs: c.thumbs };
    if (c.remote && s.session) {
      videos.push({ ...meta, session: { path: s.session.path, fileIndex: c.remote.fileIndex, fileName: c.name } });
    } else if (c.file) {
      const file = `video/${id}${ext(c.name)}`;
      files[file] = [new Uint8Array(await c.file.arrayBuffer()), { level: 0 }];
      videos.push({ ...meta, file });
    }
  }
  // Audio: once per source
  const audioIds = new Map<string, string>();
  const audio: ProjectJson['audio'] = [];
  const skipped: string[] = [];
  for (const c of s.audioClips) {
    if (audioIds.has(c.source.id)) continue;
    const id = `a${audio.length + 1}`;
    const ref = sessionRefOf(c.source, s.session, c.name);
    if (ref) {
      audioIds.set(c.source.id, id);
      audio.push({ id, session: ref, duration: c.source.duration, channels: c.source.channels });
    } else if (isInMemory(c.source)) {
      const buffer = wholeBuffer(c.source)!;
      const file = `audio/${id}.wav`;
      files[file] = [new Uint8Array(await encodeWav(buffer).arrayBuffer()), { level: 1 }];
      audioIds.set(c.source.id, id);
      audio.push({ id, file, duration: c.source.duration, channels: c.source.channels });
    } else {
      skipped.push(c.name);
    }
  }

  const project: ProjectJson = {
    format: FORMAT,
    version: VERSION,
    name,
    savedAt: new Date().toISOString(),
    pxPerSec: s.pxPerSec,
    session: s.session ?? undefined,
    videos,
    audio,
    videoClips: s.videoClips
      .filter((c) => videoIds.has(c.remote ? `remote:${c.remote.sessionId}:${c.remote.fileIndex}` : c.url))
      .map((c) => ({ id: c.id, video: videoIds.get(c.remote ? `remote:${c.remote.sessionId}:${c.remote.fileIndex}` : c.url)!, start: c.start, offset: c.offset, length: c.length })),
    audioTracks: s.audioTracks,
    audioClips: s.audioClips
      .filter((c) => audioIds.has(c.source.id))
      .map((c) => ({
        id: c.id,
        trackId: c.trackId,
        name: c.name,
        audio: audioIds.get(c.source.id)!,
        start: c.start,
        offset: c.offset,
        length: c.length,
        gain: c.gain,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        linkedVideoId: c.linkedVideoId,
      })),
    markers: s.markers,
  };
  files['project.json'] = strToU8(JSON.stringify(project, null, 2));

  const zip = zipSync(files);
  downloadBlob(new Blob([zip.slice().buffer], { type: 'application/zip' }), `${name.replace(/[^\w\- ]+/g, '_')}.asd`);
  useStore.getState().markSaved(name);
  if (skipped.length) throw new Error(`Not saved (audio no longer available): ${skipped.slice(0, 5).join(', ')}`);
}

export async function openProject(file: File) {
  if (!confirmDiscard()) return;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name}: not a valid project file`);
  }
  if (!entries['project.json']) throw new Error(`${file.name}: project.json is missing`);
  const p = JSON.parse(strFromU8(entries['project.json'])) as ProjectJson;
  if (p.format !== FORMAT) throw new Error(`${file.name}: unknown format`);
  if (p.version > VERSION) throw new Error(`${file.name}: project from a newer version`);

  transport.pause();
  // A project made from a Pro Tools session: open the session again on the server
  let pt: PtSession | null = null;
  const needsSession = p.videos.some((v) => v.session) || p.audio.some((a) => a.session);
  if (needsSession) {
    const path = p.session?.path ?? p.videos.find((v) => v.session)?.session?.path ?? p.audio.find((a) => a.session)?.session?.path;
    if (!path) throw new Error('The project refers to a Pro Tools session but does not name it');
    pt = await serverApi.openSession(path);
  }

  const videos = new Map<string, { url: string; file?: File; remote?: VideoClip['remote']; meta: ProjectJson['videos'][number] }>();
  for (const v of p.videos) {
    if (v.session && pt) {
      const f = pt.videoFiles[v.session.fileIndex];
      if (!f?.url) throw new Error(`Video missing next to the session: ${v.name}`);
      videos.set(v.id, { url: f.playable || !f.proxyUrl ? f.url : f.proxyUrl, remote: { sessionId: pt.id, fileIndex: v.session.fileIndex }, meta: v });
      continue;
    }
    const data = v.file ? entries[v.file] : undefined;
    if (!data) throw new Error(`Video missing in the project: ${v.name}`);
    const f = new File([data.slice()], v.name, { type: v.type || 'video/mp4' });
    videos.set(v.id, { file: f, url: URL.createObjectURL(f), meta: v });
  }
  const sources = new Map<string, AudioSource>();
  for (const a of p.audio) {
    if (a.session && pt) {
      const src = sourceFor(pt, a.session.fileIndex, a.session.channels ?? []);
      if (!src) throw new Error(`Audio missing next to the session: ${a.session.fileName}`);
      sources.set(a.id, src);
      continue;
    }
    const data = a.file ? entries[a.file] : undefined;
    if (!data) throw new Error(`Audio missing in the project: ${a.file ?? a.id}`);
    sources.set(a.id, registerBuffer(await engine.context().decodeAudioData(data.slice().buffer)));
  }

  const videoClips: VideoClip[] = p.videoClips.map((c) => {
    const v = videos.get(c.video)!;
    return {
      id: c.id,
      name: v.meta.name,
      file: v.file,
      url: v.file ? v.url : v.url,
      remote: v.remote,
      sourceDuration: v.meta.duration,
      width: v.meta.width,
      height: v.meta.height,
      start: c.start,
      offset: c.offset,
      length: c.length,
      thumbs: v.meta.thumbs ?? [],
    };
  });
  const audioClips: AudioClip[] = p.audioClips.map((c) => ({
    id: c.id,
    trackId: c.trackId,
    name: c.name,
    source: sources.get(c.audio)!,
    start: c.start,
    offset: c.offset,
    length: c.length,
    gain: c.gain ?? 0,
    fadeIn: c.fadeIn ?? 0,
    fadeOut: c.fadeOut ?? 0,
    linkedVideoId: c.linkedVideoId,
  }));

  const session = pt ? sessionInfoOf(pt) : (p.session ?? null);
  useStore.getState().replaceProject({ name: p.name, pxPerSec: p.pxPerSec, videoClips, audioTracks: p.audioTracks, audioClips, markers: p.markers, session });
  transport.seek(0);
  for (const v of videoClips) {
    if (v.remote && !v.thumbs.length) {
      captureThumbs(v.url, v.sourceDuration)
        .then((thumbs) => useStore.getState().setVideoClip(v.id, { thumbs }))
        .catch(() => {});
    }
  }
}

export function newProject() {
  if (!confirmDiscard()) return;
  transport.pause();
  useStore.getState().replaceProject({ name: 'Untitled', videoClips: [], audioTracks: [], audioClips: [], markers: [], session: null });
  transport.seek(0);
}

export function confirmDiscard(): boolean {
  const s = useStore.getState();
  return !s.dirty || window.confirm(`Discard unsaved changes in “${s.projectName}”?`);
}
