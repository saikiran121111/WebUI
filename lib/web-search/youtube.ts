/**
 * YouTube deep evidence (Fix 1).
 *
 * The model must be able to "watch" ANY YouTube URL format:
 *   youtu.be/<id> · youtube.com/watch?v=<id> · /shorts/<id> · /embed/<id>
 *   /v/<id> · /live/<id> · m.youtube.com/* · music.youtube.com/*
 *
 * Evidence stack, in order of reliability:
 *   1. Keyless oEmbed  → real title + channel name (works without consent).
 *   2. InnerTube player API (youtubei/v1/player, ANDROID embedded client
 *      context + CONSENT=YES cookie) → videoDetails (title / author /
 *      shortDescription / lengthSeconds / viewCount) + captionTracks.
 *   3. Watch-page scrape → brace-unpack `ytInitialPlayerResponse` when the
 *      API path fails.
 *   4. Download + parse the `timedtext` caption track (fmt=json3) into a
 *      timestamped transcript — the actual "video content".
 */
import { fetchPage, fetchUrl, apiHeaders } from "./tls-client";

const CONSENT_COOKIE = "CONSENT=YES+cb.20210328-17-p0.en+FX+700";
const INNER_TUBE_PLAYER = "https://www.youtube.com/youtubei/v1/player";

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

/* ── JSON brace-unpack for watch-page state vars ──────────────────────── */

function braceMatchJson(html: string, marker: string): any | null {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  const scanEnd = Math.min(html.length, start + 2_000_000);
  for (let i = start; i < scanEnd; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ── evidence sources ─────────────────────────────────────────────────── */

async function innerTubePlayer(videoId: string): Promise<any | null> {
  const res = await fetchUrl(INNER_TUBE_PLAYER, {
    method: "POST",
    timeoutMs: 20_000,
    headers: {
      ...apiHeaders(),
      "content-type": "application/json",
      cookie: CONSENT_COOKIE,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.09.37",
          androidSdkVersion: 30,
          hl: "en",
        },
      },
      videoId,
    }),
  });
  if (!res || !res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
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

async function watchPagePlayerResponse(canonicalUrl: string): Promise<any | null> {
  const page = await fetchPage(canonicalUrl, {
    timeoutMs: 25_000,
    headers: { cookie: CONSENT_COOKIE },
  });
  if (!page || !page.ok || !page.body) return null;
  return braceMatchJson(page.body, "ytInitialPlayerResponse");
}

/** timedtext track → "[mm:ss] line" transcript. */
async function fetchTranscript(baseUrl: string): Promise<string> {
  let url = baseUrl.replace(/&fmt=json3$/, "");
  url += (url.includes("?") ? "&" : "?") + "fmt=json3";
  const res = await fetchUrl(url, { timeoutMs: 25_000 });
  if (!res || !res.ok || !res.text) return "";
  try {
    // Guard the XSSI prefix some timedtext variants emit.
    const data = JSON.parse(res.text.replace(/^\)\]\}'/, ""));
    const events: any[] = Array.isArray(data?.events) ? data.events : [];
    const lines: string[] = [];
    for (const ev of events) {
      const segs: any[] = Array.isArray(ev?.segs) ? ev.segs : [];
      const text = segs
        .map((s) => String(s?.utf8 ?? ""))
        .join("")
        // form-feed (\f) is a word-wrap marker in json3
        .replace(/[\r\n\f ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const sec = Math.round((Number(ev?.tStartMs) || 0) / 1000);
      lines.push(`[${fmtClock(sec)}] ${text}`);
    }
    return lines.join("\n").slice(0, 12_000);
  } catch {
    return "";
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
 */
export async function getYouTubeEvidence(url: string): Promise<YouTubeEvidence | null> {
  const info = parseYouTubeVideoId(url);
  if (!info) return null;
  const { videoId, canonicalUrl } = info;

  // 1) InnerTube player (ANDROID client) — richest single source.
  let player = await innerTubePlayer(videoId);
  // 2) watch-page fallback.
  if (!player?.videoDetails?.title) {
    const wp = await watchPagePlayerResponse(canonicalUrl);
    if (wp?.videoDetails) player = wp;
  }
  const details: any = player?.videoDetails ?? null;
  const micro: any = player?.microformat?.playerMicroformatRenderer ?? null;

  let title = String(details?.title ?? "");
  let channel = String(details?.author ?? "");
  if (!title || !channel) {
    const oe = await oEmbed(videoId);
    if (oe) {
      if (!title) title = oe.title;
      if (!channel) channel = oe.channel;
    }
  }
  if (!title) return null; // nothing real to report

  const description = String(details?.shortDescription ?? micro?.description?.simpleText ?? "");
  const lengthSeconds = Number(details?.lengthSeconds) || (player && Number(player?.playabilityStatus) ? 0 : 0) || 0;
  const viewCount = Number(details?.viewCount) || 0;
  const publishDate = String(micro?.publishDate ?? "").slice(0, 10);

  // 3) transcript from the caption tracks (prefer English, any track beats none).
  let transcript = "";
  const tracks: any[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length > 0) {
    const track =
      tracks.find((t) => String(t?.languageCode ?? "").toLowerCase().startsWith("en")) ??
      tracks[0];
    if (track?.baseUrl) transcript = await fetchTranscript(String(track.baseUrl));
  }

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
  } else {
    parts.push(
      "### Transcript",
      "(No caption track available for this video — the description + metadata above are the full retrievable content.)",
    );
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
 * cannot cover.
 */
export function youTubeCompanionQuery(ev: YouTubeEvidence): string | null {
  const t = ev.title.trim();
  if (!t) return null;
  const c = ev.channel.trim();
  const q = c ? `"${t}" "${c}"` : `"${t}" youtube`;
  return q.slice(0, 200);
}
