/**
 * One-shot read of a URL through the user's interactive browser profile
 * — the pipeline's fallback surface exposed for tests and one-shot
 * tooling. Launches a headful persistent context on the URL's own
 * profile (`.data/browser-profiles/<site>/` when it exists, `default/`
 * otherwise), navigates, settles, and runs the same one-pass
 * extraction (DOM + meta + JSON-LD + window state + ARIA) the stealth
 * pool uses. The context closes immediately; per-site auth state is
 * untouched.
 *
 * Normal search keeps working exactly as before — this endpoint is the
 * documented "normal search couldn't fetch it" escalation: login walls,
 * private feeds, auth-gated docs. Callers must surface an `ok: false`
 * response verbatim (no fabricated details).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readWithInteractiveProfile } from "@/lib/browser/interactiveBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReadSchema = z.object({
  url: z.string().trim().max(2048),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("url") ?? "";
  if (!raw) {
    return NextResponse.json({ ok: false, error: "missing ?url=" }, { status: 400 });
  }
  const r = await readWithInteractiveProfile(raw, {});
  return NextResponse.json(
    {
      ok: r.ok,
      url: r.url,
      finalUrl: r.finalUrl,
      title: r.title,
      authenticated: r.authenticated,
      ...(r.site ? { site: r.site } : {}),
      bodyText: r.bodyText,
      ariaSnapshot: r.ariaSnapshot,
      meta: r.meta,
      jsonLd: r.jsonLd,
      windowState: r.windowState,
      ...(r.error ? { error: r.error } : {}),
    },
    { status: r.ok ? 200 : 422 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let url = "";
  let timeoutMs: number | undefined;
  try {
    const j = ReadSchema.parse(await req.json());
    url = j.url;
    timeoutMs = j.timeoutMs;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid read payload" }, { status: 400 });
  }
  const r = await readWithInteractiveProfile(url, { timeoutMs });
  return NextResponse.json(
    {
      ok: r.ok,
      url: r.url,
      finalUrl: r.finalUrl,
      title: r.title,
      authenticated: r.authenticated,
      ...(r.site ? { site: r.site } : {}),
      bodyText: r.bodyText,
      ariaSnapshot: r.ariaSnapshot,
      meta: r.meta,
      jsonLd: r.jsonLd,
      windowState: r.windowState,
      ...(r.error ? { error: r.error } : {}),
    },
    { status: r.ok ? 200 : 422 },
  );
}
