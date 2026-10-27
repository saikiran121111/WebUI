/**
 * YouTube deep evidence — built on youtubei.js (InnerTube client).
 *
 * The model must be able to "watch" ANY YouTube URL format:
 *   youtu.be/<id> · youtube.com/watch?v=<id> · /shorts/<id> · /embed/<id>
 *   /v/<id> · /live/<id> · m.youtube.com/* · music.youtube.com/*
 *
 * Evidence stack, in order of reliability:
 *   1. youtubei.js Innertube.create() → getInfo() — real title / channel /
 *      description / views / upload date / tags, plus getTranscript()
 *      (the actual "video content") and top comments when captions exist.
 *   2. ANDROID client retry when the web session is consent-gated.
 *   3. Keyless oEmbed → real title + channel name (last-resort metadata).
 *   4. No-caption videos → metadata + description + tags + top comments;
 *      the pipeline runs `youTubeCompanionQuery` (title + channel) through
 *      metasearch to identify the video's topic from the open web.
 */
import { fetchUrl } from "./net";
import { getBrowserTranscript } from "./media-captions";

const CONSENT_COOKIE = "CONSENT=YES+cb.20210328-17-p0.en+FX+700";

export interface YouTubeEvidence {
  videoId: string;
  canonicalUrl: string;
  title: string;
  channel: string;
  description: string;
  lengthSeconds: number;
  viewCount: number;
  publishDate: string;
  chapters: string[];
  transcript: string;
  markdown: string;
}

/* ── URL → video id (ALL formats) ─────────────────────────────────────── */

function validVideoId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

export function parseYouTubeVideoId(url: string): { videoId: string; canonicalUrl: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/^m\./, "")
      .replace(/^music\./, "");
    const canonical = (id: string) => "https://www.youtube.com/watch?v=" + id;

    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return validVideoId(id) ? { videoId: id, canonicalUrl: canonical(id) } : null;
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch" || u.pathname === "/watch_live") {
        const id = u.searchParams.get("v");
        return validVideoId(id) ? { videoId: id, canonicalUrl: canonical(id) } : null;
      }
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m && validVideoId(m[2])) return { videoId: m[2], canonicalUrl: canonical(m[2]) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ── youtubei.js sessions ──────────────────────────────────────────────── */

// youtubei.js v18 is ESM — lazy-load once, cache the web-client session so
// N videos don't each re-handshake InnerTube. The ANDROID fallback session
// is created per-call only when the web session is blocked (rare).
let _itPromise: Promise<any> | null = null;

async function innertubeCreate(clientType?: string): Promise<any> {
  const m: any = await import("youtubei.js");
  const Innertube = m?.Innertube ?? m?.default?.Innertube;
  if (!Innertube) throw new Error("youtubei.js unavailable");
  const opts: any = { cookie: CONSENT_COOKIE };
  if (clientType) opts.client_type = clientType;
  return await Innertube.create(opts);
}

function innertube(): Promise<any> {
  if (!_itPromise) {
    _itPromise = innertubeCreate().catch(() => {
      _itPromise = null; // allow a retry on the next call after a failure
      throw new Error("innertube session failed");
    });
  }
  return _itPromise;
}

/* ── evidence sources ─────────────────────────────────────────────────── */

/** Exported for the internal youtube-evidence RPC route (Rust bridge). */
export async function getInfo(videoId: string): Promise<any | null> {
  // Web session (cached).
  try {
    const it = await innertube();
    const info = await it.getInfo(videoId);
    if (info?.basic_info?.title ?? info?.title) return info;
  } catch {
    /* fall through to ANDROID */
  }
  // ANDROID client fallback — different consent surface, often works
  // when the web session is gated.
  try {
    const itA = await innertubeCreate("ANDROID");
    const info = await itA.getInfo(videoId);
    if (info?.basic_info?.title ?? info?.title) return info;
  } catch {
    /* oEmbed will cover metadata */
  }
  return null;
}

async function oEmbed(videoId: string): Promise<{ title: string; channel: string } | null> {
  const res = await fetchUrl(
    "https://www.youtube.com/oembed?url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) +
      "&format=json",
    { timeoutMs: 12_000 },
  );
  if (!res || !res.ok) return null;
  try {
    const j = JSON.parse(res.text);
    return { title: String(j?.title ?? ""), channel: String(j?.author_name ?? "") };
  } catch {
    return null;
  }
}

/** info.getTranscript() → "[mm:ss] line" timestamped transcript. */
async function transcriptFromInfo(info: any): Promise<string> {
  try {
    const tr = await info.getTranscript();
    const rawSegs: any[] =
      tr?.segments ?? tr?.transcript?.body?.initial_segments ?? [];
    const lines: string[] = [];
    for (const s of rawSegs) {
      const seg = s?.segment?.transcript_segment ?? s;
      const text = String(seg?.text?.content ?? seg?.text ?? "")
        .replace(/[\r\n\f\u2028]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const ms = Number(s?.start_ms ?? seg?.start_ms ?? s?.start ?? seg?.start ?? 0);
      lines.push(`[${fmtClock(Math.round(ms / 1000))}] ${text}`);
      if (lines.join("\n").length >= 12_000) break;
    }
    return lines.join("\n").slice(0, 12_000);
  } catch {
    return "";
  }
}

/** Top comments (sorted TOP) as short one-liners. */
async function topComments(info: any, n = 10): Promise<string[]> {
  try {
    const res = await info.getComments({ comment_sort: "TOP" });
    const arr: any[] = Array.isArray(res) ? res : res?.comments ?? [];
    const out: string[] = [];
    for (const c of arr) {
      const text = String(c?.comment?.content ?? c?.text?.content ?? c?.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      if (!text) continue;
      const author = String(c?.comment?.author ?? c?.author ?? "").trim();
      const likes = Number(c?.comment?.like_count ?? c?.like_count ?? 0);
      out.push(
        `${author ? author + (likes ? ` (${likes.toLocaleString("en-US")}👍)` : "") + ": " : ""}${text}`,
      );
      if (out.length >= n) break;
    }
    return out;
  } catch {
    return [];
  }
}

function fmtClock(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const CHAPTER_LINE_RE = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}\s*[-–—:.]?\s*\S.{0,90}$/;

function chaptersFromDescription(desc: string): string[] {
  return desc
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => CHAPTER_LINE_RE.test(l))
    .slice(0, 20);
}

/* ── top level ────────────────────────────────────────────────────────── */

/**
 * Gather the full YouTube evidence block for ANY youtube/youtu.be URL.
 * Returns null only when the video id cannot be parsed OR no title can be
 * resolved from ANY source (dead/private video).
 *
 * Memoized per video id: the pipeline's companion-query hop and the
 * extractor's platform adapter both call this for the same video inside
 * one turn — the InnerTube getInfo/transcript round-trips run once.
 */
const EVIDENCE_TTL_MS = 10 * 60_000;
const evidenceCache = new Map<string, { at: number; value: YouTubeEvidence | null }>();

export async function getYouTubeEvidence(url: string): Promise<YouTubeEvidence | null> {
  const parsed = parseYouTubeVideoId(url);
  if (!parsed) return null;
  const hit = evidenceCache.get(parsed.videoId);
  if (hit && Date.now() - hit.at < EVIDENCE_TTL_MS) return hit.value;
  const value = await collectYouTubeEvidence(url, parsed);
  if (evidenceCache.size >= 64) evidenceCache.clear();
  evidenceCache.set(parsed.videoId, { at: Date.now(), value });
  return value;
}

async function collectYouTubeEvidence(
  url: string,
  parsed: { videoId: string; canonicalUrl: string },
): Promise<YouTubeEvidence | null> {
  const { videoId, canonicalUrl } = parsed;

  // 1) youtubei.js getInfo (web → ANDROID fallback).
  const info = await getInfo(videoId);
  const bi: any = info?.basic_info ?? info ?? {};

  let title = String(bi?.title ?? "");
  // youtubei.js basic_info.channel is an OBJECT {id,name,url} in v13+ —
  // String() would yield "[object Object]" and poison the companion query.
  let channel =
    bi?.channel && typeof bi.channel === "object"
      ? String(bi.channel.name ?? "")
      : String(bi?.channel_name ?? bi?.channel ?? bi?.author ?? "");

  // 2) oEmbed last-resort metadata (works even when InnerTube is gated).
  if (!title || !channel) {
    const oe = await oEmbed(videoId);
    if (oe) {
      if (!title) title = oe.title;
      if (!channel) channel = oe.channel;
    }
  }
  if (!title) return null; // nothing real to report

  const description = String(bi?.short_description ?? bi?.description ?? "");
  const lengthSeconds = Number(bi?.duration) || 0;
  const viewCount = Number(String(bi?.view_count ?? "0").replace(/,/g, "")) || 0;
  const publishDate = String(bi?.upload_date ?? "").slice(0, 10);
  const tags: string[] = Array.isArray(bi?.tags)
    ? bi.tags.map((t: any) => String(t)).slice(0, 12)
    : [];

  // 3) transcript (real captions first) + top comments. InnerTube caption
  // fetches are anti-abuse-token gated now (200-with-empty-body), so the
  // universal browser caption engine (lib/web-search/media-captions.ts —
  // the watch URL is assembled HERE, in the YouTube vertical, not in the
  // universal engine) is the fallback tier. Gate mirrors the Rust side:
  // transcript is only attempted when info exists.
  const transcriptInnerTube = info ? await transcriptFromInfo(info) : "";
  const transcript =
    transcriptInnerTube || (info ? await getBrowserTranscript(`https://www.youtube.com/watch?v=${videoId}`) : "");
  const comments = info ? await topComments(info) : [];

  const chapters = chaptersFromDescription(description);

  /* ── assemble the evidence markdown ── */
  const parts: string[] = [];
  parts.push(`## YouTube video: "${title}"`);
  const facts: string[] = [];
  if (channel) facts.push(`Channel: ${channel}`);
  if (lengthSeconds > 0) facts.push(`Duration: ${fmtClock(lengthSeconds)}`);
  if (viewCount > 0) facts.push(`Views: ${viewCount.toLocaleString("en-US")}`);
  if (publishDate) facts.push(`Published: ${publishDate}`);
  facts.push(`Video ID: ${videoId}`);
  facts.push(`Watch URL: ${canonicalUrl}`);
  if (url !== canonicalUrl) facts.push(`Original link: ${url}`);
  parts.push(facts.join(" | "));
  if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);

  if (description) {
    parts.push("### Video description");
    parts.push(description.slice(0, 1500));
  }
  if (chapters.length > 0) {
    parts.push("### Chapters / timestamps");
    parts.push(chapters.join("\n"));
  }
  if (transcript) {
    parts.push("### Video transcript (captions, timestamped)");
    parts.push(transcript);
  } else if (comments.length > 0) {
    parts.push(
      "### Transcript",
      "(No caption track available — metadata, description and top community comments below are the full retrievable content for this video.)",
    );
  } else {
    parts.push(
      "### Transcript",
      "(No caption track and no comments available for this video — the description + metadata above are the full retrievable content.)",
    );
  }
  if (comments.length > 0) {
    parts.push("### Top comments");
    parts.push(comments.map((c) => `- ${c}`).join("\n"));
  }

  const markdown = parts.filter(Boolean).join("\n\n").slice(0, 18_000);
  if (markdown.length < 60) return null;

  return {
    videoId,
    canonicalUrl,
    title,
    channel,
    description,
    lengthSeconds,
    viewCount,
    publishDate,
    chapters,
    transcript,
    markdown,
  };
}

/**
 * Companion metasearch query for a video: "<Title>" "<Channel>" — surfaces
 * articles/reactions/summaries ABOUT the video that the transcript alone
 * cannot cover. This is also the mandated fallback for videos WITHOUT
 * captions: the pipeline searches title + channel so the topic (e.g. the
 * game played in a playthrough) is identified from the open web.
 */
export function youTubeCompanionQuery(ev: YouTubeEvidence): string | null {
  const t = ev.title.trim();
  if (!t) return null;
  const c = ev.channel.trim();
  const q = c ? `"${t}" "${c}"` : `"${t}" youtube`;
  return q.slice(0, 200);
}
