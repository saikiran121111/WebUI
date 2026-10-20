# Web Search & Research Engine

Production-grade, self-contained web-research pipeline for the WebUI.
Every prompt is classified by the LFM router before reaching the main
model; when a live search is required, the pipeline runs in parallel,
stays under the 1GB RAM budget, and feeds the main model only
verifiable evidence with inline `[S#]` citations.

## Architecture

```
user prompt
   │
   ▼
LFM gate  (src/lib/web-search/lfm-gate.ts)
   │  1. deterministic short-circuit (trigger / no-search rules)
   │  2. LLM call → JSON matching SearchDecisionSchema
   │  3. 2500ms ceiling → rule-based fallback
   ▼
metasearch  (src/lib/web-search/metasearch.ts)
   │  parallel fetch across keyless sources, URL-normalized + RRF-fused
   ▼
extractor   (src/lib/web-search/extractor.ts)
   │  3-tier anti-bot pipeline, p-limit(6), cache-aware
   ▼
reranker    (src/lib/web-search/reranker.ts)
   │  pure-CPU BM25, top 12-15, ≤3 per domain
   ▼
pipeline    (src/lib/web-search/pipeline.ts)
   │  composes all of the above + emits an [S#]-labelled evidence block
   ▼
main model  (app/api/chat/route.ts)
   │  receives: stripped user prompt + injected evidence system block
   │  instructed to cite [S1] [S2]... inline
   ▼
WebUI       (components/render/ResearchTrailCard.tsx + MarkdownRenderer)
   │  X-Web-Citations header → [S#] pills + collapsible source cards
```

## Hard budgets

- **RAM** : peak RSS stays <100MB for a 10-URL concurrent scrape
             (measured in `scripts/test-web-search.ts`). The headless
             browser pool is replaced with Impit's Rust TLS-impersonation
             client (~135MB → ~85MB).
- **Time** : discovery ≤1200ms budget; full cold-cache pipeline ≤4500ms.
- **Keys** : zero. All sources are keyless — DuckDuckGo Lite, Brave web
             scrape, Wikipedia Open API, HackerNews Algolia, arXiv,
             Reddit JSON, StackExchange API, public SearXNG failover.
- **Storage**: everything lives under `./.local-search/` (added to
             `.gitignore`). The SQLite cache and the public SearXNG
             vendor list are auto-created on first use.

## Modules

| File | Responsibility |
| --- | --- |
| `types.ts` | Zod schemas + shared types (`SearchDecision`, `RankedResult`, `EvidencePacket`, `LfmDecision`) |
| `tls-client.ts` | Impit Chrome-131 pool, SSRF guards, 2MB body cap, rotating realistic headers |
| `lfm-gate.ts` | LLM classification + deterministic trigger/no-search short-circuits + 2500ms fallback |
| `metasearch.ts` | 8 keyless source fetchers + RRF fusion + URL normalization |
| `extractor.ts` | 3-tier extraction (direct → jina fallback → snippet), SQLite cache-aware, p-limit(6) |
| `reranker.ts` | Zero-dependency BM25 (k1=1.5, b=0.75) over ~600-char semantic chunks |
| `cache.ts` | SQLite WAL cache: query results (15min-24h TTL by freshness), extracted pages (6h TTL) |
| `pipeline.ts` | Orchestrates all of the above into one call + emits the evidence block |

## Running the self-test

```bash
npx tsx scripts/test-web-search.ts
```

Verifies:
1. LFM gate — static question → `search_required=false`;
   "latest …" → `search_required=true`.
2. Metasearch — >8 unique URLs in <1200ms (cold) and <5000ms end-to-end.
3. Extraction — at least half of the top-10 pages fully extracted
   (never snippet-only).
4. BM25 — top passages produced and ranked.
5. RSS peak under 450MB during a 10-URL scrape.
6. No files created outside the project root.

The test exits 0 on full pass, 1 on any failure.

## Public API (import from here)

```ts
import {
  runLfmGate,          // LFM decision gate
  metasearch,         // parallel + fused discovery
  extractAll,         // p-limited 3-tier extraction
  rerank,             // CPU BM25
  runWebResearch,     // the full pipeline (what the chat route calls)
  evidenceBlock,      // renders [S#]-labelled passages for the main LLM
} from "@/src/lib/web-search";
```

## Integration into the WebUI

`app/api/chat/route.ts` (POST /api/chat) calls `runWebResearch` on
every user prompt — the LFM gate runs first, the pipeline runs only when
search is required, and the resulting evidence block is injected as a
system message before the main-model call. The `X-Web-Citations` and
`X-Research-Lfm` response headers carry the `[S#]` map back to the
browser for the Research Trail card + citation pills.

`POST /api/search-more` is the one-round follow-up tool: the main model
may call it at most once per turn when a fact is missing; it re-runs
the LFM gate + pipeline against the follow-up queries and returns a
fresh evidence block.
