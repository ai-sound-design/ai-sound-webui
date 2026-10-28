import { useStore } from '../store';
import type { AudioClip, Range } from '../types';
import { encodeWav } from './audio';
import { scheduleEnvelope } from './envelope';
import { loadBuffer } from './sources';

/**
 * Renders the audio under a range to a mono WAV file, as the plugin bounces the
 * clips of the selected tracks for the search by sound: the selected clip's
 * track if a clip is selected, else every audible track.
 */
export async function bounceRange(range: Range, trackIds?: string[]): Promise<File> {
  const s = useStore.getState();
  const anySolo = s.audioTracks.some((t) => t.solo);
  const tracks = s.audioTracks.filter((t) => (trackIds ? trackIds.includes(t.id) : !t.muted && (!anySolo || t.solo)));
  const ids = new Set(tracks.map((t) => t.id));
  const clips = s.audioClips.filter((c) => ids.has(c.trackId) && c.start < range.end && c.start + c.length > range.start);
  if (!clips.length) throw new Error('No audio under the selection.');
  const sr = 48000;
  const length = Math.max(1, Math.ceil((range.end - range.start) * sr));
  const ctx = new OfflineAudioContext(1, length, sr);
  const loaded = new Map<AudioClip, Awaited<ReturnType<typeof loadBuffer>>>();
  for (const c of clips) {
    try {
      loaded.set(c, await loadBuffer(c));
    } catch {
      /* missing audio stays silent */
    }
  }
  for (const c of clips) {
    const b = loaded.get(c);
    if (!b) continue;
    const skip = Math.max(0, range.start - c.start);
    const when = Math.max(0, c.start - range.start);
    const src = ctx.createBufferSource();
    src.buffer = b.buffer;
    const env = ctx.createGain();
    env.gain.value = 0;
    scheduleEnvelope(env.gain, c, when, skip);
    const trackGain = ctx.createGain();
    trackGain.gain.value = tracks.find((t) => t.id === c.trackId)?.volume ?? 1;
    src.connect(env).connect(trackGain).connect(ctx.destination);
    const inBuffer = c.offset - b.offset + skip;
    src.start(when, Math.max(0, inBuffer), Math.min(c.length - skip, b.buffer.duration - inBuffer));
  }
  const rendered = await ctx.startRendering();
  // Peak-limit as the plugin does (0.98)
  const d = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0.98) for (let i = 0; i < d.length; i++) d[i] *= 0.98 / peak;
  return new File([encodeWav(rendered)], `query_${Date.now()}.wav`, { type: 'audio/wav' });
}
