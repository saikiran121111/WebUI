/**
 * /api/search?q=<query>
 *
 * Unified search entry point: routes through the full web-research
 * pipeline (search-by-default gate → multi-engine metasearch →
 * tiered extraction → BM25 rerank) so the caller gets structured
 * evidence rather than raw engine hits. For a plain "just get me
 * search results" use case the `?raw=1` param returns the raw
 * multi-engine result list (no gate, no extraction).
 *
 * The pipeline allows up to 300 seconds (5 minutes) for deep
 * multi-hop research on a local workstation.
 */
import { NextRequest, NextResponse } from "next/server";
import { runWebResearch, evidenceBlock } from "../../../lib/web-search/pipeline";
import { runGeneralWebSearch } from "../../../lib/web-search/engines";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q");
  if (!query) return NextResponse.json({ results: [] });

  const raw = req.nextUrl.searchParams.get("raw") === "1";

  if (raw) {
    // Legacy path: raw multi-engine SERPs (no gate, no extraction) —
    // the general-web engine pool runs directly through net.ts.
    try {
      const results = await runGeneralWebSearch(query);
      return NextResponse.json({ query, results });
    } catch {
      return NextResponse.json({ error: "Search unavailable", results: [] }, { status: 502 });
    }
  }

  // Unified pipeline: LLM gate → metasearch → extraction → rerank
  try {
    const bundle = await runWebResearch({ userPrompt: query });
    if (!bundle) {
      return NextResponse.json({
        evidenceBlock: "No web evidence could be retrieved.",
        webCitations: {},
      });
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
    return NextResponse.json({
      evidenceBlock: block,
      webCitations,
      searchGate: {
        source: bundle.searchGate.source,
        depth: bundle.searchGate.decision.depth,
        freshness: bundle.searchGate.decision.freshness,
        queries: bundle.searchGate.decision.queries.map((q) => q.query),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Search pipeline failed: " + msg }, { status: 502 });
  }
}
