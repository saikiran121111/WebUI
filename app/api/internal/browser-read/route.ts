/**
 * POST /api/internal/browser-read — the Tier-3b RPC seam (Part 8,
 * MIGRATION-MAP §7).
 *
 * The Rust backend keeps Playwright a Node concern: when its
 * web-research pipeline needs a browser-rendered page read, the
 * `HttpBrowserBridge` (ruke-websearch/src/browser_bridge.rs) POSTs
 * `{ url, timeoutMs? }` here with the `x-ruke-internal-secret`
 * header, and we answer with the LIVE `extractPageInOnePass`
 * `OnePassExtraction` JSON (camelCase — the Rust side deserializes the
 * same wire the TS extractor already consumed).
 *
 * Security (mirrors the §7 design):
 * - Loopback-only in practice: Next dev binds loopback and ruke-server
 *   targets 127.0.0.1.
 * - Process-local secret generated per run by `dev-supervisor.mjs` and
 *   handed to BOTH children via env. `RUKE_BROWSER_BRIDGE_SECRET`
 *   unset ⇒ the bridge could not exist anyway ⇒ this endpoint is 401
 *   for every caller.
 * - Header compared with `timingSafeEqual` (length mismatch is not
 *   secret material, so a length gate before the compare is fine).
 * - SSRF: the URL re-runs the live guard chain —
 *   `extractPageInOnePass` → `extractUrlBrowser` performs the same
 *   internal-pool-disabled → `isSafeUrl` ordering a native TS read
 *   would, so the proxied hop cannot reach anything the TS path
 *   couldn't. (The Rust client pre-validates too; defense in depth.)
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { extractPageInOnePass } from "@/lib/web-search/agentBrowser";

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
  const timeoutMsRaw = (body as { timeoutMs?: unknown } | null)?.timeoutMs;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? timeoutMsRaw
      : undefined;

  // extractPageInOnePass is infallible by design (pool-disabled and
  // unsafe-url paths return a zeroed extraction with `ok:false`), so no
  // try/catch is needed — the error travels in the payload, same as the
  // direct TS extractor call site.
  const extraction = await extractPageInOnePass(url, timeoutMs ? { timeoutMs } : {});
  return NextResponse.json(extraction);
}
