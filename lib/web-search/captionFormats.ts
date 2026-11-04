/**
 * Universal caption/transcript wire-format engine — the provider-neutral
 * core of media-caption capture.
 *
 * WHY THIS EXISTS (probed live 2026-10-28): modern video platforms gate
 * their caption endpoints on request-scoped anti-abuse tokens (YouTube's
 * Proof-of-Origin is the exemplar: `get_transcript` → 400, and the signed
 * caption baseUrl answers 200 with an EMPTY body for every format — even
 * fetched from inside the watch page). The only party that can fetch
 * captions is the player itself. So the capture strategy is universal:
 * load the page, surface the player's caption track (DOM text tracks, the
 * CC control, or the player's own caption XHR), and PARSE whatever
 * standard wire format comes back. NOTHING in this file (or its sibling
 * captionProbe.ts / media-captions.ts) keys off a domain, host, or
 * provider-specific URL — detection is by standard format shape only.
 *
 * Formats handled (all are open standards every major player ships one
 * of): YouTube json3, WebVTT (.vtt — Dailymotion/Twitch/HTML5 native),
 * srv3 XML, TTML/DFXP. Pure functions — unit-tested without a browser.
 *
 * NOT Whisper: Whisper (lib/server/extract/audio.ts) only handles
 * uploaded audio/video attachments, never streamed media URLs.
 */

export interface CaptionSegment {
  text: string;
  startMs: number;
}

/* Wire caps: bound the RPC payloads and rendered transcripts. The
   rendered form matches the InnerTube transcript shape (12k chars), so
   downstream consumers cannot tell the tiers apart. */
const MAX_SEGMENTS = 800;
const MAX_TOTAL_CHARS = 16_000;
const RENDER_CAP = 12_000;

/**
 * Universal caption-endpoint URL filter: standard track-format names and
 * extensions across providers (timedtext/srv3/json3 = YouTube, .vtt/
 * webvtt = Twitch + HTML5, texttracks = Vimeo, captions/subtitles =
 * Dailymotion & most custom players). False positives are harmless —
 * bodies only count when a real parser accepts them (and the listener
 * only reads xhr/fetch bodies, never documents).
 */
export const CAPTION_URL_RE =
  /(?:timedtext|captions?|subtitles?|texttracks?|webvtt|ttml|dfxp|json3|srv3|transcript|closed.?captions?|\.vtt(?:$|[?#]))/i;

export function isCaptionCandidateUrl(url: string): boolean {
  return CAPTION_URL_RE.test(url);
}

/* ── time helpers ─────────────────────────────────────────────────────── */

/** "hh:mm:ss.mmm" | "mm:ss.mmm" | "ss.mmm" | "90.5" | "90.5s" → ms. */
export function parseCaptionTimeToMs(v: string): number {
  const t = String(v ?? "").trim();
  if (!t) return 0;
  if (/^\d+(?:\.\d+)?s?$/i.test(t)) return Math.round(parseFloat(t) * 1000) || 0;
  const parts = t.split(":");
  if (parts.length > 3 || parts.length === 0) return 0;
  let ms = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = parseFloat(parts[i].replace(",", "."));
    if (!Number.isFinite(n)) return 0;
    const weight = parts.length - i === 3 ? 3_600_000 : parts.length - i === 2 ? 60_000 : 1_000;
    ms += n * weight;
  }
  return Math.round(ms) || 0;
}

function fmtClock(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Collapse any run of whitespace incl. LINE/PARAGRAPH SEPARATORS (\s
    covers U+2028/U+2029) to a single space. */
function squash(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function pushSeg(
  segs: CaptionSegment[],
  state: { total: number },
  raw: string,
  startMs: number,
): boolean {
  // Order matters: strip MARKUP first, THEN decode entities — decoding
  // first would re-expose "&lt;3" (the caption heart emoticon) as "<3"
  // and the tag-strip would eat it.
  const clean = decodeEntities(squash(raw)).trim();
  if (!clean) return false;
  segs.push({ text: clean, startMs: Number(startMs) || 0 });
  state.total += clean.length;
  return segs.length >= MAX_SEGMENTS || state.total >= MAX_TOTAL_CHARS;
}

/* ── format parsers (shape-detected, domain-free) ─────────────────────── */

/** json3: `{events:[{tStartMs,segs:[{utf8}]}]}`. */
export function parseJson3Captures(body: string): CaptionSegment[] {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  const events: any[] = Array.isArray(j?.events) ? j.events : [];
  const segs: CaptionSegment[] = [];
  const state = { total: 0 };
  for (const e of events) {
    const parts: any[] = Array.isArray(e?.segs) ? e.segs : [];
    const text = parts.map((s) => String(s?.utf8 ?? "")).join("");
    if (pushSeg(segs, state, text, Number(e?.tStartMs ?? e?.tMs ?? 0) || 0)) break;
  }
  return segs;
}

/** WebVTT: `WEBVTT` header; cue = `start --> end` line + text lines. */
export function parseVttCaptures(body: string): CaptionSegment[] {
  const t = (body ?? "").replace(/\r\n?/g, "\n");
  if (!/^(﻿)?WEBVTT/i.test(t)) return [];
  return cueTextCaptures(t);
}

/**
 * SRT: same cue machine as WebVTT but NO header — the cue block is
 * `index ⏎ start --> end ⏎ text ⏎ ⏎`. SRT is what Wikimedia Commons,
 * Dailymotion, and most download/embed tooling ship, so the universal
 * engine must not require a WEBVTT header.
 */
export function parseSrtCaptures(body: string): CaptionSegment[] {
  return cueTextCaptures((body ?? "").replace(/\r\n?/g, "\n"));
}

/** SRT shape: an integer index line directly above a `start --> end`
    line. CRLF-tolerant on purpose — real-world SRT files (Wikimedia,
    Dailymotion, most downloads) emit `\r\n`, and the sniff happens on
    the raw body before any normalization. */
export const SRT_SHAPE_RE =
  /(?:^|\r?\n)[ \t]*\d+[ \t]*\r?\n[ \t]*[0-9:.,]+[ \t]*-->[ \t]*[0-9:.,]+/;

/** The shared `start --> end` + text-lines state machine. */
function cueTextCaptures(t: string): CaptionSegment[] {
  const segs: CaptionSegment[] = [];
  const state = { total: 0 };
  const lines = t.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^([0-9:.,]+)\s+-->\s+[0-9:.,]+/);
    if (!m) {
      i++;
      continue;
    }
    const startMs = parseCaptionTimeToMs(m[1]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*-->/.test(lines[i])) {
      textLines.push(lines[i]);
      i++;
    }
    if (pushSeg(segs, state, textLines.join(" "), startMs)) break;
  }
  return segs;
}

/** srv3: `<text start="123.45" dur="…">line</text>`. */
export function parseSrv3Captures(body: string): CaptionSegment[] {
  const re = /<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const segs: CaptionSegment[] = [];
  const state = { total: 0 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (pushSeg(segs, state, m[2], parseCaptionTimeToMs(m[1]))) break;
  }
  return segs;
}

/** TTML/DFXP: `<p begin="00:01:30.000" …>line</p>`. */
export function parseTtmlCaptures(body: string): CaptionSegment[] {
  const re = /<p\b[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  const segs: CaptionSegment[] = [];
  const state = { total: 0 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (pushSeg(segs, state, m[2], parseCaptionTimeToMs(m[1]))) break;
  }
  return segs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Shape-detected dispatch: JSON body → json3; `WEBVTT` header → VTT;
 * XML → srv3 then TTML. Returns [] when nothing parses — an empty body
 * (the anti-abuse token gate's favorite answer: 200 + 0 bytes) simply
 * yields no segments.
 */
export function sniffCaptures(body: string): CaptionSegment[] {
  const t = (body ?? "").trim();
  if (!t) return [];
  if (t.startsWith("{")) return parseJson3Captures(t);
  if (/^(﻿)?WEBVTT/i.test(t)) return parseVttCaptures(t);
  if (SRT_SHAPE_RE.test(t)) return parseSrtCaptures(t);
  if (/<text\b/.test(t)) {
    const srv3 = parseSrv3Captures(t);
    if (srv3.length) return srv3;
  }
  if (/<p\b[^>]*\bbegin=/.test(t)) return parseTtmlCaptures(t);
  return [];
}

/**
 * Segments → the exact "[mm:ss] line" shape the InnerTube transcript
 * path produces (same 12k cap).
 */
export function formatCaptionSegments(segs: CaptionSegment[]): string {
  const lines: string[] = [];
  for (const s of segs) {
    const text = (s.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`[${fmtClock(Math.round((s.startMs || 0) / 1000))}] ${text}`);
    if (lines.join("\n").length >= RENDER_CAP) break;
  }
  return lines.join("\n").slice(0, RENDER_CAP);
}
