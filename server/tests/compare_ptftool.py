"""
Cross-check the clip placements of ptsession against libptformat's `ptftool` output.

    python tests/compare_ptftool.py <session.ptx> <ptftool-output.txt>

ptftool lists one line per channel lane:
    `track` t(n) (file.wav) @ start + offset, length
ptsession merges the channel lanes of a track into one clip, so each clip is
expanded into one entry per region before comparing.
"""

import re
import sys
from collections import Counter

sys.path.insert(0, __import__("os").path.join(__import__("os").path.dirname(__file__), ".."))

from ptsession import parse_session  # noqa: E402

LINE = re.compile(r"^`(.*)` t\(\d+\) \((.*)\) @ (\d+) \+ (\d+), (\d+)$")


def ptftool_entries(path: str) -> Counter:
    entries: Counter = Counter()
    active = False
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        if line.startswith("Track name (Track#) (WAV filename)"):
            active = True
            continue
        if not active:
            continue
        m = LINE.match(line)
        if m:
            track, file, start, offset, length = m.groups()
            entries[(track, file, int(start), int(offset), int(length))] += 1
    return entries


def session_entries(path: str) -> tuple[Counter, dict]:
    s = parse_session(path)
    entries: Counter = Counter()
    for c in s.clips:
        track = s.tracks[c.track].name if c.track >= 0 else c.playlist
        file = s.audio_files[c.file].name if 0 <= c.file < len(s.audio_files) else "?"
        for _ in c.regions:
            entries[(track, file, c.start, c.offset, c.length)] += 1
    for clips in s.alternate_playlists.values():
        for c in clips:
            file = s.audio_files[c.file].name if 0 <= c.file < len(s.audio_files) else "?"
            for _ in c.regions:
                entries[(c.playlist, file, c.start, c.offset, c.length)] += 1
    return entries, s.to_dict()


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    ours, info = session_entries(argv[1])
    theirs = ptftool_entries(argv[2])
    missing = theirs - ours
    extra = ours - theirs
    print(f"ptftool: {sum(theirs.values())} lane entries, ptsession: {sum(ours.values())}")
    print(f"missing in ptsession: {sum(missing.values())}, extra in ptsession: {sum(extra.values())}")
    for k, n in list(missing.items())[:15]:
        print("  missing", n, k)
    for k, n in list(extra.items())[:15]:
        print("  extra  ", n, k)
    print(f"files: ptsession {len(info['audioFiles'])}, regions {len(info['audioRegions'])}, "
          f"video clips {len(info['videoClips'])}, memory locations {len(info['memoryLocations'])}, "
          f"warnings {len(info['warnings'])}")
    return 0 if not missing and not extra else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
