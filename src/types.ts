export interface VideoClip {
  id: string;
  name: string;
  /** The file in the browser (dropped or from a project); absent for session videos served by the server */
  file?: File;
  /** Playback URL: an object URL for a File, or the server's URL for a session video */
  url: string;
  /** A video of an open Pro Tools session: the server cuts pieces of it for the AI services */
  remote?: { sessionId: string; fileIndex: number };
  /** Duration of the source file (s) */
  sourceDuration: number;
  width: number;
  height: number;
  /** Position on the timeline (s) */
  start: number;
  /** In-point within the source file (s), changed by trimming the left edge */
  offset: number;
  /** Visible length on the timeline (s) */
  length: number;
  thumbs: string[];
}

export interface AudioTrack {
  id: string;
  name: string;
  color: string;
  volume: number;
  muted: boolean;
  solo: boolean;
}

/**
 * Where a clip's audio comes from. Decoded audio and peaks live outside the
 * store (lib/sources.ts): generated and imported sounds are kept in memory,
 * session files are fetched from the server in pieces as playback needs them.
 */
export interface AudioSource {
  id: string;
  /** Length of the whole source (s) */
  duration: number;
  channels: number;
  /** Server file URL (session audio); absent for in-memory sources */
  url?: string;
  /** Source channels to use when the file has more than the clip (e.g. ".L" of a stereo file) */
  channelMap?: number[];
  /** Server peaks URL (session audio) */
  peaksUrl?: string;
}

export interface AudioClip {
  id: string;
  trackId: string;
  name: string;
  source: AudioSource;
  start: number;
  offset: number;
  length: number;
  /** Clip gain in dB */
  gain: number;
  /** Fade lengths in seconds (equal-power curves) */
  fadeIn: number;
  fadeOut: number;
  /** Generated from this video clip; moves along when the video is moved */
  linkedVideoId?: string;
}

/** Memory location: a point (end undefined) or a range */
export interface Marker {
  id: string;
  start: number;
  end?: number;
  label: string;
  category?: string;
  description?: string;
  /** Number in the Pro Tools session it came from */
  number?: number;
}

export interface Range {
  start: number;
  end: number;
}

export type ClipRef = { kind: 'video' | 'audio'; id: string };

/** Edit tools, modelled on the usual DAW tool palette */
export type Tool = 'smart' | 'select' | 'grab' | 'trim' | 'blade' | 'fade';

/** Spotting · Recommendation (from the DB) · Generation (AI) · Hybrid (DB sounds via AI spotting + generated intermediate sounds) */
export type AiMode = 'spotting' | 'search' | 'generation' | 'hybrid';

export interface ServiceUrls {
  generation: string;
  search: string;
  spotting: string;
  hybrid: string;
}

export interface Settings {
  /** Simulate every service in the browser, no backend needed */
  mock: boolean;
  urls: ServiceUrls;
  /** Generation: accepted length per request (gateway: 4–600 s, bare MMAudio: 4–12 s); refreshed from /health */
  genMin: number;
  genMax: number;
  /** Timecode frame rate sent with every request (taken from an open session) */
  fps: number;
  /** Hybrid: database match parameters, as in the plugin's hybrid profile */
  piecesPer10s: number;
  minPieceSeconds: number;
  layers: number;
  minSimilarity: number;
  textWeight: number;
  splitGain: number;
  /** Seconds of a library recording kept before and after an ambience event (0 = off) */
  ambienceHandle: number;
  /** Tracks a scene's sounds may share, per kind (gen/db) */
  tracksPerScene: number;
  /** Fades given to placed library clips */
  fadeSeconds: number;
  /** Fade over the handle outside the event (false) or inside it (true) */
  fadeInside: boolean;
}

export type SoundKind = 'ambience' | 'foley' | 'sfx' | 'music' | 'dialogue';
export type SearchSource = 'video' | 'sound' | 'sketch';
export type HybridEvents = 'spot' | 'markers-rest' | 'markers-only';

export interface AiParams {
  mode: AiMode;
  prompt: string;
  negativePrompt: string;
  seed: number;
  /** Track the results go to ('' = the mode's own track) */
  targetTrackId: string;
  /** Generation without video (text-to-audio) */
  textOnly: boolean;
  /** T2A length in seconds; 0 = Auto (the selection) */
  t2aDuration: number;
  /** Recommendation */
  searchSource: SearchSource;
  searchLimit: number;
  textWeight: number;
  library: string;
  cutToSelection: boolean;
  keepHandles: boolean;
  autoFade: boolean;
  /** Spotting */
  detectScenes: boolean;
  detectEvents: boolean;
  kinds: SoundKind[];
  clipMarkers: boolean;
  hints: string;
  /** Hybrid */
  hybridEvents: HybridEvents;
  replaceEarlier: boolean;
  useDatabase: boolean;
  /** Keep the generated intermediate sounds on the scene's "(gen)" tracks */
  keepGenerated: boolean;
  hybridHandles: boolean;
  hybridAutoFade: boolean;
}

export type JobStatus = 'running' | 'done' | 'error';

export interface Job {
  id: string;
  mode: AiMode;
  title: string;
  status: JobStatus;
  progress: number;
  detail?: string;
  error?: string;
  startedAt: number;
}

export interface SearchResult {
  id: number | string;
  description: string;
  category?: string;
  library?: string;
  collection?: string;
  duration_seconds?: number;
  similarity?: number;
  external_id?: string;
  /** Search by sound: the stretch of the recording that matches */
  offset_seconds?: number;
  length_seconds?: number;
  /** mock only */
  buffer?: AudioBuffer;
}

/** The Pro Tools session the project was opened from (read through the server) */
export interface SessionInfo {
  id: string;
  name: string;
  path: string;
  product: string;
  version: string;
  sampleRate: number;
  fps: number;
  fpsSource: string;
  startSeconds: number;
  /** Every track of the session, including aux, master, VCA and folder tracks */
  tracks: { index: number; name: string; kind: string; format: string; channels: number }[];
  warnings: string[];
}
