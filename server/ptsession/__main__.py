"""Command line: python -m ptsession <session.ptx> [--json]"""

import json
import sys

from .parser import parse_session


def main(argv):
    if len(argv) < 2:
        print("usage: python -m ptsession <session.ptx> [--json]")
        return 2
    s = parse_session(argv[1])
    if "--json" in argv:
        json.dump(s.to_dict(), sys.stdout, indent=1, ensure_ascii=False)
        return 0
    sr = s.sample_rate
    print(f"{s.name}  ({s.product} {s.version})  {sr} Hz, {s.bit_depth}-bit, fps={s.fps} ({s.fps_confidence}), "
          f"start frames={s.start_frames}")
    print(f"{len(s.tracks)} tracks, {len(s.audio_files)} audio files, {len(s.video_files)} video files, "
          f"{len(s.audio_regions)} audio regions, {len(s.video_regions)} video regions, "
          f"{len(s.clips)} clips, {len(s.video_clips)} video clips, {len(s.memory_locations)} memory locations, "
          f"{len(s.alternate_playlists)} alternate playlists")
    print("\nTracks:")
    for t in s.tracks:
        n = sum(1 for c in s.clips if c.track == t.index) + sum(1 for c in s.video_clips if c.track == t.index)
        print(f"  [{t.index:2d}] {t.kind:7s} {t.format:7s} {t.name!r}  clips={n}")
    print("\nVideo clips:")
    for c in s.video_clips:
        f = s.video_files[c.file].name if 0 <= c.file < len(s.video_files) else "?"
        print(f"  @{c.start:8d} fr  len {c.length:6d} fr  off {c.offset:6d}  {f}  ({c.name})")
    print("\nMemory locations:")
    for m in s.memory_locations:
        pos = f"{m.start / sr:9.3f}s" if m.start is not None and m.unit == "samples" else f"{m.start}"
        end = f"-{m.end / sr:.3f}s" if m.end is not None and m.unit == "samples" else ""
        print(f"  #{m.number:3d} {m.kind:9s} {pos}{end:>11s} col={m.color_index} {m.name!r}  {m.comment!r}")
    print("\nFirst clips:")
    for c in s.clips[:15]:
        t = s.tracks[c.track].name if c.track >= 0 else "?"
        f = s.audio_files[c.file].name if 0 <= c.file < len(s.audio_files) else "?"
        print(f"  {t!r:34s} @{c.start / sr:9.3f}s len {c.length / sr:7.3f}s off {c.offset:9d} ch={c.channels} {f}")
    if s.warnings:
        print("\nWarnings:")
        for w in s.warnings:
            print("  " + w)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
