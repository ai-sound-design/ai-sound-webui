import { projectEnd, useStore } from '../store';
import { engine } from './engine';

/** Where playback stops: the selection end (as in Pro Tools) or the project end */
function stopPoint(): { end: number; loopStart?: number } {
  const s = useStore.getState();
  const sel = s.selection;
  if (sel && sel.end - sel.start > 0.05) return { end: sel.end, loopStart: s.loop ? sel.start : undefined };
  return { end: projectEnd() };
}

function loop() {
  const s = useStore.getState();
  if (!s.playing) return;
  const t = engine.time;
  const { end, loopStart } = stopPoint();
  if (t >= end) {
    if (loopStart !== undefined) {
      engine.seek(loopStart);
      useStore.setState({ currentTime: loopStart });
    } else {
      transport.pause();
      const sel = s.selection;
      // After playing a selection return to its start, otherwise stay at the end
      transport.seek(sel && sel.end - sel.start > 0.05 ? sel.start : end);
      return;
    }
  } else {
    useStore.setState({ currentTime: t });
  }
  requestAnimationFrame(loop);
}

export const transport = {
  async play() {
    const s = useStore.getState();
    const end = projectEnd();
    if (s.playing || end <= 0) return;
    const sel = s.selection;
    let from = s.currentTime;
    if (sel && sel.end - sel.start > 0.05) from = sel.start;
    else if (from >= end - 0.01) from = 0;
    useStore.setState({ playing: true, currentTime: from });
    await engine.play(from);
    requestAnimationFrame(loop);
  },
  pause() {
    engine.pause();
    useStore.setState({ playing: false, currentTime: engine.time });
  },
  toggle() {
    if (useStore.getState().playing) transport.pause();
    else void transport.play();
  },
  seek(t: number) {
    t = Math.max(0, t);
    engine.seek(t);
    useStore.setState({ currentTime: t });
  },
};
