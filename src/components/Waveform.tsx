import { useEffect, useRef } from 'react';

interface Props {
  peaks: Float32Array;
  width: number;
  height: number;
  color: string;
  /** Linear gain applied to the drawing (clip gain) */
  scale?: number;
}

const MAX_CANVAS = 16000;

export function Waveform({ peaks, width, height, color, scale = 1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.min(MAX_CANVAS, Math.round(width)));

  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.min(MAX_CANVAS, Math.round(w * dpr));
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = color;
    const mid = c.height / 2;
    const n = peaks.length;
    for (let x = 0; x < c.width; x++) {
      const a = Math.floor((x / c.width) * n);
      const b = Math.max(a + 1, Math.floor(((x + 1) / c.width) * n));
      let max = 0;
      for (let i = a; i < b && i < n; i++) if (peaks[i] > max) max = peaks[i];
      const h = Math.max(1, Math.min(1, max * scale) * mid * 0.95);
      g.fillRect(x, mid - h, 1, h * 2);
    }
  }, [peaks, w, height, color, scale]);

  return <canvas ref={ref} style={{ width, height }} className="waveform" />;
}
