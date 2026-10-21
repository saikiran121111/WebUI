/**
 * Post-stream claim audit — REMOVED with the web-verify ledger (2026-10-22).
 *
 * The old version called POST /api/verify-claims after every researched
 * answer, re-adjudicated what the model actually asserted, and downgraded
 * the [S#] pills of anything it overreached on. The user's decision: no
 * per-claim adjudication, no verdict badges — the answer carries [S#]
 * citations and the model's own honest wording ("I could not confirm X"
 * when a source doesn't state it), and that is the whole verification
 * story. This route is a no-op kept so any stale client call (from a
 * cached browser session) still lands on a defined 410 instead of a 404.
 */
import { NextResponse } from "next/server";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "The claim audit was removed on 2026-10-22 — [S#] citations are the verification story now." },
    { status: 410 },
  );
}
