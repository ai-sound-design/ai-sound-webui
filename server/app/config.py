"""Server settings, all from environment variables (every value has a working default)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def _dirs(value: str) -> list[Path]:
    out = []
    for part in value.replace(";", os.pathsep).split(os.pathsep):
        part = part.strip().strip('"')
        if part:
            out.append(Path(part).expanduser())
    return out


class Settings:
    def __init__(self) -> None:
        here = Path(__file__).resolve().parent.parent
        # Folders the session browser may show (several, separated by ; or the OS path separator)
        self.sessions_dirs: list[Path] = _dirs(os.environ.get("SESSIONS_DIRS", os.environ.get("SESSIONS_DIR", str(here / "sessions"))))
        # Peaks, video proxies and cut pieces
        self.cache_dir = Path(os.environ.get("CACHE_DIR", str(here / ".cache"))).expanduser()
        # The built frontend (dist/) when served by this process
        static = os.environ.get("STATIC_DIR", str(here.parent / "dist"))
        self.static_dir: Path | None = Path(static) if static and Path(static).is_dir() else None
        # The ai-services; in docker compose these are the service names
        self.services = {
            "generation": os.environ.get("GENERATION_URL", "http://localhost:8010"),
            "search": os.environ.get("SEARCH_URL", "http://localhost:8002"),
            "spotting": os.environ.get("SPOTTING_URL", "http://localhost:8003"),
            "hybrid": os.environ.get("HYBRID_URL", "http://localhost:8004"),
        }
        self.ffmpeg = os.environ.get("FFMPEG", shutil.which("ffmpeg") or "ffmpeg")
        self.ffprobe = os.environ.get("FFPROBE", shutil.which("ffprobe") or "ffprobe")
        self.version = "0.2.0"


settings = Settings()
