"""ffmpeg/ffprobe helpers: probing, audio slices, peaks and video cuts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
from pathlib import Path

import numpy as np

from .config import settings

PEAKS_PER_SECOND = 200
BROWSER_CODECS = {"h264", "hevc", "vp8", "vp9", "av1"}


class MediaError(RuntimeError):
    pass


async def _run(cmd: list[str], timeout: float = 600) -> bytes:
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise MediaError(f"{cmd[0]} timed out")
    if proc.returncode != 0:
        raise MediaError(err.decode("utf-8", "replace")[-800:])
    return out


async def probe(path: Path) -> dict:
    """Streams of a media file: duration, video fps/size/codec, audio rate/channels."""
    out = await _run([settings.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], 60)
    info = json.loads(out)
    result: dict = {"duration": float(info.get("format", {}).get("duration") or 0), "container": info.get("format", {}).get("format_name", "")}
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and "video" not in result:
            num, _, den = (s.get("r_frame_rate") or "0/1").partition("/")
            fps = float(num) / float(den or 1) if float(den or 1) else 0.0
            result["video"] = {
                "codec": s.get("codec_name", ""),
                "width": int(s.get("width") or 0),
                "height": int(s.get("height") or 0),
                "fps": round(fps, 3),
                "frames": int(s.get("nb_frames") or 0),
                "playable": s.get("codec_name") in BROWSER_CODECS,
            }
        elif s.get("codec_type") == "audio" and "audio" not in result:
            result["audio"] = {
                "codec": s.get("codec_name", ""),
                "sampleRate": int(s.get("sample_rate") or 0),
                "channels": int(s.get("channels") or 0),
                "bits": int(s.get("bits_per_raw_sample") or s.get("bits_per_sample") or 0),
            }
    return result


def pan_filter(channels: list[int | None], source_channels: int) -> list[str]:
    """ffmpeg filter selecting the given source channels (None = all)."""
    wanted = [c for c in channels if c is not None]
    if not wanted or source_channels <= 1 or len(wanted) >= source_channels and sorted(wanted) == list(range(source_channels)):
        return []
    layout = "mono" if len(wanted) == 1 else f"{len(wanted)}c"
    mapping = "|".join(f"c{i}=c{min(c, source_channels - 1)}" for i, c in enumerate(wanted))
    return ["-af", f"pan={layout}|{mapping}"]


async def audio_slice(path: Path, offset_s: float, length_s: float, channels: list[int | None], source_channels: int, rate: int) -> bytes:
    """A piece of an audio file as 16-bit WAV at the session rate."""
    cmd = [settings.ffmpeg, "-v", "error", "-nostdin", "-ss", f"{max(0.0, offset_s):.6f}", "-t", f"{max(0.001, length_s):.6f}", "-i", str(path),
           *pan_filter(channels, source_channels), "-ar", str(rate), "-c:a", "pcm_s16le", "-f", "wav", "-"]
    return await _run(cmd, 300)


def _peaks_cache_path(path: Path) -> Path:
    st = path.stat()
    key = hashlib.sha1(f"{path.resolve()}|{st.st_size}|{st.st_mtime_ns}|{PEAKS_PER_SECOND}".encode()).hexdigest()
    return settings.cache_dir / "peaks" / f"{key}.peaks"


async def peaks(path: Path) -> bytes:
    """Peak magnitude per 1/200 s over the whole file, all channels mixed, as bytes 0..255.

    The result starts with a 16-byte header: magic 'PEAK', u32 peaks per second,
    u32 count, u32 reserved.
    """
    cache = _peaks_cache_path(path)
    if cache.is_file():
        return cache.read_bytes()
    info = await probe(path)
    rate = 48000
    raw = await _run([settings.ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-ac", "1", "-ar", str(rate), "-f", "s16le", "-c:a", "pcm_s16le", "-"], 600)
    samples = np.frombuffer(raw, dtype="<i2")
    bucket = rate // PEAKS_PER_SECOND
    n = (len(samples) + bucket - 1) // bucket
    padded = np.zeros(n * bucket, dtype=np.int16)
    padded[: len(samples)] = samples
    mags = np.abs(padded.astype(np.int32)).reshape(n, bucket).max(axis=1)
    out = np.clip(mags * 255 // 32767, 0, 255).astype(np.uint8).tobytes()
    data = b"PEAK" + struct.pack("<III", PEAKS_PER_SECOND, n, 0) + out
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(cache)
    _ = info
    return data


async def video_cut(path: Path, start_s: float, end_s: float, out: Path, height: int = 360) -> None:
    """A piece of a video, downscaled, without audio, H.264: what the AI services receive."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [settings.ffmpeg, "-y", "-v", "error", "-nostdin", "-ss", f"{max(0.0, start_s):.3f}", "-i", str(path), "-t", f"{max(0.04, end_s - start_s):.3f}",
           "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", f"scale=-2:min(ih\\,{height})", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    await _run(cmd, 900)


async def video_proxy(path: Path, out: Path) -> None:
    """Browser-playable H.264 proxy of a video the browser cannot decode (ProRes, DNxHD, ...)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part.mp4")
    cmd = [settings.ffmpeg, "-y", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
           "-vf", "scale=-2:min(ih\\,720)", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp)]
    await _run(cmd, 7200)
    tmp.replace(out)
