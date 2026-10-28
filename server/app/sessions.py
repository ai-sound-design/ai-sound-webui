"""Open Pro Tools sessions: parse, find the media, turn samples and frames into seconds."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from ptsession import Session, parse_session
from ptsession.model import Clip

from .config import settings
from .media import probe

SESSION_EXT = (".ptx", ".ptf", ".pts")
MEDIA_EXT = (".wav", ".wave", ".aif", ".aiff", ".aifc", ".mxf", ".flac", ".mp3", ".m4a", ".mov", ".mp4", ".m4v", ".avi", ".mkv", ".webm", ".mpg", ".mpeg")
CATEGORIES = ("dialogue", "foley", "sfx", "ambience", "music")
# Colour indices Pro Tools stores for the five categories the plugin uses
COLOR_CATEGORIES = {12: "foley", 13: "sfx", 21: "ambience"}


class SessionError(ValueError):
    pass


@dataclass
class OpenSession:
    id: str
    path: Path
    session: Session
    audio_paths: dict[int, Path] = field(default_factory=dict)
    video_paths: dict[int, Path] = field(default_factory=dict)
    audio_info: dict[int, dict] = field(default_factory=dict)
    video_info: dict[int, dict] = field(default_factory=dict)
    fps: float = 25.0
    fps_source: str = "default"
    payload: dict = field(default_factory=dict)

    @property
    def sample_rate(self) -> int:
        return self.session.sample_rate


_open: dict[str, OpenSession] = {}


# -- the session browser -----------------------------------------------------
def roots() -> list[Path]:
    return [p for p in settings.sessions_dirs if p.is_dir()]


def resolve(vpath: str) -> Path:
    """A browser path "<root index>/<relative path>", or an absolute path inside one of the
    session folders (as a saved project remembers it), to a real path."""
    raw = vpath.replace("\\", "/").strip()
    if not raw.strip("/"):
        raise SessionError("no path")
    if re.match(r"^([a-zA-Z]:/|/)", raw):
        real = Path(raw).resolve()
        for root in roots():
            r = root.resolve()
            if real == r or r in real.parents:
                return real
        raise SessionError("path outside the session folders")
    head, _, rest = raw.strip("/").partition("/")
    try:
        root = roots()[int(head)]
    except (ValueError, IndexError):
        raise SessionError("unknown folder")
    real = (root / rest).resolve() if rest else root.resolve()
    if root.resolve() != real and root.resolve() not in real.parents:
        raise SessionError("path outside the session folders")
    return real


def browse(vpath: str) -> dict:
    if not vpath.strip("/"):
        return {
            "path": "",
            "parent": None,
            "entries": [{"name": r.name or str(r), "kind": "dir", "path": str(i), "size": 0} for i, r in enumerate(roots())],
        }
    real = resolve(vpath)
    if not real.is_dir():
        raise SessionError("not a folder")
    entries = []
    for p in sorted(real.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if p.name.startswith("."):
            continue
        if p.is_dir():
            entries.append({"name": p.name, "kind": "dir", "path": f"{vpath.strip('/')}/{p.name}", "size": 0})
        elif p.suffix.lower() in SESSION_EXT:
            entries.append({"name": p.name, "kind": "session", "path": f"{vpath.strip('/')}/{p.name}", "size": p.stat().st_size, "mtime": p.stat().st_mtime})
    parent = vpath.strip("/").rsplit("/", 1)[0] if "/" in vpath.strip("/") else ""
    return {"path": vpath.strip("/"), "parent": parent, "entries": entries}


# -- opening -------------------------------------------------------------------
def _media_index(folder: Path) -> dict[str, Path]:
    """Every media file under the session folder (and its parent), by lower-case name."""
    index: dict[str, Path] = {}
    seen = 0
    for base in (folder, folder.parent):
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("Session File Backups", "WaveCache")]
            for f in filenames:
                if f.lower().endswith(MEDIA_EXT):
                    index.setdefault(f.lower(), Path(dirpath) / f)
                    seen += 1
            if seen > 50000:
                break
    return index


async def open_session(vpath: str) -> OpenSession:
    real = resolve(vpath)
    if not real.is_file() or real.suffix.lower() not in SESSION_EXT:
        raise SessionError("not a Pro Tools session file")
    st = real.stat()
    sid = hashlib.sha1(f"{real}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]
    if sid in _open:
        return _open[sid]
    try:
        session = await asyncio.to_thread(parse_session, str(real))
    except Exception as e:  # noqa: BLE001
        raise SessionError(f"cannot read the session: {e}") from e
    osess = OpenSession(sid, real, session)
    index = await asyncio.to_thread(_media_index, real.parent)
    for f in session.audio_files:
        p = index.get(f.name.lower())
        if p:
            osess.audio_paths[f.index] = p
    for f in session.video_files:
        p = index.get(f.name.lower())
        if p:
            osess.video_paths[f.index] = p
    # Probe the media that is there (video for fps/size, audio for the channel count)
    probes = {}
    for i, p in osess.video_paths.items():
        probes[("v", i)] = probe(p)
    for i, p in osess.audio_paths.items():
        if session.audio_files[i].channels is None:
            probes[("a", i)] = probe(p)
    results = await asyncio.gather(*probes.values(), return_exceptions=True)
    for key, res in zip(probes.keys(), results):
        if isinstance(res, Exception):
            session.warnings.append(f"{key[1]}: ffprobe failed: {res}")
            continue
        (osess.video_info if key[0] == "v" else osess.audio_info)[key[1]] = res
    # Frame rate: the session's, else the first video's, else 25
    if session.fps and session.fps_confidence == "observed":
        osess.fps, osess.fps_source = session.fps, "session"
    else:
        vfps = next((v["video"]["fps"] for v in osess.video_info.values() if v.get("video", {}).get("fps")), None)
        if vfps:
            osess.fps, osess.fps_source = vfps, "video"
        elif session.fps:
            osess.fps, osess.fps_source = session.fps, "session-guess"
    osess.payload = build_payload(osess)
    _open[sid] = osess
    return osess


def get_session(sid: str) -> OpenSession:
    s = _open.get(sid)
    if not s:
        raise SessionError("session not open (the server was restarted?)")
    return s


# -- the payload the web UI reads ----------------------------------------------
def _category(comment: str, color: int | None) -> str | None:
    m = re.match(r"^\s*(dialogue|dialog|foley|sfx|ambience|ambiance|atmo|music)\s*:", comment, re.I)
    if m:
        w = m.group(1).lower()
        return {"dialog": "dialogue", "ambiance": "ambience", "atmo": "ambience"}.get(w, w)
    return COLOR_CATEGORIES.get(color or -1)


def build_payload(o: OpenSession) -> dict:
    s = o.session
    sr = float(s.sample_rate)
    fps = o.fps
    start_seconds = (s.start_frames / fps) if fps else 0.0

    def to_seconds(clip: Clip) -> tuple[float, float, float]:
        if clip.unit == "frames":
            return clip.start / fps, clip.length / fps, clip.offset / fps
        if clip.unit == "ticks":
            # 960000 ticks per quarter note; without a tempo map 120 bpm is assumed
            k = 60.0 / 120.0 / 960000.0
            return clip.start * k, clip.length / sr, clip.offset / sr
        return clip.start / sr, clip.length / sr, clip.offset / sr

    audio_files = []
    for f in s.audio_files:
        p = o.audio_paths.get(f.index)
        info = o.audio_info.get(f.index, {})
        channels = f.channels or info.get("audio", {}).get("channels") or 1
        audio_files.append({
            "index": f.index, "name": f.name, "folder": f.folder, "found": p is not None,
            "url": f"/api/sessions/{o.id}/files/{f.index}" if p else None,
            "peaksUrl": f"/api/sessions/{o.id}/files/{f.index}/peaks" if p else None,
            "channels": channels, "sampleRate": f.sample_rate or info.get("audio", {}).get("sampleRate"),
            "duration": (f.length_samples / (f.sample_rate or sr)) if f.length_samples else info.get("duration"),
        })
    video_files = []
    for f in s.video_files:
        p = o.video_paths.get(f.index)
        info = o.video_info.get(f.index, {})
        v = info.get("video", {})
        video_files.append({
            "index": f.index, "name": f.name, "folder": f.folder, "found": p is not None,
            "url": f"/api/sessions/{o.id}/videos/{f.index}" if p else None,
            "proxyUrl": f"/api/sessions/{o.id}/videos/{f.index}/proxy" if p and v and not v.get("playable") else None,
            "duration": info.get("duration"), "width": v.get("width"), "height": v.get("height"), "fps": v.get("fps"),
            "codec": v.get("codec"), "playable": bool(v.get("playable")),
        })
    clips = []
    for i, c in enumerate(s.clips):
        start, length, offset = to_seconds(c)
        clips.append({
            "index": i, "track": c.track, "name": c.name, "start": start, "length": length, "offset": offset, "file": c.file,
            "channels": c.channels, "unit": c.unit,
            "url": f"/api/sessions/{o.id}/clips/{i}/audio" if c.file in o.audio_paths else None,
        })
    video_clips = []
    for i, c in enumerate(s.video_clips):
        start, length, offset = to_seconds(c)
        video_clips.append({"index": i, "track": c.track, "name": c.name, "start": start, "length": length, "offset": offset, "file": c.file})
    markers = []
    for m in s.memory_locations:
        if m.start is None:
            continue
        if m.unit == "ticks":
            k = 60.0 / 120.0 / 960000.0
            start, end = m.start * k, (m.end * k if m.end is not None else None)
        else:
            start, end = m.start / sr, (m.end / sr if m.end is not None else None)
        markers.append({
            "number": m.number, "name": m.name, "kind": m.kind, "start": start, "end": end, "comment": m.comment,
            "category": _category(m.comment, m.color_index), "colorIndex": m.color_index,
        })
    end = 0.0
    for c in clips + video_clips:
        end = max(end, c["start"] + c["length"])
    return {
        "id": o.id, "name": s.name, "path": str(o.path), "product": s.product, "version": s.version,
        "sampleRate": s.sample_rate, "bitDepth": s.bit_depth, "fps": fps, "fpsSource": o.fps_source, "dropFrame": s.drop_frame,
        "startSeconds": start_seconds, "duration": end,
        "tracks": [t.to_dict() for t in s.tracks],
        "audioFiles": audio_files, "videoFiles": video_files, "clips": clips, "videoClips": video_clips, "markers": markers,
        "alternatePlaylists": {k: len(v) for k, v in s.alternate_playlists.items()},
        "warnings": s.warnings,
    }
