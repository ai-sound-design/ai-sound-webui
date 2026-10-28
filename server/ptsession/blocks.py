"""Decryption and block tree of a Pro Tools session file."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Iterator

MAGIC = b"\x030010111100101011"
ZMARK = 0x5A


class NotAProToolsFile(ValueError):
    pass


def gen_xor_delta(xor_value: int, mul: int, negative: bool) -> int:
    for i in range(256):
        if ((i * mul) & 0xFF) == xor_value:
            return (-i) & 0xFF if negative else i
    return 0


def decrypt(raw: bytes) -> bytes:
    """Undo the XOR obfuscation. Bytes 0x00-0x13 are plain text."""
    if len(raw) < 0x20 or raw[:17] != MAGIC:
        raise NotAProToolsFile("missing Pro Tools session magic")
    xor_type = raw[0x12]
    xor_value = raw[0x13]
    if xor_type == 0x01:          # Pro Tools 5-9
        delta = gen_xor_delta(xor_value, 53, False)
        key = bytes((i * delta) & 0xFF for i in range(256))
        body = bytes(b ^ key[(i + 0x14) & 0xFF] for i, b in enumerate(raw[0x14:]))
    elif xor_type == 0x05:        # Pro Tools 10 and later: key byte changes every 4 KiB
        delta = gen_xor_delta(xor_value, 11, True)
        key = bytes((i * delta) & 0xFF for i in range(256))
        out = bytearray(raw)
        n = len(raw)
        i = 0x14
        while i < n:
            k = key[(i >> 12) & 0xFF]
            end = min(n, (i | 0xFFF) + 1)
            chunk = raw[i:end]
            out[i:end] = bytes(b ^ k for b in chunk) if k else chunk
            i = end
        return bytes(out)
    else:
        raise NotAProToolsFile(f"unsupported xor type 0x{xor_type:02x} (Pro Tools Cloud session?)")
    return raw[:0x14] + body


@dataclass
class Block:
    pos: int            # position of the 'Z' marker
    btype: int          # block type (< 256)
    size: int           # payload size counted from the content-type field
    ctype: int          # content type
    children: list["Block"] = field(default_factory=list)

    @property
    def payload(self) -> int:
        """Offset of the first payload byte after the content type."""
        return self.pos + 9

    @property
    def end(self) -> int:
        return self.pos + 7 + self.size

    def walk(self) -> Iterator["Block"]:
        yield self
        for c in self.children:
            yield from c.walk()

    def kids(self, ctype: int) -> list["Block"]:
        return [c for c in self.children if c.ctype == ctype]

    def first(self, ctype: int) -> "Block | None":
        for c in self.children:
            if c.ctype == ctype:
                return c
        return None


class Reader:
    """Little-endian field access plus the block tree of a decrypted file."""

    def __init__(self, data: bytes):
        self.d = data
        self.big_endian = data[0x11] != 0
        if self.big_endian:
            raise NotAProToolsFile("big-endian (classic Mac) sessions are not supported")
        self.top: list[Block] = self._parse_top()

    # -- scalar access -------------------------------------------------------
    def u8(self, p: int) -> int:
        return self.d[p]

    def u16(self, p: int) -> int:
        return struct.unpack_from("<H", self.d, p)[0]

    def u32(self, p: int) -> int:
        return struct.unpack_from("<I", self.d, p)[0]

    def u64(self, p: int) -> int:
        return struct.unpack_from("<Q", self.d, p)[0]

    def uN(self, p: int, n: int) -> int:
        return int.from_bytes(self.d[p:p + n], "little", signed=False) if n else 0

    def f64(self, p: int) -> float:
        return struct.unpack_from("<d", self.d, p)[0]

    def string(self, p: int, limit: int = 4096) -> tuple[str, int]:
        """Length-prefixed string at p. Returns (text, position after it)."""
        n = self.u32(p)
        if n > limit or p + 4 + n > len(self.d):
            return "", p + 4
        return self.d[p + 4:p + 4 + n].decode("utf-8", "replace"), p + 4 + n

    # -- block tree ----------------------------------------------------------
    def _parse_at(self, pos: int, limit: int) -> Block | None:
        d = self.d
        if pos + 9 > limit or d[pos] != ZMARK:
            return None
        btype = self.u16(pos + 1)
        size = self.u32(pos + 3)
        ctype = self.u16(pos + 7)
        end = pos + 7 + size
        # Same validity rules as libptformat: small block type, fits in parent.
        if btype & 0xFF00 or size < 2 or end > limit:
            return None
        b = Block(pos, btype, size, ctype)
        p = pos + 9
        while p < end:
            q = d.find(b"Z", p, end)
            if q < 0:
                break
            c = self._parse_at(q, end)
            if c:
                b.children.append(c)
                p = c.end
            else:
                p = q + 1
        return b

    def _parse_top(self) -> list[Block]:
        top: list[Block] = []
        i = 0x14
        n = len(self.d)
        while i < n:
            b = self._parse_at(i, n)
            if b:
                top.append(b)
                i = b.end
            else:
                q = self.d.find(b"Z", i + 1)
                if q < 0:
                    break
                i = q
        return top

    def all_blocks(self) -> Iterator[Block]:
        for b in self.top:
            yield from b.walk()

    def find(self, ctype: int, top_only: bool = False) -> list[Block]:
        if top_only:
            return [b for b in self.top if b.ctype == ctype]
        return [b for b in self.all_blocks() if b.ctype == ctype]

    def three_point(self, j: int) -> tuple[int, int, int]:
        """Region timing record at j (the byte after the region name).

        Returns (offset_into_source, length, source_timestamp). The widths of the
        three numbers are in the high nibbles of bytes j+1..j+3; values follow
        from j+5.
        """
        d = self.d
        if j + 5 > len(d):
            return 0, 0, 0
        ob = (d[j + 1] & 0xF0) >> 4
        lb = (d[j + 2] & 0xF0) >> 4
        sb = (d[j + 3] & 0xF0) >> 4
        p = j + 5
        offset = self.uN(p, ob)
        length = self.uN(p + ob, lb)
        start = self.uN(p + ob + lb, sb)
        return offset, length, start
