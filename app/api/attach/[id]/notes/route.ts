import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "../../../../../lib/server/logger";
import { generateNotes } from "../../../../../lib/server/attachindex/notes";
import { hasIndex, readIndex, readNotes } from "../../../../../lib/server/attachindex/store";

/**
 * Lazy course notes for an indexed attachment (whole-content summaries).
 * Generation is deliberately NOT automatic — it costs shared-model time, so
 * it runs only when whole_video questions ask for it (lib/server/attachindex/
 * turn.ts) or when this route is called directly. Results cache to
 * notes.json next to the index.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("api/attach/notes");

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const notes = readNotes(params.id);
  if (!notes) return NextResponse.json({ error: "No cached notes for this attachment" }, { status: 404 });
  return NextResponse.json({ notes });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const attId = params.id;
  if (!hasIndex(attId)) return NextResponse.json({ error: "No knowledge index for this attachment" }, { status: 404 });

  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force) {
    const cached = readNotes(attId);
    if (cached) return NextResponse.json({ notes: cached, cached: true });
  }

  const index = readIndex(attId);
  if (!index) return NextResponse.json({ error: "Index unreadable" }, { status: 500 });

  try {
    const notes = await generateNotes(attId, index, req.signal);
    if (!notes) return NextResponse.json({ error: "Nothing to summarize" }, { status: 422 });
    return NextResponse.json({ notes, cached: false });
  } catch (err: unknown) {
    if ((err as Error)?.name === "AbortError") {
      log.warn({ attId }, "notes generation aborted by client");
      return NextResponse.json({ error: "Cancelled" }, { status: 499 });
    }
    log.error({ attId, err: (err as Error).message }, "notes generation failed");
    return NextResponse.json({ error: "Notes generation failed" }, { status: 502 });
  }
}
