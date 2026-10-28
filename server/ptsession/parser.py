"""Turn the block tree of a session file into a `Session`."""

from __future__ import annotations

import os
import re
from collections import OrderedDict

from .blocks import Block, NotAProToolsFile, Reader, decrypt
from .model import (TIMECODE_RATES, TRACK_FORMATS, TRACK_KINDS, Clip, MediaFile, MemoryLocation,
                    Region, Session, Track)

# Positions on tick-based tracks carry this bias (libptformat / PTX2RPP).
ZERO_TICKS = 0xE8D4A51000

AUDIO_FOURCC = ("WAVE", "EVAW", "AIFF", "FFIA", "fFXM", "MXFf")
AUDIO_EXT = (".wav", ".wave", ".aif", ".aiff", ".mxf")
VIDEO_EXT = (".mov", ".mp4", ".m4v", ".mxf", ".avi", ".mkv", ".webm", ".mpg", ".mpeg", ".dv", ".mts", ".m2ts")


class ParseError(ValueError):
    pass


def parse_session(path: str) -> Session:
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        data = decrypt(raw)
        r = Reader(data)
    except NotAProToolsFile as e:
        raise ParseError(str(e)) from e
    return _Parser(r, path).run()


class _Parser:
    def __init__(self, r: Reader, path: str):
        self.r = r
        self.path = path
        self.s = Session(
            path=path, name=os.path.splitext(os.path.basename(path))[0], product="", version="",
            sample_rate=0, bit_depth=None, timecode_rate_code=None, fps=None, fps_confidence="unknown",
            drop_frame=False, start_frames=0,
        )

    def warn(self, msg: str):
        self.s.warnings.append(msg)

    def run(self) -> Session:
        self.read_info()
        self.read_sample_rate()
        self.read_timecode()
        self.read_tracks()
        self.s.audio_files = self.read_files(0x1004, audio=True)
        self.s.video_files = self.read_files(0x1006, audio=False)
        self.read_file_metadata()
        self.s.audio_regions = self.read_regions(0x262A, 0x2629)
        self.s.video_regions = self.read_video_regions()
        self.read_clips()
        self.read_video_clips()
        self.read_memory_locations()
        return self.s

    # -- session info --------------------------------------------------------
    def read_info(self):
        r = self.r
        # Product block: length-prefixed strings such as "Pro Tools Ultimate", "2026.4.1", "Release"
        for b in r.find(0x0003, top_only=True):
            strings = []
            p = b.payload
            while p + 4 < b.end:
                n = r.u32(p)
                if 0 < n <= 200 and p + 4 + n <= b.end:
                    txt = r.d[p + 4:p + 4 + n].decode("utf-8", "replace")
                    if txt.isprintable():
                        strings.append(txt)
                        p += 4 + n
                        continue
                p += 1
            for txt in strings:
                if "Pro Tools" in txt and not self.s.product:
                    self.s.product = txt
                elif re.match(r"^\d{4}\.\d+", txt) and not self.s.version:
                    self.s.version = txt
        # Session name: the first string in the session-path block that ends in a session extension
        for b in r.find(0x2067, top_only=True):
            names = re.findall(rb"[\x20-\x7e]{2,200}\.pt[xfs]", r.d[b.payload:b.end])
            if names:
                self.s.name = os.path.splitext(names[0].decode("latin1"))[0]
                break

    def read_sample_rate(self):
        for b in self.r.find(0x1028):
            if b.size >= 8:
                sr = self.r.u32(b.payload + 2)
                if 8000 <= sr <= 768000:
                    self.s.sample_rate = sr
                    return
        self.warn("sample rate block missing; assuming 48000")
        self.s.sample_rate = 48000

    def read_timecode(self):
        blocks = self.r.find(0x204D)
        if len(blocks) != 1:
            self.warn(f"expected one timecode block, found {len(blocks)}")
            return
        b = blocks[0]
        code = self.r.u32(b.payload)
        self.s.timecode_rate_code = code
        self.s.start_frames = self.r.u32(b.payload + 9) if b.size >= 15 else 0
        if code in TIMECODE_RATES:
            fps, drop, conf = TIMECODE_RATES[code]
            self.s.fps, self.s.drop_frame, self.s.fps_confidence = fps, drop, conf
        else:
            self.warn(f"unknown timecode rate code {code}")

    # -- tracks --------------------------------------------------------------
    def read_tracks(self):
        r = self.r
        lists = r.find(0x2519, top_only=True) or r.find(0x2519)
        if not lists:
            self.warn("track list block missing")
            return
        seen: set[tuple[str, str]] = set()
        tracks: list[Track] = []
        for entry in lists[0].kids(0x251A):
            p = entry.payload
            kind_code = r.u16(p)
            name, q = r.string(p + 2)
            fmt_code = r.u8(q)
            uid = r.d[q + 6:q + 18].hex()  # "2a 00 00 00" + 8 id bytes
            key = (name, uid)
            if key in seen:               # the list is stored twice
                continue
            seen.add(key)
            kind = TRACK_KINDS.get(kind_code, f"unknown-{kind_code}")
            fmt, nch = TRACK_FORMATS.get(fmt_code, (f"format-{fmt_code}", 0))
            tracks.append(Track(len(tracks), name, kind, kind_code, fmt, fmt_code, nch, uid))
        self.s.tracks = tracks

    # -- media files ---------------------------------------------------------
    def read_files(self, list_ct: int, audio: bool) -> list[MediaFile]:
        r = self.r
        files: list[MediaFile] = []
        for b in r.find(list_ct, top_only=True):
            for c in b.kids(0x103A):
                if c.size < 8:
                    continue
                # u32 record count, then records of (u8 kind, u32, string, 4-byte type):
                # kind 1 names a folder, kind 2 a file in it, kind 0 ends the list.
                p = c.payload + 4
                folder = ""
                while p + 9 < c.end:
                    kind = r.u8(p)
                    if kind not in (0x01, 0x02):
                        break
                    name, q = r.string(p + 5)
                    fourcc = r.d[q:q + 4].decode("latin1", "replace").strip("\x00")
                    p = q + 4
                    if not name:
                        break
                    if kind == 0x01:
                        folder = name
                        continue
                    low = name.lower()
                    if audio:
                        ok = any(k in fourcc for k in AUDIO_FOURCC) if fourcc else low.endswith(AUDIO_EXT)
                        if ".grp" in name or "Audio Files" in name or "Fade Files" in name:
                            ok = False
                    else:
                        ok = low.endswith(VIDEO_EXT) or bool(fourcc)
                    if ok:
                        files.append(MediaFile(len(files), name, folder, fourcc))
        return files

    def read_file_metadata(self):
        r = self.r
        for b in r.find(0x1004, top_only=True):
            metas = b.kids(0x1003)
            for f, m in zip(self.s.audio_files, metas):
                info = m.first(0x1001)
                if info and info.size >= 16:
                    p = info.payload
                    f.sample_rate = r.u32(p)
                    f.channels = r.u8(p + 4)
                    f.bit_depth = r.u8(p + 5)
                    f.length_samples = r.u64(p + 6)
        depths = [f.bit_depth for f in self.s.audio_files if f.bit_depth]
        if depths:
            self.s.bit_depth = max(set(depths), key=depths.count)

    # -- regions -------------------------------------------------------------
    def read_regions(self, list_ct: int, entry_ct: int) -> list[Region]:
        r = self.r
        regions: list[Region] = []
        for lst in r.find(list_ct, top_only=True):
            for e in lst.children:
                if e.ctype != entry_ct or not e.children:
                    continue
                rec = e.children[0]              # 0x2628: name + timing
                name, j = r.string(rec.payload)
                offset, length, stamp = r.three_point(j)
                findex = r.u32(rec.end) if rec.end + 4 <= e.end else -1
                regions.append(Region(len(regions), name, findex, offset, length, stamp, _channel_of(name)))
        return regions

    def read_video_regions(self) -> list[Region]:
        r = self.r
        regions: list[Region] = []
        for e in r.find(0x262D):
            rec = e.first(0x2628)
            if not rec:
                continue
            name, j = r.string(rec.payload)
            offset, length, stamp = r.three_point(j)
            findex = r.u32(rec.end) if rec.end + 4 <= e.end else -1
            regions.append(Region(len(regions), name, findex, offset, length, stamp, None))
        return regions

    # -- clips ---------------------------------------------------------------
    def _placements(self, lane: Block, entry_ct: int) -> list[tuple[int, int, str]]:
        """(region index, start, unit) for every clip record of a lane.

        A lane holds records of several kinds (byte 15): 0x03 is a clip on the timeline;
        0x01 and 0x02 reference regions that are not visible (trim handles, parents of
        edited clips) and are left out, as a comparison with Pro Tools' own clip list shows.
        """
        r = self.r
        out = []
        for pl in lane.kids(entry_ct):
            for ref in pl.kids(0x104F):
                p = ref.payload
                rindex = r.u32(p + 2)
                raw = r.uN(p + 7, 5)
                if r.u8(p + 15) != 0x03:
                    continue
                unit = "samples"
                if raw >= ZERO_TICKS:
                    raw -= ZERO_TICKS
                    unit = "ticks"
                out.append((rindex, raw, unit))
        return out

    def read_clips(self):
        r = self.r
        s = self.s
        maps = r.find(0x1054, top_only=True) or r.find(0x1054)
        if not maps:
            return
        by_name: dict[str, Track] = {}
        for t in s.tracks:
            if t.kind == "audio":
                by_name.setdefault(t.name, t)
        # Lanes: 0x1052 entries with the same label are the channel lanes of one playlist
        lanes: "OrderedDict[str, list[Block]]" = OrderedDict()
        for m in maps:
            for lane in m.kids(0x1052):
                label, _ = r.string(lane.payload)
                lanes.setdefault(label, []).append(lane)
        for label, chans in lanes.items():
            track = by_name.get(label)
            alternate = track is None
            if alternate:
                base = re.sub(r"(\.\d+|\.dup\d+)+$", "", label)
                track = by_name.get(base)
            clips = self._merge_lanes(track.index if track else -1, label, chans)
            if alternate:
                if clips:
                    s.alternate_playlists[label] = clips
            else:
                s.clips.extend(clips)
        s.clips.sort(key=lambda c: (c.track, c.start))

    def _merge_lanes(self, track_index: int, label: str, chans: list[Block]) -> list[Clip]:
        """Merge the channel lanes of a playlist into clips (stereo pairs become one clip)."""
        regions = self.s.audio_regions
        merged: dict[tuple, Clip] = {}
        for lane in chans:
            for rindex, start, unit in self._placements(lane, 0x1050):
                if rindex >= len(regions):
                    self.warn(f"{label}: placement refers to unknown region {rindex}")
                    continue
                reg = regions[rindex]
                key = (start, reg.file, reg.offset, reg.length, unit)
                clip = merged.get(key)
                if clip is None:
                    clip = Clip(track_index, label, start, reg.length, reg.offset, reg.file,
                                _clip_name(reg.name), [], [], unit)
                    merged[key] = clip
                clip.regions.append(rindex)
                clip.channels.append(reg.channel)
        return sorted(merged.values(), key=lambda c: c.start)

    def read_video_clips(self):
        r = self.r
        s = self.s
        video_tracks = [t for t in s.tracks if t.kind == "video"]
        for m in r.find(0x1055, top_only=True) or r.find(0x1055):
            for lane in m.kids(0x1053):
                label, _ = r.string(lane.payload)
                track = next((t for t in video_tracks if t.name == label), video_tracks[0] if video_tracks else None)
                for rindex, start, unit in self._placements(lane, 0x1051):
                    if rindex >= len(s.video_regions):
                        self.warn(f"video: placement refers to unknown region {rindex}")
                        continue
                    reg = s.video_regions[rindex]
                    s.video_clips.append(Clip(track.index if track else -1, label, start, reg.length, reg.offset,
                                              reg.file, reg.name, [rindex], [None], "frames"))
        s.video_clips.sort(key=lambda c: (c.track, c.start))

    # -- memory locations ----------------------------------------------------
    def read_memory_locations(self):
        r = self.r
        seen: set[tuple] = set()
        for container in r.find(0x2030):
            for b in container.kids(0x2077):
                if b.size < 40:
                    continue
                p = b.payload
                number = r.u16(p)
                flags = r.d[p + 2:p + 6]
                name, q = r.string(p + 6)
                # flags: byte 1 bit 0 = has a time position (else a view-only location);
                # byte 0 bit 1 = position in samples (else in ticks, with the ZERO_TICKS bias)
                has_time = bool(flags[1] & 0x01)
                unit = "samples" if flags[0] & 0x02 else "ticks"
                if unit == "samples":
                    start, end = r.u64(q), r.u64(q + 8)
                else:
                    start, end = r.uN(q, 5), r.uN(q + 8, 5)
                    start = start - ZERO_TICKS if start >= ZERO_TICKS else start
                    end = end - ZERO_TICKS if end >= ZERO_TICKS else end
                q += 16
                # Then: view settings (46 bytes in PT 2025/2026), u32 -1, a byte per track
                # (u32 count + bytes), five bytes, the comment, zero/ff padding (40 bytes in PT 2026,
                # 54 in PT 2025), u16 colour, u32 count of the per-track child records, children.
                # The child records anchor the layout: colour and count sit right before the first.
                first = b.children[0].pos if b.children else b.end
                n_tracks = len(b.kids(0x2506))
                comment, color = "", None
                for x in range(q, min(q + 96, b.end - 12)):
                    if r.u32(x) != 0xFFFFFFFF:
                        continue
                    n = r.u32(x + 4)
                    c = x + 8 + n + 5
                    if n > 8192 or c + 4 > b.end:
                        continue
                    clen = r.u32(c)
                    t = c + 4 + clen
                    gap = first - t
                    if clen > 4096 or not 40 <= gap <= 96 or r.u32(first - 4) != n_tracks:
                        continue
                    if any(v not in (0x00, 0xFF) for v in r.d[t:first - 6]):
                        continue
                    comment = r.d[c + 4:t].decode("utf-8", "replace")
                    raw_color = r.u16(first - 6)
                    color = raw_color if raw_color < 0x8000 else None
                    break
                else:
                    self.warn(f"memory location #{number} {name!r}: unknown record layout")
                if not has_time:
                    kind, start_v, end_v = "none", None, None
                else:
                    kind = "selection" if end > start else "marker"
                    start_v, end_v = start, (end if end > start else None)
                key = (number, name, start_v, end_v, comment)
                if key in seen:
                    continue
                seen.add(key)
                self.s.memory_locations.append(
                    MemoryLocation(number, name, kind, start_v, end_v, unit, comment, color))
        self.s.memory_locations.sort(key=lambda m: (m.start if m.start is not None else -1, m.number))


def _channel_of(name: str) -> int | None:
    m = re.search(r"\.(L|R|C|Ls|Rs|LFE|Lss|Rss|Lsr|Rsr|Lc|Rc)$", name)
    if not m:
        return None
    return {"L": 0, "R": 1, "C": 2}.get(m.group(1))


def _clip_name(region_name: str) -> str:
    return re.sub(r"\.(L|R|C|Ls|Rs|LFE)$", "", region_name)
