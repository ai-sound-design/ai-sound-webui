"""Plain data model of a parsed session; `to_dict()` gives the JSON the web UI reads."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


# Track kinds as stored in the session's track list (first u16 of a 0x251a record).
TRACK_KINDS = {
    0x00: "audio",
    0x02: "aux",
    0x05: "master",
    0x08: "video",
    0x09: "vca",
    0x0B: "folder",
}

# Channel layouts (byte after the track name in a 0x251a record). Verified: 0, 1, 5, 6, 12.
TRACK_FORMATS = {
    0x00: ("mono", 1),
    0x01: ("stereo", 2),
    0x02: ("lcr", 3),
    0x03: ("lcrs", 4),
    0x04: ("quad", 4),
    0x05: ("5.0", 5),
    0x06: ("5.1", 6),
    0x07: ("6.0", 6),
    0x08: ("6.1", 7),
    0x09: ("7.0", 7),
    0x0A: ("7.1", 8),
    0x0C: ("video", 0),
}

# Timecode rate code of block 0x204d. Only the values marked "observed" were seen
# in real sessions; the rest follows Pro Tools' Session Setup list and is a guess.
TIMECODE_RATES = {
    0: (23.976, False, "guess"),
    1: (24.0, False, "observed"),
    2: (25.0, False, "observed"),
    3: (29.97, False, "guess"),
    4: (29.97, True, "guess"),
    5: (30.0, False, "guess"),
    6: (30.0, True, "guess"),
    7: (30.0, False, "observed"),
}


@dataclass
class Track:
    index: int
    name: str
    kind: str
    kind_code: int
    format: str
    format_code: int
    channels: int
    uid: str

    def to_dict(self):
        return asdict(self)


@dataclass
class MediaFile:
    index: int
    name: str
    folder: str
    fourcc: str
    sample_rate: int | None = None
    channels: int | None = None
    bit_depth: int | None = None
    length_samples: int | None = None

    def to_dict(self):
        return asdict(self)


@dataclass
class Region:
    index: int
    name: str
    file: int               # index into audio_files / video_files
    offset: int             # into the source file (samples, or frames for video)
    length: int
    timestamp: int          # original position stamp of the source
    channel: int | None     # 0/1 for ".L"/".R" regions of a stereo file, else None

    def to_dict(self):
        return asdict(self)


@dataclass
class Clip:
    track: int              # index into tracks
    playlist: str
    start: int              # samples (audio) or frames (video)
    length: int
    offset: int
    file: int
    name: str
    regions: list[int]      # one region per channel lane
    channels: list[int | None]
    unit: str = "samples"   # "samples" | "frames" | "ticks"

    def to_dict(self):
        return asdict(self)


@dataclass
class MemoryLocation:
    number: int
    name: str
    kind: str               # "marker" (point), "selection" (range), "none" (no time)
    start: int | None
    end: int | None
    unit: str               # "samples" | "ticks"
    comment: str
    color_index: int | None

    def to_dict(self):
        return asdict(self)


@dataclass
class Session:
    path: str
    name: str
    product: str
    version: str
    sample_rate: int
    bit_depth: int | None
    timecode_rate_code: int | None
    fps: float | None
    fps_confidence: str
    drop_frame: bool
    start_frames: int
    tracks: list[Track] = field(default_factory=list)
    audio_files: list[MediaFile] = field(default_factory=list)
    video_files: list[MediaFile] = field(default_factory=list)
    audio_regions: list[Region] = field(default_factory=list)
    video_regions: list[Region] = field(default_factory=list)
    clips: list[Clip] = field(default_factory=list)
    video_clips: list[Clip] = field(default_factory=list)
    alternate_playlists: dict[str, list[Clip]] = field(default_factory=dict)
    memory_locations: list[MemoryLocation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self):
        return {
            "path": self.path,
            "name": self.name,
            "product": self.product,
            "version": self.version,
            "sampleRate": self.sample_rate,
            "bitDepth": self.bit_depth,
            "timecode": {
                "rateCode": self.timecode_rate_code,
                "fps": self.fps,
                "fpsConfidence": self.fps_confidence,
                "dropFrame": self.drop_frame,
                "startFrames": self.start_frames,
            },
            "tracks": [t.to_dict() for t in self.tracks],
            "audioFiles": [f.to_dict() for f in self.audio_files],
            "videoFiles": [f.to_dict() for f in self.video_files],
            "audioRegions": [r.to_dict() for r in self.audio_regions],
            "videoRegions": [r.to_dict() for r in self.video_regions],
            "clips": [c.to_dict() for c in self.clips],
            "videoClips": [c.to_dict() for c in self.video_clips],
            "alternatePlaylists": {k: [c.to_dict() for c in v] for k, v in self.alternate_playlists.items()},
            "memoryLocations": [m.to_dict() for m in self.memory_locations],
            "warnings": self.warnings,
        }
