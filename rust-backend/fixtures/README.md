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
| `web-search/` | 5 | `web.test.ts` | 11 success (progress stages+evidence+web_meta+citations; legacy headers), 12 failure non-fatal BOTH shapes (starved sentinel / route catch), 13 image/vision gate ctx (pre-pass DEAD proof) |

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
- `<active_skill>` / `<decision_skill>` bodies are replaced by **anchors** (block sha256 + byte
  length + source-file hashes) so skill-file churn is visible but bodies aren't duplicated;
  Rust must reproduce the composed block byte-for-byte from the same files. Web-evidence blocks
  are kept INLINE (fully deterministic from scripted inputs).
- `writeJsonFixture` fails with a first-diff line on drift: a stale fixture is fixed by
  DELETING it and re-recording — never by hand-editing fixture bytes.
- Replay parity: run the suite twice; the second run compares against the recorded bytes.

## Env preconditions (set by each harness via `setGoldenEnv`)

- `LOG_LEVEL=silent`; `WEB_SEARCH_GATE_DISABLED=1` for every NON-web suite; web suite runs with
  the gate env REMOVED (`webSearchDisabled:false`) so the real gate/pipeline executes.
- `llmApiUrl()/llmApiKey()` mocked to `http://127.0.0.1:9/v1/chat/completions` / `golden-key`
  (unroutable port — the fetch is scripted, never attempted; host text appears in error
  fixtures by design).
- No production env var is read at module-import time in a way that changes these fixtures
  (route loads via `beforeAll` after `setGoldenEnv()`).

## Web-search mock boundary (web.test.ts)

MOCKED (I/O seams only): `lib/web-search/cache` (no sqlite native; deterministic miss, injectable
throw), `lib/web-search/net` (impit never loads; scripted `fetchPage` pages, `fetchUrl=null` kills
local verticals; REAL `isSafeUrl`), `lib/web-search/engines` (SERP table scripted per HARNESS mode:
normal / starved / throw-cache; real `deduplicateQueries` + cooldown kept).
REAL (pure CPU, deterministic): search gate Stage-0 hard bypass, query planner, metasearch RRF +
relevance floor + freshness recovery, extractor tier cascade (fetchUrl-null path), BM25 reranker,
coverage/gap logic. The evidence block bytes therefore derive ONLY from scripted SERP + pages.

## Pinned contract discoveries (Part 2; production TS left EXACTLY as-is)

1. `confidence` serializes as integer `1` (JS) — serde_json `f64` writes `1.0`. Part 4's
   serializer MUST emit `1` (or record an explicit deviation). `lfm_input`/`lfm_raw` are
   **omitted**, never null.
2. Injection-index off-by-one family: web-evidence, attachment-retrieval and (with no skill
   block) the evidence block land at `lastUserIdx + 1` → system block AFTER the user turn
   (fixture `web-search/01` pins roles `["user","system"]`; `attachments/01,04,06` pin their
   variants; `attachments/05` pins the skill-shifted-correct path). RECORDED, not fixed (§8).
3. `runVisionEntityPrepass` is DEAD code (zero call sites); the route's "vision pre-pass" comment
   is fiction. Image data URLs feed ONLY the gate context. `upstreamCalls.length===1` in
   `web-search/05` proves no vision hop.
4. Evidence block layout quirk: `</evidence>` closes the guideline header BEFORE the `[S#]`
   source lines + quoted excerpts; `buildMainModelContext` prepends `ANTI_REFUSAL_DIRECTIVE +
   "\n\n"` whenever passages exist — the block NEVER starts with `<evidence>`.
5. Two distinct web-failure shapes: starved engines → pipeline returns NON-NULL empty bundle →
   exact sentinel `"No web evidence could be retrieved. Proceed with your knowledge only."`
   injected, NO web_meta, NO citation headers (`web-search/03`); internals THROW → route catch
   swallows, NO block at all (`web-search/04`). Both fully non-fatal.
6. `web_meta` arrives as a **stage frame** (`stage:"web_meta"`) AFTER `web:done`, NOT a data
   frame; legacy path surfaces the same metadata ONLY via `X-Web-Citations`/`X-Search-Gate`
   (`encodeURIComponent(JSON)`), only when citations are non-empty.
7. `metasearch()` leaves an uncleared 15 s hard-cap `setTimeout` after every call (delays vitest
   worker exit; harmless) — Part 6 port must still honour the 15 s cap semantics.
8. Gate regexes `KNOWN_SITE_TOKEN_RE`/`DOMAIN_TLD_TOKEN_RE` in `search-gate.ts` are defined but
   unreferenced (dead).
9. `POST /api/decision` guard makes `fallbackEnvelope` (`in-process-fallback`) unreachable
   publicly — internal-only (chat empty-turn path); Rust must keep it internal.
10. Gate under hard-bypass never invokes the main model (gateMs 0, `decidedBy
    "deterministic"`) — the "gate is a main-model call every turn" perf note (§8) applies only
    to non-bypass turns.

## Known gaps (recorded, not skipped)

- `whole_video` note path + exhaustive-retrieval mode not exercised by fixtures (prompt shapes
  don't reach them; Part 6 re-records against Rust with the same harness if needed).
- `sourceClass`/`extractEntities` internal outputs pinned only indirectly through fixtures.
- Tier-3b/browser-tier of the extractor is neutralized by the net mock (no browser in Part 2).
- RESOLVED 2026-10-26 (was: pre-existing chatEngine 2/7 red): the interactive/internal
  browser subsystem was removed repo-wide (architecture change pending; see
  `reverse-engineering/internal-browser/`). The two `chatEngine.test.ts` expectations
  were updated to pin the removal (`## Browser agent` block asserted ABSENT, length 0).
  Suite 7/7 green; golden replay unaffected (fixtures byte-identical).

## Regenerating

```
npx vitest run __tests__/rust-golden            # replay (fails on drift, first-diff printed)
rm -rf rust-backend/fixtures/<dir> && npx vitest run __tests__/rust-golden/<suite>   # re-record a suite
```
