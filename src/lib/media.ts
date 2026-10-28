import { freePosition, useStore } from '../store';
import type { VideoClip } from '../types';
import { engine } from './engine';
import { uid } from './util';

function loadMeta(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error('format not supported by this browser'));
    v.src = url;
  });
}

export async function captureThumbs(url: string, duration: number, count = 10, height = 54): Promise<string[]> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  await new Promise<void>((r, j) => {
    v.onloadeddata = () => r();
    v.onerror = () => j(new Error('thumb'));
  });
  const canvas = document.createElement('canvas');
  canvas.height = height;
  canvas.width = Math.round(height * (v.videoWidth / v.videoHeight || 16 / 9));
  const g = canvas.getContext('2d')!;
  const thumbs: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, ((i + 0.5) / count) * duration);
    await new Promise<void>((r) => {
      v.onseeked = () => r();
      v.currentTime = Math.max(0, t);
    });
    g.drawImage(v, 0, 0, canvas.width, canvas.height);
    thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
  }
  v.removeAttribute('src');
  v.load();
  return thumbs;
}

export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(f.name);
export const isAudioFile = (f: File) => f.type.startsWith('audio/') || /\.(wav|aiff?|flac|mp3|ogg|opus|m4a)$/i.test(f.name);

/** Place videos one after another from `start` (default: end of the video track) on free spots */
export async function importVideos(files: File[], start?: number): Promise<string[]> {
  const errors: string[] = [];
  const clips = () => useStore.getState().videoClips;
  let cursor = start ?? clips().reduce((m, c) => Math.max(m, c.start + c.length), 0);
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      const meta = await loadMeta(url);
      cursor = freePosition(clips(), meta.duration, cursor);
      const clip: VideoClip = {
        id: uid('clip'),
        name: file.name,
        file,
        url,
        sourceDuration: meta.duration,
        width: meta.width,
        height: meta.height,
        start: cursor,
        offset: 0,
        length: meta.duration,
        thumbs: [],
      };
      cursor += meta.duration;
      useStore.getState().addVideoClips([clip]);
      captureThumbs(url, meta.duration)
        .then((thumbs) => {
          // Split pieces of the same video get the thumbnails too
          for (const c of clips()) if (c.url === url) useStore.getState().setVideoClip(c.id, { thumbs });
        })
        .catch(() => {});
    } catch (e) {
      URL.revokeObjectURL(url);
      errors.push(`${file.name}: ${(e as Error).message}`);
    }
  }
  return errors;
}

/** Put audio files on a track (like an import in Pro Tools) */
export async function importAudio(files: File[], start: number, trackName = 'Import'): Promise<string[]> {
  const errors: string[] = [];
  const items = [];
  let cursor = start;
  for (const file of files) {
    try {
      const buffer = await engine.context().decodeAudioData(await file.arrayBuffer());
      items.push({ trackName, name: file.name.replace(/\.[^.]+$/, ''), buffer, start: cursor });
      cursor += buffer.duration;
    } catch {
      errors.push(`${file.name}: audio format not readable`);
    }
  }
  useStore.getState().addAudio(items);
  return errors;
}

export async function importFiles(files: File[], start?: number, trackName?: string): Promise<string[]> {
  const videos = files.filter(isVideoFile);
  const audios = files.filter((f) => !isVideoFile(f) && isAudioFile(f));
  const other = files.filter((f) => !isVideoFile(f) && !isAudioFile(f)).map((f) => `${f.name}: neither video nor audio`);
  const e1 = videos.length ? await importVideos(videos, start) : [];
  const e2 = audios.length ? await importAudio(audios, start ?? useStore.getState().currentTime, trackName) : [];
  return [...other, ...e1, ...e2];
}
