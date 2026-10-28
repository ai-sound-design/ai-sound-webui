"""
Reader for Avid Pro Tools session files (.ptx, .ptf, .pts) without Pro Tools.

The file is a tree of blocks behind a trivial XOR obfuscation. This package
decodes the block tree and reads what a timeline needs: sample rate, timecode
rate, tracks in session order (audio, aux, master, VCA, folder, video), audio
and video files, regions, the clips on every track, and the memory locations.

The block layout follows what libptformat (LGPL, by Damien Zammit) and later
reverse-engineering established; the memory location, track type, video region
and video clip records were worked out on Pro Tools 2024-2026 sessions.
"""

from .parser import parse_session, ParseError
from .model import Session

__all__ = ["parse_session", "ParseError", "Session"]
