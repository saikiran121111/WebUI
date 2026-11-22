"""Legacy binary readers: OLE2 (.doc/.xls/.ppt) and MATLAB .mat, stdlib only.

The release law this module exists for: "the real parser replaces the printable-
string fallback". Byte-scanning recovers text that happens to be ASCII runs; a
Word 97 piece table stores text through a CP table + compressed flag, an XLS
string is a UTF-16/rich-text SST index, a PPT atom is a typed record — those
need the container decoded. A MALFORMED container (the smoke.* fixtures have
nfat=0 and zeroed DIFAT) has no structure to decode, so this module raises
OleError and the caller keeps the labeled byte-scan recovery — the honest path
for corrupt input, stated as partial.

Container laws (measured against the real fixtures, 2026-11-21):
  * header: sector shift @0x1E, mini shift @0x20, nfat @0x2C (NOT 0x28),
    dir_start @0x30, mini cutoff @0x38, mini_start @0x3C, DIFAT start @0x44.
  * DIFAT entries may begin with -2 (free marker) and repeat; a candidate FAT
    sector is accepted only when it SELF-IDENTIFIES: fat[sid % (ssz/4)] == -3.
  * streams shorter than the mini cutoff live in the mini stream (64-byte
    sectors chained through the mini-FAT); bigger ones chain through the FAT.
"""
from __future__ import annotations

import struct
import zlib

from .structures import Block, DocCoverage, Document

MAX_XLS_CELLS = 50_000


class OleError(Exception):
    """The container does not carry the structure it claims. Typed, never silent."""


# ---------------------------------------------------------------- OLE2 container

class OLE2:
    def __init__(self, data: bytes) -> None:
        if len(data) < 512 or data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise OleError("not an OLE2 compound file (magic missing)")
        self.data = data
        ssz_shift = struct.unpack_from("<H", data, 0x1E)[0]
        msz_shift = struct.unpack_from("<H", data, 0x20)[0]
        if not (6 <= ssz_shift <= 16):
            raise OleError(f"implausible sector size shift {ssz_shift}")
        self.ssz = 1 << ssz_shift
        self.msz = 1 << msz_shift
        nfat = struct.unpack_from("<I", data, 0x2C)[0]
        self.dir_start = struct.unpack_from("<i", data, 0x30)[0]
        self.cutoff = struct.unpack_from("<I", data, 0x38)[0]
        self.mini_start = struct.unpack_from("<i", data, 0x3C)[0]
        difat_start = struct.unpack_from("<i", data, 0x44)[0]
        difat_count = struct.unpack_from("<I", data, 0x48)[0]

        entries: list[int] = []
        seen: set[int] = set()
        # Collect FAT sector IDs from the DIFAT. Writers put junk in unused
        # slots (Word 97: slot values 0, 11124, metadata blobs), so a slot is
        # accepted only when it points INSIDE the file and its payload carries
        # a 0xFFFFFFFD entry -- the self-entry a FAT sector carries for its own
        # sector ID. Payloads are materialized at coverage slot = collection
        # order (DIFAT order == FAT chain order per MS-CFB 2.4.1).
        def _fat_slot(sid: int) -> bool:
            off = 512 + sid * self.ssz
            if sid >= (len(data) - 512) // self.ssz:
                return False
            per = self.ssz // 4
            return -3 in struct.unpack_from(f"<{per}i", data, off)

        # Two-tier collection: slots that self-identify (Word 97 SR2 marks its
        # FAT sectors, junk slots do not) come first; when fewer than nfat
        # pass -- PowerPoint 97 omits the marker on later FAT sectors -- fill
        # from the remaining in-bounds slots in DIFAT slot order.
        fill: list[int] = []
        for off in range(0x44, min(0x44 + 4 * 436, 0x44 + 4 * max(0, (len(data) - 0x44) // 4)), 4):
            v = struct.unpack_from("<i", data, off)[0]
            if 0 <= v < (len(data) - 512) // self.ssz and v not in seen:
                seen.add(v)
                if _fat_slot(v):
                    entries.append(v)
                else:
                    fill.append(v)
        if nfat and len(entries) < nfat:
            entries.extend(fill[: nfat - len(entries)])
        # Chained DIFAT sectors for big files: slots are FAT sectors by
        # construction, so no probe is applied; only bounds and dedup.
        sector, guard = difat_start, 0
        while sector >= 0 and difat_count and guard < 4096:
            off = 512 + sector * self.ssz
            if off + self.ssz > len(data):
                break
            per = self.ssz // 4
            for k in range(per - 1):
                v = struct.unpack_from("<i", data, off + k * 4)[0]
                if v >= 0 and v not in seen:
                    seen.add(v)
                    entries.append(v)
            sector = struct.unpack_from("<i", data, off + (per - 1) * 4)[0]
            guard += 1
        if nfat and len(entries) < nfat:
            raise OleError(f"file declares {nfat} FAT sectors, directory provides {len(entries)}")

        def _is_fat_sector(sid: int) -> bool:
            off = 512 + sid * self.ssz
            if off + self.ssz > len(data):
                return False
            return struct.unpack_from("<i", data, off + (sid % (self.ssz // 4)) * 4)[0] == -3

        fat_sector = None
        for sid in entries:
            if _is_fat_sector(sid):
                fat_sector = sid
                break
        if fat_sector is None:
            raise OleError("no self-identifying FAT sector: the allocation table is absent "
                           "or zeroed (container is malformed)")

        # The FAT is indexed by sector ID, and the i-th FAT sector in DIFAT
        # (chain) order covers sector IDs [i*per, (i+1)*per) -- the FAT sector's
        # own sector ID says nothing about that range (the self-entry is the -3
        # probe marker), so coverage comes from the DIFAT slot, never from the
        # sector ID and never from following self-entries as a chain.
        per = self.ssz // 4
        self.fat: list[int] = [-2] * (len(entries) * per)
        for i, sid in enumerate(entries):
            off = 512 + sid * self.ssz
            if off + self.ssz > len(data):
                raise OleError(f"DIFAT names sector {sid}, beyond the file end")
            base = i * per
            self.fat[base:base + per] = struct.unpack_from(f"<{per}i", data, off)

        self.dir_entries = self._chain(self.dir_start)
        self.streams = self._directory()
        mini_bytes = self.read_stream_bytes("MiniStream")
        self.mini_fat = self._mini_fat()
        self._mini_base = mini_bytes

    def _chain(self, start: int) -> bytes:
        out = bytearray()
        # A valid chain never reuses a sector, so the sector count is the
        # cycle bound; a runaway guard (1e6 x sector size) would memory-dump.
        sector, guard = start, 0
        while sector >= 0 and guard < len(self.fat):
            off = 512 + sector * self.ssz
            if off + self.ssz > len(self.data):
                raise OleError("stream chain reaches beyond the file end")
            if sector >= len(self.fat):
                raise OleError(f"stream chain names sector {sector}, outside the FAT")
            out += self.data[off:off + self.ssz]
            sector = self.fat[sector]
            guard += 1
        return bytes(out)

    def _mini_fat(self) -> list[int]:
        if self.mini_start < 0:
            return []
        raw = self._chain(self.mini_start)
        return struct.unpack(f"<{len(raw) // 4}i", raw)

    def _directory(self) -> dict[str, tuple[int, int]]:
        streams: dict[str, tuple[int, int]] = {}
        mini_ref: tuple[int, int] | None = None
        for off in range(0, len(self.dir_entries), 128):
            ent = self.dir_entries[off:off + 128]
            if len(ent) < 128:
                break
            name_len = struct.unpack_from("<H", ent, 0x40)[0]
            etype = ent[0x42]
            if name_len == 0 or name_len > 64:
                continue
            raw = ent[0:name_len - 2] if name_len >= 2 else b""
            try:
                name = raw.decode("utf-16-le", "replace")
            except Exception:
                continue
            start = struct.unpack_from("<i", ent, 0x74)[0]
            size = struct.unpack_from("<I", ent, 0x78)[0]
            if etype == 5:  # root storage: its chain IS the mini stream
                mini_ref = (start, size)
            elif etype == 2:
                streams[name] = (start, size)
        if mini_ref:
            self._root_ref = mini_ref
        return streams

    def read_stream_bytes(self, name: str) -> bytes:
        if name == "MiniStream":
            start, size = getattr(self, "_root_ref", (-1, 0))
            raw = self._chain(start) if start >= 0 else b""
            return raw[:size]
        if name not in self.streams:
            raise OleError(f"stream {name!r} is not in the directory")
        start, size = self.streams[name]
        if size < self.cutoff:
            if not self.mini_fat:
                raise OleError(f"stream {name!r} needs the mini stream but the mini-FAT is absent")
            out = bytearray()
            sector, guard = start, 0
            while sector >= 0 and guard < len(self.mini_fat):
                if sector >= len(self.mini_fat):
                    raise OleError(f"mini-stream chain names sector {sector}, outside the mini-FAT")
                off = sector * self.msz
                if off + self.msz > len(self._mini_base):
                    break
                out += self._mini_base[off:off + self.msz]
                sector = self.mini_fat[sector]
                guard += 1
            return bytes(out[:size])
        return self._chain(start)[:size]


# ---------------------------------------------------------------- Word 97 (.doc)

def _word_text(data: bytes) -> str:
    try:
        ole = OLE2(data)
        wd = ole.read_stream_bytes("WordDocument")
    except (OleError, struct.error) as exc:
        raise OleError(f"WordDocument stream unreadable: {exc}") from exc
    if len(wd) < 0x01B0:
        raise OleError(f"WordDocument stream is {len(wd)} bytes, too small to carry a FIB")
    flags = struct.unpack_from("<H", wd, 0x0A)[0]
    table_name = "1Table" if flags & 0x200 else "0Table"
    fc_clx = struct.unpack_from("<I", wd, 0x01A2)[0]
    lcb_clx = struct.unpack_from("<I", wd, 0x01AA)[0]
    pieces: list[str] = []
    table = None
    try:
        table = ole.read_stream_bytes(table_name)
    except OleError:
        table = None
    if table and 0 < lcb_clx and fc_clx + lcb_clx <= len(table):
        pos, end = fc_clx, fc_clx + lcb_clx
        clx = table
        while pos < end:
            clxt = clx[pos]
            if clxt == 1:  # Prc: property modifier, skip
                cb = struct.unpack_from("<H", clx, pos + 1)[0]
                pos += 3 + cb
                continue
            if clxt == 2:  # Pcdt: the piece table
                lcb = struct.unpack_from("<I", clx, pos + 1)[0]
                plc = clx[pos + 5:pos + 5 + lcb]
                count = (lcb - 4) // 12
                cps = struct.unpack_from(f"<{count + 1}i", plc, 0)
                base = 4 * (count + 1)
                for k in range(count):
                    raw_fc = struct.unpack_from("<I", plc, base + 8 * k + 2)[0]
                    compressed = (raw_fc >> 30) & 1
                    fc = (raw_fc & 0x3FFF_FFFF) >> 1
                    cch = cps[k + 1] - cps[k]
                    if cch <= 0:
                        continue
                    if compressed:
                        pieces.append(wd[fc:fc + cch].decode("cp1252", "replace"))
                    else:
                        pieces.append(wd[fc:fc + cch * 2].decode("utf-16-le", "replace"))
                break
            raise OleError(f"unexpected Clx entry 0x{clxt:02X}; the piece table is malformed")
    if not pieces:
        # No usable piece table: Word stores simple (fComplex=0) text as one run.
        if not flags & 0x04:
            fc_min = struct.unpack_from("<I", wd, 0x18)[0]
            fc_mac = struct.unpack_from("<I", wd, 0x1C)[0]
            if 0 <= fc_min < fc_mac <= len(wd):
                pieces.append(wd[fc_min:fc_mac].decode("cp1252", "replace"))
    text = "".join(pieces)
    if not text.strip():
        raise OleError("the Word piece table yielded no text")
    text = text.replace("\r", "\n").replace("\x07", " | ")
    for marker in ("\x13", "\x14", "\x15"):
        text = text.replace(marker, "")
    return text


def _doc_document(data: bytes, source_id: str, source_hash: str) -> Document:
    text = _word_text(data)
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    blocks = [Block(p, "paragraph", source_id, source_hash, {"paragraph": pi})
              for pi, p in enumerate(paragraphs, start=1)]
    cov = DocCoverage(1, 1, method="word97-piecetable",
                      note="text decoded through the piece table (CPs + compressed flag), "
                           "not scanned from raw bytes; paragraph marks kept, formatting lost")
    cov.units_succeeded = [1]
    return Document(source_id, source_hash, "doc", blocks, cov,
                    {"unit_numbering": "1-based paragraph index",
                     "not_extracted": ["character formatting", "styles", "headers/footers",
                                       "embedded objects", "tracked revisions"]})


# ---------------------------------------------------------------- PowerPoint 97 (.ppt)

# Atom header (MS-PPT 2.2, field layout measured on both fixtures 2026-11-21):
# recVer(4)|recInstance(12) u16, recType u16, recLength u32. PowerPoint 97
# files mark CONTAINERS with recInstance == 0xF (recVer stays 0x0), so the
# 0xF test goes on the low 12 bits.
_PPT_TEXT_CHARS = 4000   # utf-16-le
_PPT_TEXT_BYTES = 4008   # cp1252
_PPT_DOCUMENT = 1000     # per-context story container
_PPT_NOTES = 1008        # per-slide notes text container (file order == slide order)
_PPT_SLIDE = 1006        # slide container (text directly inside, container order == slide order)
_PPT_SLIDE_LIST = 1016   # SlideListWithText: masters AND real slides/notes as children
_PPT_MASTER_STYLE = 1036 # TextMasterStyleAtom: placeholder text when a direct child of 1016
_PPT_STORY = 4080        # TextStoryContainer inside a 1000 DocumentAtom


def _ppt_document(data: bytes, source_id: str, source_hash: str) -> Document:
    try:
        ole = OLE2(data)
        body = ole.read_stream_bytes("PowerPoint Document")
    except (OleError, struct.error) as exc:
        raise OleError(f"PowerPoint Document stream unreadable: {exc}") from exc

    slides: list[list[str]] = []          # ordered slide texts
    notes: list[list[str]] = []           # ordered notes-container texts
    story: list[str] = []                 # texts of the current DocumentAtom story
    seen: set[str] = set()                # global text dedup (stories repeat cumulatively)
    deep_truncated = [False]              # a container body contained itself

    def walk(pos: int, end: int, parents: tuple[int, ...]) -> None:
        nonlocal story
        if len(parents) > 16:
            # A container atom claiming a body that contains itself nests
            # forever; genuine PP97 trees nest < 10 deep, so cut at 16.
            deep_truncated[0] = True
            return
        while pos + 8 <= end:
            ver_inst, rec_type, length = struct.unpack_from("<HHI", body, pos)
            body_start, body_end = pos + 8, pos + 8 + length
            if body_end > end:
                break  # truncated atom: keep what decoded, stop the walk
            if (ver_inst & 0xFFF) == 0xF:
                if rec_type == _PPT_MASTER_STYLE and parents and parents[-1] == _PPT_SLIDE_LIST:
                    pass  # slide-master placeholders: not slide content
                elif rec_type == _PPT_SLIDE:
                    slides.append([])
                    walk(body_start, body_end, parents + (rec_type,))
                elif rec_type == _PPT_NOTES:
                    notes.append([])
                    walk(body_start, body_end, parents + (rec_type,))
                elif rec_type == _PPT_DOCUMENT:
                    story = []
                    walk(body_start, body_end, parents + (rec_type,))
                    # Stories repeat cumulatively across DocumentAtoms and
                    # duplicate the slide-container texts; insertion-time dedup
                    # via `seen` leaves only this atom's new texts in `story`,
                    # and those open the next slide.
                    if story:
                        slides.append(story)
                elif rec_type == _PPT_STORY:
                    walk(body_start, body_end, parents + (rec_type,))
                else:
                    walk(body_start, body_end, parents + (rec_type,))
            elif rec_type in (_PPT_TEXT_CHARS, _PPT_TEXT_BYTES):
                enc = "utf-16-le" if rec_type == _PPT_TEXT_CHARS else "cp1252"
                text = body[body_start:body_end].decode(enc, "replace").strip()
                # PP97 list-style marker atoms carry a bare "*": layout noise.
                if text and text != "*":
                    if _PPT_NOTES in parents and notes:
                        notes[-1].append(text)
                    elif _PPT_SLIDE in parents and slides:
                        slides[-1].append(text)
                        seen.add(text)  # story atoms repeat these texts
                    elif _PPT_STORY in parents and text not in seen:
                        # Cumulative stories can re-emit a paragraph split one
                        # byte differently ("...formatting" vs "...formattingT");
                        # a long prefix of an already-seen text is a repeat.
                        # NOTE: no `continue` here -- it would skip the pos
                        # advance below and freeze the scan on this atom.
                        if not any(len(t) >= 16 and (text.startswith(t) or t.startswith(text))
                                   for t in seen):
                            seen.add(text)
                            story.append(text)
            pos += 8 + length

    walk(0, len(body), ())
    # A DocumentAtom story belongs to one slide per occurrence; the dedup above
    # keeps duplicates out. Notes container k maps to slide k+1 (file order,
    # measured on both fixtures).
    blocks: list[Block] = []
    empty: list[int] = []
    for si, texts in enumerate(slides, start=1):
        if not texts and not (notes[si - 1] if si <= len(notes) else []):
            empty.append(si)
        for t in texts:
            blocks.append(Block(t, "paragraph", source_id, source_hash, {"slide": si}))
    for ni, note_texts in enumerate(notes, start=1):
        slide = min(ni, max(1, len(slides)))
        for t in note_texts:
            blocks.append(Block(t, "note", source_id, source_hash,
                                {"slide": slide, "part": "notes"}))
    if not slides:
        raise OleError("the PowerPoint Document atom walk found no slide text")
    total = len(slides)
    cov = DocCoverage(total, total - len(empty), units_empty=empty, method="ppt-atom-walk",
                      note="text atoms decoded by record type (TextChars UTF-16 / TextBytes ANSI), "
                           "notes kept separate from slide text; PowerPoint 97 notes-master "
                           "placeholder text in a notes container is carried with that slide's notes"
                           + ("; nesting deeper than 16 atoms was truncated" if deep_truncated[0] else ""))
    cov.units_succeeded = [si for si in range(1, total + 1) if si not in set(empty)]
    return Document(source_id, source_hash, "ppt", blocks, cov,
                    {"unit_numbering": "1-based slide ordinal (container order; document-story "
                                        "order with first-occurrence dedup)",
                     "slides": total})


# ---------------------------------------------------------------- Excel 97-2003 (.xls)

_BOF, _EOF, _BOUNDSHEET, _SST, _CONTINUE = 0x0809, 0x000A, 0x0085, 0x00FC, 0x003C
_LABELSST, _LABEL, _NUMBER, _RK, _FORMULA = 0x00FD, 0x0204, 0x0203, 0x027E, 0x0006


def _rk_value(rk: int) -> float:
    """Excel RK number: bit0 /100, bit1 30-bit integer, else the DOUBLE'S HIGH 32 BITS.
    (Packing rk into the low half yields 1e-315 garbage — measured on solver.xls.)"""
    if rk & 0x02:
        value = float(rk >> 2)  # arithmetic shift: signed 30-bit integer
    else:
        value = struct.unpack("<d", b"\x00\x00\x00\x00" + struct.pack("<I", rk & 0xFFFFFFFC))[0]
    return value / 100.0 if rk & 0x01 else value


def _fmt_number(v: float) -> str:
    if v != v:
        return "NA()"
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return f"{v:.10g}"


def _records(body: bytes):
    pos = 0
    while pos + 4 <= len(body):
        rec, length = struct.unpack_from("<HH", body, pos)
        start = pos + 4
        end = min(start + length, len(body))
        yield rec, body[start:end]
        pos += 4 + length
        if length == 0 and rec == 0:
            break


class _SSTReader:
    """Boundary-aware SST string reader (MS-XLS string rules, measured on solver.xls).

    A string's bytes may cross CONTINUE records. Each CONTINUE body carrying
    CONTINUED string data begins with a NEW grb flags byte (no cch prefix) whose
    bit 0 switches the encoding for the REMAINING characters of that string.
    Rich-text (cbExt) and extended (EXTSZ) bytes straddle records the same way
    (grb byte at each record start); they are skipped, not decoded.
    """

    def __init__(self, first_body: bytes, continues: list[bytes]) -> None:
        self.rec = [first_body] + continues
        self.rec_index = 0
        self.off = 12  # skip total + unique counts

    def _advance_record(self) -> int:
        """Move to the next record; return its grb flags byte (record starts at 1)."""
        self.rec_index += 1
        self.off = 0
        if self.rec_index >= len(self.rec) or self.rec[self.rec_index] == b"":
            raise OleError("SST ended mid-string")
        grb = self.rec[self.rec_index][0]
        self.off = 1
        return grb

    def _at_boundary(self) -> bool:
        return self.off >= len(self.rec[self.rec_index])

    def _take(self, count: int, grb_on_advance: bool) -> bytes:
        out = bytearray()
        while len(out) < count:
            if self.rec_index >= len(self.rec):
                raise OleError("SST ended mid-string")
            avail = len(self.rec[self.rec_index]) - self.off
            if avail <= 0:
                self._advance_record()
                if not grb_on_advance:
                    self.off = 0  # fixed-width straddle: no grb prefix (e.g. cch header)
                continue
            take = min(avail, count - len(out))
            out += self.rec[self.rec_index][self.off:self.off + take]
            self.off += take
        return bytes(out)

    def string(self) -> str:
        if self.rec_index >= len(self.rec) or self._at_boundary():
            raise OleError("no room for a string header in the SST")
        cch = struct.unpack("<H", self._take(2, False))[0]
        if self.rec_index >= len(self.rec) or self._at_boundary():
            raise OleError("SST string header ended at a record boundary")
        grb = self.rec[self.rec_index][self.off]
        self.off += 1
        rich = (grb & 0x08) != 0
        extended = (grb & 0x04) != 0
        cb_ext = struct.unpack("<H", self._take(2, True))[0] if rich else 0
        n_ext = struct.unpack("<H", self._take(2, True))[0] if extended else 0
        chars: list[str] = []
        remaining = cch
        utf16 = (grb & 1) != 0
        while remaining > 0:
            if self.rec_index >= len(self.rec):
                raise OleError("SST ended mid-string")
            if self._at_boundary():
                utf16 = (self._advance_record() & 1) != 0
                continue
            avail = len(self.rec[self.rec_index]) - self.off
            if utf16:
                take_bytes = min(avail - (avail % 2), remaining * 2)
                if take_bytes == 0:
                    self.off = len(self.rec[self.rec_index])  # straddle odd byte to CONTINUE
                    continue
                chars.append(self._take(take_bytes, False).decode("utf-16-le", "replace"))
                remaining -= take_bytes // 2
            else:
                take_bytes = min(avail, remaining)
                chars.append(self._take(take_bytes, False).decode("cp1252", "replace"))
                remaining -= take_bytes
        if rich:
            self._take(cb_ext, True)  # rich runs: grb per record, skipped
        self._take(n_ext * 4, True)   # extended data, skipped
        return "".join(chars)


def _compressed_string(body: bytes) -> str:
    if len(body) < 3:
        return ""
    cch = body[0]
    grb = body[1]
    data = body[2:]
    if grb & 1:
        return data[:cch * 2].decode("utf-16-le", "replace")
    return data[:cch].decode("cp1252", "replace")


def _xls_document(data: bytes, source_id: str, source_hash: str) -> Document:
    try:
        ole = OLE2(data)
        try:
            wb = ole.read_stream_bytes("Workbook")
        except OleError:
            wb = ole.read_stream_bytes("Book")
    except (OleError, struct.error) as exc:
        raise OleError(f"Excel workbook stream unreadable: {exc}") from exc

    recs = list(_records(wb))
    sst: _SSTReader | None = None
    strings: list[str] = []
    for i, (rec, body) in enumerate(recs):
        if rec == _SST:
            continues = []
            j = i + 1
            while j < len(recs) and recs[j][0] == _CONTINUE:
                continues.append(recs[j][1])
                j += 1
            sst = _SSTReader(body, continues)
            count = struct.unpack_from("<I", body, 0)[0]
            for _ in range(count):
                try:
                    strings.append(sst.string())
                except OleError:
                    break
            break

    sheet_names: list[str] = []
    for rec, body in recs:
        if rec == _BOUNDSHEET and len(body) >= 8:
            sheet_names.append(_compressed_string(body[6:]).strip("\x00"))

    blocks: list[Block] = []
    sheet_index = 0
    in_globals = True
    truncated = False
    for rec, body in recs:
        if rec == _BOF:
            bof_type = struct.unpack_from("<H", body, 2)[0] if len(body) >= 4 else 5
            if bof_type == 0x0010:  # sheet document begins
                in_globals = False
                sheet_index += 1
            continue
        if in_globals:
            continue
        name = sheet_names[sheet_index - 1] if 0 < sheet_index <= len(sheet_names) else f"sheet{sheet_index}"
        if len(body) < 6:
            continue
        row, col = struct.unpack_from("<HH", body, 0)
        ref = f"{_colA1(col)}{row + 1}"
        loc = {"sheet": name, "sheet_index": max(1, sheet_index), "cell": ref}
        if len(blocks) >= MAX_XLS_CELLS:
            truncated = True
            break
        if rec == _LABELSST and len(body) >= 10:
            isst = struct.unpack_from("<I", body, 6)[0]
            if isst < len(strings):
                text = strings[isst].strip()
                if text:
                    blocks.append(Block(text, "cell", source_id, source_hash, loc))
        elif rec == _LABEL:
            text = _compressed_string(body[6:]).strip()
            if text:
                blocks.append(Block(text, "cell", source_id, source_hash, loc))
        elif rec == _NUMBER and len(body) >= 14:
            value = struct.unpack_from("<d", body, 6)[0]
            blocks.append(Block(_fmt_number(value), "cell", source_id, source_hash, loc))
        elif rec == _RK and len(body) >= 10:
            rk = struct.unpack_from("<i", body, 6)[0]
            blocks.append(Block(_fmt_number(_rk_value(rk)), "cell", source_id, source_hash, loc))
        elif rec == _FORMULA and len(body) >= 14:
            value = struct.unpack_from("<d", body, 6)[0]
            if value != value:
                continue  # NaN cache: BIFF spells "no cached value" this way
            loc["formula_note"] = "binary expression not decoded; cached result shown"
            blocks.append(Block(f"={_fmt_number(value)}", "formula", source_id, source_hash, loc))
    if not blocks:
        raise OleError("the workbook stream decoded no readable cells")
    sheets_total = max(1, sheet_index)
    cov = DocCoverage(sheets_total, sheets_total, method="biff8-cells",
                      note="cell addresses, shared-string values, RK/IEEE numbers decoded; "
                           "number formats, styles and formula EXPRESSIONS are not re-derived")
    cov.units_succeeded = list(range(1, sheets_total + 1))
    meta = {"sheets": sheet_names, "unit_numbering": "1-based BOUNDSHEET order",
            "not_extracted": ["formula expressions (cached results only)", "number formats",
                              "styles", "charts", "pivot caches"]}
    if truncated:
        meta["cells_truncated"] = f"cell blocks capped at {MAX_XLS_CELLS}"
    return Document(source_id, source_hash, "xls", blocks, cov, meta)


def _colA1(col: int) -> str:
    col += 1
    letters = ""
    while col > 0:
        col, rem = divmod(col - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


# ---------------------------------------------------------------- MATLAB (.mat)

_MAT_V4_PRECISION = {1: "<b", 2: "<B", 3: "<h", 4: "<H", 5: "<i", 6: "<I", 7: "<f", 9: "<d"}


def _mat_document(data: bytes, source_id: str, source_hash: str) -> Document:
    arrays: list[tuple[str, list[int], list[float]]] = []
    notes: list[str] = []
    if data[:16].startswith(b"MATLAB 5.0"):
        arrays, notes = _mat_v5(data)
    else:
        arrays, notes = _mat_v4(data)
    if not arrays:
        raise OleError("no numeric MATLAB array found in the .mat file "
                       f"({'/'.join(notes) if notes else 'structure unreadable'})")
    blocks: list[Block] = []
    for name, dims, values in arrays:
        rows, cols = (dims + [1, 1])[:2]
        blocks.append(Block(f"{name} dims {rows}x{cols} (column-major)", "cell", source_id,
                            source_hash, {"variable": name, "dims": dims}))
        shown = 0
        for idx, v in enumerate(values):
            if shown >= 10_000:
                blocks.append(Block(f"{name}: value list truncated at 10000 entries", "cell",
                                    source_id, source_hash, {"variable": name}))
                break
            r = idx % rows
            c = idx // rows
            blocks.append(Block(f"{name}[{r + 1},{c + 1}] = {_fmt_number(v)}", "cell",
                                source_id, source_hash,
                                {"variable": name, "row": r + 1, "col": c + 1}))
            shown += 1
    cov = DocCoverage(len(arrays), len(arrays), method="mat-numeric",
                      note="numeric arrays decoded from the container (dims kept, column-major); "
                           "cell/struct/sparse arrays and complex parts are declared in meta")
    cov.units_succeeded = list(range(1, len(arrays) + 1))
    meta = {"unit_numbering": "1-based variable ordinal",
            "variables": [a[0] for a in arrays]}
    if notes:
        meta["unsupported_arrays"] = notes
    return Document(source_id, source_hash, "mat", blocks, cov, meta)


def _mat_v4(data: bytes) -> tuple[list[tuple[str, list[int], list[float]]], list[str]]:
    """MAT v4: 32-bit words [type/flags, m, n, ...], name, raw numeric data.

    The standard layout is (type=10 miMATRIX, precision, ndims, m, n, imag). The
    fixture family writes a five-word variant [flags, m, n, imag, nameLen]; both
    are accepted, and the layout used is named in the notes.
    """
    arrays: list[tuple[str, list[int], list[float]]] = []
    notes: list[str] = []
    pos = 0
    while pos + 20 <= len(data):
        words = struct.unpack_from("<5I", data, pos)
        name = ""
        dims: list[int] = []
        precision = 9
        data_start = 0
        standard = words[0] == 10
        if standard:
            _type, precision, ndims, m, n = words[0], words[1], words[2], words[3], words[4]
            imag = struct.unpack_from("<I", data, pos + 20)[0]
            pos += 24
            if ndims < 2:
                notes.append("array with ndims < 2 skipped")
                break
            dims = [m, n]
        else:
            flags, m, n, imag, name_len = words
            if flags != 0 or imag != 0 or m == 0 or n == 0 or name_len == 0 or name_len > 4096:
                notes.append("unrecognized MAT v4 object header")
                break
            dims = [m, n]
            pos += 20
        raw_name = data[pos:pos + 1024].split(b"\x00")[0]
        name = raw_name.decode("ascii", "replace")
        pos += len(name) + 1
        count = dims[0] * dims[1]
        fmt = _MAT_V4_PRECISION.get(precision, "<d")
        need = count * struct.calcsize(fmt)
        # Legacy v4 writers vary: some pad the name to a 4-byte boundary, some
        # put the payload directly after the terminating NUL (the fixture's
        # 59-byte file proves it). Take the offset that fits; unaligned first.
        data_start = pos if pos + need <= len(data) else (pos + 3) & ~3
        if data_start + need > len(data):
            notes.append(f"array {name!r}: data extends beyond the file")
            break
        # struct needs the byte-order char first: "<f8" + count -> "<4f8".
        values = [float(v) for v in struct.unpack_from(f"{fmt[0]}{count}{fmt[1:]}", data, data_start)]
        arrays.append((name, dims, values))
        pos = data_start + need
    return arrays, notes


def _mat_v5(data: bytes) -> tuple[list[tuple[str, list[int], list[float]]], list[str]]:
    arrays: list[tuple[str, list[int], list[float]]] = []
    notes: list[str] = []
    pos = 128
    endian = "<"
    if pos + 4 <= len(data):
        probe = struct.unpack_from("<I", data, pos)[0]
        # The first element must be miMATRIX (14); a byte-swapped file reads it
        # in the HIGH half of the tag word.
        if (probe & 0xFFFF) == 0 and (probe >> 16) in (14, 15):
            endian = ">"
    while pos + 8 <= len(data):
        dtype, nbytes = struct.unpack_from(endian + "II", data, pos)
        if dtype == 15:  # miCOMPRESSED (zlib)
            chunk = data[pos + 8:pos + 8 + nbytes]
            try:
                inner = zlib.decompress(chunk)
            except zlib.error:
                notes.append("compressed data element failed zlib decompression")
                break
            got, more = _mat_v5_blocks(inner, endian)
            arrays.extend(got)
            notes.extend(more)
            pos += 8 + nbytes
            continue
        if dtype != 14:  # only matrices are read
            notes.append(f"data element type {dtype} skipped")
            pos += 8 + nbytes
            continue
        got, more = _mat_v5_blocks(data[pos + 8:pos + 8 + nbytes], endian)
        arrays.extend(got)
        notes.extend(more)
        pos += 8 + nbytes
    return arrays, notes


def _mat_v5_element(block: bytes, pos: int, endian: str) -> tuple[int, bytes, int]:
    dtype, count = struct.unpack_from(endian + "II", block, pos)
    if (count >> 16) != 0:  # small element: count in high 16 bits, data inline
        n = count >> 16
        return dtype, block[pos + 4:pos + 4 + n], pos + 8
    return dtype, block[pos + 8:pos + 8 + count], pos + 8 + ((count + 7) & ~7)


# MAT-File Format Table 1-1 (MathWorks, verified 2026-11-21): data element type
# identifiers used by the real-part subelement of numeric arrays.
_MAT_V5_DATA_FMT = {1: "b", 2: "B", 3: "h", 4: "H", 5: "i", 6: "I",
                    7: "f", 9: "d", 12: "q", 13: "Q"}
# Table 1-3: numeric array classes. 1 cell / 2 struct / 4 char / 5 sparse are not numeric.
_MAT_V5_CLASS_NUMERIC = frozenset({6, 7, 8, 9, 10, 11, 12, 13, 14, 15})


def _mat_v5_blocks(block: bytes, endian: str) -> tuple[list[tuple[str, list[int], list[float]]], list[str]]:
    """One miMATRIX payload: ArrayFlags (miUINT32) → Dimensions (miINT32) →
    ArrayName (miINT8) → Real part (any numeric type) → optional Imaginary part."""
    arrays: list[tuple[str, list[int], list[float]]] = []
    notes: list[str] = []
    pos = 0
    name, dims, cls = "", [], 0
    flags_seen = dims_seen = real_seen = False
    label = "array"
    while pos + 8 <= len(block):
        dtype, payload, pos = _mat_v5_element(block, pos, endian)
        if dtype == 6 and not flags_seen:  # miUINT32 ArrayFlags: low byte = class
            values = struct.unpack(f"{endian}{len(payload) // 4}I", payload)
            cls = values[0] & 0xFF
            flags_seen = True
            if values[0] & 0x800:
                notes.append(f"{label}: complex array")
        elif dtype == 5 and flags_seen and not dims_seen:  # miINT32 Dimensions
            dims = list(struct.unpack(f"{endian}{len(payload) // 4}i", payload))
            dims_seen = True
        elif dtype == 1 and dims_seen:  # miINT8 ArrayName
            name = payload.split(b"\x00")[0].decode("utf-8", "replace")
            label = name or label
        elif dtype in _MAT_V5_DATA_FMT and dims_seen:  # Real part (then optional imaginary)
            fmt = _MAT_V5_DATA_FMT[dtype]
            values = [float(v) for v in
                      struct.unpack(f"{endian}{len(payload) // struct.calcsize(fmt)}{fmt}", payload)]
            if not real_seen:
                arrays.append((name or label, dims, values))
                real_seen = True
            else:
                notes.append(f"{label}: complex imaginary part not merged")
        elif dtype == 14:  # nested miMATRIX: cell/struct member — declared, not traversed
            notes.append(f"{label}: nested cell/struct member not traversed")
        elif dtype in (16, 17, 18):
            notes.append(f"{label}: unicode character element not extracted")
    if not real_seen:
        if cls == 1:
            notes.append(f"{label}: cell array (nested members not traversed)")
        elif cls == 2:
            notes.append(f"{label}: struct array (nested members not traversed)")
        elif cls == 4:
            notes.append(f"{label}: character array text not extracted")
        elif cls == 5:
            notes.append(f"{label}: sparse array not decoded")
        elif cls and cls not in _MAT_V5_CLASS_NUMERIC:
            notes.append(f"{label}: class {cls} carries no plain numeric data")
        elif flags_seen:
            notes.append(f"{label}: numeric subelement missing")
    return arrays, notes
