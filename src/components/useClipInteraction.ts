import { useRef } from 'react';
import type React from 'react';
import { freePosition, useStore } from '../store';
import type { ClipRef } from '../types';

const SNAP_PX = 8;
const EDGE_PX = 7;
const FADE_ZONE_PX = 14;

type Mode = 'move' | 'trim-l' | 'trim-r' | 'fade-in' | 'fade-out' | 'blade' | 'none';

const CURSORS: Record<Mode, string> = {
  move: 'grab',
  'trim-l': 'w-resize',
  'trim-r': 'e-resize',
  'fade-in': 'nw-resize',
  'fade-out': 'ne-resize',
  blade: 'crosshair',
  none: 'text',
};

/** Snap targets: zero, playhead, selection, markers and the edges of all other clips */
function snapTargets(exclude: string): number[] {
  const s = useStore.getState();
  const t = [0, s.currentTime];
  if (s.selection) t.push(s.selection.start, s.selection.end);
  for (const m of s.markers) t.push(m.start, ...(m.end !== undefined ? [m.end] : []));
  for (const c of [...s.videoClips, ...s.audioClips]) if (c.id !== exclude) t.push(c.start, c.start + c.length);
  return t;
}

export function snap(value: number, edges: number[], exclude: string, alt: boolean): number {
  if (alt) return value;
  const tol = SNAP_PX / useStore.getState().pxPerSec;
  let best = tol;
  let out = value;
  for (const t of snapTargets(exclude)) {
    for (const e of edges) {
      const d = Math.abs(value + e - t);
      if (d < best) {
        best = d;
        out = t - e;
      }
    }
  }
  return out;
}

/**
 * Pointer handling for clips, depending on the active tool:
 *   smart  body = move, edges = trim, top corners (audio) = fade, like the Pro Tools smart tool
 *   select lets the event through to the lane, which draws a selection
 *   grab   move only · trim nearest edge · blade split at the click · fade left/right half
 * Alt disables snapping.
 */
export function useClipInteraction(ref: ClipRef) {
  const drag = useRef<{ mode: Mode; x0: number; start: number; offset: number; length: number; fadeIn: number; fadeOut: number; moved: boolean } | null>(null);

  const get = () => {
    const s = useStore.getState();
    return ref.kind === 'video' ? s.videoClips.find((c) => c.id === ref.id) : s.audioClips.find((c) => c.id === ref.id);
  };

  const modeAt = (e: React.PointerEvent): Mode => {
    const tool = useStore.getState().tool;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const fromRight = r.right - e.clientX;
    const audio = ref.kind === 'audio';
    switch (tool) {
      case 'select':
        return 'none';
      case 'grab':
        return 'move';
      case 'blade':
        return 'blade';
      case 'trim':
        return x < r.width / 2 ? 'trim-l' : 'trim-r';
      case 'fade':
        return audio ? (x < r.width / 2 ? 'fade-in' : 'fade-out') : 'none';
      default: {
        const wide = r.width > EDGE_PX * 4;
        if (audio && wide && e.clientY - r.top < FADE_ZONE_PX) {
          if (x < r.width * 0.3) return 'fade-in';
          if (fromRight < r.width * 0.3) return 'fade-out';
        }
        if (wide && x < EDGE_PX) return 'trim-l';
        if (wide && fromRight < EDGE_PX) return 'trim-r';
        return 'move';
      }
    }
  };

  const timeAt = (e: React.PointerEvent) => {
    const lane = (e.currentTarget as HTMLElement).parentElement!.closest('.tl-lane') as HTMLElement;
    return Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / useStore.getState().pxPerSec);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const c = get();
    if (!c) return;
    const mode = modeAt(e);
    if (mode === 'none') return; // selector: the lane below handles it
    e.stopPropagation();
    const s = useStore.getState();
    s.selectClip(ref);
    if (mode === 'blade') {
      s.splitAt(snap(timeAt(e), [0], ref.id, e.altKey), ref);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const a = 'fadeIn' in c ? c : { fadeIn: 0, fadeOut: 0 };
    drag.current = { mode, x0: e.clientX, start: c.start, offset: c.offset, length: c.length, fadeIn: a.fadeIn, fadeOut: a.fadeOut, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = e.currentTarget as HTMLElement;
    if (!d) {
      el.style.cursor = CURSORS[modeAt(e)];
      return;
    }
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    const s = useStore.getState();
    if (!d.moved) {
      d.moved = true;
      s.checkpoint();
    }
    const dt = dx / s.pxPerSec;
    const c = get();
    if (!c) return;
    const maxLength = 'source' in c ? c.source.duration : c.sourceDuration;

    switch (d.mode) {
      case 'move': {
        let start = Math.max(0, snap(d.start + dt, [0, d.length], ref.id, e.altKey));
        if (ref.kind === 'video') {
          start = freePosition(s.videoClips, d.length, start, ref.id);
          s.moveVideoClip(ref.id, start);
        } else {
          // Changing tracks: find the audio lane under the pointer
          const lane = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.trackId) as HTMLElement | undefined;
          s.setAudioClip(ref.id, { start, ...(lane?.dataset.trackId ? { trackId: lane.dataset.trackId } : {}) });
        }
        break;
      }
      case 'trim-l': {
        const target = snap(d.start + dt, [0], ref.id, e.altKey);
        const delta = Math.min(d.length - 0.05, Math.max(-d.offset, -d.start, target - d.start));
        const patch = { start: d.start + delta, offset: d.offset + delta, length: d.length - delta };
        if (ref.kind === 'video') s.setVideoClip(ref.id, patch);
        else s.setAudioClip(ref.id, patch);
        break;
      }
      case 'trim-r': {
        const end = snap(d.start + d.length + dt, [0], ref.id, e.altKey);
        const length = Math.min(maxLength - d.offset, Math.max(0.05, end - d.start));
        if (ref.kind === 'video') s.setVideoClip(ref.id, { length });
        else s.setAudioClip(ref.id, { length });
        break;
      }
      case 'fade-in':
        s.setAudioClip(ref.id, { fadeIn: Math.max(0, snap(d.start + d.fadeIn + dt, [0], ref.id, e.altKey) - d.start) });
        break;
      case 'fade-out':
        s.setAudioClip(ref.id, { fadeOut: Math.max(0, d.start + d.length - snap(d.start + d.length - d.fadeOut + dt, [0], ref.id, e.altKey)) });
        break;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
