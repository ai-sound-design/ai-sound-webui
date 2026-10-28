import { projectEnd, useStore } from '../store';
import { encodeWav } from './audio';
import { scheduleEnvelope } from './envelope';
import { loadBuffer } from './sources';
import { downloadBlob } from './util';

/** Bounce: the mix (honouring mute/solo) or a single track as WAV */
export async function exportMix(trackId?: string) {
  const { audioClips, audioTracks, selection } = useStore.getState();
  // Like a bounce in Pro Tools: with a selection only the selected range
  const from = selection ? selection.start : 0;
  const to = selection ? selection.end : projectEnd();
  if (to - from <= 0) return;
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil((to - from) * sr), sr);
  const anySolo = audioTracks.some((t) => t.solo);
  const gains = new Map<string, GainNode>();
  for (const t of audioTracks) {
    if (trackId && t.id !== trackId) continue;
    const g = ctx.createGain();
    g.gain.value = trackId ? t.volume : t.muted || (anySolo && !t.solo) ? 0 : t.volume;
    g.connect(ctx.destination);
    gains.set(t.id, g);
  }
  const used = audioClips.filter((c) => gains.has(c.trackId) && c.start + c.length > from && c.start < to);
  // Session audio is fetched piece by piece; a few at a time
  const loaded = new Map<string, Awaited<ReturnType<typeof loadBuffer>>>();
  for (let i = 0; i < used.length; i += 6) {
    await Promise.all(
      used.slice(i, i + 6).map(async (c) => {
        try {
          loaded.set(c.id, await loadBuffer(c));
        } catch {
          /* missing audio is left silent */
        }
      }),
    );
  }
  for (const c of used) {
    const g = gains.get(c.trackId)!;
    const b = loaded.get(c.id);
    if (!b) continue;
    const skip = Math.max(0, from - c.start);
    const when = Math.max(0, c.start - from);
    const src = ctx.createBufferSource();
    src.buffer = b.buffer;
    const env = ctx.createGain();
    env.gain.value = 0;
    scheduleEnvelope(env.gain, c, when, skip);
    src.connect(env).connect(g);
    const inBuffer = c.offset - b.offset + skip;
    src.start(when, Math.max(0, inBuffer), Math.min(c.length - skip, b.buffer.duration - inBuffer));
  }
  const buffer = await ctx.startRendering();
  const name = trackId ? audioTracks.find((t) => t.id === trackId)?.name ?? 'track' : 'mix';
  downloadBlob(encodeWav(buffer), `${name.replace(/[^\w\- ]+/g, '_')}.wav`);
}
