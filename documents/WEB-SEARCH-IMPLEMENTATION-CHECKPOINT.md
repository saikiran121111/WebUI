# RUKE WEB SEARCH — P1–P7 IMPLEMENTATION CHECKPOINT

Living checkpoint for the master implementation brief (executed order: **P1 → P6 → P3 → P2 → P4 → P5 → P7**;
Phases P2–P5 additionally carry the locked RICH RESULTS ADDENDUM binding — see
`documents/WEB-SEARCH-RICH-RESULTS-ADDENDUM.md`). Branch `develop`; NEVER merged/pushed to `main` by this
workflow. Playwright runs ONLY as the single final locked loop in P7 (`.ai-coordination/playwright.lock`,
foreground, nothing else during the run).

Status board (updated per phase):

| Phase | Scope (short) | Status |
| --- | --- | --- |
| P1 | Trusted runtime-clock context injection | **CLOSED** (commit ad4f938, golden family re-recorded, verified) |
| P6 | Safety: SSRF/DNS-rebinding/redirect revalidation, secret scrub, untrusted-data laws, wall law, §19 provenance | **CLOSED** (commit 65ad1d2 — details below) |
| P3 | Retrieval quality: freshness classes, TTL/RetrievalMode, wiki cap, normalize/dedupe, dynamic segment filtering; preserve structured metadata for P5 | **CLOSED** (this commit — details below) |
| P2 | Model tools: `web_search`/`read_page`, kill `searchMoreStub`, gap loop, RetrievalFailure taxonomy, budgets, tool/result envelopes | **CLOSED** (this commit — details below) |
| P4 | Planner: query schema/domain semantics/decomposition, evidence sufficiency, bounded Deep, PresentationPlan router | **CLOSED** (this commit — details below) |
| P5 | UI: citations + U1–U13 + full universal rich-results registry (`components/web-results/`, no gradients) | pending |
| P7 | Deterministic proof suite + before/after benchmarks + ONE final locked Playwright loop + final report | pending |

---

## P6 — Safety (CLOSED 2026-11-02, TS ⇄ Rust in one commit)

**Threat model honored:** retrieved web content is untrusted data (can never change scope, authorize tools,
request secrets, or grant consent); login/CAPTCHA/paywall/403/429/interstitial walls are represented
structurally, never bypassed; SSRF is block-by-default with resolved-IP validation, per-redirect
revalidation, and DNS-rebinding mitigation; outbound queries/fetches never carry credentials or private data.

### Implementation — TypeScript side
- `lib/web-search/ssrf.ts` (hardened, design previously locked): kept the legacy private-host regex
  VERBATIM (deliberate over-blocks `fd.nl`/`10.example.com` and the 172.15/172.32 allows stay pinned);
  added bracketed-IPv6 parsing (manual 8×16-bit groups: `::`, `::1`, ULA `fc00::/7`, link-local
  `fe80::/10`, multicast, IPv4-mapped/compatible → v4 delegation, 6to4 `2002::/16`, Teredo `2001::/32`
  with obfuscated-client XOR decode), CGNAT `100.64.0.0/10`, reserved suffixes
  (`.local/.internal/.localhost/.home.arpa/.invalid`), userinfo rejection, `scrubQuerySecrets`
  (case-sensitive + case-insensitive credential shapes, whitespace collapse), `firstUnsafeRedirectHop`,
  and async `isSafeUrlWithDns(url, resolver?)` (ANY private A/AAAA record ⇒ unsafe; resolver failure ⇒
  literal decision).
- `lib/web-search/net.ts`: `beforeRedirect` SSRF throw on the got passes; post-send LANDING-url
  `isSafeUrl` rechecks on every pass (gotPageFetch, gotUrlFetch, Pass B — unsafe ⇒ prefer got response
  else status-0 shape, Pass C, fetchUrl Pass B — unsafe ⇒ got observation, link-preview per-bot — unsafe
  bot skipped, result carries `resolvedUrl: lpFinalUrl`); entry guards upgraded to
  `isSafeUrlWithDns` (fetchPage / fetchUrl / link-preview).
- `lib/web-search/metasearch.ts`: deterministic `scrubQuerySecrets` at the `searchOne` chokepoint
  (query + allQueries) and on the composed urlSearchFallback query; §19 provenance — the RRF fuse
  stamps `origin: "search"` on every fused candidate.
- `lib/web-search/types.ts`: `SearchOrigin = "search" | "user" | "retrieval" | "config"`; optional
  `origin` on `NormalizedResult` / `RankedResult`.
- `lib/web-search/pipeline.ts`: the evidence block now carries the three §21 law sentences (evidence-not-
  instruction, no-secrets-in-queries/URLs, walls-are-access-controls) in place of the single old
  untrusted-data bullet — exactly 8 guideline bullets; direct-target seeds stamp `origin: "user"`.
- `__tests__/web-search/security.test.ts` (NEW, 18 tests): classification/allow-pins incl. reversed
  quirks, redirect-chain helper, fake-resolver DNS guard semantics, scrub vectors incl. benign
  no-over-scrub pins, 8-bullet + three-sentence evidence pins, fuse origin stamp. Vectors are SHARED
  with the Rust inline suite (both sides change in one commit).
- Golden fixtures 01/02/05 re-recorded (guideline-bullet bytes + `_meta` "8 guideline bullets").

### Implementation — Rust mirror (`ruke-websearch`)
- `ssrf.rs` rewritten: pure deterministic core `is_safe_url_with_records(url, Option<DnsRecords>)` +
  async `is_safe_url_with_dns` (std `ToSocketAddrs` in `spawn_blocking` — tokio `net` feature absent;
  documented superset: hosts-file entries consulted where TS is DNS-only — stricter, never weaker);
  `dns_gate_host` shared shape gate; scrub regex ports (`(?i)` in-pattern for CI list); the dead
  dotted-quad branch inside `parse_ipv6_groups` ported VERBATIM with an honest comment — do NOT
  "improve" the parser. 12 inline tests mirroring the TS vectors byte-for-byte.
- `net.rs`: `client_page` redirect policy is now `Policy::custom` — validates EVERY redirect target
  (⇔ got `beforeRedirect`) and caps the chain at 10 hops (⇔ got `maxRedirects: 10`); `reqwest::redirect::Redirect`
  is not a public type in 0.12.28 so the closure is inferred. Each pass rechecks the landing
  `res.url()` (`UrlWreqResult` gained `url`); Pass C unsafe ⇒ got observation; fetch_url unsafe ⇒ None
  routed through the existing `None => got_resp` arm; link-preview adds `lp_final` check + returns it;
  entry DNS guards on all three public fetchers. The old "does NOT re-validate per hop" deviation note
  was replaced with the hardened note (Rust additionally validates impit/wreq-equivalent intermediate
  hops — strictly stronger, recorded).
- `types.rs`: `SearchOrigin` enum (camelCase serde) + `origin` on BOTH structs with
  `skip_serializing_if` ⇔ TS undefined-absence byte parity.
- `metasearch.rs`: scrub at `search_one` head (shadowed `&str` + `as_deref()` for allQueries — zero
  downstream churn) + url_search_fallback composition; fuse `origin: Some(SearchOrigin::Search)`;
  manually-built fallback results intentionally unstamped (TS parity).
- `pipeline.rs`: three §21 bullets byte-identical to TS (block = 8 bullets); direct-target
  `origin: Some(SearchOrigin::User)`; linkedin-guest unstamped; struct-update at the re-read hop
  propagates `origin` automatically.
- Test-literal field additions (`origin: None`) in `cache.rs`, `extractor.rs`, `types.rs`,
  `metasearch.rs`, `pipeline.rs` helpers — no other workspace crate constructs these structs
  (`cargo check -p ruke-server --tests` clean).

### Byte-level findings recorded (do not re-derive)
- Fixtures contain NO `"rrf"`/`"origin"` bytes ⇒ the provenance field required ZERO additional
  golden re-records (only the guideline-text re-records 01/02/05 from the earlier session).
- REVERSED quirks (intentional hardening): `http://[::1]/` and `http://[fd00::1234]/` are now BLOCKED
  in both engines; `fd.nl`, `10.example.com` stay over-blocked; `172.15.0.1`/`172.32.0.1`/
  `100.63.255.255`/`[2002:8888:1111::]`/`[2606:4700:4700::1111]` stay ALLOWED.
- WHATWG/`url` crate normalize bracketed IPv6 identically (`host_str()` includes brackets); decimal/hex
  IPv4 deflates in both engines.
- TS Pass C PageResponse keeps `resolvedUrl: url` (NOT the wreq landing url) — mirrored verbatim;
  only link-preview returns the landing url.

### Verification (real commands, real exits — P6 gate)
- `cargo test -p ruke-websearch --manifest-path rust-backend/Cargo.toml` → **310 + 5 + 0 tests, 0 failed** (run twice, 68–69 s each).
- `cargo clippy -p ruke-websearch --manifest-path rust-backend/Cargo.toml` → exactly the 7 pre-existing baseline warnings (engines.rs×6 doc-list + extractor.rs:1614); the 2 warnings the new ssrf.rs initially introduced were fixed in-crate (`is_some_and`, lifetime elision). `cargo fmt -p ruke-websearch --manifest-path …` applied (crate-scoped only — workspace is NOT rustfmt-clean).
- `cargo check -p ruke-server --tests` → clean, exit 0.
- `npx vitest run __tests__/web-search` → 9 files, **78/78 passed**, exit 0.
- `npx vitest run __tests__/rust-golden --no-file-parallelism` → 10 files, **54/54 passed**, exit 0 (no drift ⇒ no re-record needed).
- `npx tsc --noEmit` → exit 0.
- No Playwright executed in P6 (reserved for the final locked P7 loop).

---

## P3 — Retrieval quality (CLOSED 2026-11-02, TS ⇄ Rust in one commit)

Freshness-aware retrieval: the pipeline now distinguishes time-scoped queries from timeless ones,
decays stale evidence, shortens cache retention for live-sensitive queries, canonicalizes URLs so
duplicates collapse, and — the one new fetch-side law of this phase (§11.12) — filters off-query
page segments before they ever join the rerank pool. Every semantic change is mirrored TS ⇄ Rust;
structured result metadata is preserved untouched for P5's `RichResult` envelope.

### Implementation — kernel (landed TS ⇄ Rust across sessions; committed here)
- **Freshness engine** — TS `lib/web-search/freshness.ts` (NEW: `isTimeScopedFreshness`,
  `freshnessFit`) ⇔ Rust `freshness_fit`/`is_time_scoped_freshness` in `types.rs`. Band table:
  realtime w=1 day/boost 1.3, day 2/1.3, week 7/1.25, month 30/1.2, year 365/1.1. Fit ladder:
  age ≤ window (future dates included) ⇒ boost; ≤2× window ⇒ 1.0; ≤8× ⇒ 0.7; else ⇒ 0.5;
  undated/unparseable ⇒ 1.0 (never punish unknown dates); non-time-scoped ⇒ 1.0.
  Shared test clock `NOW_MS = 1_781_481_600_000` (2026-06-15T00:00:00Z) pinned in BOTH test suites.
- **RetrievalMode + per-freshness TTLs** — TS `types.ts` union `cached_preferred | live_preferred |
  live_required` + `retrievalModeForFreshness` ⇔ Rust `types.rs` `RetrievalMode` +
  `retrieval_mode_for_freshness`. realtime ⇒ `live_required` (cache READ skipped; write TTL capped
  by `REALTIME_QUERY_TTL_MS` = 5 min), day/week ⇒ `live_preferred` (cap `FRESH_QUERY_TTL_MS` =
  15 min; both constants live in `cache.ts` ⇔ `cache.rs`).
- **Wiki vertical cap** — the wiki vertical is dropped from general results only for time-scoped
  queries (encyclopedic pages must not out-rank fresh news).
- **RRF fuse freshness decay** — fourth freshness-aware parameter in the fuse:
  `score *= freshnessFit(publishedDate, freshness, nowMs)` (⇔ Rust identical placement).
- **Rerank order-prior** — freshness multiplies the SORT KEY only
  (`rawScore*(1-0.8*penalty)` then `*fit`, bit-identical op order both sides); the stored
  `bm25Score` reported in evidence stays undecayed so citation blocks remain stable.
- **normalizeUrl ⇔ normalize_url** (`metasearch.ts`/`metasearch.rs`): strips 7 `TRACKING_PARAMS`
  + every `utm_*`; `m.`/`amp.`/`wap.` hosts fold to apex; AMP paths collapse. Dedupe consumes the
  canonical form. Vector-pinned both sides.
- **Gate prompt parity** — the search-gate system prompt is byte-identical TS ⇔ Rust
  (filesystem probe test pins it).
- **Freshness recovery** — when a time-scoped run yields <5 relevant results it auto-reruns with
  freshness "any": `metasearchWithFreshnessRecovery` ⇔ `metasearch_with_freshness_recovery`,
  `freshness_recovery_used` recorded both sides.

### Implementation — §11.12 dynamic segment filtering (this session's completion)
- TS `lib/web-search/segment-filter.ts` (NEW: `filterPassageSegments` / `applySegmentFilter`) ⇔
  Rust `reranker.rs` (`filter_passage_segments` / `apply_segment_filter`). STRUCTURAL DEVIATION
  (recorded): TS gets its own module; Rust lives in `reranker.rs` to reuse `tokenize`/`junk_penalty`.
  The `extract_all` trait method signature (the scripted-fixture seam) was NOT touched — the filter
  is applied at the pipeline call sites: main read waves + the gap hop (gap concatenates its
  `gapQuery`), via hoisted `segmentFilterQuery` = user prompt + gate queries joined. Prompt-URL and
  SERP-baseline packets are deliberately exempt.
- Conservative by construction: no query terms ⇒ inert; `[Structured Page Facts]` ⇒ inert (P5 JSON-LD
  preservation law); ≤2 blocks ⇒ inert; page with zero query-covered non-atomic block ⇒ inert
  (never empties a page); nothing droppable ⇒ ORIGINAL bytes verbatim. Always keeps: fenced code,
  pipe tables, query-covered blocks, headings. Drops only: junk-penalty ≥ 0.8 boilerplate (any
  size) and zero-coverage prose ≥ 200 chars (UTF-16 length ⇔ `utf16_len`). No cloud model, ever.
- Vectors pinned vector-for-vector in `__tests__/web-search/retrieval-quality.test.ts` ⇔ Rust
  `segment_filter_shared_vectors` + `apply_segment_filter_mutates_passages_in_place`.

### Byte-level findings recorded (do not re-derive)
- **Fixture clock stability:** fixtures 01/02 carry dated sources (2026-02-11, 2024-12-30) that are
  always >8× the week window ⇒ fit = 0.5 forever ⇒ rerank order is wall-clock stable in goldens.
- The §11.12 filter is **INERT on the fixture corpus**: a full delete-and-re-record produced bytes
  byte-identical to the pre-filter fixtures (structured-facts passages + short blocks). Fixtures
  01/02 stay M from the earlier P3-kernel re-record; 05 is unchanged.
- **Pre-existing golden reproducibility hazard (NOT introduced by P3):** `web.test.ts:235` documents
  that the extractor browser tier runs LIVE stealth Chromium for non-scripted URLs. During this
  phase one record attempt drifted on 01/02/05 with bytes that exist NOWHERE in the repo — live
  multi-language `example.com` paragraphs (fixture 05) and BM25 11.01→11.35 (fixture 01/02: a
  corpus IDF shift caused by that live content change). A fresh re-record then produced the OLD
  bytes again. Conclusion: drift came from upstream web content, not repo code. If rust-golden web
  drift ever reproduces on unchanged code, suspect live-tier content first. Never weaken assertions
  to accommodate it; P7 must account for this hazard explicitly.

### Verification (real commands, real exits — P3 gate)
- `npx vitest run __tests__/web-search` → 10 files, **124/124 passed** (retrieval-quality.test.ts: 46).
- `cargo test -p ruke-websearch --manifest-path rust-backend/Cargo.toml` → **320 lib + 5 integration, 0 failed**.
- `cargo test -p ruke-server --manifest-path rust-backend/Cargo.toml` → **109 lib + 6 attachment_replay + 1 browser_ui_routes + 19 golden_replay, 0 failed** (TS ⇔ Rust byte parity intact with the filter active on both sides).
- `cargo clippy -p ruke-websearch --manifest-path rust-backend/Cargo.toml` → exactly the 7 baseline warnings (engines.rs×6 doc-list + extractor.rs map_or) — the new filter code adds zero warnings.
- `cargo fmt -p ruke-websearch --manifest-path …` → in-set files (cache/metasearch/pipeline/reranker/search_gate/types .rs) are FMT-STABLE (hash-checked across a second fmt pass); the 16 known out-of-set files reverted.
- `npx vitest run __tests__/rust-golden --no-file-parallelism` → 10 files, **54/54 passed**, exit 0 (run twice incl. standalone web.test.ts 5/5 after the re-record audit above).
- `npx tsc --noEmit` → exit 0.
- No Playwright executed in P3 (reserved for the final locked P7 loop).

---

## P2 — Model-facing web research tools (CLOSED 2026-11-02, TS ⇄ Rust in one commit)

**Rich-results addendum honored:** tool/retriever → validated structured envelope → frontend renderer path is
in place end-to-end; tool results carry ONLY structured retrieval payloads (the model can never fabricate
prices/ratings/coordinates — the READ/SEARCH envelopes carry exactly what the pipeline validated); one tool
round buys N pages (read_page batch within one round under the MAX_TOOL_ROUNDS budget).

### Implementation — TypeScript side
- `lib/web-search/tools.ts` (NEW, 646 lines): §11.13 `RetrievalFailure` taxonomy + `classifyRetrievalFailure`
  (deterministic needle order unsafe→robots→captcha→rate→auth→size→mime→dns→timeout, then status≥400,
  then parse_failure default); depth budgets quick{1,6,2}/standard{2,12,4}/deep{4,20,6} rounds/searchCalls/
  readUrls; session with `[S#]` seed continuation (`Math.max(1, seed)`), `ws-` search-session id, 500-char
  focus context; byte-locked `WEB_SEARCH_TOOL_DESCRIPTION` / `READ_PAGE_TOOL_DESCRIPTION`;
  `webToolDefinitions()` (queries 1–4, missing_claims 1–6, desired_source_types enum, freshness incl.
  "realtime", urls 1–8, timeoutMs [1000,60000], `additionalProperties:false`); `execWebSearchTool`
  (§11.18: URL-shaped queries route to read_page semantics with an honest notice, never a SERP query;
  per-query `metasearch([{query,intent,freshness}], 10)`; `normalizeUrl` dedupe keeps the FIRST-SEEN RAW url;
  snippets capped at 300+"…"; optional same-round page reads); `execReadPageTool` (SSRF guard FIRST —
  `unsafe_destination` and the extractor is never touched; per-packet `extractUrl` + §11.12
  `applySegmentFilter` + `[S#]` renumbering; whole-URL budget drops with notices; 20 000-char batch budget
  deducts WHOLE passages — a page is kept or omitted, never halved; wall outcomes stay STRUCTURAL:
  auth_required / captcha_required / rate_limited via the §P6 classification, never a bypass);
  `budgetExhaustedEnvelope` / `invalidArgsEnvelope` are honest, never guesses.
- `lib/chat/web-tool-loop.ts` (NEW, 499 lines): `runWebToolLoop` — guidance block injected in the skill
  slot (immediately before the last user turn, `injectSystemBefore`), `payload.tools` armed;
  `ToolStreamRelay` merges tool-call fragments BY INDEX and swallows a round's `[DONE]` iff that round ended
  `finish_reason:"tool_calls"` → exactly ONE `[DONE]` per stream, even on misbehaving final rounds
  (documented deviation at the round cap: tools removed + `WEB_TOOL_FINAL_DIRECTIVE` + ONE forced no-tools
  round, synthetic `data: [DONE]` if the model calls tools again there); `web:tools` stage with the call
  census + progress; fresh citation seeds merge into the `[S#]` map and the MERGED map re-rides a `web_meta`
  frame (the `hooks/useChat` OVERWRITE law); `unknown_tool` / `invalid_arguments` honest tool-message
  envelopes keep the loop alive; `beginUserTurn`/`endUserTurn` exactly once for the WHOLE loop (Rule 5);
  think-tag scrubbing identical to the passthrough path.
- `app/api/chat/route.ts`: the loop arms ONLY when the pipeline produced a bundle (`meta.webDepth`) AND the
  client sent no `tools` (Browser Panel passthrough law `client.ts:70` untouched); the legacy `stream:false`
  path keeps the old forward verbatim (fixture 02 pins it).
- `lib/web-search/pipeline.ts`: `searchMoreStub` KILLED — grep proof: zero `searchMore` references remain in
  `__tests__/` or `rust-backend/fixtures/`, so NO golden re-record was required for the stub removal itself.

### Implementation — Rust mirror
- `crates/ruke-websearch/src/tools.rs` (NEW, ~950 lines): byte-locked constants ⇔ TS
  (`WEB_SEARCH_TOOL_DESCRIPTION:267`, `READ_PAGE_TOOL_DESCRIPTION:269`, `WEB_TOOL_GUIDANCE` concat block
  :351–361, `WEB_TOOL_FINAL_DIRECTIVE:367`, caps :371–376 — each per-line probe text occurs EXACTLY ONCE per
  file); `exec_web_search` (:684) / `exec_read_page` (:831) mirror the TS envelopes, budgets, §11.18 routing,
  dedupe, char-budget whole-passage law, and wall-law classification; `lib.rs` exposes the module.
- `crates/ruke-server/src/chat/web_loop.rs` (NEW, 425 lines): the same loop shape as `browser_loop.rs` but
  read-only research; REUSES `ToolStreamRelay` + `tool_content` (visibility widened to `pub(crate)` in
  `browser_loop.rs`, no second copy); `state.slot.begin_guard()` held for the WHOLE loop (Rule 5);
  `stream_round` helper shared by normal + forced-final rounds; synthetic `b"data: [DONE]\n\n"` restores
  the grammar when the misbehaving final round's `[DONE]` was swallowed; citations merged + `web_meta`
  re-emitted under the OVERWRITE law (contracts `StageEvent` unchanged — no schema change needed).
- `crates/ruke-server/src/chat/pipeline.rs`: `run_turn_pipeline` returns `web_depth`; `pump_progress` arms
  the `web_tools` path ⇔ route.ts gate; `mod.rs` wires the module.

### Byte-level findings recorded (do not re-derive)
- `metasearch` takes a FLAT plan array of one `{query,intent,freshness}` object per call (not double-nested).
- On the TS side the guidance/directive constants live ONLY in `web-tool-loop.ts` — `web-search/tools.ts`
  does not re-export them (Rust side: they live in `tools.rs`; the probe compares each file to itself).
- A successful `read_page` entry carries NO `fetched` key at all; only failed pages carry `fetched:false`.
- Dedupe keys on the NORMALIZED url but the FIRST-SEEN RAW url (query params and all) rides into the envelope.
- Golden fixtures 01/03/05 RE-RECORDED this commit: the recorded chain is now
  `[guidance, user, runtime_clock, evidence|sentinel]` + the `tools` array (bodyJson pins both descriptions +
  schemas verbatim). Fixture 02 (legacy headers) and 04 (pipeline throws) did NOT drift — the throw path and
  the legacy path never arm the loop; that non-arming is now itself pinned.

### Verification (real commands, real exits — P2 gate)
- `npx vitest run __tests__/web-search/web-tools.test.ts __tests__/chat/web-tool-loop.test.ts` → **67/67**
  (57 + 10, both files NEW this phase).
- `npx vitest run __tests__/web-search` → 11 files, **181/181 passed** (was 124 at P3 close).
- `npx vitest run __tests__/chat` → 2 files, **15/15 passed**.
- `npx vitest run __tests__/rust-golden --no-file-parallelism` → 10 files, **54/54 passed** — run twice;
  the second pass is the determinism/replay proof for the re-recorded fixtures.
- `npx tsc --noEmit` → exit 0.
- `cargo test -p ruke-websearch --manifest-path rust-backend/Cargo.toml` → **331 lib + 5 integration, 0 failed**
  (tools.rs added 11 lib tests over P3's 320).
- `cargo test -p ruke-server --manifest-path rust-backend/Cargo.toml` → **109 lib + 6 + 1 + 19 + 2 + 6**
  integration targets, 0 failed.
- `cargo clippy -p ruke-server -p ruke-websearch --all-targets` → EXACTLY the locked baseline
  (6× doc-list-item + 1× map_or in ruke-websearch; ruke-server adds ZERO).
- `cargo check -p ruke-server --tests` → clean. `cargo fmt` in-set files (tools.rs, web_loop.rs,
  browser_loop.rs, chat/pipeline.rs, mod.rs, lib.rs, extractor.rs) are fmt-stable; the 16 known out-of-set
  files reverted.
- No Playwright executed in P2 (reserved for the final locked P7 loop).

---

---

## P4 — Planner law + presentation router + soft source ranking (CLOSED 2026-11-02, TS ⇄ Rust in one commit)

**Implementation (TypeScript):**
- NEW `lib/web-search/planner-law.ts`: `derivePlannerLaw` (§11.5/§11.17 — only/block scope phrases,
  plural-tolerant domain names, `site:` operators, brand-docs preferences, gate `preferred_domains` merge
  with the block-wins contradiction law, COARSE location only (§11.22 — never IP-derived),
  `expectedSourceTypes` classMap, `budgetForDepth` §11.21); `applyPlannerLaw` (scoped `site:` companion
  queries, cover-aware, 4-wave cap, `origin:"preferred"`); `applyDomainControl` (hard allow/block ONLY —
  user-directed links exempt); `evaluateSufficiency` (§11.14 gates: snippet-only never counts, contradiction
  metric scan, stopEarly); `buildGapDemand` (§11.6 never-repeat suffix ladder, whole-collision drop ⇒ null,
  snake_case wire).
- **Soft source ranking (search-policy correction 2026-11-02):** implemented in the EXISTING ranking layer —
  `reranker.ts` `sourceAuthorityTier` (primary → specialist → journalism → general → community ladder,
  suffix rule), `classifySearchIntent` (exp/sci/bkg/cur/none ladder), `authorityMultiplier` (intent-aware,
  bounded, ALWAYS >0 ⇒ FALLBACK LAW: nothing is ever dropped; Wikipedia de-biased for current/disputed
  claims, community raised for experiential intent; designated = planner allowed+preferred reads as primary).
  The prior is ORDER-ONLY (multiplied into `orderKey` — stored `bm25Score` bytes never shift). Reddit/Quora/
  Wikipedia/forums are NEVER default-blocked; `blockedDomains` is populated ONLY by explicit user/policy
  demand. Per the architecture redirect: NO parallel planner ranking subsystem — the planner law only
  expresses intent/permissions; P3-style ranking decides boost/penalize strength.
- NEW `lib/web-search/presentation.ts`: §55 PresentationPlan router (19-rung primary ladder + layout +
  reason; deterministic, zero extra LLM calls; §53 no-spam ⇒ `null` for plain factuals). P5 CONSUMES this.
- `pipeline.ts`: EvidenceBundle carries `plannerLaw`/`sufficiency`/`gapDemand`/`demandWaveFired`;
  `designatedDomains` plumbed to all three `rerank` hops; wave + gap + deep demand-wave gated by budget.
- `query-planner.ts`: gate `preferred_domains` EXECUTE as `site:` companions (original query kept).

**Implementation (Rust mirror, same commit):** `ruke-websearch/src/planner_law.rs` (NEW, ⇔ planner-law.ts),
`src/presentation.rs` (NEW, ⇔ presentation.ts; serde key order ⇔ TS literal order), `reranker.rs`
(`source_authority_tier`/`classify_search_intent`/`authority_multiplier`, `Neutral` ⇔ `"none"`),
`pipeline.rs` (`designated_domains` ×3 rerank hops + law/sufficiency/gap wiring), `lib.rs` module decls,
`ruke-server/src/chat/pipeline.rs` test-helper ripple only.

**Search-policy fixture law:** the `blockedDomains:["reddit.com","quora.com"]` values in the Rust/TS tests
are FIXTURE INPUTS proving explicit-user-block serialization (the prompts literally say "Don't use reddit or
quora") — commented on BOTH sides so nobody reads them as default policy. Production auto-injection of
weak-source blocks was fact-checked: it does NOT exist and must never be added.

**Verification (real runs, exit 0):** `npx vitest run __tests__/web-search __tests__/chat` → **223/223**
(web-search 208 = 181 + 27 new parity tests in `planner-law.test.ts` 14 + `presentation.test.ts` 9 +
`source-ranking.test.ts` 4; chat 15); `npx tsc --noEmit` → clean; `cargo test -p ruke-websearch` →
**358 lib + 5 integration, 0 failed** (69.5s; +27 over P2: 14 planner_law + 4 presentation + 4 reranker +
5 ripple/helpers); `cargo test -p ruke-server` → all green (109 lib + 6 + 1 + 19 + 2 + 6);
`cargo clippy -p ruke-server -p ruke-websearch --all-targets` → EXACTLY the locked 7-warning baseline
(the 2 new needless_borrow hits planner_law.rs drew were fixed at source); `cargo check -p ruke-server
--tests` clean; `npx vitest run __tests__/rust-golden --no-file-parallelism` → **54/54 run TWICE with
ZERO fixture drift** (git-clean fixtures — P4's order-only prior + general-tier fixture domains leave the
recorded corpus byte-identical; NO re-record needed, assertions untouched); fmt crate-scoped, in-set
FMT-STABLE, the known out-of-set files reverted (`examples/engine_bench.rs` lives under examples/, not
src/). No Playwright (final locked P7 loop only).

---

## Next-up contract reminders (carried into P5)
- P5 consumes the P4 outputs: `PresentationPlan` rides the EvidenceBundle → drive
  `components/web-results/` from it (addendum §55/§56: structured source routing — YouTube→video,
  geocoded→map, weather→weather, sports→sports, news cluster→grid; never flatten to prose then rebuild
  client-side). ONE primary surface by default (§53 no-spam).
- ONE versioned `RichResult` Zod envelope (+ Rust serde mirrors, unknown kinds → generic card); validated
  RichAction bridge; per-field provenance — community/user-generated labels feed from
  `sourceAuthorityTier` (P4 exports); one broken widget never destroys the response (§59).
- FenceRouter UNTOUCHED; rich system lives in NEW parallel `components/web-results/`; do NOT regress
  existing artifact blocks (ChartBlock, WidgetBlock, MarkdownTable, Mermaid, Code, HTML, Resume/Docx/Xlsx/
  Pptx, PowerBi, 3D viewers — addendum §66). Heavy surfaces via `next/dynamic` ssr:false.
- HARD VISUAL LAW: no AI-slop aesthetic, NO gradients in the new system (§76 style regression tests land
  in P7), motion 120–200ms, prefers-reduced-motion honored.
- Streaming stays additive: `web:surface_discovered/ready/updated` are NEW StageEvent kinds on top of
  ruke_stage/web:*/web_meta (P2's tool loop remains the ONLY streaming path; evidence block stays 8
  bullets — any bullet edit ⇒ byte-identical mirror + re-record in the same commit).
- P7 warning (still live): rust-golden web fixtures carry live-browser-tier bytes (P3 finding) — suspect
  upstream content first for unexplained drift; never weaken assertions.
