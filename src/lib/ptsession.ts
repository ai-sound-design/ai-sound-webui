import { serverApi, serverUrl, type PtSession } from '../api/server';
import { useStore } from '../store';
import type { AudioClip, AudioSource, AudioTrack, Marker, SessionInfo, VideoClip } from '../types';
import { captureThumbs } from './media';
import { transport } from './transport';
import { uid } from './util';

/**
 * Opens a Pro Tools session (read by the web UI server) as the project:
 * every audio track of the session with its clips, the video track, and the
 * memory locations as markers. Audio stays on the server and is fetched in
 * pieces around the playhead; the video plays from the server too.
 */

const TRACK_COLORS = ['#4fb3ff', '#ffb547', '#7ee081', '#ff6f91', '#b18cff', '#4de0d0', '#ff8a4c', '#e3e36a'];

export async function openPtSession(path: string, opts: { emptyTracks?: boolean } = {}): Promise<PtSession> {
  const s = await serverApi.openSession(path);
  applySession(s, opts);
  return s;
}

export function sessionInfoOf(s: PtSession): SessionInfo {
  return {
    id: s.id,
    name: s.name,
    path: s.path,
    product: s.product,
    version: s.version,
    sampleRate: s.sampleRate,
    fps: s.fps,
    fpsSource: s.fpsSource,
    startSeconds: s.startSeconds,
    tracks: s.tracks.map((t) => ({ index: t.index, name: t.name, kind: t.kind, format: t.format, channels: t.channels })),
    warnings: s.warnings,
  };
}

/** The source of a session audio file for a given channel selection */
export function sourceFor(s: PtSession, fileIndex: number, channels: (number | null)[]): AudioSource | null {
  const f = s.audioFiles[fileIndex];
  if (!f?.url) return null;
  const map = channels.filter((c): c is number => c !== null);
  const useMap = map.length > 0 && map.length < (f.channels || 1);
  return {
    id: `pt:${s.id}:${fileIndex}${useMap ? ':' + map.join(',') : ''}`,
    duration: f.duration ?? 0,
    channels: useMap ? map.length : f.channels || 1,
    url: f.url,
    channelMap: useMap ? map : undefined,
    peaksUrl: f.peaksUrl ?? undefined,
  };
}

export function applySession(s: PtSession, opts: { emptyTracks?: boolean } = {}) {
  transport.pause();
  const withClips = new Set(s.clips.map((c) => c.track));
  const tracks: AudioTrack[] = [];
  const trackIds = new Map<number, string>();
  let n = 0;
  for (const t of s.tracks) {
    if (t.kind !== 'audio') continue;
    if (!opts.emptyTracks && !withClips.has(t.index)) continue;
    const id = uid('track');
    trackIds.set(t.index, id);
    tracks.push({ id, name: t.name, color: TRACK_COLORS[n++ % TRACK_COLORS.length], volume: 0.8, muted: false, solo: false });
  }

  const audioClips: AudioClip[] = [];
  const missing = new Set<string>();
  for (const c of s.clips) {
    const trackId = trackIds.get(c.track);
    if (!trackId) continue;
    const source = sourceFor(s, c.file, c.channels);
    if (!source) {
      missing.add(s.audioFiles[c.file]?.name ?? `file ${c.file}`);
      continue;
    }
    audioClips.push({
      id: uid('aclip'),
      trackId,
      name: c.name,
      source,
      start: c.start,
      offset: c.offset,
      length: c.length,
      gain: 0,
      fadeIn: 0,
      fadeOut: 0,
    });
  }

  const videoClips: VideoClip[] = [];
  for (const vc of s.videoClips) {
    const f = s.videoFiles[vc.file];
    if (!f?.url) {
      missing.add(f?.name ?? `video ${vc.file}`);
      continue;
    }
    const url = serverUrl(f.playable || !f.proxyUrl ? f.url : f.proxyUrl);
    videoClips.push({
      id: uid('clip'),
      name: f.name,
      url,
      remote: { sessionId: s.id, fileIndex: vc.file },
      sourceDuration: f.duration ?? vc.length,
      width: f.width ?? 0,
      height: f.height ?? 0,
      start: vc.start,
      offset: vc.offset,
      length: vc.length,
      thumbs: [],
    });
  }

  const markers: Marker[] = s.markers.map((m) => ({
    id: uid('mk'),
    start: m.start,
    end: m.end ?? undefined,
    label: m.name,
    category: m.category ?? undefined,
    description: m.comment || undefined,
    number: m.number,
  }));

  const info = sessionInfoOf(s);
  if (missing.size) info.warnings = [...info.warnings, `media not found next to the session: ${[...missing].slice(0, 8).join(', ')}${missing.size > 8 ? ' …' : ''}`];

  // Zoom so the session fits the window
  const span = Math.max(30, s.duration - Math.min(...[...videoClips, ...audioClips].map((c) => c.start), 0));
  const pxPerSec = Math.min(400, Math.max(4, (window.innerWidth - 260) / span));

  useStore.getState().replaceProject({ name: s.name, pxPerSec, videoClips, audioTracks: tracks, audioClips, markers, session: info });
  // The AI requests carry the timecode rate; take the session's
  const st = useStore.getState();
  if (s.fps && Math.abs(st.settings.fps - s.fps) > 1e-6) st.setSettings({ ...st.settings, fps: s.fps });
  // Start at the first thing on the timeline
  const first = Math.min(...[...videoClips, ...audioClips].map((c) => c.start), s.duration);
  transport.seek(Number.isFinite(first) ? first : 0);

  for (const v of videoClips) {
    captureThumbs(v.url, v.sourceDuration)
      .then((thumbs) => useStore.getState().setVideoClip(v.id, { thumbs }))
      .catch(() => {});
  }
}
