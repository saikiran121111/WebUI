import type { IndexChunk, TranscriptSegment } from "./types";

const CHUNK_CHARS = Number(process.env.ATTACH_INDEX_CHUNK ?? 1200);
const OVERLAP_CHARS = Number(process.env.ATTACH_INDEX_OVERLAP ?? 150);

interface Unit {
  text: string;
  startSec: number | null;
  endSec: number | null;
}

/** Plain text split into sentence-ish units (newlines are hard breaks). */
export function sentenceUnits(text: string): Unit[] {
  const units: Unit[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    for (const p of t.split(/(?<=[.!?])["')\]]*\s+/)) {
      const s = p.trim();
      if (s) units.push({ text: s, startSec: null, endSec: null });
    }
  }
  return units;
}

function segmentUnits(segments: TranscriptSegment[]): Unit[] {
  return segments
    .map(s => ({ text: s.text.trim(), startSec: s.start, endSec: s.end }))
    .filter(u => u.text);
}

/** A unit bigger than the whole chunk: split by sentence, then raw slice. */
function splitOversized(u: Unit, size: number): Unit[] {
  if (u.text.length <= size) return [u];
  const pieces: string[] = [];
  let cur = "";
  for (const s of u.text.match(/[^.!?]+[.!?]*\s*|\s+/g) ?? []) {
    if (cur && (cur + s).trimEnd().length > size) {
      pieces.push(cur.trim());
      cur = s;
    } else cur += s;
    while (cur.length > size) {
      pieces.push(cur.slice(0, size).trim());
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) pieces.push(cur.trim());
  // Timestamps cannot be split precisely — every piece keeps the unit's span.
  return pieces.map(t => ({ text: t, startSec: u.startSec, endSec: u.endSec }));
}

/**
 * Group sentence units into ~`size`-char chunks with ~`overlap` chars of
 * carry-over, so a thought is never cut at a chunk boundary. Timestamped
 * units (Whisper segments) carry their min/max times onto the chunk.
 */
function groupUnits(units: Unit[], size: number, overlap: number): IndexChunk[] {
  const expanded = units.flatMap(u => splitOversized(u, size));
  const chunks: IndexChunk[] = [];
  let cur: Unit[] = [];
  let len = 0;

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map(u => u.text).join(" ");
    const startSec = cur.find(u => u.startSec != null)?.startSec ?? null;
    const endSec = [...cur].reverse().find(u => u.endSec != null)?.endSec ?? null;
    chunks.push({ i: chunks.length, startSec, endSec, text, vec: [] });
  };

  for (const u of expanded) {
    if (cur.length && len + 1 + u.text.length > size) {
      const done = cur;
      flush();
      // Carry the trailing units into the next chunk (bounded by `overlap`).
      // Never carry the whole flushed chunk — that would loop forever.
      const carry: Unit[] = [];
      let carryChars = 0;
      for (let j = done.length - 1; j >= 0; j--) {
        const add = done[j].text.length + (carry.length ? 1 : 0);
        if (carryChars + add > overlap || carryChars + add > size / 2) break;
        carry.unshift(done[j]);
        carryChars += add;
      }
      cur = carry.length < done.length ? carry : [];
      len = cur === carry ? carryChars : 0;
    }
    len += (cur.length ? 1 : 0) + u.text.length;
    cur.push(u);
  }
  flush();
  return chunks;
}

/** Timestamped chunks from Whisper segments. */
export function chunkSegments(
  segments: TranscriptSegment[],
  size = CHUNK_CHARS,
  overlap = OVERLAP_CHARS,
): IndexChunk[] {
  return groupUnits(segmentUnits(segments), size, overlap);
}

/** Untimestamped chunks from plain text. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): IndexChunk[] {
  return groupUnits(sentenceUnits(text), size, overlap);
}
