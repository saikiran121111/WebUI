# Web Search & Research Engine

Production-grade, self-contained web-research pipeline for the WebUI.
Every prompt is classified by the LLM gate before reaching the main
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
   │  + urlSearchFallback() for hard-blocked / auth-walled URLs
   ▼
extractor   (src/lib/web-search/extractor.ts)
   │  5-tier anti-bot pipeline:
   │  0. SQLite cache
   │  1.5. domain adapter (Reddit .json, GitHub raw, YouTube oEmbed,
   │       OSM Nominatim, ...) — runs BEFORE DOM extraction
   │  1. direct fetch → block-detector gate → DOM + JSON-LD +
   │     hydration-state + OpenGraph structured extraction
   │  2. jina.ai markdown fallback
   │  3. snippet / title preservation
   ▼
reranker    (src/lib/web-search/reranker.ts)
   │  pure-CPU BM25 + junk-passage filter, top 12-15, ≤3 per domain
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

- **RAM** : peak RSS stays <150MB for a 10-URL concurrent scrape
             (measured in `scripts/test-web-search.ts`). The headless
             browser pool is replaced with Impit's Rust TLS-impersonation
             client. Fingerprint rotation (Chrome → Firefox → Edge) on
             403/429/503 avoids WAF lockout.
- **Time** : discovery ≤1200ms budget; full cold-cache pipeline ≤4500ms.
- **Keys** : zero. All sources are keyless — DuckDuckGo Lite, Brave web
             scrape, Wikipedia Open API, HackerNews Algolia, arXiv,
             Reddit JSON, StackExchange API, public SearXNG failover.
- **Storage**: everything lives under `./.local-search/` (added to
             `.gitignore`). SQLite cache, SearXNG vendor list, and the
             Tranco corpus are auto-created on first use.

## Modules

| File | Responsibility |
| --- | --- |
| `types.ts` | Zod schemas + shared types (`SearchDecision`, `RankedResult`, `EvidencePacket`, `LfmDecision`) |
| `tls-client.ts` | Impit pool (Chrome/Firefox/Edge rotation), SSRF guards, 2MB body cap, rotating realistic headers, per-request cookie jar for redirect chains |
| `lfm-gate.ts` | LLM classification + deterministic trigger/no-search short-circuits + 2500ms fallback |
| `metasearch.ts` | 8 keyless source fetchers + RRF fusion + URL normalization + `urlSearchFallback` for blocked URLs |
| `block-detector.ts` | Pre-DOM classification of Cloudflare / Akamai / PerimeterX / DataDome / CAPTCHA / login-wall / JS-shell responses |
| `domain-adapters.ts` | Zero-key smart extractors: Reddit .json, GitHub raw / README, YouTube oEmbed + hydration, OSM Nominatim / OSM API |
| `extractor.ts` | 5-tier pipeline (cache → adapter → direct+block-gate+structured-meta → Jina → snippet), each packet tagged with a stress-test classification |
| `reranker.ts` | Zero-dependency BM25 (k1=1.5, b=0.75) over ~600-char semantic chunks + junk-passage filter |
| `cache.ts` | SQLite WAL cache: query results (15min-24h TTL by freshness), extracted pages (6h TTL) |
| `stress-cache.ts` | SQLite checkpoint + results store for the stress test (separate from the production cache) |
| `pipeline.ts` | Orchestrates all of the above into one call + emits the evidence block |

## Stress test

```bash
# 1. Build the 10,000+ URL corpus (writes .local-search/stress-test/corpus-10k.json)
npx tsx scripts/build-10k-corpus.ts

# 2. Run the 720-URL canary matrix across all 10 genres (rapid diagnostic)
npx tsx scripts/stress-test-10k.ts --mode=canary

# 3. Run the full 10,000+ corpus with domain-level rate limiting + checkpointing
npx tsx scripts/stress-test-10k.ts --mode=full-10k --concurrency=8

# 4. Resume a crashed full-10k run (SQLite checkpoint)
npx tsx scripts/stress-test-10k.ts --mode=full-10k --resume
```

Outputs:
- `.local-search/stress-test/report.json` — per-URL classification + latency + RSS
- `.local-search/stress-test/SUMMARY.md` — per-genre success rate + tier breakdown + p50/p95/p99
- `.local-search/stress-test/stress-cache.sqlite` — resume checkpoint

**PASS criteria** (all three must be 0):
- `FAIL_SILENT_BOT_BLOCK` = 0 (every WAF/challenge page is caught by the block detector and routed to Jina / snippet fallback)
- `FAIL_SILENT_LOGIN_WALL` = 0 (no login-form text leaks into BM25 passages)
- `FAIL_NETWORK_OR_CRASH` = 0 (zero unhandled rejections or timeouts)

All 10 genres must produce at least one `SUCCESS_*` passage.

## Running the self-test

```bash
npx tsx scripts/test-web-search.ts
```

Verifies:
1. LLM gate — static question → `search_required=false`;
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
  runLlmGate,          // LLM decision gate
  metasearch,         // parallel + fused discovery
  urlSearchFallback,  // harvest snippets for a blocked/auth-walled URL
  extractAll,         // p-limited 5-tier extraction
  rerank,             // CPU BM25 + junk filter
  runWebResearch,     // the full pipeline (what the chat route calls)
  evidenceBlock,      // renders [S#]-labelled passages for the main LLM
  detectBlock,        // pre-DOM block detector (Cloudflare / CAPTCHA / login walls)
  domainAdapter,      // zero-key smart extractors (Reddit / GitHub / YouTube / OSM)
} from "@/src/lib/web-search";
```

## Integration into the WebUI

`app/api/chat/route.ts` (POST /api/chat) calls `runWebResearch` on
every user prompt — the LLM gate runs first, the pipeline runs only when
search is required, and the resulting evidence block is injected as a
system message before the main-model call. The `X-Web-Citations` and
`X-Research-Lfm` response headers carry the `[S#]` map back to the
browser for the Research Trail card + citation pills.

`POST /api/search-more` is the one-round follow-up tool: the main model
may call it at most once per turn when a fact is missing; it re-runs
the LLM gate + pipeline against the follow-up queries and returns a
fresh evidence block.
