/**
 * /api/search-more — the "one more round" follow-up tool.
 *
 * The main model (after synthesizing from the initial evidence) may call
 * this at most ONCE per conversation turn if a specific fact is missing.
 * It re-runs the pipeline against the original query set plus any new
 * targeted queries the model supplies, and returns a fresh evidence block
 * in the same [S#]-labelled shape.
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
  evidenceBlock,
} from "../../../lib/web-search/pipeline";
import { childLogger } from "@/lib/server/logger";
import { rustEnabled, rustProxy } from "@/lib/server/rustProxy";

const log = childLogger("api/search-more");

export async function POST(req: NextRequest) {
  if (rustEnabled()) return rustProxy(req, "/api/ruke/search-more");
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

  const t0 = performance.now();
  // The pipeline's gate decides (main model, rules fallback) whether these
  // follow-up queries still warrant a search.
  const bundle = await runWebResearch(
    { userPrompt: queries.join(" ") },
    undefined,
    req.signal, // abort if the user cancels the request
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
