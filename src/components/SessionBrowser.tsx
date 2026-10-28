import { useEffect, useRef, useState } from 'react';
import { serverApi, type BrowseEntry, type BrowseResult } from '../api/server';
import { openPtSession } from '../lib/ptsession';
import { confirmDiscard } from '../lib/project';
import { Btn } from './ui';
import { ChevronRight, FolderOpen, LoaderCircle } from './icons';
import { Film, Folder, RefreshCw } from 'lucide-react';

/**
 * Picks a Pro Tools session from the folders the web UI server shows and opens
 * it as the project.
 */
export function SessionBrowser({ open, onClose, onError }: { open: boolean; onClose: () => void; onError: (msg: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyTracks, setEmptyTracks] = useState(false);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      d.showModal();
      void load('');
    } else if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function load(p: string) {
    setError(null);
    setBusy('list');
    try {
      const r = await serverApi.browse(p);
      setListing(r);
      setPath(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openEntry(e: BrowseEntry) {
    if (e.kind === 'dir') return load(e.path);
    if (!confirmDiscard()) return;
    setBusy(e.path);
    setError(null);
    try {
      const s = await openPtSession(e.path, { emptyTracks });
      ref.current?.close();
      if (s.warnings.length) onError(s.warnings.join('\n'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const crumbs = listing?.path ? listing.path.split('/') : [];

  return (
    <dialog ref={ref} className="settings session-browser" onClose={onClose}>
      <h2>Open Pro Tools session</h2>
      <p className="muted small">Sessions from the folders the web UI server shows (SESSIONS_DIR). Audio and video stay where they are; the server streams them.</p>

      <div className="crumbs">
        <button type="button" className="crumb" onClick={() => void load('')} disabled={!listing?.path}>
          Folders
        </button>
        {crumbs.map((c, i) => {
          const p = crumbs.slice(0, i + 1).join('/');
          const name = i === 0 ? listing?.entries && c : c;
          return (
            <span key={p} className="crumb-seg">
              <ChevronRight size={12} strokeWidth={2} />
              <button type="button" className="crumb" onClick={() => void load(p)} disabled={p === listing?.path}>
                {i === 0 ? rootName(c, listing) : name}
              </button>
            </span>
          );
        })}
        <span className="spacer" />
        <Btn icon={RefreshCw} size="sm" variant="ghost" tip="Reload" onClick={() => void load(path)} />
      </div>

      <div className="entries">
        {busy === 'list' && !listing && <div className="muted small">Loading …</div>}
        {listing && listing.entries.length === 0 && <div className="muted small">No folders or sessions here.</div>}
        {listing?.entries.map((e) => (
          <button key={e.path} type="button" className={`entry ${e.kind}`} onClick={() => void openEntry(e)} disabled={busy !== null}>
            {busy === e.path ? <LoaderCircle size={16} strokeWidth={1.75} className="spin" /> : e.kind === 'dir' ? <Folder size={16} strokeWidth={1.75} /> : <Film size={16} strokeWidth={1.75} />}
            <span className="entry-name">{e.name}</span>
            {e.kind === 'session' && <span className="muted small">{(e.size / 1024 / 1024).toFixed(1)} MB</span>}
          </button>
        ))}
      </div>

      {error && <pre className="health err">{error}</pre>}

      <div className="dialog-buttons">
        <label className="check">
          <input type="checkbox" checked={emptyTracks} onChange={(e) => setEmptyTracks(e.target.checked)} />
          Show audio tracks without clips
        </label>
        <span className="spacer" />
        <Btn variant="outline" label="Cancel" onClick={() => ref.current?.close()} />
        <Btn variant="primary" icon={FolderOpen} label="Open" disabled tip="Click a session in the list" />
      </div>
    </dialog>
  );
}

function rootName(index: string, listing: BrowseResult | null): string {
  // The root folder names are only in the top-level listing; fall back to the index
  void listing;
  return `Folder ${Number(index) + 1}`;
}
