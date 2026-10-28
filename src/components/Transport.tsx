import { projectEnd, useStore } from '../store';
import { transport } from '../lib/transport';
import { formatTime } from '../lib/util';
import { TOOLS } from './ToolsPanel';
import { Btn, Group } from './ui';
import { Play, Repeat, SkipBack, Square, ZoomIn, ZoomOut } from './icons';

export function Transport() {
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.currentTime);
  const end = useStore((s) => projectEnd(s));
  const sel = useStore((s) => s.selection);
  const loop = useStore((s) => s.loop);
  const pps = useStore((s) => s.pxPerSec);
  const tool = useStore((s) => s.tool);
  const s = useStore.getState();

  return (
    <div className="transport">
      <Group>
        <Btn icon={SkipBack} tip="Return to start" kbd="Enter" onClick={() => transport.seek(0)} />
        <Btn icon={playing ? Square : Play} tip={playing ? 'Stop' : 'Play'} kbd="Space" className="play-btn" active={playing} disabled={end <= 0} onClick={() => transport.toggle()} />
        <Btn icon={Repeat} tip="Loop the selection" kbd="L" active={loop} onClick={() => s.setLoop(!loop)} />
      </Group>

      <div className="counter" data-tip="Playhead position">
        <span className="counter-main">{formatTime(time)}</span>
      </div>

      <div className="sel-fields" data-tip="Selection">
        <Field label="Start" value={sel ? formatTime(sel.start) : '—'} />
        <Field label="End" value={sel ? formatTime(sel.end) : '—'} />
        <Field label="Length" value={sel ? formatTime(sel.end - sel.start) : '—'} />
      </div>

      {/* Compact tool switch next to the timeline; the full palette lives in the Tools panel */}
      <Group className="tool-switch">
        {TOOLS.map((t) => (
          <Btn key={t.id} icon={t.icon} tip={`${t.label} tool: ${t.hint}`} kbd={t.key} active={t.id === tool} onClick={() => s.setTool(t.id)} />
        ))}
      </Group>

      <div className="spacer" />
      <div className="zoom">
        <Btn icon={ZoomOut} variant="ghost" size="sm" tip="Zoom out" kbd="−" onClick={() => s.setZoom(pps / 1.25)} />
        <input type="range" min={Math.log(4)} max={Math.log(400)} step={0.01} value={Math.log(pps)} onChange={(e) => s.setZoom(Math.exp(Number(e.target.value)))} aria-label="Zoom" />
        <Btn icon={ZoomIn} variant="ghost" size="sm" tip="Zoom in" kbd="+" onClick={() => s.setZoom(pps * 1.25)} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="sel-field">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
