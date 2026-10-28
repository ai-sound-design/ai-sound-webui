import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { VideoPlayer } from './components/VideoPlayer';
import { Transport } from './components/Transport';
import { Timeline } from './components/Timeline';
import { TOOLS, ToolsPanel } from './components/ToolsPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { SessionBrowser } from './components/SessionBrowser';
import { importFiles } from './lib/media';
import { exportMix } from './lib/export';
import { transport } from './lib/transport';
import { newProject, openProject, saveProject } from './lib/project';
import * as edit from './lib/edit';
import { Btn, Divider, Group, TooltipHost } from './components/ui';
import { CircleAlert, Download, FilePlus2, FolderOpen, Import, PanelRight, Redo2, Save, Settings2, Undo2, X } from './components/icons';
import { Clapperboard } from 'lucide-react';

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const projectName = useStore((s) => s.projectName);
  const session = useStore((s) => s.session);
  const dirty = useStore((s) => s.dirty);
  const hasAudio = useStore((s) => s.audioClips.length > 0);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const mock = useStore((s) => s.settings.mock);
  const hasSel = useStore((s) => !!s.selection);
  const sidebar = useStore((s) => s.ui.sidebar);

  const showErrors = (errs: string[]) => errs.length && setErrors(errs);
  const open = (f: File) => openProject(f).catch((e) => setErrors([(e as Error).message]));
  const save = () => saveProject().catch((e) => setErrors([`Saving failed: ${(e as Error).message}`]));
  const dropFiles = (files: File[]) => {
    const proj = files.find((f) => f.name.endsWith('.asd'));
    if (proj) void open(proj);
    else void importFiles(files).then(showErrors);
  };

  useEffect(() => {
    // Warn before unsaved work is lost by closing or reloading the tab
    const onUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  useEffect(() => {
    // Keyboard shortcuts, loosely following Pro Tools
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, dialog')) return;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const tool = TOOLS.find((t) => t.key === e.key);
      if (mod && k === 's') {
        e.preventDefault();
        void save();
      } else if (mod && k === 'o') {
        e.preventDefault();
        projectInput.current?.click();
      } else if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        s.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        edit.duplicate();
      } else if (mod && k === 't') {
        e.preventDefault();
        edit.cropToSelection();
      } else if (mod && k === 'e') {
        e.preventDefault();
        edit.splitAtPlayhead();
      } else if (mod) {
        return;
      } else if (e.code === 'Space') {
        e.preventDefault();
        transport.toggle();
      } else if (tool) {
        s.setTool(tool.id);
      } else if (k === 'b') {
        edit.splitAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        edit.deleteSelected();
      } else if (e.code === 'NumpadEnter' || k === 'm') {
        edit.addMarkerHere();
      } else if (e.key === 'Home' || e.key === 'Enter') {
        transport.seek(0);
      } else if (k === 'g') {
        edit.fadeIn();
      } else if (k === 'h') {
        edit.fadeOut();
      } else if (k === 'f') {
        edit.crossfade();
      } else if (k === 'n') {
        edit.normalize();
      } else if (e.key === '[') {
        edit.nudgeGain(-1);
      } else if (e.key === ']') {
        edit.nudgeGain(1);
      } else if (k === 'l') {
        s.setLoop(!s.loop);
      } else if (e.key === 'Escape') {
        s.setSelection(null);
        s.selectClip(null);
      } else if (e.key === '+' || e.key === '=' || k === 't') {
        s.setZoom(s.pxPerSec * 1.25);
      } else if (e.key === '-' || k === 'r') {
        s.setZoom(s.pxPerSec / 1.25);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if ((e.nativeEvent as DragEvent & { handled?: boolean }).handled) return;
        dropFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="app-name">AI Sound Design</span>
          <Divider />
          <span className="project-name" data-tip={dirty ? 'Unsaved changes' : 'All changes saved'}>
            {projectName}
            {dirty && <span className="dirty" />}
          </span>
          {session && (
            <span className="session-chip" data-tip={`${session.product} ${session.version} · ${session.path} · ${session.sampleRate} Hz · ${session.fps} fps (${session.fpsSource})`}>
              <Clapperboard size={13} strokeWidth={1.75} />
              Pro Tools {session.version} · {session.fps} fps
            </span>
          )}
        </div>
        <div className="actions">
          <Group>
            <Btn icon={FilePlus2} tip="New project" onClick={newProject} />
            <Btn icon={FolderOpen} tip="Open project" kbd="Ctrl O" onClick={() => projectInput.current?.click()} />
            <Btn icon={Save} tip="Save project" kbd="Ctrl S" onClick={() => void save()} />
          </Group>
          <Btn variant="outline" icon={Clapperboard} label="Open session" tip="Open a Pro Tools session (.ptx) through the web UI server" onClick={() => setSessionOpen(true)} />
          <Group>
            <Btn icon={Undo2} tip="Undo" kbd="Ctrl Z" disabled={!canUndo} onClick={() => useStore.getState().undo()} />
            <Btn icon={Redo2} tip="Redo" kbd="Ctrl Shift Z" disabled={!canRedo} onClick={() => useStore.getState().redo()} />
          </Group>
          <Btn variant="outline" icon={Import} label="Import" tip="Import videos or audio files" onClick={() => fileInput.current?.click()} />
          <Btn variant="outline" icon={Download} label={hasSel ? 'Bounce selection' : 'Bounce'} tip="Export the mix as WAV (only the selected range if there is one)" disabled={!hasAudio} onClick={() => void exportMix()} />
          <Divider />
          <button className={`backend-pill ${mock ? 'is-mock' : 'is-live'}`} onClick={() => setSettingsOpen(true)} data-tip="Backend settings">
            <span className="pill-dot" />
            {mock ? 'Mock backend' : 'ai-services'}
            <Settings2 size={14} strokeWidth={1.75} />
          </button>
          <Btn icon={PanelRight} tip={sidebar ? 'Hide tools panel' : 'Show tools panel'} active={sidebar} onClick={() => useStore.getState().setUi({ sidebar: !sidebar })} />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="video/*,audio/*,.asd"
          multiple
          hidden
          onChange={(e) => {
            dropFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <input
          ref={projectInput}
          type="file"
          accept=".asd"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void open(f);
            e.target.value = '';
          }}
        />
      </header>

      {errors.length > 0 && (
        <div className="errors" role="alert">
          <CircleAlert size={16} strokeWidth={1.75} />
          <div className="errors-list">
            {errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
          <Btn icon={X} size="sm" variant="ghost" tip="Dismiss" onClick={() => setErrors([])} />
        </div>
      )}

      <div className="main">
        <div className="editor">
          <VideoPlayer />
          <Transport />
          <Timeline onErrors={showErrors} />
        </div>
        {sidebar && <ToolsPanel />}
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Import size={28} strokeWidth={1.5} />
            <strong>Drop to import</strong>
            <span>Videos go to the video track, audio to the playhead, a .asd file opens as project</span>
          </div>
        </div>
      )}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SessionBrowser open={sessionOpen} onClose={() => setSessionOpen(false)} onError={(m) => setErrors(m.split('\n'))} />
      <TooltipHost />
    </div>
  );
}
