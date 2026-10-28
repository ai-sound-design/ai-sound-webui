import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, videoPiecesIn, workRange } from '../store';
import type { AiMode, AiParams, AudioClip, HybridEvents, SearchResult, SearchSource, SoundKind, Tool } from '../types';
import { DEFAULT_NEGATIVE, KINDS, importSearchResult, loadPreview, runners, stopRun } from '../lib/ai';
import { libraries, type Library } from '../api/services';
import { AudioWaveform, CircleStop, Film, Pencil } from 'lucide-react';
import * as edit from '../lib/edit';
import { engine } from '../lib/engine';
import { formatTime } from '../lib/util';
import { Btn } from './ui';
import {
  AudioLines, ChevronRight, CircleAlert, CircleCheck, Copy, Crop, Crossfade, Database, FadeIn, FadeOut, FadeTool, Flag, Layers, ListPlus,
  LoaderCircle, Minus, Move, Play, Plus, ScanSearch, Scissors, SmartTool, Sparkles, Square, SquareSplitHorizontal, TextCursor, Trash2, TrimTool,
  WandSparkles, type IconType,
} from './icons';

export const TOOLS: { id: Tool; icon: IconType; label: string; key: string; hint: string }[] = [
  { id: 'smart', icon: SmartTool, label: 'Smart', key: '1', hint: 'Body: move · edges: trim · top corners: fade · empty lane: select' },
  { id: 'select', icon: TextCursor, label: 'Select', key: '2', hint: 'Drag anywhere, also across clips, to select a range' },
  { id: 'grab', icon: Move, label: 'Grab', key: '3', hint: 'Move clips (audio also to other tracks)' },
  { id: 'trim', icon: TrimTool, label: 'Trim', key: '4', hint: 'Drag the nearer clip edge' },
  { id: 'blade', icon: Scissors, label: 'Blade', key: '5', hint: 'Click a clip to split it there' },
  { id: 'fade', icon: FadeTool, label: 'Fade', key: '6', hint: 'Drag in the left half for a fade-in, in the right half for a fade-out' },
];

const AI_MODES: { id: AiMode; label: string; icon: IconType; info: string }[] = [
  { id: 'spotting', label: 'Spotting', icon: ScanSearch, info: 'The AI detects the sound events in the picture and adds them as memory locations (spotting-api).' },
  { id: 'search', label: 'Recommendation', icon: Database, info: 'Recommends sounds from the database that match the video, a text or both (sound-search-api).' },
  { id: 'generation', label: 'Generation', icon: WandSparkles, info: 'The AI generates sound from video + prompt, or from the prompt alone (generation gateway in front of MMAudio). Pieces longer than the service accepts are split.' },
  { id: 'hybrid', label: 'Hybrid', icon: Layers, info: 'Database sounds per sound event: the AI spots the events, generates an intermediate sound for each and uses it to find matching recordings in the database (hybrid-api).' },
];

export function ToolsPanel() {
  return (
    <aside className="tools">
      <Section id="edit" title="Edit">
        <EditSection />
      </Section>
      <Section id="clip" title="Clip">
        <ClipInspector />
      </Section>
      <Section id="ai" title="AI tools">
        <AiSection />
      </Section>
      <JobsSection />
    </aside>
  );
}

function Section({ id, title, extra, children }: { id: string; title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  const open = useStore((s) => s.ui.sections[id] ?? true);
  const toggle = useStore((s) => s.toggleSection);
  return (
    <section className={`tool-section ${open ? 'open' : ''}`}>
      <header onClick={() => toggle(id)}>
        <ChevronRight className="chev" size={14} strokeWidth={2} />
        {title}
        <span className="spacer" />
        {extra}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────────

function EditSection() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const hasSel = useStore((s) => !!s.selection);
  const clip = useStore((s) => s.selectedClip);
  const hasAudioTarget = useStore((s) => s.selectedClip?.kind === 'audio' || (!!s.selection && s.audioClips.some((c) => c.start < s.selection!.end && c.start + c.length > s.selection!.start)));
  const active = TOOLS.find((t) => t.id === tool)!;

  return (
    <>
      <div className="palette">
        {TOOLS.map((t) => (
          <button key={t.id} className={t.id === tool ? 'tool is-active' : 'tool'} onClick={() => setTool(t.id)} data-tip={t.hint} data-kbd={t.key}>
            <t.icon size={18} strokeWidth={1.6} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <p className="hint">{active.hint}</p>
      <div className="actions-grid">
        <Action icon={SquareSplitHorizontal} label="Split" kbd="B" onClick={edit.splitAtPlayhead} tip="Split at the playhead (selected clip, else all clips under it)" />
        <Action icon={Copy} label="Duplicate" kbd="Ctrl D" onClick={edit.duplicate} disabled={!clip} tip="Copy the selected clip right after itself" />
        <Action icon={Crop} label="Crop" kbd="Ctrl T" onClick={edit.cropToSelection} disabled={!hasSel} tip="Crop clips to the selection" />
        <Action icon={Trash2} label="Delete" kbd="Del" onClick={edit.deleteSelected} disabled={!clip} tip="Delete the selected clip" />
        <Action icon={FadeIn} label="Fade in" kbd="G" onClick={edit.fadeIn} disabled={!hasAudioTarget} tip="Fade in up to the selection end (or 0.5 s)" />
        <Action icon={FadeOut} label="Fade out" kbd="H" onClick={edit.fadeOut} disabled={!hasAudioTarget} tip="Fade out from the selection start (or 0.5 s)" />
        <Action icon={Crossfade} label="Crossfade" kbd="F" onClick={edit.crossfade} disabled={!hasSel} tip="Crossfade adjacent clips within the selection" />
        <Action icon={AudioLines} label="Normalize" kbd="N" onClick={edit.normalize} disabled={!hasAudioTarget} tip="Clip gain so the peak reaches −1 dBFS" />
        <Action icon={Minus} label="Gain −1 dB" kbd="[" onClick={() => edit.nudgeGain(-1)} disabled={!hasAudioTarget} tip="Lower the clip gain by 1 dB" />
        <Action icon={Plus} label="Gain +1 dB" kbd="]" onClick={() => edit.nudgeGain(1)} disabled={!hasAudioTarget} tip="Raise the clip gain by 1 dB" />
        <Action icon={Flag} label="Marker" kbd="M" onClick={edit.addMarkerHere} tip="Memory location at the playhead, or for the selection" />
        <Action icon={ListPlus} label="New track" kbd="" onClick={() => useStore.getState().addTrack()} tip="Add an empty audio track" />
      </div>
    </>
  );
}

function Action({ icon: Icon, label, kbd, onClick, disabled, tip }: { icon: IconType; label: string; kbd: string; onClick: () => void; disabled?: boolean; tip: string }) {
  return (
    <button className="action" onClick={onClick} disabled={disabled} data-tip={tip} data-kbd={kbd || undefined}>
      <Icon size={15} strokeWidth={1.75} />
      <span className="action-label">{label}</span>
    </button>
  );
}

// ── Clip inspector ──────────────────────────────────────────────────────────

function ClipInspector() {
  const clip = useStore(
    useShallow((s) => {
      const r = s.selectedClip;
      if (!r) return null;
      return (r.kind === 'video' ? s.videoClips.find((c) => c.id === r.id) : s.audioClips.find((c) => c.id === r.id)) ?? null;
    }),
  );
  const tracks = useStore((s) => s.audioTracks);
  if (!clip) return <p className="muted small">Select a clip to see and edit its properties.</p>;
  const audio = 'source' in clip ? (clip as AudioClip) : null;
  const s = useStore.getState();
  const set = (patch: Partial<AudioClip>) => {
    s.checkpoint();
    if (audio) s.setAudioClip(audio.id, patch);
    else s.setVideoClip(clip.id, patch);
  };

  return (
    <div className="inspector">
      <label className="field">
        Name
        <input key={clip.id} defaultValue={clip.name} onBlur={(e) => e.target.value !== clip.name && set({ name: e.target.value })} />
      </label>
      <div className="kv">
        <span>Start</span>
        <b>{formatTime(clip.start)}</b>
        <span>Length</span>
        <b>{formatTime(clip.length)}</b>
        <span>Source in</span>
        <b>{formatTime(clip.offset)}</b>
        {audio && (
          <>
            <span>Track</span>
            <b>{tracks.find((t) => t.id === audio.trackId)?.name}</b>
          </>
        )}
      </div>
      {audio && (
        <>
          <label className="field">
            Clip gain {audio.gain > 0 ? '+' : ''}
            {audio.gain.toFixed(1)} dB
            <input type="range" min={-24} max={12} step={0.5} value={audio.gain} onChange={(e) => s.setAudioClip(audio.id, { gain: Number(e.target.value) })} onPointerDown={() => s.checkpoint()} onDoubleClick={() => set({ gain: 0 })} />
          </label>
          <div className="row">
            <label className="field grow">
              Fade in (s)
              <input type="number" min={0} step={0.1} value={+audio.fadeIn.toFixed(2)} onChange={(e) => set({ fadeIn: Number(e.target.value) })} />
            </label>
            <label className="field grow">
              Fade out (s)
              <input type="number" min={0} step={0.1} value={+audio.fadeOut.toFixed(2)} onChange={(e) => set({ fadeOut: Number(e.target.value) })} />
            </label>
          </div>
          {audio.linkedVideoId && (
            <label className="check">
              <input type="checkbox" checked onChange={() => set({ linkedVideoId: undefined })} />
              Follows its video clip
            </label>
          )}
        </>
      )}
    </div>
  );
}

// ── AI tools ────────────────────────────────────────────────────────────────

function AiSection() {
  const params = useStore((s) => s.params);
  const setParams = useStore((s) => s.setParams);
  const settings = useStore((s) => s.settings);
  const tracks = useStore((s) => s.audioTracks);
  const running = useStore((s) => s.jobs.some((j) => j.status === 'running'));
  const mode = AI_MODES.find((m) => m.id === params.mode)!;
  const toggleKind = (k: SoundKind) => setParams({ kinds: params.kinds.includes(k) ? params.kinds.filter((x) => x !== k) : [...params.kinds, k] });
  const kindsDisabled = (params.mode === 'spotting' && !params.detectEvents) || (params.mode === 'hybrid' && params.hybridEvents === 'markers-only');
  const defaultTrack = params.mode === 'search' ? 'DB' : params.mode === 'generation' ? 'Generation' : '';

  return (
    <div className="ai">
      <div className="segmented" role="tablist">
        {AI_MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={m.id === params.mode} className={m.id === params.mode ? 'is-active' : ''} onClick={() => setParams({ mode: m.id })}>
            <m.icon size={15} strokeWidth={1.75} />
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted small">{mode.info}</p>
      <RangeInfo />

      {params.mode !== 'spotting' && (
        <label className="field">
          {params.mode === 'search' ? 'Search text' : 'Prompt'}{' '}
          <span className="muted">
            {params.mode === 'search' ? (params.searchSource === 'sketch' ? '(what the sound is; required)' : '(optional)') : params.mode === 'hybrid' ? '(optional, added to every event)' : '(optional)'}
          </span>
          <textarea rows={2} value={params.prompt} onChange={(e) => setParams({ prompt: e.target.value })} placeholder={params.mode === 'search' ? 'e.g. footsteps on gravel' : 'e.g. rain on a window, night'} />
        </label>
      )}

      {(params.mode === 'generation' || params.mode === 'hybrid') && (
        <div className="row">
          <label className="field grow">
            Negative prompt
            <input
              value={params.negativePrompt}
              onChange={(e) => setParams({ negativePrompt: e.target.value })}
              placeholder={params.mode === 'generation' ? `empty: ${DEFAULT_NEGATIVE}` : 'empty: built per event from the other events'}
            />
          </label>
          <label className="field seed">
            Seed
            <input type="number" value={params.seed} onChange={(e) => setParams({ seed: Number(e.target.value) })} title="-1 = a fresh random seed every run; the seed used is in the job's result" />
          </label>
        </div>
      )}

      {params.mode === 'generation' && (
        <>
          <div className="segmented two" role="tablist">
            <button role="tab" aria-selected={!params.textOnly} className={!params.textOnly ? 'is-active' : ''} onClick={() => setParams({ textOnly: false })}>
              <Film size={14} strokeWidth={1.75} /> V2A: video + prompt
            </button>
            <button role="tab" aria-selected={params.textOnly} className={params.textOnly ? 'is-active' : ''} onClick={() => setParams({ textOnly: true })}>
              <TextCursor size={14} strokeWidth={1.75} /> T2A: prompt only
            </button>
          </div>
          {params.textOnly && (
            <label className="field">
              Duration
              <select value={params.t2aDuration} onChange={(e) => setParams({ t2aDuration: Number(e.target.value) })}>
                <option value={0}>Auto (the selection, at least {settings.genMin} s)</option>
                {durationSteps(settings.genMin, settings.genMax).map((d) => (
                  <option key={d} value={d}>
                    {d} s
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {params.mode === 'search' && (
        <>
          <div className="segmented three" role="tablist">
            {SEARCH_SOURCES.map(([id, label, Icon]) => (
              <button key={id} role="tab" aria-selected={params.searchSource === id} className={params.searchSource === id ? 'is-active' : ''} onClick={() => setParams({ searchSource: id })}>
                <Icon size={14} strokeWidth={1.75} /> {label}
              </button>
            ))}
          </div>
          <p className="muted small">
            {params.searchSource === 'video'
              ? 'Searches with the video under the marked range (and the text, if any).'
              : params.searchSource === 'sound'
                ? 'Searches with the audio under the selection (the selected clip, else all audible tracks), to swap a sound for archive recordings of the same kind.'
                : 'The clips under the selection are a sketch of how the sound runs (a voice, taps on a desk); the words say what it is. The sketch chooses the stretch inside each recording.'}
          </p>
          <div className="row">
            {params.searchSource === 'video' && (
              <label className="field grow">
                Text weight {Math.round(params.textWeight * 100)} %
                <input type="range" min={0} max={1} step={0.05} value={params.textWeight} onChange={(e) => setParams({ textWeight: Number(e.target.value) })} />
              </label>
            )}
            <label className="field seed">
              Sounds per search
              <select value={params.searchLimit} onChange={(e) => setParams({ searchLimit: Number(e.target.value) })}>
                {[5, 10, 15, 20, 30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <LibraryField />
          <label className="check">
            <input type="checkbox" checked={params.cutToSelection} onChange={(e) => setParams({ cutToSelection: e.target.checked })} />
            Cut imports to the selection
          </label>
          <label className="check sub">
            <input type="checkbox" disabled={!params.cutToSelection} checked={params.keepHandles} onChange={(e) => setParams({ keepHandles: e.target.checked })} />
            Keep handles ({settings.ambienceHandle} s before and after, for the Trim tool)
          </label>
          <label className="check sub">
            <input type="checkbox" disabled={!params.cutToSelection} checked={params.autoFade} onChange={(e) => setParams({ autoFade: e.target.checked })} />
            Auto fade ({settings.fadeSeconds} s, {settings.fadeInside ? 'inside' : 'outside'} the range)
          </label>
        </>
      )}

      {params.mode === 'spotting' && (
        <>
          <label className="check">
            <input type="checkbox" checked={params.detectScenes} onChange={(e) => setParams({ detectScenes: e.target.checked })} />
            Detect scenes (one memory location per place and time; Hybrid uses them)
          </label>
          <label className="check">
            <input type="checkbox" checked={params.detectEvents} onChange={(e) => setParams({ detectEvents: e.target.checked })} />
            Detect sound events
          </label>
          <label className="field">
            Scene hints <span className="muted">(optional)</span>
            <input value={params.hints} onChange={(e) => setParams({ hints: e.target.value })} placeholder="e.g. interior, kitchen, rain outside" disabled={!params.detectEvents} />
          </label>
          <label className="check">
            <input type="checkbox" checked={params.clipMarkers} onChange={(e) => setParams({ clipMarkers: e.target.checked })} />
            Memory location per clip boundary
          </label>
        </>
      )}

      {params.mode === 'hybrid' && (
        <>
          <label className="field">
            Events
            <select value={params.hybridEvents} onChange={(e) => setParams({ hybridEvents: e.target.value as HybridEvents })}>
              <option value="spot">Spot everything (the backend finds the events)</option>
              <option value="markers-rest">Memory locations, spot the rest</option>
              <option value="markers-only">Memory locations only (clips without are skipped)</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={params.replaceEarlier} onChange={(e) => setParams({ replaceEarlier: e.target.checked })} />
            Replace earlier hybrid clips in the range
          </label>
          <label className="check">
            <input type="checkbox" checked={params.useDatabase} onChange={(e) => setParams({ useDatabase: e.target.checked })} />
            Use database sounds (library recordings that sound like each generated sound)
          </label>
          <label className="check sub">
            <input type="checkbox" disabled={!params.useDatabase} checked={params.keepGenerated} onChange={(e) => setParams({ keepGenerated: e.target.checked })} />
            Keep generated sounds too (on muted (gen) tracks)
          </label>
          <label className="check sub">
            <input type="checkbox" disabled={!params.useDatabase} checked={params.hybridHandles} onChange={(e) => setParams({ hybridHandles: e.target.checked })} />
            Keep ambience handles ({settings.ambienceHandle} s)
          </label>
          <label className="check sub">
            <input type="checkbox" disabled={!params.useDatabase} checked={params.hybridAutoFade} onChange={(e) => setParams({ hybridAutoFade: e.target.checked })} />
            Auto fade ({settings.fadeSeconds} s, {settings.fadeInside ? 'inside' : 'outside'} the event)
          </label>
          {params.useDatabase && <LibraryField />}
        </>
      )}

      {(params.mode === 'spotting' || params.mode === 'hybrid') && (
        <>
          <span className="opt-label">Kinds of sound {kindsDisabled ? '(from the memory locations)' : params.kinds.length === KINDS.length || !params.kinds.length ? '(all)' : ''}</span>
          <div className="kinds">
            {KINDS.map((k) => (
              <button key={k.id} type="button" className={`kind ${params.kinds.includes(k.id) ? 'is-active' : ''}`} disabled={kindsDisabled} onClick={() => toggleKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
        </>
      )}

      {(params.mode === 'generation' || params.mode === 'search') && (
        <label className="field">
          Place on track
          <select value={params.targetTrackId} onChange={(e) => setParams({ targetTrackId: e.target.value })}>
            <option value="">New or existing track {defaultTrack}</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="run-row">
        <Btn variant="primary" className="run" disabled={running} onClick={() => void runners[params.mode]()} icon={running ? SpinIcon : Sparkles} label={running ? 'Running …' : runLabel(params)}>
          {settings.mock && <span className="badge">Mock</span>}
        </Btn>
        {(params.mode === 'spotting' || params.mode === 'hybrid') && !running && (
          <Btn
            variant="outline"
            className="run secondary"
            icon={Film}
            label="Entire track"
            tip="Run on the whole video track, clip by clip"
            onClick={() => {
              if (window.confirm(`Run ${mode.label} on the whole video track? This can take a long time.`)) void runners[params.mode](true);
            }}
          />
        )}
        {running && <Btn variant="outline" className="run secondary" icon={CircleStop} label="Stop" tip="Stop after the current request; what was placed stays" onClick={stopRun} />}
      </div>

      {params.mode === 'search' && <SearchResults />}
    </div>
  );
}

const SEARCH_SOURCES: [SearchSource, string, IconType][] = [
  ['video', 'From video', Film],
  ['sound', 'From sound', AudioWaveform],
  ['sketch', 'From sketch', Pencil],
];

function runLabel(p: AiParams): string {
  switch (p.mode) {
    case 'spotting':
      return 'Spot selection';
    case 'search':
      return 'Recommend sounds';
    case 'generation':
      return 'Generate sound';
    default:
      return 'Generate sound events';
  }
}

/** The T2A length list: whole seconds from the minimum to the maximum, in at most about 40 steps */
function durationSteps(min: number, max: number): number[] {
  const step = Math.max(1, Math.ceil((max - min) / 40));
  const out: number[] = [];
  for (let d = Math.ceil(min); d <= max; d += step) out.push(d);
  return out;
}

/** Library choice, filled from the search service; several can be chosen */
function LibraryField() {
  const params = useStore((s) => s.params);
  const setParams = useStore((s) => s.setParams);
  const settings = useStore((s) => s.settings);
  const [libs, setLibs] = useState<Library[] | null>(null);
  useEffect(() => {
    if (settings.mock) {
      setLibs([{ library: 'mock', sounds: 7 }]);
      return;
    }
    libraries(settings.urls)
      .then(setLibs)
      .catch(() => setLibs([]));
  }, [settings.mock, settings.urls]);
  const chosen = params.library
    ? params.library
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  if (libs && libs.length > 1) {
    return (
      <>
        <span className="opt-label">Libraries {chosen.length ? '' : '(all)'}</span>
        <div className="kinds">
          {libs.map((l) => (
            <button
              key={l.library}
              type="button"
              className={`kind ${chosen.includes(l.library) ? 'is-active' : ''}`}
              title={`${l.sounds} sounds${l.hours ? `, ${l.hours.toFixed(0)} h` : ''}`}
              onClick={() => setParams({ library: (chosen.includes(l.library) ? chosen.filter((x) => x !== l.library) : [...chosen, l.library]).join(',') })}
            >
              {l.library}
            </button>
          ))}
        </div>
      </>
    );
  }
  return (
    <label className="field">
      Library <span className="muted">(empty = all{libs?.length === 1 ? `: ${libs[0].library}, ${libs[0].sounds} sounds` : ''})</span>
      <input value={params.library} onChange={(e) => setParams({ library: e.target.value })} placeholder={libs?.[0]?.library ?? 'bbc'} />
    </label>
  );
}

function RangeInfo() {
  // Re-render when the selection, the selected clip or the clips change
  useStore(useShallow((s) => [s.selection, s.selectedClip, s.videoClips, s.audioClips.length]));
  const params = useStore((s) => s.params);
  const hasSel = useStore((s) => !!s.selection);
  const hasClip = useStore((s) => !!s.selectedClip);
  if (params.mode === 'generation' && params.textOnly) return <div className="range-info">Target: the selection, else the playhead</div>;
  if (params.mode === 'search' && params.searchSource !== 'video') {
    const s = useStore.getState();
    const sel = s.selection;
    if (sel)
      return (
        <div className="range-info">
          <strong>Selection</strong> {formatTime(sel.start)} – {formatTime(sel.end)} · audio of {s.selectedClip?.kind === 'audio' ? 'the selected clip' : 'all audible tracks'}
        </div>
      );
    if (s.selectedClip?.kind === 'audio')
      return (
        <div className="range-info">
          <strong>Selected clip</strong> · its audio
        </div>
      );
    return <div className="range-info warn">Select a range or an audio clip</div>;
  }
  const r = workRange();
  if (!r) return <div className="range-info warn">No videos in the timeline yet</div>;
  const pieces = videoPiecesIn(r);
  const source = hasSel ? 'Selection' : hasClip ? 'Selected clip' : 'All videos';
  return (
    <div className={pieces.length ? 'range-info' : 'range-info warn'}>
      <strong>{source}</strong> {formatTime(r.start)} – {formatTime(r.end)} · {pieces.length} video piece{pieces.length === 1 ? '' : 's'}
    </div>
  );
}

function SearchResults() {
  const results = useStore((s) => s.searchResults);
  const [playing, setPlaying] = useState<SearchResult['id'] | null>(null);
  const [loading, setLoading] = useState<SearchResult['id'] | null>(null);
  const src = useRef<AudioBufferSourceNode | null>(null);

  const stop = () => {
    src.current?.stop();
    src.current = null;
    setPlaying(null);
  };
  useEffect(() => stop, []);

  const preview = async (r: SearchResult) => {
    if (playing === r.id) return stop();
    stop();
    setLoading(r.id);
    try {
      const buffer = await loadPreview(r);
      const ctx = engine.context();
      await ctx.resume();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => setPlaying((p) => (p === r.id ? null : p));
      node.start();
      src.current = node;
      setPlaying(r.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(null);
    }
  };

  if (!results.length) return null;
  return (
    <ul className="results">
      {results.map((r) => (
        <li key={r.id}>
          <Btn size="sm" variant="outline" icon={loading === r.id ? SpinIcon : playing === r.id ? Square : Play} tip={playing === r.id ? 'Stop preview' : r.offset_seconds !== undefined ? 'Preview the matched stretch' : 'Preview'} onClick={() => void preview(r)} />
          <div className="result-text">
            <div>{r.description}</div>
            <small className="muted">
              {[r.library, r.category, r.duration_seconds && `${r.duration_seconds.toFixed(1)} s`, r.similarity !== undefined && `${Math.round(r.similarity * 100)} %`].filter(Boolean).join(' · ')}
              {r.offset_seconds !== undefined && (
                <span className="stretch">
                  {' '}
                  · at {formatTime(r.offset_seconds)}
                  {r.length_seconds ? ` for ${r.length_seconds.toFixed(1)} s` : ''}
                </span>
              )}
            </small>
          </div>
          <Btn size="sm" variant="outline" icon={Plus} tip="Place at the selection / playhead" onClick={() => void importSearchResult(r)} />
        </li>
      ))}
    </ul>
  );
}

// ── Jobs ────────────────────────────────────────────────────────────────────

function JobsSection() {
  const jobs = useStore((s) => s.jobs);
  const clear = useStore((s) => s.clearJobs);
  if (!jobs.length) return null;
  return (
    <Section
      id="jobs"
      title={`Jobs (${jobs.length})`}
      extra={
        <Btn
          size="sm"
          variant="ghost"
          label="Clear"
          tip="Remove finished jobs"
          onClick={(e) => {
            e.stopPropagation();
            clear();
          }}
        />
      }
    >
      <ul className="jobs">
        {jobs.map((j) => (
          <li key={j.id} className={`job ${j.status}`}>
            <div className="job-title">
              {j.status === 'done' ? <CircleCheck size={14} strokeWidth={2} /> : j.status === 'error' ? <CircleAlert size={14} strokeWidth={2} /> : <SpinIcon size={14} />}
              <span>{j.title}</span>
            </div>
            {j.status === 'running' && (
              <div className="bar">
                <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </div>
            )}
            {(j.detail || j.error) && <small className={j.error ? 'err' : 'muted'}>{j.error ?? j.detail}</small>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

const SpinIcon: IconType = (p) => <LoaderCircle {...p} className="spin" />;
