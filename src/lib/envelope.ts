import type { AudioClip } from '../types';

export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Clip gain × fades at `t` seconds into the clip (equal-power fade curves) */
export function envelopeAt(clip: Pick<AudioClip, 'gain' | 'fadeIn' | 'fadeOut' | 'length'>, t: number): number {
  let g = dbToGain(clip.gain);
  if (clip.fadeIn > 0 && t < clip.fadeIn) g *= Math.sin((Math.max(0, t) / clip.fadeIn) * (Math.PI / 2));
  const fromEnd = clip.length - t;
  if (clip.fadeOut > 0 && fromEnd < clip.fadeOut) g *= Math.sin((Math.max(0, fromEnd) / clip.fadeOut) * (Math.PI / 2));
  return g;
}

/**
 * Schedules the envelope on a gain parameter. `when` is the context time at which
 * clip time `skip` is heard; the envelope runs until the end of the clip.
 */
export function scheduleEnvelope(param: AudioParam, clip: AudioClip, when: number, skip: number) {
  const dur = clip.length - skip;
  if (dur <= 0) return;
  if (clip.fadeIn <= 0 && clip.fadeOut <= 0) {
    param.setValueAtTime(dbToGain(clip.gain), when);
    return;
  }
  const n = Math.max(2, Math.min(20000, Math.ceil(dur * 200)));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = envelopeAt(clip, skip + (dur * i) / (n - 1));
  param.setValueCurveAtTime(curve, when, dur);
}
