import { NextRequest, NextResponse } from "next/server";
import { requestTitleGeneration, type TitleJobResult } from "../../../../../lib/server/titles/queue";

/**
 * Trigger (or force, for the backfill script) an auto-title refresh for a
 * conversation. Generation runs server-side through the queue: serialised so
 * it never competes with active user inference, guarded so an older job can
 * never overwrite a newer title, and manual titles are never touched.
 *
 * The job is intentionally NOT bound to req.signal — it is background work
 * that must survive the client navigating away.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  let model: string | undefined;
  try {
    const body = await req.json().catch(() => null);
    if (typeof body?.model === "string" && body.model) model = body.model;
  } catch {
    /* body optional */
  }

  const r = requestTitleGeneration(params.id, { model, force });
  if (r.status === "skipped") return NextResponse.json({ queued: false, reason: r.reason });
  if (r.status === "coalesced") return NextResponse.json({ queued: true, coalesced: true });

  const done = await (r.done ?? Promise.resolve<TitleJobResult>({ ok: false, reason: "no-job" }));
  return NextResponse.json({ queued: true, ...done });
}
