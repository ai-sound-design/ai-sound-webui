import { useStore } from '../store';
import type { AudioClip } from '../types';
import { scheduleEnvelope } from './envelope';
import { bufferOf, ensureWindow, onSourcesChanged } from './sources';

/**
 * Web Audio playback of all audio clips. The AudioContext clock is the
 * timeline's master clock; the video follows it.
 *
 * Clips whose audio lives on the server are fetched in pieces around the
 * playhead (lib/sources.ts); a clip that arrives while playing is started at
 * the right moment, the rest is scheduled up front.
 */
const LOOKAHEAD_S = 90;
const LOOKBEHIND_S = 5;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private trackGains = new Map<string, GainNode>();
  private sources = new Map<string, AudioBufferSourceNode>();
  private startCtxTime = 0;
  private startPos = 0;
  private pausedPos = 0;
  private prefetchTimer: ReturnType<typeof setInterval> | undefined;
  playing = false;

  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.watchStore();
      onSourcesChanged(() => this.onSourcesChanged());
    }
    return this.ctx;
  }

  get time(): number {
    if (!this.playing || !this.ctx) return this.pausedPos;
    return this.startPos + Math.max(0, this.ctx.currentTime - this.startCtxTime);
  }

  async play(from: number) {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopSources();
    this.startPos = from;
    this.startCtxTime = ctx.currentTime + 0.05;
    this.playing = true;
    this.prefetch(from);
    this.schedule();
    clearInterval(this.prefetchTimer);
    this.prefetchTimer = setInterval(() => this.playing && this.prefetch(this.time), 2000);
  }

  pause() {
    this.pausedPos = this.time;
    this.playing = false;
    clearInterval(this.prefetchTimer);
    this.stopSources();
  }

  seek(t: number) {
    t = Math.max(0, t);
    if (this.playing && this.ctx) {
      this.stopSources();
      this.startPos = t;
      this.startCtxTime = this.ctx.currentTime + 0.03;
      this.prefetch(t);
      this.schedule();
    } else {
      this.pausedPos = t;
      this.prefetch(t);
    }
  }

  /** Fetches the audio of the clips around `t` */
  prefetch(t: number) {
    ensureWindow(useStore.getState().audioClips, t - LOOKBEHIND_S, t + LOOKAHEAD_S);
  }

  private gainFor(trackId: string): GainNode {
    let g = this.trackGains.get(trackId);
    if (!g) {
      g = this.context().createGain();
      g.connect(this.master!);
      this.trackGains.set(trackId, g);
    }
    return g;
  }

  private updateGains() {
    if (!this.ctx) return;
    const { audioTracks } = useStore.getState();
    const anySolo = audioTracks.some((t) => t.solo);
    for (const t of audioTracks) {
      const silent = t.muted || (anySolo && !t.solo);
      this.gainFor(t.id).gain.setTargetAtTime(silent ? 0 : t.volume, this.ctx.currentTime, 0.01);
    }
  }

  private schedule() {
    this.updateGains();
    for (const clip of useStore.getState().audioClips) this.scheduleClip(clip);
  }

  /** Starts one clip at its place in the running playback, if its audio is there */
  private scheduleClip(clip: AudioClip) {
    if (!this.playing || this.sources.has(clip.id)) return;
    const ctx = this.context();
    const end = clip.start + clip.length;
    // Where playback is now, in timeline time (the start offset covers clips that begin before it)
    const now = this.startPos + Math.max(0, ctx.currentTime - this.startCtxTime);
    if (end <= now) return;
    const loaded = bufferOf(clip);
    if (!loaded) return;
    const skip = Math.max(0, now - clip.start);
    const when = Math.max(ctx.currentTime + 0.02, this.startCtxTime + (clip.start - this.startPos));
    const inBuffer = clip.offset - loaded.offset + skip;
    const dur = clip.length - skip;
    if (dur <= 0 || inBuffer >= loaded.buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = loaded.buffer;
    const env = ctx.createGain();
    env.gain.value = 0;
    scheduleEnvelope(env.gain, clip, when, skip);
    src.connect(env).connect(this.gainFor(clip.trackId));
    src.start(when, Math.max(0, inBuffer), Math.min(dur, loaded.buffer.duration - inBuffer));
    src.onended = () => {
      if (this.sources.get(clip.id) === src) this.sources.delete(clip.id);
    };
    this.sources.set(clip.id, src);
  }

  private onSourcesChanged() {
    if (!this.playing) return;
    for (const clip of useStore.getState().audioClips) this.scheduleClip(clip);
  }

  private stopSources() {
    for (const s of this.sources.values()) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources.clear();
  }

  private watchStore() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    useStore.subscribe((s, prev) => {
      if (s.audioTracks !== prev.audioTracks) this.updateGains();
      if (s.audioClips !== prev.audioClips) {
        clearTimeout(timer);
        // Clips were moved, edited or generated: reschedule the running playback
        timer = setTimeout(() => this.playing && this.seek(this.time), 120);
      }
    });
  }
}

export const engine = new AudioEngine();
