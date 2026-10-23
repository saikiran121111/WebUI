/**
 * /api/search?q=<query>
 *
 * Unified search entry point: routes through the full web-research
 * pipeline (LFM gate → multi-engine metasearch → 5-tier extraction →
 * BM25 rerank) so the caller gets structured evidence rather than raw
 * engine hits. For a plain "just get me search results" use case the
 * `?raw=1` param returns the legacy SearXNG-format result list.
 *
 * The pipeline allows up to 300 seconds (5 minutes) for deep
 * multi-hop research on a local workstation.
 */
import { NextRequest, NextResponse } from "next/server";
import { runWebResearch, evidenceBlock } from "../../../lib/web-search/pipeline";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q");
  if (!query) return NextResponse.json({ results: [] });

  const raw = req.nextUrl.searchParams.get("raw") === "1";

  if (raw) {
    // Legacy path: direct SearXNG proxy (no LLM gate, no extraction)
    try {
      const url = new URL("http://127.0.0.1:8888/search");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("engines", "google,duckduckgo,brave,wikipedia");
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error("SearXNG returned " + res.status);
      const data = await res.json();
      return NextResponse.json(data);
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
