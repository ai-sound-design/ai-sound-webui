import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import type { VideoPiece } from '../store';
import { serverApi } from '../api/server';

/**
 * Cuts a range out of a video the way the plugin does with ffmpeg (downscaled,
 * no audio, H.264). Videos of an open Pro Tools session are cut by the web UI
 * server; dropped files are cut with ffmpeg.wasm in the browser, loaded on
 * first use (~30 MB). If the piece covers the whole clip, the original file is
 * sent as is.
 */
let ffmpeg: Promise<FFmpeg> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpeg) {
    ffmpeg = (async () => {
      const f = new FFmpeg();
      await f.load({ coreURL, wasmURL });
      return f;
    })();
    ffmpeg.catch(() => (ffmpeg = null));
  }
  return ffmpeg;
}

export async function videoForPiece(piece: VideoPiece, onStatus?: (s: string, fraction?: number) => void): Promise<File> {
  const { clip } = piece;
  const len = piece.end - piece.start;
  const base = clip.name.replace(/\.[^.]+$/, '');
  const outName = `${base}_${piece.srcStart.toFixed(1)}-${(piece.srcStart + len).toFixed(1)}.mp4`;

  if (clip.remote) {
    onStatus?.('cutting video on the server …');
    const res = await fetch(serverApi.videoCutUrl(clip.remote.sessionId, clip.remote.fileIndex, piece.srcStart, piece.srcStart + len));
    if (!res.ok) throw new Error(`the server could not cut the video (${res.status})`);
    return new File([await res.arrayBuffer()], outName, { type: 'video/mp4' });
  }

  if (!clip.file) throw new Error(`${clip.name}: the video file is not available`);
  if (piece.srcStart < 0.05 && Math.abs(len - clip.sourceDuration) < 0.1) return clip.file;
  const file = clip.file;

  // ffmpeg.wasm works serially
  const run = queue.then(async () => {
    onStatus?.('loading ffmpeg …');
    const f = await getFFmpeg();
    const inName = `in_${clip.id}${clip.name.match(/\.\w+$/)?.[0] ?? '.mp4'}`;
    const tmpName = `cut_${Date.now()}.mp4`;
    const progress = ({ progress }: { progress: number }) => onStatus?.('cutting video …', Math.max(0, Math.min(1, progress)));
    f.on('progress', progress);
    try {
      await f.writeFile(inName, await fetchFile(file));
      const code = await f.exec([
        '-ss', piece.srcStart.toFixed(3), '-i', inName, '-t', len.toFixed(3),
        '-an', '-vf', 'scale=-2:min(ih\\,360)', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
        tmpName,
      ]);
      if (code !== 0) throw new Error('ffmpeg could not cut the video');
      const data = (await f.readFile(tmpName)) as Uint8Array;
      await f.deleteFile(tmpName);
      await f.deleteFile(inName);
      return new File([data.slice()], outName, { type: 'video/mp4' });
    } finally {
      f.off('progress', progress);
    }
  });
  queue = run.catch(() => {});
  return run;
}
