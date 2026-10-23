# Web Search & Research Engine

Production-grade, self-contained web-research pipeline for the WebUI.
Every prompt passes the search-by-default gate before reaching the main
model; when a live search is required, the pipeline runs in parallel,
stays under the 1GB RAM budget, and feeds the main model only
verifiable evidence with inline `[S#]` citations.

## Architecture

```
user prompt
   │
   ▼
SEARCH-GATE  (lib/web-search/search-gate.ts)
   │  1. deterministic short-circuit (trigger / no-search rules)
   │  2. LLM call → JSON matching SearchDecisionSchema
   │  3. 2500ms ceiling → rule-based fallback
   ▼
metasearch  (lib/web-search/metasearch.ts)
   │  parallel fetch across keyless sources, URL-normalized + RRF-fused
   │  + urlSearchFallback() for hard-blocked / auth-walled URLs
   ▼
extractor   (lib/web-search/extractor.ts)
   │  tiered pipeline (Pass A: got-scraping via net.ts, Pass B:
   │  fingerprinted Playwright pool):
   │  0. SQLite cache
   │  1.5. platform API adapter (Reddit .json, GitHub raw/README,
   │       youtubei.js evidence, Maps, OSM, short-link unwrap —
   │       platform-api.ts)
   │  1. direct fetch → in-extractor block gate → DOM + JSON-LD
   │       (schema-extract.ts) + hydration walker + OpenGraph
   │  2. fingerprinted browser / link-preview-bot fetch
   │  3. jina.ai markdown → Wayback → slug triangulation
   │  4. SERP snippet / title baseline passages (always kept)
   ▼
reranker    (lib/web-search/reranker.ts)
   │  pure-CPU BM25 + junk-passage filter, top 12-15, ≤3 per domain
   ▼
pipeline    (lib/web-search/pipeline.ts)
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
             (measured in `scripts/test-web-search.ts`). HTTP goes
             through got-scraping with rotating browser header
             profiles; impit's Rust TLS-impersonation client is the
             automatic fallback on 403/429/503, and the fingerprinted
             Playwright pool (Pass B) handles JS challenge pages.
- **Time** : discovery ≤1200ms budget; full cold-cache pipeline ≤4500ms.
- **Keys** : zero. All sources are keyless — Google, DuckDuckGo (html),
             Bing (+ news RSS), Yahoo, Brave, Wikipedia/Wikidata REST,
             Reddit JSON, HackerNews Algolia, StackExchange, arXiv,
             Semantic Scholar, IMDb suggestions, GitHub, Dev.to.
- **Storage**: everything lives under `./.local-search/` (added to
             `.gitignore`). The SQLite cache is auto-created on first
             use; browsers + cookies stay in `./.data/`.

## Modules

| File | Responsibility |
| --- | --- |
| `types.ts` | Zod schemas + shared types (`SearchDecision`, `RankedResult`, `EvidencePacket`, `SearchGateResult`) |
| `net.ts` | got-scraping primary fetch with impit TLS fallback (403/429/503), fingerprint rotation, cookie jars, size/time caps, cert-tolerant `.gov` fallback |
| `ssrf.ts` | single SSRF guard (`isSafeUrl`) shared by net.ts and the agent browser |
| `search-gate.ts` | LLM classification + deterministic trigger/no-search short-circuits + 2500ms fallback |
| `engines.ts` | general-web engine pool (DDG, Google, Bing+RSS, Yahoo, Brave, Reddit, GitHub, Dev.to) + per-host pacing + sharded multi-query runner |
| `metasearch.ts` | 15-source aggregator (general engines via engines.ts + Wikipedia/Wikidata/Reddit/HN/StackExchange/arXiv/Semantic Scholar/IMDb) + RRF fusion + URL normalization + `urlSearchFallback` for blocked URLs + SERP baseline preservation |
| `platform-api.ts` | keyless platform API adapters: Reddit .json, GitHub raw/README, youtubei.js evidence, Google Maps, OSM/Nominatim, short-link unwrap |
| `schema-extract.ts` | structured facts: JSON-LD (JobPosting/Product/Movie/FAQ/LocalBusiness…), microdata, OpenGraph |
| `youtube.ts` | youtubei.js evidence: getInfo + getTranscript, chapters, top comments; no-caption videos feed a companion metasearch query |
| `redirect-unwrap.ts` | stage-0 short-link unwrapper (maps.app.goo.gl, bit.ly, t.co, lnkd.in…) incl. meta-refresh hops |
| `google-maps.ts` | Maps place decoding: chain unwrap, URL parse, place-page scrape, Nominatim reverse geocode |
| `extractor.ts` | tiered pipeline (cache → platform adapter → direct fetch + in-extractor block gate + schema/hydration → fingerprinted browser → Jina/Wayback/triangulation → SERP snippet baseline), each packet tagged with a stress-test classification |
| `reranker.ts` | Zero-dependency BM25 (k1=1.5, b=0.75) over ~600-char semantic chunks + junk-passage filter |
| `cache.ts` | SQLite WAL cache: query results (15min-24h TTL by freshness), extracted pages (6h TTL) |
| `pipeline.ts` | Orchestrates all of the above into one call + emits the evidence block |

## Stress test

```bash
# 1. Build the verified URL corpus (zero-download rule: candidates come
#    from the project's own engine SERPs + in-repo seeds; target count
#    is an optional argument — see the script's usage header).
#    Writes .data/web-search-10k-urls.json
npx tsx scripts/build-10k-url-corpus.ts

# 2. Audit the corpus through the live pipeline
npx playwright test tests/web-search-10k.spec.ts
```

Latest audited run: `docs/web-search-10k-report.md`.

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
  runSearchGate,      // search-by-default decision gate
  metasearch,         // parallel + fused discovery
  urlSearchFallback,  // harvest snippets for a blocked/auth-walled URL
  extractAll,         // p-limited tiered extraction
  rerank,             // CPU BM25 + junk filter
  runWebResearch,     // the full pipeline (what the chat route calls)
  evidenceBlock,      // renders [S#]-labelled passages for the main LLM
  platformAdapter,    // keyless platform APIs (Reddit / GitHub / YouTube / Maps / OSM)
  schemaExtract,      // JSON-LD / microdata / OpenGraph fact extraction
} from "@/lib/web-search";
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
