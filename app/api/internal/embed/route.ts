/**
 * POST /api/internal/embed — attachment-index QUERY-EMBEDDING RPC.
 *
 * The Rust retrieval path (ruke-attach) obtains its query vector from the
 * Node ONNX embedder (lib/server/attachindex/embed.ts): the model stays
 * Node-owned — extraction and index BUILD already run it in-process, and the
 * brief keeps ONNX embedding on the Node side. Part 5's production seam ran
 * `UnavailableEmbedder` instead, which pinned chat-time retrieval to
 * BM25-alone; the long-document E2E proved that degrades on deep, rare-word
 * markers (filler chunks tie on function-word overlap and outrank the
 * marker chunk through RRF without any cosine signal), so the seam had to
 * close the way Tier-3b closed the browser-pool gap: a loopback RPC.
 *
 * Same Tier-3b trust model as /api/internal/browser-read:
 * - loopback-only in practice (Next dev binds loopback, ruke-server
 *   targets 127.0.0.1);
 * - per-run process-local secret via RUKE_BROWSER_BRIDGE_SECRET, handed to
 *   both children by dev-supervisor.mjs; unset ⇒ 401 for every caller;
 * - `timingSafeEqual` header compare (length gate first — length is not
 *   secret material). Rule 17: the secret is never logged here.
 *
 * `{ text }` → `{ ok: true, vector }` — one L2-normalized row, exactly the
 * `embedTexts([text])[0]` a TS chat turn computed in-process. If the model
 * cannot load or run, embedOne throws, Next answers 500, and the Rust
 * client maps any non-success/malformed response to `EmbedUnavailable`:
 * retrieval then degrades exactly like the TS
 * `try { queryVec = await embedOne(rq) } catch {}` path (empty vector,
 * BM25-alone ranking).
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { embedOne } from "@/lib/server/attachindex/embed";

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
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const vector = await embedOne(text);
  return NextResponse.json({ ok: true, vector });
}
