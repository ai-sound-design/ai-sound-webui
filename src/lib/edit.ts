import { selectedClipObj, useStore } from '../store';
import type { AudioClip } from '../types';
import { clipPeak, loadBuffer } from './sources';
import { uid } from './util';

/** Edit actions for the tools panel and keyboard shortcuts */

const st = () => useStore.getState();
const DEFAULT_FADE = 0.5;

function selectedAudio(): AudioClip | undefined {
  const c = selectedClipObj();
  return c && 'source' in c ? c : undefined;
}

/** Audio clips an edit applies to: the selected clip, else all clips touched by the selection */
function targets(): AudioClip[] {
  const a = selectedAudio();
  if (a) return [a];
  const sel = st().selection;
  if (!sel) return [];
  return st().audioClips.filter((c) => c.start < sel.end && c.start + c.length > sel.start);
}

export function splitAtPlayhead() {
  st().splitAt(st().currentTime);
}

export function deleteSelected() {
  const ref = st().selectedClip;
  if (ref) st().deleteClip(ref);
}

/** Copy the selected clip and place it right after the original */
export function duplicate() {
  const s = st();
  const ref = s.selectedClip;
  if (!ref) return;
  s.checkpoint();
  if (ref.kind === 'audio') {
    const c = s.audioClips.find((x) => x.id === ref.id)!;
    const copy = { ...c, id: uid('aclip'), start: c.start + c.length, linkedVideoId: undefined };
    useStore.setState({ audioClips: [...s.audioClips, copy], selectedClip: { kind: 'audio', id: copy.id } });
  } else {
    const c = s.videoClips.find((x) => x.id === ref.id)!;
    const end = s.videoClips.reduce((m, v) => Math.max(m, v.start + v.length), 0);
    const copy = { ...c, id: uid('clip'), start: end };
    useStore.setState({ videoClips: [...s.videoClips, copy], selectedClip: { kind: 'video', id: copy.id } });
  }
}

/** Crop clips to the selection (audio clips touched by it, or the selected clip) */
export function cropToSelection() {
  const s = st();
  const sel = s.selection;
  if (!sel) return;
  const ref = s.selectedClip;
  const hit = (c: { start: number; length: number }) => c.start < sel.end && c.start + c.length > sel.start;
  const crop = <T extends { start: number; offset: number; length: number }>(c: T): T => {
    const start = Math.max(c.start, sel.start);
    const end = Math.min(c.start + c.length, sel.end);
    return { ...c, start, offset: c.offset + (start - c.start), length: end - start };
  };
  s.checkpoint();
  useStore.setState({
    audioClips: s.audioClips.map((c) => (hit(c) && (!ref || ref.id === c.id) ? clampFades(crop(c)) : c)),
    videoClips: s.videoClips.map((c) => (ref?.kind === 'video' && ref.id === c.id && hit(c) ? crop(c) : c)),
  });
}

const clampFades = (c: AudioClip): AudioClip => {
  const fadeIn = Math.min(c.fadeIn, c.length);
  return { ...c, fadeIn, fadeOut: Math.min(c.fadeOut, c.length - fadeIn) };
};

/** Fade in: to the selection's end if one exists, else a default length */
export function fadeIn() {
  const sel = st().selection;
  const list = targets();
  if (!list.length) return;
  st().checkpoint();
  for (const c of list) {
    const len = sel && sel.end > c.start ? sel.end - c.start : DEFAULT_FADE;
    st().setAudioClip(c.id, { fadeIn: Math.min(len, c.length) });
  }
}

export function fadeOut() {
  const sel = st().selection;
  const list = targets();
  if (!list.length) return;
  st().checkpoint();
  for (const c of list) {
    const end = c.start + c.length;
    const len = sel && sel.start < end ? end - Math.max(c.start, sel.start) : DEFAULT_FADE;
    st().setAudioClip(c.id, { fadeOut: Math.min(len, c.length) });
  }
}

/**
 * Crossfade over the selection: on every track where one clip ends and the next
 * starts inside the selection, fade the first out and the second in. Clips that
 * only touch are extended into each other where their sources allow it.
 */
export function crossfade() {
  const s = st();
  const sel = s.selection;
  if (!sel) return;
  const pairs: [AudioClip, AudioClip][] = [];
  for (const t of s.audioTracks) {
    const clips = s.audioClips.filter((c) => c.trackId === t.id).sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < clips.length; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const aEnd = a.start + a.length;
      const inSel = (t: number) => t >= sel.start - 0.01 && t <= sel.end + 0.01;
      if (inSel(aEnd) && inSel(b.start)) pairs.push([a, b]);
    }
  }
  if (!pairs.length) return;
  s.checkpoint();
  for (const [a, b] of pairs) {
    // Extend a to the selection end and b back to the selection start as far as the sources reach
    const aEnd = Math.min(sel.end, a.start - a.offset + a.source.duration);
    const bStart = Math.max(sel.start, b.start - b.offset);
    const bPatch = { start: bStart, offset: b.offset - (b.start - bStart), length: b.length + (b.start - bStart) };
    const overlap = Math.max(0, aEnd - bStart);
    st().setAudioClip(a.id, { length: aEnd - a.start, fadeOut: overlap });
    st().setAudioClip(b.id, { ...bPatch, fadeIn: overlap });
  }
}

/** Set clip gain so the clip's peak reaches -1 dBFS */
export async function normalize() {
  const list = targets();
  if (!list.length) return;
  st().checkpoint();
  for (const c of list) {
    let peak = 0;
    try {
      const b = await loadBuffer(c);
      const sr = b.buffer.sampleRate;
      const from = Math.max(0, Math.floor((c.offset - b.offset) * sr));
      const to = Math.min(b.buffer.length, Math.ceil((c.offset - b.offset + c.length) * sr));
      for (let ch = 0; ch < b.buffer.numberOfChannels; ch++) {
        const d = b.buffer.getChannelData(ch);
        for (let i = from; i < to; i++) {
          const v = Math.abs(d[i]);
          if (v > peak) peak = v;
        }
      }
    } catch {
      peak = clipPeak(c);
    }
    if (peak > 0) st().setAudioClip(c.id, { gain: +(-1 - 20 * Math.log10(peak)).toFixed(2) });
  }
}

export function nudgeGain(db: number) {
  const list = targets();
  if (!list.length) return;
  st().checkpoint();
  for (const c of list) st().setAudioClip(c.id, { gain: Math.max(-48, Math.min(24, +(c.gain + db).toFixed(2))) });
}

export function addMarkerHere() {
  const s = st();
  const n = s.markers.length + 1;
  if (s.selection) s.addMarkers([{ start: s.selection.start, end: s.selection.end, label: `Marker ${n}`, category: 'sfx' }]);
  else s.addMarkers([{ start: s.currentTime, label: `Marker ${n}` }]);
}
