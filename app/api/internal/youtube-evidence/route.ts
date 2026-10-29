/**
 * POST /api/internal/youtube-evidence — the Rust YOUTUBE VERTICAL's
 * evidence RPC (its InnerTube transport seam, ruke-websearch/src/
 * youtube_bridge.rs → set_default_inner_tube).
 *
 * `{ videoId }` → `{ videoId, info, transcript, comments, captionSource }`
 * mirroring the three youtubei.js round-trips the TS vertical makes:
 * - `info`: getInfo result, PICKED down to the exact fields the Rust
 *   `collect_youtube_evidence` reads (title/channel/channel_name/author/
 *   short_description/description/duration/view_count/upload_date/tags)
 *   plus a `video_id` stamp — never the whole object (circular refs +
 *   size; and the Rust side re-reads the parity fields off `info` or
 *   `info.basic_info`).
 * - `transcript`: InnerTube `getTranscript()` when it answers (it is
 *   Proof-of-Origin gated now — the normal answer is a throw), else the
 *   UNIVERSAL browser caption engine (lib/web-search/media-captions.ts)
 *   normalized to `{segments:[{text,start_ms}]}`, which the Rust
 *   `transcript_lines` parser consumes verbatim. `captionSource` records
 *   which tier answered: "innertube" | "browser-cc" | null.
 * - `comments`: `getComments({comment_sort:"TOP"})` array as-is.
 *
 * This endpoint belongs to the YouTube vertical (video ids are that
 * vertical's contract); the CAPABILITY underneath it is universal and
 * domain-free. Same Tier-3b trust model as /api/internal/browser-read:
 * loopback-only, process-local RUKE_BROWSER_BRIDGE_SECRET (unset ⇒ 401
 * for everyone), `timingSafeEqual` with a length gate first.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getInfo } from "@/lib/web-search/youtube";
import { getCaptionSegmentsViaBrowser } from "@/lib/web-search/media-captions";

const SECRET_HEADER = "x-ruke-internal-secret";

/** Fields the Rust collect_youtube_evidence reads off the info payload. */
const INFO_FIELDS = [
  "title",
  "channel",
  "channel_name",
  "author",
  "short_description",
  "description",
  "duration",
  "view_count",
  "upload_date",
  "tags",
] as const;

function authorized(req: NextRequest): boolean {
  const expected = process.env.RUKE_BROWSER_BRIDGE_SECRET;
  if (!expected) return false;
  const got = req.headers.get(SECRET_HEADER);
  if (!got) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** JSON round-trip: strip class instances/circular refs to plain wire data. */
function jsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const videoId = (body as { videoId?: unknown } | null)?.videoId;
  if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "videoId required (11-char id)" }, { status: 400 });
  }

  const info = await getInfo(videoId);
  if (!info) {
    // Mirrors the TS vertical: no InnerTube info ⇒ Rust degrades to oEmbed
    // only (get_info None ⇒ transcript/comments never consulted).
    return NextResponse.json({
      videoId,
      info: null,
      transcript: null,
      comments: null,
      captionSource: null,
    });
  }

  const infoOut: Record<string, unknown> = { video_id: videoId };
  for (const f of INFO_FIELDS) {
    const v = info?.basic_info?.[f] ?? info?.[f];
    if (v !== undefined && v !== null) infoOut[f] = jsonSafe(v);
  }

  let transcript: unknown = null;
  let captionSource: string | null = null;
  try {
    const raw = jsonSafe(await (info as any).getTranscript?.());
    const segCount =
      (Array.isArray((raw as any)?.segments) ? (raw as any).segments.length : 0) ||
      (Array.isArray((raw as any)?.transcript?.body?.initial_segments)
        ? (raw as any).transcript.body.initial_segments.length
        : 0);
    if (raw && segCount > 0) {
      transcript = raw;
      captionSource = "innertube";
    }
  } catch {
    /* POt-gated get_transcript (400) — the normal state of affairs */
  }
  if (!transcript) {
    const segs = await getCaptionSegmentsViaBrowser(
      `https://www.youtube.com/watch?v=${videoId}`,
    );
    if (segs && segs.length > 0) {
      // Shape the Rust transcript_lines parser already accepts (snake_case).
      transcript = { segments: segs.map((s) => ({ text: s.text, start_ms: s.startMs })) };
      captionSource = "browser-cc";
    }
  }

  let comments: unknown = null;
  try {
    const res = await (info as any).getComments?.({ comment_sort: "TOP" });
    const safe = jsonSafe(Array.isArray(res) ? res : (res?.comments ?? null));
    if (Array.isArray(safe) && safe.length > 0) comments = safe;
  } catch {
    /* comments gated — degrade exactly like the TS catch arm */
  }

  return NextResponse.json({ videoId, info: infoOut, transcript, comments, captionSource });
}
