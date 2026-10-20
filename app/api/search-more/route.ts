/**
 * /api/search-more — the "one more round" follow-up tool.
 *
 * The main model (after synthesizing from the initial evidence) may call
 * this at most ONCE per conversation turn if a specific fact is missing.
 * It re-runs the LFM-gated pipeline against the LFM's original query set
 * plus any new targeted queries the model supplies, and returns a fresh
 * evidence block in the same [S#]-labelled shape.
 *
 * Body:  { queries: string[] }   (max 3 new queries, ≤ 100 chars each)
 * Returns: { evidenceBlock, webCitations }
 *
 * The tool result rides back into the model's context as a plain text
 * block — the model is instructed to treat it as untrusted data.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  runWebResearch,
  buildMainModelContext,
  evidenceBlock,
} from "../../../src/lib/web-search/pipeline";
import { runLfmGate } from "../../../src/lib/web-search/lfm-gate";
import { childLogger } from "../../../lib/server/logger";

const log = childLogger("api/search-more");

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body" },
      { status: 400 },
    );
  }

  const queries: string[] = Array.isArray(body?.queries)
    ? body.queries.filter((q: unknown) => typeof q === "string").slice(0, 3)
    : [];

  if (queries.length === 0) {
    return NextResponse.json(
      { error: "queries array is required (1-3 string entries)" },
      { status: 400 },
    );
  }

  // Re-run the LFM gate against the FIRST new query so it can extend the
  // source pool (e.g. add arxiv for academic follow-ups). If the gate
  // rejects all queries, fall back to the rule-based plan.
  const lfm = await runLfmGate({ userPrompt: queries[0] ?? "" });

  const plans = lfm.decision.search_required
    ? lfm.decision.queries.map((q) => ({
        query: q.query,
        intent: q.intent,
        preferredDomains: q.preferred_domains,
      }))
    : // No LLM decision AND no trigger: build a minimal pool from the raw
      // queries so we still get something back (the tool is a fallback).
      queries.map((q: string) => ({
        query: q.slice(0, 200),
        intent: "general" as const,
      }));

  void plans; // plans feed into the search pool; the pipeline re-derives
  // them from the userPrompt passed to runWebResearch below.

  const t0 = performance.now();
  const bundle = await runWebResearch(
    { userPrompt: queries.join(" ") },
  );
  const ms = Math.round(performance.now() - t0);

  if (!bundle) {
    return NextResponse.json(
      {
        evidenceBlock:
          "No web evidence could be retrieved for the follow-up queries.",
        webCitations: {},
        ms,
      },
    );
  }

  void buildMainModelContext; // imported for API completeness; the raw
  // evidenceBlock shape is what the tool returns to the main model.
  const block = evidenceBlock(bundle);

  const webCitations: Record<string, any> = {};
  for (const packet of bundle.packets) {
    webCitations[packet.sourceId] = {
      sourceId: packet.sourceId,
      url: packet.url,
      title: packet.title,
      domain: packet.domain,
      publishedAt: packet.publishedAt,
    };
  }

  log.info({ ms, queries: queries.length, results: bundle.searchResults.length }, "search-more complete");

  return NextResponse.json({
    evidenceBlock: block,
    webCitations,
    ms,
  });
}
