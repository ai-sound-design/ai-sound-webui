import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { projectEnd, useStore } from '../store';
import type { AudioClip, AudioTrack, Marker, VideoClip } from '../types';
import { transport } from '../lib/transport';
import { exportMix } from '../lib/export';
import { addMarkerHere } from '../lib/edit';
import { dbToGain } from '../lib/envelope';
import { onSourcesChanged, peaksOf } from '../lib/sources';
import { importAudio, importVideos, isAudioFile, isVideoFile } from '../lib/media';
import { formatTime } from '../lib/util';
import { useClipInteraction } from './useClipInteraction';
import { Waveform } from './Waveform';
import { Btn } from './ui';
import { Download, Link2, ListPlus, Plus, Trash2, Volume2, VolumeX, X } from './icons';

export const HEADER_W = 200;
const VIDEO_H = 76;
const AUDIO_H = 64;

export const CATEGORY_COLORS: Record<string, string> = {
  foley: '#ffb547',
  sfx: '#ff6f91',
  ambience: '#4fb3ff',
  music: '#7ee081',
  dialogue: '#b18cff',
  scene: '#e3e36a',
  clip: '#8a93a6',
};

type ErrFn = (errors: string[]) => void;

export function Timeline({ onErrors }: { onErrors: ErrFn }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { tracks, pps, end, tool } = useStore(useShallow((s) => ({ tracks: s.audioTracks, pps: s.pxPerSec, end: projectEnd(s), tool: s.tool })));
  const hasVideo = useStore((s) => s.videoClips.length > 0);
  const duration = Math.max(60, end * 1.25 + 10);
  const width = duration * pps;

  // Ctrl/⌘ + mouse wheel zooms around the pointer
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useStore.getState();
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_W + el.scrollLeft;
      const t = x / s.pxPerSec;
      s.setZoom(s.pxPerSec * Math.exp(-e.deltaY * 0.002));
      el.scrollLeft = t * useStore.getState().pxPerSec - (x - el.scrollLeft);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className={`timeline tool-${tool}`} ref={scrollRef}>
      <div className="tl-content" style={{ width: HEADER_W + width }}>
        <div className="tl-sticky-top">
          <div className="tl-row ruler-row">
            <div className="tl-header ruler-label">Time</div>
            <div className="tl-lane ruler" style={{ width }} onPointerDown={scrubHandler}>
              <Ruler duration={duration} pps={pps} />
            </div>
          </div>
          <div className="tl-row marker-row">
            <div className="tl-header ruler-label">
              Memory locations
              <Btn icon={Plus} size="sm" variant="ghost" tip="Add a memory location at the playhead, or for the selection" kbd="M" onClick={addMarkerHere} />
            </div>
            <MarkerLane width={width} />
          </div>
        </div>

        <div className="tl-row" style={{ height: VIDEO_H }}>
          <VideoHeader />
          <Lane width={width} className="video-lane" onFiles={async (files, t) => onErrors(await importVideos(files.filter(isVideoFile), t))}>
            <VideoClips pps={pps} />
          </Lane>
        </div>

        {tracks.map((t) => (
          <div className="tl-row" key={t.id} style={{ height: AUDIO_H }}>
            <TrackHeader track={t} />
            <Lane width={width} trackId={t.id} className="audio-lane" onFiles={async (files, time) => onErrors(await importAudio(files.filter(isAudioFile), time, t.name))}>
              <AudioClips track={t} pps={pps} />
            </Lane>
          </div>
        ))}

        <div className="tl-row add-row">
          <div className="tl-header">
            <Btn icon={ListPlus} variant="ghost" className="add-track" label="Add audio track" onClick={() => useStore.getState().addTrack()} />
          </div>
          <div className="tl-hint">
            {!hasVideo
              ? 'Drop videos onto the video track (several at once work too). Audio files can be dropped onto audio tracks.'
              : tracks.length === 0
                ? 'Drag across the timeline to select a range, then run an AI tool from the Tools panel. Without a selection all videos are used.'
                : ''}
          </div>
        </div>

        <SelectionOverlay />
        <Playhead scrollRef={scrollRef} />
      </div>
    </div>
  );
}

const timeAtX = (clientX: number, lane: HTMLElement) => Math.max(0, (clientX - lane.getBoundingClientRect().left) / useStore.getState().pxPerSec);

/** Ruler: click or drag to move the playhead */
function scrubHandler(e: React.PointerEvent<HTMLDivElement>) {
  if (e.button !== 0) return;
  const lane = e.currentTarget;
  lane.setPointerCapture(e.pointerId);
  transport.seek(timeAtX(e.clientX, lane));
  const move = (ev: PointerEvent) => transport.seek(timeAtX(ev.clientX, lane));
  const up = () => {
    lane.removeEventListener('pointermove', move);
    lane.removeEventListener('pointerup', up);
  };
  lane.addEventListener('pointermove', move);
  lane.addEventListener('pointerup', up);
}

/** Track background: click sets the playhead, drag selects a range, shift-click extends it */
function selectHandler(e: React.PointerEvent<HTMLDivElement>) {
  if (e.button !== 0) return;
  const lane = e.currentTarget;
  lane.setPointerCapture(e.pointerId);
  const s = useStore.getState();
  s.selectClip(null);
  let t0 = timeAtX(e.clientX, lane);
  if (e.shiftKey && s.selection) {
    const t = t0;
    s.setSelection({ start: Math.min(s.selection.start, t), end: Math.max(s.selection.end, t) });
    t0 = t < s.selection.start ? s.selection.end : s.selection.start;
  } else {
    s.setSelection(null);
    transport.seek(t0);
  }
  const move = (ev: PointerEvent) => {
    const t = timeAtX(ev.clientX, lane);
    if (Math.abs(t - t0) * useStore.getState().pxPerSec < 3) return;
    const start = Math.min(t0, t);
    useStore.getState().setSelection({ start, end: Math.max(t0, t) });
    transport.seek(start);
  };
  const up = () => {
    lane.removeEventListener('pointermove', move);
    lane.removeEventListener('pointerup', up);
  };
  lane.addEventListener('pointermove', move);
  lane.addEventListener('pointerup', up);
}

function Lane({ width, className, trackId, onFiles, children }: { width: number; className: string; trackId?: string; onFiles: (files: File[], t: number) => void; children: React.ReactNode }) {
  const [dropX, setDropX] = useState<number | null>(null);
  return (
    <div
      className={`tl-lane ${className}`}
      style={{ width }}
      data-track-id={trackId}
      onPointerDown={selectHandler}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropX(timeAtX(e.clientX, e.currentTarget) * useStore.getState().pxPerSec);
      }}
      onDragLeave={() => setDropX(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDropX(null);
        // The app-wide drop handler must not import the files a second time
        (e.nativeEvent as DragEvent & { handled?: boolean }).handled = true;
        onFiles(Array.from(e.dataTransfer.files), timeAtX(e.clientX, e.currentTarget));
      }}
    >
      {children}
      {dropX !== null && <div className="drop-marker" style={{ left: dropX }} />}
    </div>
  );
}

function Ruler({ duration, pps }: { duration: number; pps: number }) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * pps >= 70) ?? 600;
  const ticks = [];
  for (let t = 0; t <= duration; t += step) {
    ticks.push(
      <div key={t} className="tick" style={{ left: t * pps }}>
        <span>{formatTime(t, step < 1)}</span>
      </div>,
    );
    for (let k = 1; k < 5; k++) ticks.push(<div key={`${t}-${k}`} className="tick minor" style={{ left: (t + (k * step) / 5) * pps }} />);
  }
  return <>{ticks}</>;
}

function MarkerLane({ width }: { width: number }) {
  const markers = useStore((s) => s.markers);
  const pps = useStore((s) => s.pxPerSec);
  // Spread overlapping markers over rows
  const rows: number[] = [];
  const placed = markers.map((m) => {
    const end = Math.max(m.end ?? m.start, m.start + 90 / pps);
    let row = rows.findIndex((r) => r <= m.start);
    if (row < 0) {
      rows.push(0);
      row = rows.length - 1;
    }
    rows[row] = end;
    return { m, row };
  });
  const rowH = Math.min(14, 40 / Math.max(1, rows.length));
  return (
    <div className="tl-lane marker-lane" style={{ width }} onPointerDown={scrubHandler}>
      {placed.map(({ m, row }) => (
        <MarkerView key={m.id} m={m} pps={pps} top={2 + row * rowH} height={rowH - 1} />
      ))}
    </div>
  );
}

function MarkerView({ m, pps, top, height }: { m: Marker; pps: number; top: number; height: number }) {
  const color = CATEGORY_COLORS[m.category ?? ''] ?? '#c9ced9';
  const w = m.end !== undefined ? Math.max(2, (m.end - m.start) * pps) : 0;
  return (
    <div
      className={m.end !== undefined ? 'marker range' : 'marker point'}
      style={{ left: m.start * pps, width: w || undefined, top, height, ['--c' as string]: color }}
      title={`${m.label}${m.category ? ` [${m.category}]` : ''}\n${formatTime(m.start)}${m.end !== undefined ? ' – ' + formatTime(m.end) : ''}${m.description ? '\n' + m.description : ''}\nClick: select · Double-click: rename`}
      onPointerDown={(e) => {
        e.stopPropagation();
        transport.seek(m.start);
        useStore.getState().setSelection(m.end !== undefined ? { start: m.start, end: m.end } : null);
      }}
      onDoubleClick={() => {
        const label = window.prompt('Memory location name', m.label);
        if (label !== null) {
          useStore.getState().checkpoint();
          useStore.getState().updateMarker(m.id, { label });
        }
      }}
    >
      <span>{m.label}</span>
      <button className="marker-x" aria-label="Delete marker" onPointerDown={(e) => e.stopPropagation()} onClick={() => useStore.getState().removeMarker(m.id)}>
        <X size={10} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function SelectionOverlay() {
  const sel = useStore((s) => s.selection);
  const pps = useStore((s) => s.pxPerSec);
  if (!sel) return null;
  return <div className="selection" style={{ left: HEADER_W + sel.start * pps, width: Math.max(1, (sel.end - sel.start) * pps) }} />;
}

function Playhead({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const t = useStore((s) => s.currentTime);
  const pps = useStore((s) => s.pxPerSec);
  const playing = useStore((s) => s.playing);
  const x = t * pps;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const visible = el.clientWidth - HEADER_W;
    if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - visible * 0.2);
  }, [x, playing, scrollRef]);
  return <div className="playhead" style={{ left: HEADER_W + x }} />;
}

function VideoHeader() {
  const videoAudio = useStore((s) => s.videoAudio);
  const setVideoAudio = useStore((s) => s.setVideoAudio);
  return (
    <div className="tl-header">
      <div className="track-name">
        <span className="dot" style={{ background: 'var(--brand-ice)' }} />
        Video
      </div>
      <div className="track-controls">
        <Btn size="sm" variant="ghost" icon={videoAudio ? Volume2 : VolumeX} label="Original audio" active={videoAudio} tip="Also play the videos' own sound" onClick={() => setVideoAudio(!videoAudio)} />
      </div>
    </div>
  );
}

function VideoClips({ pps }: { pps: number }) {
  const clips = useStore((s) => s.videoClips);
  return (
    <>
      {clips.map((c) => (
        <VideoClipView key={c.id} clip={c} pps={pps} />
      ))}
    </>
  );
}

function VideoClipView({ clip, pps }: { clip: VideoClip; pps: number }) {
  const selected = useStore((s) => s.selectedClip?.id === clip.id);
  const handlers = useClipInteraction({ kind: 'video', id: clip.id });
  const w = clip.length * pps;
  const thumbW = (VIDEO_H - 8) * (clip.width / clip.height || 16 / 9);
  const slots = Math.max(1, Math.ceil(w / thumbW));
  // Thumbnails matching the visible part of the source
  const thumbAt = (i: number) => {
    const src = clip.offset + ((i + 0.5) / slots) * clip.length;
    return clip.thumbs[Math.min(clip.thumbs.length - 1, Math.floor((src / clip.sourceDuration) * clip.thumbs.length))];
  };
  return (
    <div className={`clip video-clip ${selected ? 'selected' : ''}`} style={{ left: clip.start * pps, width: w }} title={`${clip.name}\n${formatTime(clip.start)} – ${formatTime(clip.start + clip.length)}`} {...handlers}>
      <div className="filmstrip">{clip.thumbs.length > 0 && Array.from({ length: slots }, (_, i) => <img key={i} src={thumbAt(i)} style={{ width: thumbW }} draggable={false} alt="" />)}</div>
      <div className="clip-bar">
        <span className="clip-name">{clip.name}</span>
      </div>
    </div>
  );
}

function TrackHeader({ track }: { track: AudioTrack }) {
  const update = useStore((s) => s.updateTrack);
  const remove = useStore((s) => s.removeTrack);
  const [editing, setEditing] = useState(false);
  return (
    <div className="tl-header">
      <div className="track-name" title={`${track.name} (double-click to rename)`} onDoubleClick={() => setEditing(true)}>
        <span className="dot" style={{ background: track.color }} />
        {editing ? (
          <input
            autoFocus
            defaultValue={track.name}
            onBlur={(e) => {
              update(track.id, { name: e.target.value || track.name });
              setEditing(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          track.name
        )}
      </div>
      <div className="track-controls">
        <button className={`ms mute ${track.muted ? 'is-active' : ''}`} onClick={() => update(track.id, { muted: !track.muted })} data-tip="Mute">
          M
        </button>
        <button className={`ms solo ${track.solo ? 'is-active' : ''}`} onClick={() => update(track.id, { solo: !track.solo })} data-tip="Solo">
          S
        </button>
        <input className="vol" type="range" min={0} max={1.5} step={0.01} value={track.volume} onChange={(e) => update(track.id, { volume: Number(e.target.value) })} data-tip={`Volume ${Math.round(track.volume * 100)} %`} aria-label="Volume" />
        <span className="spacer" />
        <Btn icon={Download} size="sm" variant="ghost" tip="Export track as WAV" onClick={() => void exportMix(track.id)} />
        <Btn icon={Trash2} size="sm" variant="ghost" tip="Delete track" onClick={() => remove(track.id)} />
      </div>
    </div>
  );
}

function AudioClips({ track, pps }: { track: AudioTrack; pps: number }) {
  const clips = useStore(useShallow((s) => s.audioClips.filter((a) => a.trackId === track.id)));
  const silent = useStore((s) => track.muted || (s.audioTracks.some((t) => t.solo) && !track.solo));
  return (
    <div className={silent ? 'lane-clips silent' : 'lane-clips'}>
      {clips.map((a) => (
        <AudioClipView key={a.id} clip={a} pps={pps} color={track.color} />
      ))}
    </div>
  );
}

function AudioClipView({ clip, pps, color }: { clip: AudioClip; pps: number; color: string }) {
  const selected = useStore((s) => s.selectedClip?.id === clip.id);
  const handlers = useClipInteraction({ kind: 'audio', id: clip.id });
  const w = clip.length * pps;
  const h = AUDIO_H - 6;
  // Draw the waveform of the whole source and shift it by the offset
  const fullW = clip.source.duration * pps;
  const peaks = usePeaks(clip);
  const fi = clip.fadeIn * pps;
  const fo = clip.fadeOut * pps;
  return (
    <div
      className={`clip audio-clip ${selected ? 'selected' : ''}`}
      style={{ left: clip.start * pps, width: w, borderColor: color, background: `${color}26` }}
      title={`${clip.name}\n${formatTime(clip.start)} – ${formatTime(clip.start + clip.length)}${clip.gain ? `\nGain ${clip.gain > 0 ? '+' : ''}${clip.gain.toFixed(1)} dB` : ''}${clip.linkedVideoId ? '\n(follows its video)' : ''}`}
      {...handlers}
    >
      <div className="wave-wrap" style={{ left: -clip.offset * pps, width: fullW }}>
        {peaks ? <Waveform peaks={peaks} width={fullW} height={AUDIO_H - 22} color={color} scale={dbToGain(clip.gain)} /> : <div className="wave-pending" style={{ width: fullW, height: AUDIO_H - 22 }} />}
      </div>
      {(fi > 0 || fo > 0) && (
        <svg className="fades" width={w} height={h} viewBox={`0 0 ${Math.max(1, w)} ${h}`} preserveAspectRatio="none">
          {fi > 0 && <path d={`M0 ${h} L0 0 L${fi} 0 Q${fi * 0.3} ${h * 0.3} 0 ${h} Z`} />}
          {fo > 0 && <path d={`M${w} ${h} L${w} 0 L${w - fo} 0 Q${w - fo * 0.3} ${h * 0.3} ${w} ${h} Z`} />}
          {fi > 0 && <path className="line" d={`M0 ${h} Q${fi * 0.3} ${h * 0.3} ${fi} 0`} />}
          {fo > 0 && <path className="line" d={`M${w} ${h} Q${w - fo * 0.3} ${h * 0.3} ${w - fo} 0`} />}
        </svg>
      )}
      <span className="clip-name" style={{ color }}>
        {clip.linkedVideoId && <Link2 size={11} strokeWidth={2.25} className="link-ico" />}
        {clip.name}
        {clip.gain ? <em className="gain-tag">{`${clip.gain > 0 ? '+' : ''}${clip.gain.toFixed(1)} dB`}</em> : null}
      </span>
    </div>
  );
}

/** Waveform peaks of a clip's source; session audio peaks arrive from the server */
function usePeaks(clip: AudioClip): Float32Array | undefined {
  return useSyncExternalStore(onSourcesChanged, () => peaksOf(clip.source));
}
