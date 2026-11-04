# Web-Search TypeScript Rollback — Restoration Manifest

Started: 2026-11-03 · Branch: `develop` · Starting HEAD: `2ccbf557797854027497e85c244e680ac17621a4`
Restoration baseline: `791faed07d92396e7c0e1ed5779711bb80fd7fd8` (2026-10-26, last commit before the Rust migration).

Uncommitted work at session start (regression-audit fixes, RUST side will be deleted with the crate; preserved as a patch first):
- Saved to `handover/2026-11-03-uncommitted-audit-fixes.patch` (git diff of the full uncommitted tree).
- Excluded from staging permanently: `tsconfig.tsbuildinfo`, `repomix-browser.xml`.

## Section B — dependency stack (VERIFIED, no merge required)

`git show 791faed0:package.json` dependency sections are **byte-identical** to develop's `package.json`.
Lockfile pins for the retrieval stack are identical too (only exception below):

| package | 791faed0 declared | 791faed0 lock | develop lock | status |
|---|---|---|---|---|
| got-scraping | ^4.2.2 | 4.2.2 | 4.2.2 | same |
| header-generator | ^2.1.89 | 2.1.89 | 2.1.89 | same |
| impit (Rust-backed Node lib — KEEP) | ^0.14.6 | 0.14.6 | 0.14.6 | same |
| wreq-js (Rust-backed Node lib — KEEP) | ^3.2.0 | 3.2.0 | 3.2.0 | same |
| playwright / @playwright/test | 1.63.0 | 1.63.0 | 1.63.0 | same |
| playwright-core | (via playwright) | 1.63.0 | 1.63.0 | same |
| fingerprint-generator / -injector | ^2.1.89 | 2.1.89 | 2.1.89 | same |
| @crawlee/playwright | ^3.18.2 | 3.18.2 | 3.18.2 | same |
| @mozilla/readability | ^0.6.0 | 0.6.0 | 0.6.0 | same |
| cheerio | ^1.2.0 | 1.2.0 | 1.2.0 | same |
| linkedom | ^0.18.13 | 0.18.14 | 0.18.15 | **DEVIATION (accepted):** patch-level drift inside the same semver range, already installed on develop; pinning back would churn the lock with no behavioral benefit. |
| turndown / turndown-plugin-gfm | ^7.2.4 / ^1.0.2 | 7.2.4 / 1.0.2 | same | same |
| unpdf | ^1.8.1 | 1.8.1 | 1.8.1 | same |
| better-sqlite3 | ^13.0.3 | 13.0.3 | 13.0.3 | same |
| p-limit | ^7.3.3 | 7.3.3 | 7.3.3 | same |
| youtubei.js | ^18.3.0 | 18.3.0 | 18.3.0 | same |
| zod | ^3.23.8 | 3.25.76 | 3.25.76 | same |
| pino | ^10.4.0 | 10.4.0 | 10.4.0 | same |
| @huggingface/transformers | ^4.3.1 | 4.3.1 | 4.3.1 | same |
| ffmpeg-static | ^5.3.0 | 5.3.0 | 5.3.0 | same |
| tldts | — | 7.4.19 | 7.4.19 | same |

Native platform bindings expected (Windows x64): `@wreq-js/binding-win32-x64-msvc@3.2.0`, `impit-win32-x64-msvc@0.14.6` — load check in verification log below.

### Section B verification log (2026-11-03)

- **Installed versions match the 791 lock exactly** (read from node_modules): got-scraping 4.2.2, header-generator 2.1.89, impit 0.14.6 (+impit-win32-x64-msvc 0.14.6), wreq-js 3.2.0 (+@wreq-js/binding-win32-x64-msvc 3.2.0), playwright 1.63.0, fingerprint-generator/-injector 2.1.89, @crawlee/playwright 3.18.2, better-sqlite3 13.0.3, tldts 7.4.19, unpdf 1.8.1, youtubei.js 18.3.0, linkedom 0.18.15 (deviation 4). No install/merge was required — develop's lock already pinned the historical graph.
- **wreq-js native load + real request: PASS** — binding loads on node 26/win-x64; loopback GET through the real binding returned 200 with body and final URL; timeout-semantics repro captured above (this doubles as the pinned regression).
- **impit native load + real request: PASS** — `new Impit({browser:"chrome"})` + impersonated loopback GET returned 200; response body arrives as a `ReadableStream` (matches net.ts `readBounded(res.body)` usage), final URL surfaced for the landing revalidation.
- **Playwright browser: PASS** — playwright-core 1.63.0, chromium build 1243 present at `%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe`.
- **Dependency-mutation guard:** predev (`scripts/auto-update-search.mjs`) runs `npm update` on 11 search-stack packages every 6 h; it has no opt-out env, only the `.data/last-search-update.json` throttle (git-ignored). With ~1.6 h of window left at audit time, the timestamp was advanced so no automatic update can land during the rollback/verification window. All dependency changes in this rollback remain deliberate. The historical `dev: "next dev"` script was NOT restored — `dev: node scripts/dev-supervisor.mjs` stays (it owns the retained Rust services).
- **Next server-bundling audit:** `next.config.mjs` `serverComponentsExternalPackages` already covered impit, better-sqlite3, playwright/@crawlee, got-scraping, header/fingerprint (data-file __dirname law), unpdf, tldts, linkedom, youtubei.js, pino. **GAP FOUND AND FIXED: `wreq-js` was missing from the list in both 791 and develop** — webpack bundling its dist makes the platform-binding resolution fail, and `wreqLoad()`'s `.catch(() => null)` then SILENTLY disables Pass C in production builds (the transport looks installed but never runs). Added `"wreq-js"` with a comment.

Dependency mutation guard: `predev` runs `scripts/auto-update-search.mjs` (npm update every ~6h). During this rollback the predev auto-update must not run/land; updates stay deliberate. The historical `dev: next dev` script must NOT replace the current `dev: node scripts/dev-supervisor.mjs` (supervisor owns the retained Rust services).

## Section A — provenance audit & targeted restoration (NOT a wholesale 24-file checkout)

**Central finding (per-file `git diff` adjudication of all 24 baseline files):** develop's TS
`lib/web-search/` was never dormant or stale. It is `791faed0` PLUS post-791 audit laws
(§11.3/§11.8/§11.10/§11.11/§14/§17/§18/§19/§24/§25/§26/§29, audit #9 provenance law, Part-10
gate layers A–F, P-series fixes) PLUS current wire contracts (task-scope threading, planner-law
hook, presentation/richResults EvidenceBundle fields, realtime freshness). A wholesale 791
checkout would DELETE all of that — forbidden by the brief's own retention clauses ("retain
necessary current modules/adapters for existing tool/UI contracts", "keep modern SSRF checks",
"do not reactivate brand/TLD guessing") and by the pinned test suite (269 green vectors).
Therefore the operation is: **keep develop wherever the newer content is a law, contract, or
security mechanism; adopt 791 only for retrieval behavior the Rust-era bench changed.**

Per-file outcome:

- **Identical at 791faed0 already (no action):** charset-normalizer.ts, google-maps.ts,
  hydration-unpacker.ts, llm-json.ts, platform-api.ts, redirect-unwrap.ts, schema-extract.ts,
  universal-extractor.ts, vision-prepass.ts.
- **Kept at develop HEAD (deliberate — each diff hunk inspected; newer side is law/contract):**
  agentBrowser.ts (caption probe + pool exports for youtube-captions), cache.ts (freshness-aware
  TTLs), extractor.ts (§25 tier timeouts, §11.3 page budget, §17/§29 domain cooldown — the
  2026-10-29 amendment that fixed the "can't access BookMyShow/HackerNews" class), index.ts,
  metasearch.ts (§11.8 URL normalize, §14 secret scrub, §11.10 freshness fusion arg, audit #9
  provenance labels), pipeline.ts (scope stage, EvidenceBundle presentation/richResults, §26
  direct-target hop, evidence LAWS incl. wall-handling), query-planner.ts (no-fabrication law +
  scope companions — pins the brief's "no brand/TLD guessing" clause; 791's INDIAN_BRAND_HINTS/
  inferBrandDomain/buildDeepIndexQuery fabricate site:what.com / blinkitcom.com and were NOT
  restored), reranker.ts (source-authority ladder, mirrors Rust op order), search-gate.ts
  (Part-10 layers D/E1/E2/F, narrow WEB_INTENT_RE, realtime), ssrf.ts (P6 hardening),
  types.ts (realtime freshness, origin), url-detector.ts (named tldts import — 791's default
  import was a known browser-ESM crash), youtube.ts (exported getInfo for the internal RPC).
- **Restored from 791faed0 (the actual ownership/behavior rollback):**
  - **engines.ts** — the one Rust-era regression fix: GENERAL_WEB_ENGINES back to the full
    multi-engine pool (ddg, ddg-Lite-POST, google, bing, yahoo, brave, reddit + github) with
    the 150–300 ms tier-stagger fan-out, restoring RRF multi-engine corroboration. Removed
    develop's "VALUE-FIRST" 4-engine pool + race-to-enough (stop at 10 unique URLs / 1.2 s
    grace) — the mechanism that let fast Bing alone fill the pool with off-site junk for a
    `site:`-scoped query (the live Zepto→Amul/Wikipedia symptom) and that was coupled verbatim
    to the now-removed Rust GENERAL_WEB_ENGINES static.
  - **net.ts** — 791 baseline with develop's SSRF/redirect-guard law hunks re-blended verbatim
    plus the wreq API fix (deviation 1) and `opts = {}` default-arg hardening.

Verification: `npm run typecheck` exit 0; `__tests__/web-search` 17 files / 272 tests green
(including retrieval-quality 46 shared-vector matrix, task-scope-planner no-fabrication
vectors, security 18, and the new net-wreq.test.ts).

## Intentional deviations from the 791faed0 baseline (NOT byte-identity)

1. **wreq-js API fix (net.ts)** — historical net.ts passed `(timeoutMs ?? 30000)/1000` (SECONDS) and `emulate:'chrome'` cast through `as any`. Pinned wreq-js 3.2.0 expects `timeout` in MILLISECONDS and the option name `browser`. Reproduced live against the real native binding (loopback, 120 ms server delay): `timeout:30` → "operation timed out"; `timeout:30000, browser:'chrome'` → 200 + body + final URL surfaced. Pinned by `__tests__/web-search/net-wreq.test.ts` (3 vectors: ms-timeout success regression, bounded-timeout enforcement, default-timeout path) which also drove a small hardening: `wreqFetch`'s opts param gained `= {}` so the default-timeout call cannot throw on a missing object.
2. **Modern SSRF/DNS/redirect checks kept** — develop's hardened `ssrf.ts` (+ P6 port) and net.ts SSRF guards are retained over the 2026-10-26 versions.
3. **Brand/TLD guessing NOT reactivated** — the historical query-planner/engines `site:find.com` / guessed `zepto.in` heuristics stay removed; no new website lists introduced (standing law: no hardcoded brand→domain maps or preferred TLDs).
4. linkedom 0.18.15 lock pin (see table).

## Compat layer preserved over the restored baseline

**Finding: the anticipated narrow compatibility layer is a NO-OP — zero new adapter code was
needed.** The two files restored from 791 (engines.ts, net.ts) already return the exact shapes
current callers consume (SerpResult lists; PageFetchResult with fingerprint/elapsedMs/final-URL
contract), and every current-wire seam lives in the files kept at develop HEAD: scope threading
(pipeline `activeScope` → planQueries 4th arg), searchGate wire shape (search-gate.ts +
types.ts), presentation/richResults wiring (pipeline EvidenceBundle), planner-law hook
(derivePlannerLaw/applyPlannerLaw), tools.ts session contract (lib/chat/web-tool-loop.ts),
route progress frames (PipelineStage "scope" stage). Proof: typecheck exit 0 and 272/272
web-search tests green with only the engines.ts/net.ts behavior changes in place.

## Callers moved to TS

Filled 2026-11-03. One search owner; no dormant Rust fallback; no proxy recursion;
response shapes / SSE frames / citations / legacy headers preserved.

1. **`app/api/search` + `app/api/search-more`** — the `rustProxy` passthrough branches
   were removed from both routes; they run the TS pipeline unconditionally, even when
   `RUKE_RUST_BACKEND=1` arms every other proxied route.
2. **Initial-chat research (Rust chat pipeline)** — `crates/ruke-server/src/chat/pipeline.rs`
   (PART-8) makes exactly ONE authenticated loopback call,
   `NextSearchBridge::research` → `POST /api/internal/web-research`
   (`crates/ruke-server/src/chat/next_search.rs`; env pair `RUKE_BROWSER_BRIDGE_BASE_URL`
   + `RUKE_BROWSER_BRIDGE_SECRET`, header `x-ruke-internal-secret`). The reply is NDJSON:
   progress frames relay as `web:<kebab-stage>` SSE stage frames; the terminal
   `result` frame (bundle / no_bundle / error) feeds `buildMainModelContext().systemBlock`
   at `lastUserIdx + 1`. Client abort drops the request mid-stream (⇔ TS request
   signal). Bridge failure = log-and-continue (Rule 2.4) — the turn proceeds without
   web evidence; unset bridge env ⇒ no research, no fallback.
3. **`web_search`/`read_page` tool loop** — definitions, guidance, budgets
   (quick 1/6/2 · standard 2/12/4 · deep 4/20/6, cap 20), session store (30-min TTL)
   and execution are TS-owned in `lib/web-search/tools.ts` +
   `lib/server/web-tools-rpc.ts` over `POST /api/internal/web-tools`
   (actions create/exec/discover/close). Rust (`chat/web_loop.rs`) keeps ONLY the
   generic model/SSE transport loop and byte-identical fallback guidance consts
   (pinned by `__tests__/web-search/web-tools.test.ts` against BOTH source files).
4. **Browser-loop destination discovery** — `chat/browser_loop.rs` calls the web-tools
   `discover` action (TS owner); the browser operation itself stays Rust
   (`ruke-browser` untouched).
5. **Deleted caller surfaces** — `rust-backend/crates/ruke-server/src/search_routes.rs`;
   `app/api/internal/browser-read/`, `app/api/internal/youtube-evidence/`,
   `app/api/internal/media-transcript/` (+ their 2 route tests); the
   `export { extractUrlBrowser as browserRead }` alias in `lib/web-search/agentBrowser.ts`;
   the now-internal-only `getInfo` export in `lib/web-search/youtube.ts`.
   KEPT: `/api/internal/embed` (ruke-attach query vector), the whole ruke-browser
   profile/authority/permissions/tabs/UI stack, `psl` (moved into ruke-server).

## Rust removal

Filled 2026-11-03.

1. **Crate deletion** — `rust-backend/crates/ruke-websearch/` deleted (33 files, ~389
   Rust tests) via `git rm -f` — every pre-session local modification of those files is
   preserved in `handover/2026-11-03-uncommitted-audit-fixes.patch` (1,707,467 bytes).
2. **Workspace** — member + dependency removed from `rust-backend/Cargo.toml`;
   `ruke-server/Cargo.toml` drops the dep and gains `psl.workspace`; `Cargo.lock`
   stripped. `cargo tree -p ruke-server` shows no `ruke_websearch`.
3. **Runtime wiring** — `WebRuntime`/`AppState.web`, RealNet, the Rust search cache and
   verticals removed from ruke-server (`main.rs` Part-8 wiring deleted; 7 WebRuntime
   fixture blocks stripped from route tests). `ipc.rs` is now the neutral env-const
   module (base URL / secret / header names) used by the research bridge, embed client
   and browser_routes.
4. **Relocated shared code** — `task_scope.rs` (13 tests) and `url_detector.rs` (9 tests)
   `git mv`'d from ruke-websearch into ruke-server; the shared corpus
   `rust-backend/fixtures/task-scope/cases.json` is still replayed by BOTH languages
   (TS side: `__tests__/decision/task-scope.test.ts`).
5. **Contract manifest** — the rpc ledger entries `browserRead`/`youtubeEvidence`/
   `mediaTranscript` were replaced by `webResearch` (NDJSON terminal grammar
   bundle/no_bundle/error) and `webTools` (action vocabulary) in
   `rust-backend/scripts/gen-contract-manifest.mjs`; manifest regenerated and the drift
   gate (`npm run contracts:check`) is green. The TS binder
   (`__tests__/rust-golden/contract-manifest.test.ts`) now pins the two live route
   sources, the handler action vocabulary and the Rust bridge consts
   (`RESEARCH_PATH`/`TOOLS_PATH` byte-cross-check). The Rust binder
   (`crates/ruke-contracts/tests/manifest_drift.rs`) never referenced the dead rpc
   entries and needed no edit.
6. **Docs/tests marked historical** — banners added to `rust-backend/MIGRATION-MAP.md`,
   `OVERNIGHT-REPORT.md`, `perf/PROVIDER-VALUE-REPORT.md`, `FINAL-MIGRATION-REPORT.md`;
   the Rust-parity probe origins in the TS suites (gate prompts, security vectors,
   task-scope-planner, extractor page budget, rich-results) are marked
   "sole owner since the 2026-11-03 rollback".
7. **Coverage retirement** — the removed crate's ~389 behavioral tests do not need a
   Rust re-port: every retained behavior is pinned TS-side (retrieval-quality 46,
   security, search-gate parity ×2, task-scope-planner, extractor-page-budget,
   web-tools 61, web-tools-rpc 10, net-wreq 3, engines/metasearch/freshness/
   segment-filter suites). Full vitest after the rollback: **1094 passed | 1 skipped,
   tsc exit 0**; cargo check --workspace --tests exit 0.
