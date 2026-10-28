import type { SearchResult } from '../types';
import { hashString, mulberry32, sleep } from '../lib/util';
import type { HybridAnswer, ProgressFn, Scene, SpotEvent } from './services';

/**
 * Offline stand-in for all four services: the same answer shapes as the
 * ai-services, synthesised in the browser, so the interface can be tried
 * without a GPU server.
 */

const SR = 44100;
const CATALOG: { label: string; category: string; description: string }[] = [
  { label: 'footsteps', category: 'foley', description: 'footsteps on concrete' },
  { label: 'door slam', category: 'sfx', description: 'a heavy door slams shut' },
  { label: 'city ambience', category: 'ambience', description: 'distant traffic and wind' },
  { label: 'cloth rustle', category: 'foley', description: 'jacket rustling' },
  { label: 'car passes', category: 'sfx', description: 'a car passes from left to right' },
  { label: 'birds', category: 'ambience', description: 'birds chirping in the park' },
  { label: 'glass clink', category: 'foley', description: 'glasses clink on a table' },
];

async function fakeWork(onProgress: ProgressFn, steps: number, label: string, from = 0, to = 1) {
  for (let i = 1; i <= steps; i++) {
    await sleep(90);
    onProgress(from + ((to - from) * i) / steps, `${label} ${i}/${steps} (mock)`);
  }
}

function noise(ctx: BaseAudioContext, seconds: number, rand: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
  return b;
}

/** Ein zur Kategorie passender synthetischer Klang */
export async function synth(category: string, seconds: number, seed: number): Promise<AudioBuffer> {
  const rand = mulberry32(seed);
  const dur = Math.max(0.2, seconds);
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  if (category === 'ambience') {
    for (const pan of [-0.6, 0.6]) {
      const src = ctx.createBufferSource();
      src.buffer = noise(ctx, 2, rand);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.frequency.value = 400 + rand() * 700;
      const g = ctx.createGain();
      g.gain.value = 0.2;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(lp).connect(g).connect(p).connect(ctx.destination);
      src.start(0, rand() * 2);
    }
  } else if (category === 'music') {
    const base = [220, 174.61, 261.63, 196][Math.floor(rand() * 4)];
    for (const r of [1, 1.25, 1.5]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = base * r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.07, 0.5);
      g.gain.linearRampToValueAtTime(0, dur);
      o.connect(g).connect(ctx.destination);
      o.start();
    }
  } else if (category === 'foley') {
    const buf = noise(ctx, 0.3, rand);
    for (let t = 0.05; t < dur - 0.1; t += 0.35 + rand() * 0.25) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 300 + rand() * 1500;
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(t, 0, 0.15);
    }
  } else {
    // sfx: a sweep
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 80 + rand() * 300;
    o.frequency.setValueAtTime(f, 0);
    o.frequency.exponentialRampToValueAtTime(f * (rand() > 0.5 ? 4 : 0.3), dur);
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, 0);
    g.gain.exponentialRampToValueAtTime(0.35, Math.min(0.3, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.001, dur);
    o.connect(lp).connect(g).connect(ctx.destination);
    o.start();
  }
  return ctx.startRendering();
}

export async function mockSpot(videoName: string, duration: number, onProgress: ProgressFn): Promise<SpotEvent[]> {
  await fakeWork(onProgress, 10, 'frames');
  const rand = mulberry32(hashString(videoName + duration.toFixed(2)));
  const n = Math.max(1, Math.round(duration / 3));
  const out: SpotEvent[] = [];
  for (let i = 0; i < n; i++) {
    const e = CATALOG[Math.floor(rand() * CATALOG.length)];
    const len = e.category === 'ambience' ? duration : Math.min(duration, 1 + rand() * 3);
    const start = e.category === 'ambience' ? 0 : rand() * Math.max(0, duration - len);
    out.push({ ...e, start_seconds: +start.toFixed(2), end_seconds: +(start + len).toFixed(2), confidence: +(0.5 + rand() * 0.5).toFixed(2) });
  }
  return out.sort((a, b) => a.start_seconds - b.start_seconds);
}

export async function mockGenerate(prompt: string, seed: number, duration: number, onProgress: ProgressFn): Promise<AudioBuffer> {
  await fakeWork(onProgress, 8, 'generiere');
  const p = prompt.toLowerCase();
  const cat = /music|musik/.test(p) ? 'music' : /step|schritt|foley/.test(p) ? 'foley' : /rain|regen|wind|atmo|ambi/.test(p) ? 'ambience' : 'sfx';
  return synth(cat, duration, seed);
}

export async function mockSearch(text: string, hasVideo: boolean, limit: number): Promise<SearchResult[]> {
  await sleep(500);
  const rand = mulberry32(hashString(text + hasVideo));
  const items = [...CATALOG].sort(() => rand() - 0.5).slice(0, Math.min(limit, CATALOG.length));
  return Promise.all(
    items.map(async (e, i) => {
      const dur = e.category === 'ambience' ? 20 : 2 + rand() * 5;
      return {
        id: `mock-${i}-${e.label}`,
        description: e.description,
        category: e.category,
        library: 'mock',
        duration_seconds: +dur.toFixed(1),
        similarity: +(0.8 - i * 0.05).toFixed(3),
        buffer: await synth(e.category, dur, hashString(e.label)),
      };
    }),
  );
}

export async function mockHybrid(
  videoName: string,
  duration: number,
  events: SpotEvent[] | undefined,
  onProgress: ProgressFn,
): Promise<{ answer: HybridAnswer; buffers: Map<string, AudioBuffer> }> {
  const buffers = new Map<string, AudioBuffer>();
  let evs = events;
  if (!evs?.length) evs = await mockSpot(videoName, duration, (f, d) => onProgress(f * 0.5, `spotting, ${d}`));
  const base = events?.length ? 0 : 0.5;
  const sounds: HybridAnswer['sounds'] = [];
  for (const [n, e] of evs.entries()) {
    onProgress(base + ((1 - base) * n) / evs.length, `sound ${n + 1} of ${evs.length}: ${e.label} (mock)`);
    await sleep(150);
    const len = Math.max(0.3, e.end_seconds - e.start_seconds);
    const url = `mock:${n}:${e.label}`;
    buffers.set(url, await synth(e.category, len, hashString(url + videoName)));
    const sound: HybridAnswer['sounds'][number] = { ...e, end_seconds: e.start_seconds + len, audio_url: url };
    // DB match: split in two for longer sounds, now and then none (then the AI sound stays)
    if ((n + 1) % 4 !== 0) {
      const cut = len > 3 ? len / 2 : len;
      const pieces = [];
      for (let t = 0; t < len - 0.01; t += cut) {
        const purl = `${url}:db:${t}`;
        const l = Math.min(cut, len - t);
        buffers.set(purl, await synth(e.category, l, hashString(purl)));
        pieces.push({ layer: 1, start_seconds: t, length_seconds: l, description: `DB: ${e.description} #${pieces.length + 1}`, similarity: 0.7, audio_url: purl });
      }
      sound.match = { pieces };
    }
    sounds.push(sound);
  }
  onProgress(1);
  return { answer: { sounds, events_source: events?.length ? 'memory_locations' : 'spotting' }, buffers };
}

/** Scenes: one per three clips */
export async function mockScenes(names: string[], onProgress: ProgressFn): Promise<{ scenes: Scene[]; clip_scenes: number[] }> {
  await fakeWork(onProgress, 4, 'scenes');
  const places = ['Kitchen, day', 'Street, night', 'Office, day', 'Forest, dusk'];
  const scenes: Scene[] = [];
  const clip_scenes: number[] = [];
  for (let i = 0; i < names.length; i += 3) {
    const index = scenes.length + 1;
    scenes.push({ index, name: places[(index - 1) % places.length], description: `Clips ${i + 1}–${Math.min(names.length, i + 3)} share one place and time.`, first_clip: i, last_clip: Math.min(names.length - 1, i + 2) });
    for (let k = i; k < Math.min(names.length, i + 3); k++) clip_scenes.push(index);
  }
  return { scenes, clip_scenes };
}

/** Search by sound: like the text search, with a matched stretch per recording */
export async function mockSearchByAudio(text: string, limit: number, querySeconds: number): Promise<SearchResult[]> {
  const results = await mockSearch(text || 'sound', true, limit);
  return results.map((r, i) => ({ ...r, offset_seconds: +(i * 1.5).toFixed(2), length_seconds: +Math.max(0.5, querySeconds).toFixed(2) }));
}
