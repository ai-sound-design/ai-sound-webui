/**
 * Client for the web UI's own server (server/): the session browser, parsed
 * Pro Tools sessions and their media. Same origin in production; the Vite dev
 * server forwards /api to it.
 */

export interface ServerHealth {
  status: string;
  service: string;
  version: string;
  sessionsDirs: string[];
  services: Record<string, string>;
}

export interface BrowseEntry {
  name: string;
  kind: 'dir' | 'session';
  path: string;
  size: number;
  mtime?: number;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface PtTrack {
  index: number;
  name: string;
  kind: 'audio' | 'aux' | 'master' | 'video' | 'vca' | 'folder' | string;
  format: string;
  channels: number;
}

export interface PtAudioFile {
  index: number;
  name: string;
  folder: string;
  found: boolean;
  url: string | null;
  peaksUrl: string | null;
  channels: number;
  sampleRate: number | null;
  duration: number | null;
}

export interface PtVideoFile {
  index: number;
  name: string;
  found: boolean;
  url: string | null;
  proxyUrl: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  playable: boolean;
}

export interface PtClip {
  index: number;
  track: number;
  name: string;
  start: number;
  length: number;
  offset: number;
  file: number;
  channels: (number | null)[];
  unit: 'samples' | 'frames' | 'ticks';
  url: string | null;
}

export interface PtVideoClip {
  index: number;
  track: number;
  name: string;
  start: number;
  length: number;
  offset: number;
  file: number;
}

export interface PtMarker {
  number: number;
  name: string;
  kind: 'marker' | 'selection';
  start: number;
  end: number | null;
  comment: string;
  category: string | null;
  colorIndex: number | null;
}

export interface PtSession {
  id: string;
  name: string;
  path: string;
  product: string;
  version: string;
  sampleRate: number;
  bitDepth: number | null;
  fps: number;
  fpsSource: 'session' | 'video' | 'session-guess' | 'default';
  dropFrame: boolean;
  startSeconds: number;
  duration: number;
  tracks: PtTrack[];
  audioFiles: PtAudioFile[];
  videoFiles: PtVideoFile[];
  clips: PtClip[];
  videoClips: PtVideoClip[];
  markers: PtMarker[];
  alternatePlaylists: Record<string, number>;
  warnings: string[];
}

let base = '/api';

export function setServerBase(url: string) {
  base = url.replace(/\/+$/, '') || '/api';
}

export function serverUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  // Payload URLs already start with /api/…; keep them relative to the configured base
  if (path.startsWith('/api/')) return base === '/api' ? path : base + path.slice(4);
  return base + (path.startsWith('/') ? path : '/' + path);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl(path), init);
  } catch {
    throw new Error('web UI server not reachable (npm run server, or the webui container)');
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* no JSON body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const serverApi = {
  health: () => json<ServerHealth>('/health'),
  browse: (path = '') => json<BrowseResult>(`/browse?path=${encodeURIComponent(path)}`),
  openSession: (path: string) => json<PtSession>('/sessions/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }),
  session: (id: string) => json<PtSession>(`/sessions/${id}`),
  /** Peaks of a whole audio file: 200 per second, 0..1 */
  async peaks(url: string): Promise<{ perSecond: number; peaks: Float32Array }> {
    const res = await fetch(serverUrl(url));
    if (!res.ok) throw new Error(`peaks ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 16 || String.fromCharCode(...buf.subarray(0, 4)) !== 'PEAK') throw new Error('bad peaks');
    const perSecond = view.getUint32(4, true);
    const n = view.getUint32(8, true);
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) peaks[i] = buf[16 + i] / 255;
    return { perSecond, peaks };
  },
  videoCutUrl: (sessionId: string, fileIndex: number, start: number, end: number) => serverUrl(`/sessions/${sessionId}/videos/${fileIndex}/cut?start=${start.toFixed(3)}&end=${end.toFixed(3)}`),
};
