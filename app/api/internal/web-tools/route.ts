/**
 * POST /api/internal/web-tools — the Rust chat/browser loops' web-tool RPC.
 *
 * Web-search ownership is TypeScript (rollback 2026-11-03): when Rust runs a
 * chat turn or the browser destination-discovery step, the tool SESSION
 * (budgets, scope admission), tool definitions, guidance text and execution
 * live here (lib/server/web-tools-rpc.ts over the tested
 * lib/web-search/tools.ts primitives). Rust keeps the generic model-round +
 * SSE transport and relays the envelopes to the model verbatim.
 *
 * Auth: same loopback internal-bridge contract as /api/internal/embed
 * (RUKE_BROWSER_BRIDGE_SECRET + x-ruke-internal-secret). Not reachable
 * without the per-run secret; loopback-only by deployment.
 *
 * Body: { action: "create" | "exec" | "discover" | "close", ... } — see
 * lib/server/web-tools-rpc.ts for per-action shapes.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { handleWebToolsRpc } from "@/lib/server/web-tools-rpc";

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const result = await handleWebToolsRpc(body, req.signal);
  return NextResponse.json(result.json, { status: result.status });
}
