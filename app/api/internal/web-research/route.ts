/**
 * POST /api/internal/web-research — the Rust chat pipeline's research RPC.
 *
 * Web-search ownership is TypeScript (rollback 2026-11-03): when the Rust
 * backend orchestrates a chat turn, its internal web research runs HERE, in
 * the Node process, through the same runWebResearch() the public /api/search
 * route uses. Rust keeps only the generic model/SSE transport; this endpoint
 * owns the gate, planning, retrieval, extraction, rerank and citations.
 *
 * Auth: same loopback internal-bridge contract as /api/internal/embed
 * (RUKE_BROWSER_BRIDGE_SECRET + x-ruke-internal-secret). Loopback-only +
 * SSRF defense-in-depth (this route performs outbound fetches on request).
 *
 * Body:  { prompt, history?, hasImageAttachment?, hasAttachmentEvidence?,
 *          imageDataUrls?, scope? }   (scope = Rust-folded TaskScope JSON)
 * Reply: NDJSON stream — zero or more
 *          {"type":"progress","stage","detail?",...}   (PipelineProgress)
 * then exactly one terminal frame:
 *          {"type":"result","status":"bundle","systemBlock",citations,
 *           searchGate,"depth",presentation,richResults,stats}
 *          {"type":"result","status":"no_bundle"}
 *          {"type":"result","status":"error","message"}
 * The research call honors the request's abort signal, so a Rust-side
 * cancellation (socket close) stops retrieval work immediately.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
  runWebResearch,
  buildMainModelContext,
  type PipelineProgress,
} from "@/lib/web-search/pipeline";
import { childLogger } from "@/lib/server/logger";

const log = childLogger("internal/web-research");

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

  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const ctx = {
    userPrompt: prompt,
    history: Array.isArray(body.history)
      ? body.history
          .filter(
            (t: any) =>
              t && typeof t.role === "string" && typeof t.content === "string",
          )
          .map((t: any) => ({ role: t.role, content: t.content }))
      : undefined,
    hasImageAttachment: body.hasImageAttachment === true,
    hasAttachmentEvidence: body.hasAttachmentEvidence === true,
    imageDataUrls: Array.isArray(body.imageDataUrls)
      ? body.imageDataUrls.filter((u: unknown) => typeof u === "string")
      : undefined,
    // Rust-folded TaskScope (shared task-scope fixture matrix pins the
    // shape; the gate/planner tolerate missing fields leniently).
    scope: body.scope && typeof body.scope === "object" ? body.scope : undefined,
  };

  const t0 = performance.now();
  const encoder = new TextEncoder();
  const ctrl = new AbortController();
  req.signal.addEventListener("abort", () => ctrl.abort());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // (audit item 11, 2026-11-04) Already-aborted guard: if Rust hung
      // up before the stream even started, do not spin up a full research
      // run whose output nobody will read.
      if (ctrl.signal.aborted) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      const write = (frame: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        } catch {
          // Client vanished mid-stream (Rust cancelled): stop retrieval.
          ctrl.abort();
        }
      };
      const onProgress = (p: PipelineProgress) => write({ type: "progress", ...p });

      runWebResearch(ctx, onProgress, ctrl.signal)
        .then((bundle) => {
          if (!bundle) {
            write({ type: "result", status: "no_bundle" });
            return;
          }
          const citations: Record<string, unknown> = {};
          for (const packet of bundle.packets) {
            citations[packet.sourceId] = {
              sourceId: packet.sourceId,
              url: packet.url,
              title: packet.title,
              domain: packet.domain,
              publishedAt: packet.publishedAt,
            };
          }
          write({
            type: "result",
            status: "bundle",
            systemBlock: buildMainModelContext(bundle).systemBlock,
            citations,
            // ⇔ ruke-contracts::stages::ResearchMeta (camelCase serde).
            searchGate: {
              depth: bundle.searchGate.decision.depth,
              freshness: bundle.searchGate.decision.freshness,
              decidedBy: bundle.searchGate.source,
              queries: bundle.searchGate.decision.queries.map((q) => ({
                query: q.query,
                intent: q.intent,
              })),
            },
            depth: bundle.searchGate.decision.depth,
            presentation: bundle.presentation ?? null,
            // TS OVERWRITE law: only non-empty surfaces cross the wire.
            richResults:
              bundle.richResults && bundle.richResults.length > 0
                ? bundle.richResults
                : [],
            stats: {
              passages: bundle.topPassages.length,
              results: bundle.searchResults.length,
              gateSource: bundle.searchGate.source,
              fromCache: bundle.fromCache,
            },
          });
        })
        .catch((err: unknown) => {
          write({
            type: "result",
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          log.info(
            {
              ms: Math.round(performance.now() - t0),
              aborted: ctrl.signal.aborted,
            },
            "internal research finished",
          );
          try {
            controller.close();
          } catch {
            /* already closed/cancelled */
          }
        });
    },
    // (audit item 11, 2026-11-04) The consumer (Rust transport) CANCELLING
    // the response body must cancel the source too: without this hook a
    // client that vanished between progress frames left runWebResearch
    // burning engines/browser slots for nobody. enqueue failures already
    // abort; stream cancellation now does too.
    cancel() {
      ctrl.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}
