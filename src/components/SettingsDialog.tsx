import { useEffect, useRef, useState } from 'react';
import { defaultSettings, useStore } from '../store';
import type { ServiceUrls, Settings } from '../types';
import { generationLimits, health } from '../api/services';
import { serverApi, serverUrl } from '../api/server';
import { Btn } from './ui';
import { Activity } from 'lucide-react';

const SERVICES: { key: keyof ServiceUrls; label: string; port: number; env: string }[] = [
  { key: 'spotting', label: 'Spotting', port: 8003, env: 'SPOTTING_URL' },
  { key: 'search', label: 'Recommendation (sound search)', port: 8002, env: 'SEARCH_URL' },
  { key: 'generation', label: 'Generation (gateway in front of MMAudio)', port: 8010, env: 'GENERATION_URL' },
  { key: 'hybrid', label: 'Hybrid', port: 8004, env: 'HYBRID_URL' },
];

type Check = { ok: boolean; text: string };
type Health = Partial<Record<keyof ServiceUrls, Check>>;

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [status, setStatus] = useState<Health>({});
  const [server, setServer] = useState<Check | null>(null);
  const [limits, setLimits] = useState<Check | null>(null);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setDraft(settings);
      setStatus({});
      setServer(null);
      setLimits(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, settings]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setUrl = (k: keyof ServiceUrls, v: string) => setDraft((d) => ({ ...d, urls: { ...d.urls, [k]: v } }));
  const num = (v: string) => (v === '' ? 0 : Number(v));

  const test = async (k: keyof ServiceUrls) => {
    setStatus((s) => ({ ...s, [k]: { ok: true, text: 'checking …' } }));
    try {
      const text = await health(draft.urls[k]);
      setStatus((s) => ({ ...s, [k]: { ok: true, text } }));
    } catch (e) {
      setStatus((s) => ({ ...s, [k]: { ok: false, text: (e as Error).message } }));
    }
  };

  const testServer = () => {
    setServer({ ok: true, text: 'checking …' });
    void serverApi
      .health()
      .then((h) => setServer({ ok: true, text: `${h.service} ${h.version}\nsessions: ${h.sessionsDirs.join(', ') || '(none)'}` }))
      .catch((e: Error) => setServer({ ok: false, text: e.message }));
  };

  const fromService = () => {
    setLimits({ ok: true, text: 'asking the generation service …' });
    void generationLimits(draft.urls)
      .then((l) => {
        setDraft((d) => ({ ...d, genMin: l.min, genMax: l.max }));
        setLimits(null);
      })
      .catch((e: Error) => setLimits({ ok: false, text: e.message }));
  };

  const serverPath = serverUrl('/').replace(/\/$/, '');

  return (
    <dialog ref={ref} className="settings" onClose={onClose}>
      <form method="dialog" onSubmit={() => setSettings(draft)}>
        <h2>Backend</h2>
        <p className="muted small">
          The web UI talks to the same services as the Pro Tools plugin:{' '}
          <a href="https://github.com/ai-sound-design/ai-services" target="_blank" rel="noreferrer">
            ai-sound-design/ai-services
          </a>
          . The /svc paths are forwarded to them by the web UI server (or the dev server), since two of the services send no CORS headers.
          {draft.mock && ' Mock mode is on (?mock=1): the services are simulated in the browser.'}
        </p>

        <div className="settings-grid">
          <div className="col">
            <fieldset>
              <legend>Services</legend>
              {SERVICES.map((s) => (
                <div key={s.key} className="service">
                  <label className="field grow">
                    <span className="service-label">
                      {s.label}
                      <small>
                        {s.env} · default localhost:{s.port}
                      </small>
                    </span>
                    <div className="row">
                      <input className="grow" value={draft.urls[s.key]} onChange={(e) => setUrl(s.key, e.target.value)} placeholder={defaultSettings.urls[s.key]} />
                      <Btn variant="outline" icon={Activity} label="Test" tip="Call GET /health" onClick={() => void test(s.key)} />
                    </div>
                  </label>
                  {status[s.key] && <pre className={status[s.key]!.ok ? 'health ok' : 'health err'}>{status[s.key]!.text}</pre>}
                </div>
              ))}
              <div className="service">
                <div className="field grow">
                  <span className="service-label">
                    Web UI server (sessions, media)
                    <small>fixed · the server that serves this page</small>
                  </span>
                  <div className="row">
                    <input
                      className="grow"
                      value={serverPath}
                      readOnly
                      title="Reads Pro Tools sessions and streams their media (server/, or the webui container). Not configurable: it is the origin this page comes from."
                    />
                    <Btn variant="outline" icon={Activity} label="Test" tip="Call GET /api/health" onClick={testServer} />
                  </div>
                </div>
                {server && <pre className={server.ok ? 'health ok' : 'health err'}>{server.text}</pre>}
              </div>
            </fieldset>

            <fieldset>
              <legend>Generation</legend>
              <div className="num-grid">
                <label className="field" title="Shortest length the generation service accepts">
                  Min (s)
                  <input type="number" value={draft.genMin} onChange={(e) => set('genMin', num(e.target.value))} />
                </label>
                <label className="field" title="Longest length the generation service accepts (the gateway: 600)">
                  Max (s)
                  <input type="number" value={draft.genMax} onChange={(e) => set('genMax', num(e.target.value))} />
                </label>
                <div className="field">
                  <span aria-hidden="true">&nbsp;</span>
                  <Btn variant="outline" label="From service" tip="Read min/max from the generation service's /health" onClick={fromService} />
                </div>
                <label className="field" title="Timecode frame rate sent with every request; an open session sets it">
                  Timecode fps
                  <input type="number" step={0.001} value={draft.fps} onChange={(e) => set('fps', num(e.target.value))} />
                </label>
              </div>
              {limits && <pre className={limits.ok ? 'health ok' : 'health err'}>{limits.text}</pre>}
            </fieldset>
          </div>

          <div className="col">
            <fieldset>
              <legend>Hybrid: database match</legend>
              <p className="muted small">The settings of the plugin's hybrid profile; sent with every hybrid request that uses database sounds.</p>
              <div className="num-grid">
                <label className="field" title="At most this many pieces per 10 s of a generated sound; 0 = automatic">
                  Pieces / 10 s
                  <input type="number" min={0} max={20} value={draft.piecesPer10s} onChange={(e) => set('piecesPer10s', num(e.target.value))} />
                </label>
                <label className="field">
                  Min. piece (s)
                  <input type="number" min={0.1} step={0.5} value={draft.minPieceSeconds} onChange={(e) => set('minPieceSeconds', num(e.target.value))} />
                </label>
                <label className="field" title="Further tracks with other recordings where they still fit">
                  Max DB tracks
                  <input type="number" min={1} max={10} value={draft.layers} onChange={(e) => set('layers', num(e.target.value))} />
                </label>
                <label className="field" title="Weaker matches are left out">
                  Min. similarity
                  <input type="number" min={0} max={1} step={0.05} value={draft.minSimilarity} onChange={(e) => set('minSimilarity', num(e.target.value))} />
                </label>
                <label className="field" title="Weight of the event's text against the generated sound when matching">
                  Text weight
                  <input type="number" min={0} max={1} step={0.05} value={draft.textWeight} onChange={(e) => set('textWeight', num(e.target.value))} />
                </label>
                <label className="field" title="A cut into pieces must improve the match by this much">
                  Split gain
                  <input type="number" min={0} max={1} step={0.01} value={draft.splitGain} onChange={(e) => set('splitGain', num(e.target.value))} />
                </label>
              </div>
            </fieldset>

            <fieldset>
              <legend>Placement</legend>
              <p className="muted small">How placed library clips are trimmed, faded and spread over tracks; also part of the plugin's hybrid profile.</p>
              <div className="num-grid wide">
                <label className="field" title="Seconds of a recording kept before and after an ambience event, for the Trim tool">
                  Ambience handles (s)
                  <input type="number" min={0} max={120} value={draft.ambienceHandle} onChange={(e) => set('ambienceHandle', num(e.target.value))} />
                </label>
                <label className="field" title="Tracks the sounds of a scene may share, per kind (gen/db)">
                  Tracks per scene
                  <input type="number" min={1} max={64} value={draft.tracksPerScene} onChange={(e) => set('tracksPerScene', num(e.target.value))} />
                </label>
                <label className="field" title="Fade-in and fade-out of placed library clips">
                  Fade (s)
                  <input type="number" min={0} max={30} step={0.25} value={draft.fadeSeconds} onChange={(e) => set('fadeSeconds', num(e.target.value))} />
                </label>
                <label className="field" title="Outside: the clip keeps that much handle beyond the event and the fade runs over it. Inside: the clip ends at the event and the fade runs within it.">
                  Fade place
                  <select value={draft.fadeInside ? 'inside' : 'outside'} onChange={(e) => set('fadeInside', e.target.value === 'inside')}>
                    <option value="outside">outside the event</option>
                    <option value="inside">inside the event</option>
                  </select>
                </label>
              </div>
            </fieldset>
          </div>
        </div>

        <div className="dialog-buttons">
          <Btn variant="ghost" label="Reset to defaults" onClick={() => setDraft(defaultSettings)} />
          <div className="spacer" />
          <Btn variant="outline" label="Cancel" onClick={() => ref.current?.close()} />
          <Btn variant="primary" type="submit" label="Save" />
        </div>
      </form>
    </dialog>
  );
}
