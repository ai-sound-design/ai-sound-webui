"""
AI Sound Design web UI server.

Serves the built frontend, opens Pro Tools sessions from the mounted session
folders, streams their media, cuts video pieces for the AI services with ffmpeg
and forwards /svc/* to the four ai-services (two of them send no CORS headers).
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import sessions
from .config import settings
from .media import MediaError, audio_slice, peaks, video_cut, video_proxy

class _QuietResets(logging.Filter):
    """Browsers abort media requests all the time; on Windows asyncio logs each as a traceback."""

    def filter(self, record: logging.LogRecord) -> bool:
        text = f"{record.getMessage()} {record.exc_info[1] if record.exc_info else ''}"
        return "ConnectionResetError" not in text and "_call_connection_lost" not in text


logging.getLogger("asyncio").addFilter(_QuietResets())

app = FastAPI(title="AI Sound Design web UI", version=settings.version, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["*"])

_http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0))


@app.exception_handler(sessions.SessionError)
async def _session_error(_: Request, e: sessions.SessionError):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(MediaError)
async def _media_error(_: Request, e: MediaError):
    return JSONResponse({"detail": f"ffmpeg: {e}"}, status_code=500)


# -- health ---------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "ai-sound-webui",
        "version": settings.version,
        "sessionsDirs": [str(p) for p in settings.sessions_dirs],
        "services": settings.services,
        "static": str(settings.static_dir) if settings.static_dir else None,
    }


# -- sessions -------------------------------------------------------------------
class OpenRequest(BaseModel):
    path: str


@app.get("/api/browse")
async def browse(path: str = ""):
    return sessions.browse(path)


@app.post("/api/sessions/open")
async def open_session(req: OpenRequest):
    return (await sessions.open_session(req.path)).payload


@app.get("/api/sessions/{sid}")
async def session_payload(sid: str):
    return sessions.get_session(sid).payload


@app.get("/api/sessions/{sid}/files/{index}")
async def audio_file(sid: str, index: int):
    o = sessions.get_session(sid)
    p = o.audio_paths.get(index)
    if not p:
        raise HTTPException(404, "audio file not found next to the session")
    return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "application/octet-stream", filename=p.name)


@app.get("/api/sessions/{sid}/files/{index}/peaks")
async def audio_peaks(sid: str, index: int):
    o = sessions.get_session(sid)
    p = o.audio_paths.get(index)
    if not p:
        raise HTTPException(404, "audio file not found next to the session")
    data = await peaks(p)
    return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/sessions/{sid}/files/{index}/slice")
async def audio_file_slice(sid: str, index: int, offset: float = 0.0, length: float = 0.0, channels: str = ""):
    """A piece of an audio file as WAV; `channels` picks source channels (e.g. "0" or "0,1")."""
    o = sessions.get_session(sid)
    p = o.audio_paths.get(index)
    if not p:
        raise HTTPException(404, "audio file not found next to the session")
    f = o.payload["audioFiles"][index]
    if length <= 0:
        length = max(0.001, (f["duration"] or 0) - offset)
    chans: list[int | None] = [int(c) for c in channels.split(",") if c.strip().isdigit()] or [None]
    data = await audio_slice(p, offset, length, chans, f["channels"] or 1, o.sample_rate)
    return Response(data, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/sessions/{sid}/clips/{index}/audio")
async def clip_audio(sid: str, index: int):
    o = sessions.get_session(sid)
    if not 0 <= index < len(o.session.clips):
        raise HTTPException(404, "no such clip")
    c = o.payload["clips"][index]
    p = o.audio_paths.get(c["file"])
    if not p:
        raise HTTPException(404, "the clip's audio file is missing")
    f = o.payload["audioFiles"][c["file"]]
    data = await audio_slice(p, c["offset"], c["length"], c["channels"], f["channels"] or 1, o.sample_rate)
    return Response(data, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/sessions/{sid}/videos/{index}")
async def video_file(sid: str, index: int):
    o = sessions.get_session(sid)
    p = o.video_paths.get(index)
    if not p:
        raise HTTPException(404, "video file not found next to the session")
    return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "video/mp4", filename=p.name)


@app.get("/api/sessions/{sid}/videos/{index}/proxy")
async def video_file_proxy(sid: str, index: int):
    """An H.264 version of a video the browser cannot play; made once and cached."""
    o = sessions.get_session(sid)
    p = o.video_paths.get(index)
    if not p:
        raise HTTPException(404, "video file not found next to the session")
    st = p.stat()
    key = hashlib.sha1(f"{p.resolve()}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()
    out = settings.cache_dir / "proxies" / f"{key}.mp4"
    if not out.is_file():
        await video_proxy(p, out)
    return FileResponse(out, media_type="video/mp4", filename=f"{p.stem}_proxy.mp4")


@app.get("/api/sessions/{sid}/videos/{index}/cut")
async def video_piece(sid: str, index: int, start: float, end: float):
    """A downscaled piece of a session video, as the plugin sends it to the services."""
    o = sessions.get_session(sid)
    p = o.video_paths.get(index)
    if not p:
        raise HTTPException(404, "video file not found next to the session")
    if end <= start:
        raise HTTPException(400, "end must be after start")
    out = settings.cache_dir / "cuts" / f"{sid}_{index}_{start:.3f}_{end:.3f}.mp4"
    if not out.is_file():
        await video_cut(p, start, end, out)
    return FileResponse(out, media_type="video/mp4", filename=f"{p.stem}_{start:.1f}-{end:.1f}.mp4")


# -- the ai-services, same origin -----------------------------------------------
HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"}


@app.api_route("/svc/{service}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
async def proxy(service: str, path: str, request: Request):
    base = settings.services.get(service)
    if not base:
        raise HTTPException(404, f"unknown service {service!r}")
    url = base.rstrip("/") + "/" + path
    if request.url.query:
        url += "?" + request.url.query
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}
    try:
        upstream = await _http.send(_http.build_request(request.method, url, headers=headers, content=request.stream()), stream=True)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"{service} not reachable at {base}: {e}")
    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_HEADERS and k.lower() not in ("access-control-allow-origin",)}
    return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=resp_headers, background=BackgroundTask(upstream.aclose))


# -- the frontend ----------------------------------------------------------------
if settings.static_dir:
    class SpaStaticFiles(StaticFiles):
        async def get_response(self, path: str, scope):
            try:
                return await super().get_response(path, scope)
            except HTTPException as e:
                if e.status_code == 404 and not path.startswith(("api/", "svc/")):
                    return await super().get_response("index.html", scope)
                raise

    app.mount("/", SpaStaticFiles(directory=str(settings.static_dir), html=True), name="static")
else:
    @app.get("/")
    async def root():
        return {"service": "ai-sound-webui", "hint": "frontend not built; run the Vite dev server or build dist/", "docs": "/api/docs"}


@app.on_event("shutdown")
async def _shutdown():
    await _http.aclose()


_ = Path  # keep import for type checkers
