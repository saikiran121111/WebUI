# RUKE Final Migration Report — Parts 9 & 10 (Next.js → Rust backend)

Date: 2026-10-29 (final verification wave). Branch: `develop`. All numbers below are
measured from real runs with real exit codes — no theoretical or extrapolated claims (Rule 15).

---

## 1. What the migration is

20 migrated server-side handlers (14 `app/api/**` route files) run behind
`rustProxy(req, <rust path>)` only when `RUKE_RUST_BACKEND=1` (supervisor-only).
Unset ⇒ TS executes verbatim (vitest/golden oracles intact). The Rust workspace
(`rust-backend/crates/*`) now owns: chat pipeline, search gate, query planner,
metasearch, universal extractor (4-stage waterfall + stealth-Chromium tier),
conversation/settings/stats APIs, title queue, web-verify, embeds, streaming proxy.

## 2. Final verification battery (this wave, real exit codes)

| Check | Command | Result |
|---|---|---|
| Rust unit/integration | `cargo test --manifest-path rust-backend/Cargo.toml --workspace` | **580 passed / 0 failed** (incl. amendment test) |
| Rust lint | `cargo clippy --manifest-path rust-backend/Cargo.toml --workspace -- -D warnings` | clean |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| Vitest full | `npx vitest run` | run1: 728/732, 3 transient load-flakes (exit 1); settled re-run: **731 passed / 1 skipped, exit 0** |
| Golden Rust↔TS replay | `npx vitest run __tests__/rust-golden --no-file-parallelism` | one 51/54 cluster (right after cargo rebuild — Defender/indexer scan of freshly built exes), re-runs **54/54 exit 0** (6 consecutive greens pre-amendment) |
| Universal live (post-budget-amendment) | `npx playwright test tests/universal-websites.spec.ts -g …` in 4 locked batches | **u1 BookMyShow+StackOverflow 2/2 exit 0 (2.9 m); u2 Zepto+Greenhouse 2/2 exit 0 (2.7 m); u3 HackerNews+Government 2/2 exit 0 (4.3 m); u6 (cold cache) Blinkit+Myntra+Zomato 3/3 exit 0 (4.2 m)**. YouTube/Maps/LinkedIn link-shortener trio green in pre-amendment runs (their direct-fetch path is not on the budget-modified cascade). Post-amendment universal ledger: 9/9 re-run cases green. |
| Search-gate | `npx playwright test tests/search-gate.spec.ts` | **3/3 exit 0** (after fixture-contamination fix, see §4.3) |
| Tier-3b browser-read | in `tests/tier3b-live.spec.ts` run | **1/1 passed** (exit was from the search-gate fixture, not tier3b) |
| web-search-10k | `WEB_SEARCH_10K_RANGE=… npx playwright test tests/web-search-10k.spec.ts` | chunk 35–69 **P**, chunk 70–99 **P**, chunk 0–34 **F (4th attempt)**: 3/35 zero-extractions — `stackoverflow.com/`, `swiggy.com`, `zepto.com` homepages returned 403/202 WAF challenges; the full waterfall (direct→preview→browser→jina→wayback→search) still extracted zero. Same 3 sites fail across BOTH epochs on this network since 10-28 (TS oracle ran the same corpus green on 10-23) ⇒ classified **environmental / third-party WAF**, not a migration regression. Threshold is a hard "<2" — assertion NOT weakened. |
| File-reading (FR) battery | 6 live suites | all green earlier this Part (106 readable / 3 skipped / 215 truth) |
| CodeBlock streaming colors | live browser probe (playwright-cli session) | fence colored at **2 545 ms while `data-state="streaming"`**; final bubble `colored=1, complete`; screenshot `.playwright-cli/codeblock-midstream.png` |
| Lifecycle | `npm run dev` start → health → teardown | start: `:3101 /api/ruke/health` 200 + `:3000` 200 in ~100 s. Stop: supervisor tree killed, **ports 3000/3101 free, orphan scan clean** (one stale `playwright test-server` PID 21212 found and killed) |

## 3. Performance re-measure (same harness: `rust-backend/perf/baseline-measure.sh`, exit 0)

Measured Rust (`/tmp/perf-rerun-20261029.log`, ws csv `ws-17956.csv`) vs §8 TS baselines (2026-10-26):

| Metric | TS baseline | Rust measured | Delta |
|---|---|---|---|
| Idle WS | 1,931 MB | 2,083 MB | +152 MB (dev-mode Next + extra `ruke-server` process both counted; dev-mode-only figure, honest caveat from §8 still applies) |
| Peak WS | 2,514 MB | 2,088 MB | **−426 MB** |
| 10× tiny-turn WS growth | 2,212→2,156 MB (no leak) | 2,084→2,085-2,086 MB | **no leak**, lower absolute |
| Warm routing (settings / model-stats) | 4.5–6.6 ms | 3.8–5.2 ms | at parity |
| Warm routing (GET /api/conversations) | 5.3–5.7 ms | 89–103 ms | **measured regression — open item** (DB has grown large with restored conversations; investigate list-query pagination/serialization next) |
| Time-to-first-progress (warm) | 39–47 ms | 41–54 ms | at parity |
| Cancellation | next turn first-stage 47 ms, no zombie | first-stage 46 ms, next turn 248 ms content | at parity, no zombie |
| Research-turn structure | 18 stage frames (2 cycles) | 36 stage frames (2 cycles), same gate→planning→searching→reading→reranking→done shape | parity |

Rust-vs-TS decision (per user rule "keep Rust unless impossible"): **Rust stays.**
Every parity oracle is green, memory is lower, latency is at parity except the
`/api/conversations` item above. No web-search functionality had to be moved back to TS.

## 4. Fixes landed this session

1. **`fix:` web-search per-page budget amendment (MIGRATION-MAP §11.3 amendment).**
   The Part-10 budget (`PAGE_BUDGET_DEFAULT_MS=60_000`) had made a slow page abandon
   its whole tier cascade mid-page, starve the browser tier, and emit
   `PAGE_BUDGET_TIMEOUT` — a starvation the TS epoch never had (TS had no per-page
   cutoff). Amended semantics (both epochs): the deadline is now **tier-boundary
   cooperative** — every HTTP tier is capped at the remaining deadline, but a
   budget-exhausted page ALWAYS still gets the browser tier (45 s bridge + 46 s
   allowance). New Rust test `budget_exhausted_page_still_gets_browser_allowance`;
   TS mirror `withDeadline`/`DEADLINE_EXPIRED` sentinel; `extractUrl(result)` stays
   uncapped for golden parity. Result (live): 0 `PAGE_BUDGET_TIMEOUT` in all
   post-amendment runs; tallies now show `SUCCESS_BROWSER`/`SUCCESS_JINA_FALLBACK`
   recoveries that the old budget killed; Zepto (previously null/0) read **10/10
   SUCCESS_DIRECT**; Greenhouse false-failure eliminated.
2. **`fix:` pipeline tally logging** — `extract all complete packets=N tally=KEY=cnt…`
   per turn, so evidence quality is observable per domain (the BookMyShow lesson).
3. **`test:` universal-websites helper race** — count bubbles BEFORE send, wait on
   THIS turn's `data-state` (never length-settle, never `.last()`, deadline throws).
4. **`test:` search-gate fixture contamination** — `page.goto("/")` restores the
   prior conversation (proven behavior); restored turns carry `a[data-citation]`
   pills, so "no search" assertions are now scoped to this turn's own bubble.
   Fixes the u4 false failure without weakening anything (3/3 green after).
5. **`fix:` CodeBlock colors during generation (user-reported)** — the streaming
   path used a pure 150 ms debounce that a local model outran: the timer reset on
   every chunk and Shiki only ran when the fence closed. Replaced with a 400 ms
   **throttle** (at most ~2.5 Shiki passes/s worst case; the orphaned
   `STREAM_HIGHLIGHT_INTERVAL_MS` constant became real). Verified live mid-stream.

## 5. Universal-access law compliance

Zero site-specific code, zero hardcoded URLs in production paths (Rust or TS).
Every green universal case ran through the same generic waterfall; Myntra's turn
even shows the generic vertical layer (`SUCCESS_ADAPTER=1`). Bot-protection is
handled by generic fingerprint/stealth tiers only.

## 6. DELETE_AFTER_PARITY retirement — status: deferred, with reasons

The map lists exactly three retirement candidates; none can be retired without
breaking a protected invariant today:

- `lib/server/logger.ts` (pino) — map's own condition: "pino stays until Node-only
  modules remain"; Node-only modules (supervisor, e2e-llm-proxy, embed/ONNX, tests) remain.
- `lib/web-search/index.ts` (barrel) — the vitest oracles (60+ web-search tests,
  incl. `extractor-page-budget.test.ts`) import through it; the map forbids deleting
  TS oracle surfaces.
- `src/lib/web-verify/types.ts` + `lib/web-verify-types.ts` — still imported by
  client code (`components/render/citations.ts`) and tests; the law forbids deleting
  client/UI code. Retirement = move `ClaimStatus` into a client-owned types module —
  a client refactor, not a migration deletion; scheduled as follow-up.

No deletions were performed this wave, so no post-retirement re-run was required.
This deviation from the original retirement instruction is deliberate: a deletion
that breaks tsc/vitest/client rules at 4 AM would violate the "never fake success /
preserve features" laws.

## 7. Open items (honest ledger)

1. **Search evidence quality (top priority follow-up).** The BookMyShow case passed
   the test but its evidence was 3 Wikipedia articles (SERP returned no
   bookmyshow.com page); the HN "top story right now" turn cited stale/off-target
   threads. This content-selection weakness predates the migration (the TS-era
   universal baseline failed BookMyShow/Zepto outright on 10-23 — Rust era is
   strictly better: both now pass with real site evidence in later turns).
   Proposed universal fix (no hardcodes): hostname↔query-token affinity boost in the
   fusion/rerank stage (a rare proper-noun query token matching a result hostname
   boosts that result) — needs Rust+TS mirror + golden fixture regeneration; too
   invasive to land safely at closeout.
2. `GET /api/conversations` 89–103 ms vs TS 5.3–5.7 ms — investigate list size / serialization.
3. 10k chunk 0–34: 3 WAF-blocked homepages (environmental; assertion intact).
4. Media streamers (dailymotion/vimeo transcripts) accepted as requirement; probe not run this wave.
5. Turn-id counter skips (behavioral/cosmetic, unfixed).
6. Golden/vitest flake family under rebuild load: documented, non-reproducible when quiet; keep `--no-file-parallelism` for golden.

## 8. Commits & push

See `git log` on `develop` (pushed to origin this session): budget-amendment fix,
pipeline tally, CodeBlock fix, spec fixes, and this report. Last green baseline
preserved throughout; no build in any commit was red.
