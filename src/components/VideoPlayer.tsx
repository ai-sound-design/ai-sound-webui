import { useEffect, useRef, useState } from 'react';
import { activeClipAt, useStore } from '../store';

/**
 * A single <video> element that follows the timeline clock: at every position
 * the clip underneath is loaded and seeked to the matching time.
 */
export function VideoPlayer() {
  const ref = useRef<HTMLVideoElement>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const hasClips = useStore((s) => s.videoClips.length > 0);
  const videoAudio = useStore((s) => s.videoAudio);

  useEffect(() => {
    const v = ref.current!;
    let loadedId: string | null = null;

    const sync = () => {
      const s = useStore.getState();
      const clip = activeClipAt(s.videoClips, s.currentTime);
      setActiveName(clip?.name ?? null);
      if (!clip) {
        if (!v.paused) v.pause();
        if (loadedId) {
          loadedId = null;
          v.removeAttribute('src');
          v.load();
        }
        return;
      }
      if (loadedId !== clip.id) {
        loadedId = clip.id;
        v.src = clip.url;
        return; // continues on loadedmetadata
      }
      if (v.readyState < 1) return;
      const local = clip.offset + (s.currentTime - clip.start);
      if (s.playing) {
        if (Math.abs(v.currentTime - local) > 0.25) v.currentTime = local;
        if (v.paused) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - local) > 0.02 && !v.seeking) v.currentTime = local;
      }
    };

    v.addEventListener('loadedmetadata', sync);
    const unsub = useStore.subscribe(sync);
    sync();
    return () => {
      unsub();
      v.removeEventListener('loadedmetadata', sync);
    };
  }, []);

  return (
    <section className="viewer">
      <div className="screen">
        <video ref={ref} playsInline muted={!videoAudio} />
        {!activeName && hasClips && <div className="screen-empty">No video at this position</div>}
        {!hasClips && (
          <div className="screen-welcome">
            <span className="wordmark">AI Sound Design</span>
            <span className="tagline">
              <em className="ice">Iced Generation.</em> <em className="fire">Forged in your Library.</em>
            </span>
            <p className="welcome-hint">Drop videos here, or use Import, to start a session</p>
          </div>
        )}
        {activeName && <div className="screen-label">{activeName}</div>}
      </div>
    </section>
  );
}
