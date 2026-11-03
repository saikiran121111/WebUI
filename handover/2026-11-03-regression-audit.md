# 2026-11-03 REGRESSION AUDIT TASK (user directive, verbatim record)

User observation driving this: "every websearch that's being done currently is completely
irrelevant and out of what user is expecting even the model literally said user asked
something different and I got completely different."

## Directive

Fix the existing named-site/product-search and interactive-browser regressions in
saikiran121111/WebUI develop **before adding features**. Verified at commit
`14f44ca85c82e9f17237ce159a00aedfc86155b3` (= current develop head). Keep Rust as the
production request handler; update the shared TypeScript search implementation and fixtures
consistently. Resolve arbitrary websites through evidence; implement no retailer-specific
branches, brand-domain tables, guessed TLDs, or product adapters.

Compare pre-cutover `7e405b57abd4c12f5b87f81bbfdbe028d5ab2b4d`, Rust activation
`33b5a8542920253ce75b4b586a47e73449d74a9f`, and current develop. Distinguish the transport
change at cutover from later planner/scope/extraction changes. The old planner sometimes
emitted product + site:amazon.com; the new bare-name path emits a broad product query plus a
name-only discovery query. The old code also guessed zepto.in and fabricated domains such as
find.com, so restore reliable scoped retrieval using VERIFIED destinations.

## The 10 items

1. **Restore the lost fetching capability.** ruke-websearch/src/net.rs: got/Impit/wreq-style
   passes are all implemented with ordinary reqwest; browser-header rotation does not restore
   the old transports' TLS behavior. Compare the actual TypeScript clients and Rust requests.
   Use a supported Rust transport or the existing bounded browser-read bridge for page-fetch.
   Verify content decoding and bridge availability. Distinguish unavailable bridge, access
   wall, transport failure, and genuinely absent product. Measure identical URLs/queries with
   fresh caches before attributing retailer failure to this. Keep whole-request failure
   handling explicit.

2. **Fix intent and target extraction.** deriveTaskScope (lib/decision/task-scope.ts L372) +
   Rust mirror (ruke-websearch/src/task_scope.rs L577): the eight-token backward window loses
   Amazon in "Find Samsung Galaxy S24 Ultra 256 GB Titanium Gray on Amazon." Direct-object
   forms "Open Zepto" / "Search Amazon for milk" produce no target. "Click the login button
   on example.com" becomes site_info because click is absent from the operational
   vocabulary, while browser routing accepts only operate. Handle natural word order, long
   product descriptions, multiword names, casing, Unicode, explicit URLs/domains, actions,
   negation, incidental mentions through the existing typed contract. Validate structured
   extraction. Preserve research-a-company vs operate-on-its-website distinction. Ensure
   chat/pipeline.rs routes the intent correctly regardless of panel visibility.

3. **Complete discovery → verified destination → product retrieval.**
   planQueries (lib/web-search/query-planner.ts L204) emits only a quoted site name for an
   unresolved target. TS resolution handoff (pipeline.ts L782) + Rust handoff (ruke-websearch
   /src/pipeline.rs L1261) refresh domain restrictions without guaranteeing a product-specific
   search on the newly resolved site. Schedule a bounded, deduplicated product/entity +
   site:verified-host pass after resolution; retain relevant deep product URLs; preserve scope
   in recovery/gap/tool searches. Budget the site operator's length BEFORE trimming query text
   (append-then-slice removes it for a 200-character query). Process requested destinations
   within declared limits; report incomplete resolution accurately. Align
   bounded_destination_discovery with tools.rs budgets: two-target loop currently uses a Quick
   session permitting only one search call.

4. **Enforce unresolved and ambiguous scope.** Domain admission (planner-law.ts L343), web
   tools, read_page, and browser affinity (ruke-browser/src/authority.rs L686) treat EMPTY
   resolved hosts as unrestricted. "Find milk on Zepto" can admit pricekart.co.in while Zepto
   remains unresolved. Permit bounded discovery to identify the destination, keep discovery
   candidates separate from target-site answer evidence, require clarification or an honest
   unresolved result when identity remains uncertain. Enforce in runtime/tool code.
   Distinguish explicit-but-pending scope from unrestricted research.

5. **Fix destination identity and follow-ups.** resolveTarget accepts a lone
   zeptodiscounts.com candidate for "Zepto" via prefix matching. PSL validity and string
   resemblance do not verify site identity. Require actual identity evidence, preserve the
   discovered canonical URL and provenance, support brand/domain names that differ, handle
   competing candidates explicitly. mergeTaskScope drops the destination for "What is its
   rating?" but carries a prior purchase operation into "Write a short poem" because every
   short request counts as continuation. Preserve scope on genuine continuations, reset on
   topic changes, apply explicit destination changes. Carry verified destinations through
   trusted conversation state; replaying only raw user text loses resolutions made during
   retrieval.

6. **Unify source constraints.** derivePlannerLaw (planner-law.ts L185) + planner_law.rs:
   "Only use alpha-store.com and don't use beta-store.net" puts BOTH domains in
   allowedDomains and leaves blockedDomains empty (segment-wide ONLY matching wins before
   BLOCK matching). applyDomainControl then admits B. Bind each constraint to its actual
   target; enforce explicit blocks over allowances/preferences/authorizations; prevent
   broader legacy lists from weakening mandatory scope. Honor generic excludedPhrases
   throughout resolution and admission (production does not consume them). Excluded full
   URLs must not become affirmative targets through scheme-URL promotion. Keep preferences
   soft unless the user imposed a restriction.

7. **Close browser navigation gaps.** known_destination (ruke-browser/src/executor.rs L1957)
   prechecks only navigate_tab_url and URL-bearing tab_new. Back/forward obtain history
   entries but navigate without destination affinity checks. Clicks, forms, redirects, JS/CDP
   navigation and adopted popups need equivalent enforcement. Lifecycle updates (engine.rs
   L866) update landed URLs without enforcing task affinity; "post-landing check" comments
   overstate protection. Check destinations before navigation where possible; handle
   unexpected landings before further observation/action. Equivalent checks for read_page
   redirects and final-URL evidence admission. Preserve legitimate human actions and explicit
   one-action cross-site authorization, including necessary sign-in/payment hops.

8. **Repair retrieval priority and freshness.** extractor.ts L995 + Rust mirror: top-six
   browser-read allowance, ten-minute bot-block cooldown, cooperative page budget (all
   post-cutover). Give an explicitly requested relevant product page a bounded opportunity
   despite unrelated rankings or an earlier domain failure. Preserve deadlines/cancellation.
   Realtime queries bypass query cache but still read the normal five-hour page cache.
   Propagate freshness into page reads/writes including read_page. Preserve actual
   source/time provenance for live observations, cached content, indexed snippets, archives,
   third-party fallbacks. Surface location/login/variant limitations when they prevent a
   verified price or rating.

9. **Verify the complete request and UI path.** Trace chat client/marker → decision/scope
   fold → search gate or browser loop → planner → engine/network → resolver/admission →
   extraction/reranking → model tools → browser executor/session/lifecycle → panel state.
   Preserve current omnibox normalization, free-text search handoff, working-tab fixes. The
   "Searching … reading …" text comes from searchGate/webCitations in ProcessingStatus.tsx;
   it does not establish an interactive tab visit. Make status and final claims reflect actual
   evidence and browser outcomes.

10. **Prove the fixes with regression tests.** Existing selected suites pass — 425 TypeScript
    tests and 567 Rust browser/search library tests — while additional audit checks expose 11
    TypeScript failures, eight independently reproduced against compiled Rust. Cover every
    example above, mixed allow/block clauses, excluded URLs, lookalikes, long queries,
    unresolved/ambiguous/partial resolution, follow-up retention/reset, redirects/popups/
    history, cache freshness, native/bridge failure. Include actual bare-name discovery
    followed by product retrieval: the current browser-scope matrix supplies explicit URLs and
    bypasses discovery. Test arbitrary unseen website names alongside natural
    Zepto/Blinkit/Amazon/Myntra prompts. Run checks and browser journeys under repository
    coordination rules. Assert attempted/landed domains and product evidence, not model
    narration alone. Report commits, tests, remaining live limitations. Treat the Windows
    contracts:check CRLF mismatch separately; generated content matches after newline
    normalization.

Completion = demonstrated correction of these regressions. Do NOT claim guaranteed ChatGPT
parity or universal retailer access.

## 2026-11-03b EXPANDED DIRECTIVE (18 items) — supersedes the 10-item list

The user expanded the audit mid-session to 18 items ("Repair Ruke's existing web-search,
research, media-understanding and interactive-browser behavior… reliability repair across
arbitrary genres and websites"). Companion audit doc + raw evidence: 14 failing of 18 new
assertions, 5 compiled-Rust assertion failures (realtime-price classification, stale-date
freshness, single-source sufficiency, late-transcript retention); evidence files
`./ruke-media-freshness-adversarial-vitest.json`, `./ruke-media-freshness-rust.txt`,
`./ruke-nov3-adversarial-vitest.json`, `./ruke-nov3-rust-adversarial.txt`; harnesses under
`work/audit-media-*.test.ts` and `work/audit-media-rust.rs` (outside source checkout).
New coverage beyond the 10: login/resume pending-task flow with the VISIBLE browser
persistent profile (credentials never in chat/model/search), browser_loop screenshot
culling vs bounded image input, YouTube captions→transcription→visual timeline, ffmpeg
20%/70% frames, Rust store_compat.rs golden test that ASSERTS the image-drop defect (must
be replaced), ANTI_REFUSAL_DIRECTIVE honesty, unseen-genre validation, "25 failing TS +
13 Rust assertions" proof matrix. Constraint reaffirmed: "Do not claim universal Cloudflare
bypass, 99.9% internet access or ChatGPT parity without evidence."

## 2026-11-03c BACKEND DECISION — web retrieval rolls back to TypeScript (verbatim)

User decision, recorded verbatim: "I want you to fix this completely finally if web
searching is unable to resolve then here is the thing we roll back every implementation we
did for web searching to typescript back again where it used to work for all of the
websites basically most of the websites only the web searching and improve in typescript
itself instead of coming to rust again"

Policy now in force:
- **Web SEARCH/RETRIEVAL execution = TypeScript** (`lib/web-search/` restored as the
  retrieval backend; improve there). Rust-native retrieval paths are retired for search.
- **Rust keeps**: chat orchestration, session/scope state, the Rust interactive browser
  (ruke-browser), and the TaskScope law mirror (corpus parity unchanged).
- Rust entry points that need retrieval — chat/pipeline.rs `run_web_research`,
  chat/web_loop.rs, browser_loop.rs destination discovery, search_routes.rs — must call
  the TS retrieval behind ONE authenticated internal bridge (per the 18-item directive):
  no proxy recursion, no duplicate execution/model calls, no separate budgets or citation
  sessions; streaming, cancellation, scope, provenance and failure types preserved.
- `RUKE_RUST_BACKEND=0` is NOT a valid rollback: app/api/chat/route.ts L675 has no browser
  engine and strips browser_session. Only web searching moves; browser turns stay Rust.

## 2026-11-03d STOP NOTICE (user instruction)

User: "implementation plan is changed for websearching can you stop now.?" — ALL
web-search implementation is PAUSED pending the user's new plan. Bridge design was
reconnaissance ONLY (no code written): the pattern would be a new Next internal route
wrapping lib/web-search/pipeline.ts `runWebResearch` behind `x-ruke-internal-secret`
(same Tier-3b trust model as /api/internal/browser-read, secret env
`RUKE_BROWSER_BRIDGE_*` via scripts/dev-supervisor.mjs), with Rust callers —
ruke-websearch/src/pipeline.rs `run_web_research` (pipeline.rs L710; used by
ruke-server search_routes.rs L82/L181, chat/pipeline.rs L390, web_loop tool sessions
via webtools::exec_web_search, browser_loop.rs bounded_destination_discovery L358) —
deserializing the TS bundle. Do NOT resume this without the user's new plan.

## R1 STATUS (task-scope law — DONE 2026-11-03)

lib/decision/task-scope.ts + ruke-websearch/src/task_scope.rs + fixtures/task-scope/
cases.json: bounded clause-aware Pass 3, Pass 3b direct-object destinations
(DO_SITE_VERBS/DO_SCAFFOLD/CONJ_STOPS), OP_VERBS click/tap/scroll/select/submit/fill
family, equality-only resolveTarget (prefix matching deleted; zeptodiscounts.com ≠ Zepto),
isFollowUp Tier-1 cue-anywhere + Tier-2 ≤6-token fragment head rule ("its" added),
mergeTaskScope v2 (target replace / anaphoric inherit / reset). Corpus: +4 derive,
+2 merges, 2 prefix resolutions flipped to unresolved, lookalike case added.
Verified: vitest 63/63, cargo test -p ruke-websearch task_scope 13/13, full suites below.

## Loop board state at pivot (superseded mid-run)

Final locked loop (old §8) ran pw-42..pw-75. Green: pw-42..44 (acceptance), pw-50 OMNIBOX,
pw-51 ROUTING, pw-53/pw-61 DENIAL, pw-54/pw-62 HOP, pw-56/pw-63 WORKING TAB, pw-58 FOLLOW-UP,
pw-59 REDIRECT, pw-60 ROUTING, pw-65 Blinkit, pw-66 Myntra, pw-67 Zepto, pw-68 BookMyShow,
pw-69 Zomato, pw-70 YouTube, pw-71 Maps, pw-72 LinkedIn, pw-73 HackerNews, pw-74 StackOverflow.
pw-64 = invalid invocation (wrong spec filename + quoting). Redesign commits: 76fb9fa
(DENIAL/HOP page-content hop), cb706be (WORKING TAB /easy/arrived), 14f44ca (two-slot
MARK_KEEP law — session.rs end_turn keeps exactly one deliverable + one handoff per turn,
latest-wins). pw-75 Greenhouse FAILED: turn never reached "complete" within 180 s — likely a
manifestation of the retrieval regressions below; deferred to the final loop after fixes.
Pending old board: Greenhouse, Government portal, web-search-10k ×4 ranges, acceptance
EASY/MEDIUM/HARD re-run, then §9 closeout + shutdown (ALL now superseded by this audit).
