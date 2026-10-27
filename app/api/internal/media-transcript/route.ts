/**
 * POST /api/internal/media-transcript — universal media transcript RPC.
 *
 * `{ url }` → `{ ok, url, transcript }` for ANY page hosting a video
 * player (the engine in lib/web-search/media-captions.ts is provider-
 * neutral: HTML5 text tracks, accessible-name caption controls, and the
 * player's own caption-track responses — never domain or URL-shape
 * matching). This is the seam for backends (e.g. the Rust pipeline) to
 * reach caption text their own HTTP stack cannot: modern players gate
 * caption endpoints on request-scoped anti-abuse tokens, and only the
 * player's own requests carry them (see captionFormats.ts header).
 *
 * Same Tier-3b trust model as /api/internal/browser-read:
 * - loopback-only in practice (Next dev binds loopback, ruke-server
 *   targets 127.0.0.1);
 * - process-local secret via RUKE_BROWSER_BRIDGE_SECRET, handed to both
 *   children by dev-supervisor.mjs; unset ⇒ 401 for every caller;
 * - `timingSafeEqual` header compare (length gate first — length is not
 *   secret material);
 * - SSRF: the URL re-runs the live guard chain —
 *   getCaptionSegmentsViaBrowser performs the same pool-disabled →
 *   `isSafeUrl` ordering a native TS read would, so the proxied hop
 *   cannot reach anything the TS path couldn't.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getBrowserTranscript } from "@/lib/web-search/media-captions";

const SECRET_HEADER = "x-ruke-internal-secret";

function authorized(req: NextRequest): boolean {
  const expected = process.env.RUKE_BROWSER_BRIDGE_SECRET;
  if (!expected) return false;
  const got = req.headers.get(SECRET_HEADER);
  if (!got) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
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
  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const transcript = await getBrowserTranscript(url);
  return NextResponse.json({ ok: transcript.length > 0, url, transcript });
}
