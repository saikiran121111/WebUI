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
| P6 | Safety: SSRF/DNS-rebinding/redirect revalidation, secret scrub, untrusted-data laws, wall law, §19 provenance | **CLOSED** (this commit — details below) |
| P3 | Retrieval quality: freshness classes, TTL/RetrievalMode, wiki cap, normalize/dedupe, dynamic segment filtering; preserve structured metadata for P5 | pending |
| P2 | Model tools: `web_search`/`read_page`, kill `searchMoreStub`, gap loop, RetrievalFailure taxonomy, budgets, tool/result envelopes | pending |
| P4 | Planner: query schema/domain semantics/decomposition, evidence sufficiency, bounded Deep, PresentationPlan router | pending |
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

## Next-up contract reminders (carried into P3+)
- §11 planner contracts (SearchCandidate, RetrievalMode, RetrievalFailure, budgets, dynamic-filter law) land in P3/P2 per the mapping in the parity doc §11.24.
- Addendum binding for P3: retrieval must PRESERVE structured result metadata (JSON-LD facts: price, currency, rating, availability, hours, poster) — the P5 `RichResult` envelope consumes tool/retrieval data, never model-fabricated UI values.
- Evidence block = 8 bullets; any bullet edit ⇒ TS+Rust byte-identical + fixture re-record in the same commit.
