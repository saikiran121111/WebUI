# Golden-Contract Fixture Corpus (RUKE Next.js → Rust migration, Part 2)

Deterministic TypeScript **wire-contract baseline** that every Rust port part must match.
Recorded exclusively from the CURRENT TypeScript implementation (`app/api/chat/route.ts`,
`app/api/decision/route.ts`) driven in-process by vitest against a **scripted mock upstream**
(`__tests__/rust-golden/support/golden.ts`) — the corpus reproduces on any machine WITHOUT a
live Strata backend and without Playwright.

## Layout (§5)

| Dir | Count | Harness | Frozen §6 scenarios |
|---|---|---|---|
| `chat/` | 11 | `__tests__/rust-golden/chat-core.test.ts` | 1 streaming, 2 legacy non-streaming, 3 malformed passthrough, 4 empty/minimal (04a/04b/04c), 5 compaction passthrough, 6 decision_mode (06a legacy / 06b progress), 16 client abort, 10 web-search disabled |
| `errors/` | 8 | `errors.test.ts` | 14 upstream 4xx/5xx (legacy+progress each), 15 unreachable upstream (legacy+progress) incl. empty-body branch |
| `sse/` | 3 | `sse-vectors.test.ts` | 17 frame-split boundaries, 18 UTF-8 split matrix, 19 `<think>` split-at-every-byte matrix (incl. unterminated) — 02/03 are **approved-deviation** |
| `skills/` | 5 | `skills.test.ts` | 6 slash skill (progress+legacy), unknown-slash passthrough, core-tier via decision, decision_mode excel passthrough |
| `decision/` + `serialization/` | 6 | `decision-serialization.test.ts` | envelope bytes + per-field comparison ledger |
| `attachments/` | 6 | `attachments.test.ts` | 8 retrieval success, failure non-fatal (02/03), video keyframe paths (04/05), legacy parity (06) |
| `web-search/` | 5 | `web.test.ts` | **RE-SCOPED 2026-11-05 (MHR-A..D):** 1 model-directed research (model calls web_search → read_page → answer; tool-message grammar + ledger-gated web_meta), 2 legacy stream:false PLAIN forward (no tools/evidence/headers), 3 starved pool honest empty envelope, 4 search-budget exhausted honest refusal, 5 image parts passthrough + loop ARMED-unused (vision pre-pass DEAD proof) |

Every fixture embeds an inline `_meta` block: originating harness, scenario, expected
semantics, **comparison class**, env preconditions, normalization notes.

## Comparison classes

- **byte-exact** — response bytes must match verbatim (legacy path, decision envelope, error bodies).
- **structural** — logical SSE frames + parsed upstream payload must match; volatile fields normalized.
- **semantic** — behavioral ledgers (serialization field table).
- **approved-deviation** — fixture ALSO records the *expected Rust* output where current TS is
  knowingly buggy (`sse/02` think split, `sse/03` UTF-8 split; MIGRATION-MAP Rule 4). The Rust
  port conforms to the recorded `expectedRust*` values, not to the mangled TS bytes.

## Determinism & normalization rules

- Stage-event `ms` timing digits are replaced with `"<ms>"` (`normalizeBodyMs` / `normalizeMs`).
  Progress-path response bodies are ms-normalized; **logical frames are the contract**, never
  TCP chunk boundaries — the sole exception is the sse 02/03 matrices, which deliberately
  document boundary-dependent buggy behavior.
- MHR (2026-11-05) web corpus volatile masking: per-turn random session ids mask to `ws-<sid>`
  (searchSessionId + ledger ids `ws-<sid>-aN`) and action-ledger ISO stamps mask to
  `"at":"<volatile-at>"` — applied to upstream bodies AND response text before parsing.
  `publishedDate`/`publishedAt` are NEVER masked (real fixture content).
- `<active_skill>` / `<decision_skill>` bodies are replaced by **anchors** (block sha256 + byte
  length + source-file hashes) so skill-file churn is visible but bodies aren't duplicated;
  Rust must reproduce the composed block byte-for-byte from the same files. Web-evidence blocks
  are kept INLINE (fully deterministic from scripted inputs).
- `writeJsonFixture` fails with a first-diff line on drift: a stale fixture is fixed by
  DELETING it and re-recording — never by hand-editing fixture bytes.
- Replay parity: run the suite twice; the second run compares against the recorded bytes.

## Env preconditions (set by each harness via `setGoldenEnv`)

- `LOG_LEVEL=silent`; `WEB_SEARCH_GATE_DISABLED=1` for every NON-web suite; web suite runs with
  the gate env REMOVED (`webSearchDisabled:false`) so the web pipeline primitives execute.
  Post-MHR-C the chat route never consults the gate at all (the env var is a kill switch for the
  tool loop); the gate still serves the `app/api/search` surfaces.
- `llmApiUrl()/llmApiKey()` mocked to `http://127.0.0.1:9/v1/chat/completions` / `golden-key`
  (unroutable port — the fetch is scripted, never attempted; host text appears in error
  fixtures by design).
- No production env var is read at module-import time in a way that changes these fixtures
  (route loads via `beforeAll` after `setGoldenEnv()`).

## Web-search mock boundary (web.test.ts)

MOCKED (I/O seams only, post-MHR 2026-11-05): `lib/web-search/cache` (no sqlite native;
deterministic miss-only), `lib/web-search/net` (impit never loads; scripted `fetchPage` pages,
`fetchUrl=null` kills local verticals; REAL `isSafeUrl`), `lib/web-search/engines` (SERP table
scripted per HARNESS mode normal / starved; an `ENGINE_CALLS` counter lets fixtures PROVE zero
search traffic; real `deduplicateQueries` + cooldown kept), `lib/web-search/ssrf` (ONLY the DNS
leg of `isSafeUrlWithDns` replaced — real node:dns would run on the always-armed tool chain;
literal classification REAL via `actual.isSafeUrl`), `lib/web-search/agentBrowser` (scripted
browser tier — P7 hermeticity; every unlisted URL is a deterministic miss).
REAL (pure CPU, deterministic): tool dispatch + budget gate + action ledger + citation minting,
metasearch RRF + relevance floor, extractor tier cascade (fetchUrl-null path), BM25 reranker.
The CHAT path runs no gate/planner prefetch at all — the MAIN MODEL (scripted upstream, MHR-G
mock caveat) chooses web_search/read_page; retrieval bytes therefore derive ONLY from scripted
SERP + pages via tool envelopes.

## Pinned contract discoveries (Part 2; production TS left EXACTLY as-is)

1. `confidence` serializes as integer `1` (JS) — serde_json `f64` writes `1.0`. Part 4's
   serializer MUST emit `1` (or record an explicit deviation). `lfm_input`/`lfm_raw` are
   **omitted**, never null. **RESOLVED in Part 3 (2026-10-26):** `ruke-decision` ships a
   narrow JS-compatible number serializer (integral f64 → `1`) and skips `lfm_*`; the
   decision 01–05 replays in `crates/ruke-decision/tests/fixture_replay.rs` are byte-exact
   against these fixtures — no fixture or serializer deviation was needed.
2. Injection-index off-by-one family: attachment-retrieval blocks land at `lastUserIdx + 1` →
   system block AFTER the user turn (`attachments/01,04,06` pin their variants; `attachments/05`
   pins the skill-shifted-correct path). RECORDED, not fixed (§8). The web-evidence half of this
   family is SUPERSEDED 2026-11-05 (MHR): chat turns inject NO evidence block;
   `web-search/01` now pins roles `["system","user","system"]` (guidance first, clock last).
3. `runVisionEntityPrepass` is DEAD code (zero call sites); the route's "vision pre-pass" comment
   is fiction. `upstreamCalls.length===1` in `web-search/05` (parts passthrough, loop ARMED but
   unused) proves no vision hop — and simultaneously zero engine legs (ENGINE_CALLS=0).
4. Evidence block layout quirk (gate-era): SUPERSEDED 2026-11-05 (MHR-C) on the chat path — no
   evidence block is ever injected there. The quirk (`</evidence>` closing the guideline header
   before `[S#]` lines; `ANTI_REFUSAL_DIRECTIVE` prefix) applies only where the gate pipeline
   still runs (`app/api/search` surfaces).
5. Web-failure honesty (rewritten 2026-11-05, MHR-A..D — supersedes the sentinel-prefetch
   family): there is no prefetched bundle and no injected "No web evidence" sentinel on chat
   anymore; honesty lives in the TOOL ENVELOPE the model itself called. Starved pool ⇒
   `ok:true, results:[], resultCount:0` recorded in the ledger with `retrieved:0`
   (`web-search/03`). Budget spent ⇒ `ok:false, error:"budget_exhausted"` + detail +
   remainingBudget; the refused target is named by the action LEDGER (`ok:false` record with the
   refused queries), NEVER echoed in the envelope (error envelopes never repeat model args)
   (`web-search/04`). Both fully non-fatal; zero error frames. (History: the old gate-era
   sentinel string — reworded 2026-11-05 morning, research-depth audit — now belongs only to
   surfaces that still run the gate pipeline; both old fixtures were regenerated from the live
   TS oracle, never hand-edited.)
6. `web_meta` arrives as a **stage frame** (`stage:"web_meta"`), LEDGER-GATED (WS18): one per
   tool round whose action ledger grew, immediately after that round's `web:tools` census frame,
   plus one completion snapshot (OVERWRITE law) — `web-search/01` pins the interleaved frame
   order. The `X-Web-Citations`/`X-Search-Gate` header pair is GONE from EVERY chat response:
   the legacy stream:false path is a PLAIN FORWARD (`web-search/02`) — headers, stage frames,
   tools and evidence are all absent there.
7. `metasearch()` leaves an uncleared 15 s hard-cap `setTimeout` after every call (delays vitest
   worker exit; harmless) — Part 6 port must still honour the 15 s cap semantics.
8. Gate regexes `KNOWN_SITE_TOKEN_RE`/`DOMAIN_TLD_TOKEN_RE` in `search-gate.ts` are defined but
   unreferenced (dead). (Post-MHR-C the whole gate is OFF the chat path; it still serves
   `app/api/search`.)
9. `POST /api/decision` guard makes `fallbackEnvelope` (`in-process-fallback`) unreachable
   publicly — internal-only (chat empty-turn path); Rust must keep it internal.
10. Gate under hard-bypass never invokes the main model (gateMs 0, `decidedBy
    "deterministic"`). SUPERSEDED on chat 2026-11-05 (MHR-C): chat runs NO gate model call
    EVER — zero gate hops per turn (the `web-search/*` fixtures' single-fetch upstream proofs
    cover this); the perf note now applies only to `app/api/search` surfaces.

## Known gaps (recorded, not skipped)

- `whole_video` note path + exhaustive-retrieval mode not exercised by fixtures (prompt shapes
  don't reach them; Part 6 re-records against Rust with the same harness if needed).
- `sourceClass`/`extractEntities` internal outputs pinned only indirectly through fixtures.
- Tier-3b/browser-tier of the extractor is SCRIPTED via the `agentBrowser` mock (P7 hermeticity
  fix 2026-11-02 — no live Chromium; unlisted URLs are deterministic misses).
- RESOLVED 2026-10-26 (was: pre-existing chatEngine 2/7 red): the interactive/internal
  browser subsystem was removed repo-wide (architecture change pending; see
  `reverse-engineering/internal-browser/`). The two `chatEngine.test.ts` expectations
  were updated to pin the removal (`## Browser agent` block asserted ABSENT, length 0).
  Suite 7/7 green; golden replay unaffected (fixtures byte-identical).

## Part-4 Rust replay status (chat / errors / sse) — 2026-10-26

- **sse/02 + sse/03 approved deviation: RESOLVED.** The Rust scrubber
  (`crates/ruke-server/src/chat/scrubber.rs`) reproduces the atomic `expectedRust*` vectors at
  EVERY recorded split point and under byte-at-a-time feeding
  (`crates/ruke-server/tests/scrubber_vectors.rs`, 2/2 green); the mangled TS bytes are never
  reproduced. The replay additionally forced a holdback refinement: only the longest tail that
  is a *proper prefix* of a tag is held (a fixed `len(tag)-1` holdback stalls literal tail bytes
  of a final SSE frame when the upstream goes quiet before EOF — chat/07 pinned the stall; the
  atomic output is identical either way).
- **chat/ replay:** `crates/ruke-server/tests/golden_replay.rs` 19/19 — byte-exact bodies plus
  byte-identical forwarded upstream bodies for all success fixtures; 06a/06b reproduce the
  recorded `<decision_skill …>` block byte-for-byte from the repo's real `.cskills`; chat/07
  (semantic fixture) replays over a REAL socket: client drop ⇒ upstream-abort witness +
  inference-slot release; frames before the abort equal `logicalFramesBeforeAbort`.
- **errors/ replay:** all 8 assert the FULL application header set + body; the scripted upstream
  error text is DERIVED from each fixture's recorded contract string, never retyped.
  - **No-body class:** undici recorded `body === null`; the Rust replay scripts **HTTP 204**
    (the real-HTTP no-body status — the route maps 204/205/304 ⇒ 502). A `200` with
    `content-length: 0` HAS a body (empty stream) and must NOT become 502 (pinned in
    `forward.rs`).
  - **content-length handling:** the recorded header maps are the *application-level* set
    `NextResponse.json` exposes — `content-type` only. axum 0.8's top-level route future injects
    a `content-length` from the body's exact size hint (hyper likewise derives one from a
    known-length body), so the Rust `json_error` presents its body as a one-frame stream: the
    hint is unknown, the recorded set matches verbatim, and the wire framing (chunked here vs
    content-length on Node's socket) is semantically identical to any fetch client. No fixture
    was modified for this.
  - **unreachable pair:** the Rust replay genuinely connects-refuses to `127.0.0.1:9`; the
    fixture's `upstreamCalls` metadata was stubbed by the TS harness (fetch never attempted), so
    the replay asserts the response contract there and not the stubbed call metadata.

## Part-5 Rust replay status (attachments) — 2026-10-27

- **Reworded 2026-11-05 (P3a record-honesty law):** the attachment rules and the
  keyframe lead-in no longer claim a perception channel the model does not have
  ("You have watched this video from start to finish" / "You have heard this
  recording directly" → "You are given this video's/recording's complete saved
  record"; "part of the video you watched" → "come from the video's saved
  record"). Fixtures 04/05 were RE-RECORDED from the live TS oracle (deleted +
  suite rerun, never hand-edited). `attachments/store/` bytes were NOT touched —
  turn text is not part of the on-disk index — and the store drift guard passed.
  `attachment_replay` 6/6 and `store_compat` 6/6 are byte-exact against the
  re-recorded fixtures; ruke-attach and TS `rules()` stay byte-identical.

- **attachments/01–06: GREEN.** `crates/ruke-server/tests/attachment_replay.rs` (6/6) replays
  every fixture through the FULL Rust chat pipeline (`POST /api/chat` on the library router):
  `assert_response` (status, full header set, ms-normalized or byte-exact body, logical frames —
  `retrieval`/`retrieval_done {1,1}` / `{0,0}` semantics pinned) and `assert_upstream_call`
  (BYTE-IDENTICAL forwarded body ⇒ the strip, the recorded `lastUserIdx+1` injection quirk
  orders, the time_range header, and the keyframe `data:image/jpeg;base64,…` part all match TS
  verbatim). Fixture 06 (legacy path) replays byte-exact.
- **Cross-language store compatibility (§27):** `attachments/store/<attId>/` commits the EXACT
  bytes the PRODUCTION Node writer (`writeIndex`) puts on disk (`meta.json` pretty 2-space,
  `chunks.jsonl` + trailing newline, `full.txt`, `frames/`); `att_golden1b` is intentionally
  absent (fixture 02 = missing index). Seeds are shared with `attachments.test.ts` via
  `__tests__/rust-golden/support/attach-seeds.ts` — the replay fixtures and the store bytes MUST
  seed identically. `crates/ruke-server/tests/store_compat.rs` (6/6) copies them VERBATIM into a
  temp root and compares Rust's parsed index + injected block against the TS oracle; Rust never
  reconstructs or edits these bytes.
- **Regen (re-record) command:**
  `RUKE_WRITE_STORE_FIXTURE=1 npx vitest run __tests__/rust-golden/store-fixture.test.ts`
  (from the repo root; seeds via the production writer, copies the tree byte-for-byte, then
  removes the scratch store). The default run is the DRIFT GUARD: regenerates and byte-compares
  every committed file. If it fails because the writer or seeds intentionally changed: DELETE
  `attachments/store/` and re-record — NEVER hand-edit these bytes. Re-record replay fixtures in
  the same pass (seeds changed ⇒ fixtures change with them).
- Embedding seam on both sides: fixed pseudo-vector `[1,0,0.05]` (TS `vi.mock embedOne` ↔ Rust
  `FixedEmbedder`) — the embedding model is not a wire contract; no second model is added.
- Part-4 corpus re-verified alongside (golden_replay 19/19, scrubber 2/2) — attachment wiring did
  not regress chat/errors/sse fixtures.

## Regenerating

```
npx vitest run __tests__/rust-golden            # replay (fails on drift, first-diff printed)
rm -rf rust-backend/fixtures/<dir> && npx vitest run __tests__/rust-golden/<suite>   # re-record a suite
RUKE_WRITE_STORE_FIXTURE=1 npx vitest run __tests__/rust-golden/store-fixture.test.ts  # re-record attachments/store bytes
```
