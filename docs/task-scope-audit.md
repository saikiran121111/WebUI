# Task-Scope & Browser-Routing Audit (2026-11-02, verified at c7b8da4)

User brief: 12-issue audit + complete fix. ALL 12 VERIFIED against current code.

## Live regression evidence (universal journeys)
- Plan rows in `.local-search/db/search-cache.sqlite` for the 3 journeys contain identical
  junk SERPs (pricehistory.app, wikipedia/Price, kerala price pages, amazon kaju-rate,
  flipkart printers) — caused by deterministic planner bugs, NOT the chat model:
  1. `buildDeepIndexQuery` → `site:what.com`: `extractBrandTokens` pascalRe `\b([A-Z][a-zA-Z]{3,19})\b`
     matches sentence-initial "What"; BRAND_COMMON_WORD_EXCLUSIONS lacks interrogatives;
     `buildDeepIndexQuery` uses brands[0] only.
  2. `pricing "price"`: targeted query `pricing "${entities[0]}"` where entity extraction
     (loose content words via tokenize) picked "price" as entities[0] → degenerate.
  3. `"price" "kingfisher" "beer" "650ml"`: ALL entities quoted incl. generic terms →
     over-constrained, ~0 hits.
  4. All cached items came from bing/bing-news only (DDG contributed nothing).
- Old DB backups (db-bak-20261029-preuniv/prewave) prove blinkit PDPs (prid, 520KB, price 325)
  and zepto brand pages (Product JSON arrays ₹110) WERE fetched pre-re-architecture → genuine regression.

## Verified issue map (file:line at c7b8da4)
1. `lib/decision/types.ts:60-61` task_constraints/extracted_entities EMPTY;
   `ruke-decision/src/engine.rs:128-129` same; test asserts emptiness (engine.rs:284). No task scope.
2. `browser_session` marker: app/page.tsx:58 getBrowserSession (panel-only), useChat.ts:705,
   lib/chat/client.ts:78, handler.rs:87-107 (session identity only), :257 feeds browser_loop.
3. ruke-server/src/chat/pipeline.rs: run_turn_pipeline (90) runs research BEFORE
   browser_loop::run_tool_loop (559); SearchGateContext (279) has no operational scope.
4. query-planner.ts (mirrored query_planner.rs): as above + `inferBrandDomain` strips dots
   BEFORE the dot-test (blinkit.com→blinkitcom.com class of bug), domain regex limited TLDs
   (foo.community→foo.com), INDIAN_BRAND_HINTS fabricated TLDs, companion query dies at
   plans.slice(0,4), Rust deep-brand sets preferred_domains None (search_gate.rs 588-940 all None).
5. planner-law.ts BRAND_DOCS_RE only matches docs-phrasing; "do this in Blinkit"/"only use
   Blinkit" → empty allowed/preferred; "only use blinkit.com" → works (explicit domain path :186-197).
6. applyDomainControl (planner-law.ts:289-298) r.origin=="user" exempt; search_gate.rs
   rules_based_plan (666) + fallbacks all preferred_domains: None; WebToolSession (tools.rs:207-217)
   has no scope; exec_web_search plans None.
7. ruke-browser/src/executor.rs: TabNew(191)/NavigateTabUrl(249) only check_navigable (scheme) +
   actable_tab (ownership); settle_page post-records URL; session.rs no affinity; Tabs exposes all.
8. authority.rs: gate_for(NavigateTabUrl)=act(tab) (649) → apply_gate (449) reads CURRENT tab URL;
   TabNew ungated.
9. metasearch.rs slug_triangulation (2116) mixes siteQuery+site:*+broadQuery results;
   extractor synthesized passages carry target URL/domain.
10. browserStore.ts setTabs (135-137) keeps previous selection; new targets never auto-selected;
    BrowserPanel shows selected only; handleBrowserStage lacks tab id.
11. browserClient.ts normalizeOmniboxUrl (185-190) prepends https:// blindly (zepto→zepto host
    guess fails DNS-wise? treats name as hostname); agentBrowser.ts vs ruke-browser separation OK.
12. rustProxy.ts 502 (no TS retry) + app/api/browser/route.ts 503 — CORRECT, preserve as-is.

## Fix design (single authoritative contract)
`TaskScope` as a STANDALONE threaded type — the DecisionEnvelope stays byte-pinned
(frozen; fixtures/contract replay) and is NOT extended:
  intent: research|site_info|operate|compare_sites; targetPhrase verbatim;
  state: none|unresolved|resolved|ambiguous; hosts (verified registrable hosts); urls;
  provenance: explicit_url|explicit_domain|resolved_search|resolved_cache|ambiguous|none;
  authorizedHosts (explicitly authorized extra sites, e.g. auth/pay hops).
Deterministic derivation lib/decision/task-scope.ts ⇔ ruke-websearch/src/task_scope.rs
(the ONLY PSL/url-detector-capable home; ruke-decision has no psl/url deps):
  explicit URL (PSL url-detector) → resolved; explicit domain (PSL boundary regex) → resolved;
  operational/source/restriction phrase + bare name → UNRESOLVED (no domain invention; no brand lists;
  no TLD guessing); bounded discovery resolves via host-label containment evidence; multi-candidate
  → ambiguous → clarification. Model tool args CANNOT widen scope (server-registered only).
Threading: handler→pipeline SearchGateContext.scope, planner-law mandatory-scope mode (separate
from soft preferred), gate fallbacks/gap/recovery carry hosts, WebToolSession.scope,
browser_loop registers scope with ruke-browser session+executor; destination checks BEFORE
TabNew/createTarget, NavigateTabUrl, form submits, popup claims; post-check+rollback for
unknowable destinations (JS nav) with honest scope-violation reporting (documented limitation).
Panel: browser:working_tab stage events (session+turn qualified) drive selection; explicit human
tab click = manual pin until session/turn change; omnibox: PSL → URL else search; provenance
separation in slug_triangulation + extractor (search evidence never presented as live target read).
No new planner subsystems; existing reranker soft-ranking untouched.

## Test plan
Vitest: task-scope derivation (case/multiword/uncommon-TLD/incidental/negation/ambiguity),
planner regressions (what.com/order.com/blinkitcom.com/foo.community gone), planner-law scope,
applyDomainControl conflict, gate-fallback scope carry, triangulation provenance.
Rust: task_scope.rs units, planner/gate/tools scope units, authority destination gates,
TS⇔Rust task-scope parity via the SHARED CORPUS rust-backend/fixtures/task-scope/cases.json
("the corpus is the contract": 32 derive + 8 resolution + 3 merge cases replayed by BOTH
__tests__/decision/task-scope.test.ts and task_scope.rs #[cfg(test)]); other planner/gate
parities via existing contracts:check + goldens (UPDATE goldens that pin malformed behavior).
E2E (final loop ONLY): new spec w/ fixture site names + mocked discovery + multiple local origins;
assert attempted/landed URLs, blocked actions, working tab. Then rerun affected universal journeys.

## Loop state (interrupted)
Final Playwright loop paused after run 41 (universal Zepto). Remaining rows: universal
BookMyShow/Zomato/YouTube/Maps/LinkedIn/HN/SO/Greenhouse/Gov + web-search-10k ×4 + NEW scope
specs + rerun of Blinkit/Myntra/Zepto after fix. Logs /tmp/pw-*.log preserved.
