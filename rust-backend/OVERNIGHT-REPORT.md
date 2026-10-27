# RUKE Next.js→Rust Migration — Overnight Run Report (Parts 6–8)

Run date: 2026-10-27 (evening → overnight). Unattended run per the user brief: Parts 6→7→8 executed
sequentially, each gated (tests → docs → commit); NO Playwright at any point; STOP before Part 9.

> # ⛔ USER MANUAL REGRESSION CHECKPOINT
>
> **Manually regression-test RUKE Part 8 before anything else. DO NOT START PART 9.**
>
> Part 8 flips the live `npm run dev` topology (Next delegates to the Rust backend when the
> supervisor arms it). Automated gates prove route/JSON parity, but the interactive product
> surface — streaming chat through the proxy, cancel mid-stream, the browser-read bridge with a
> real Playwright pool — has NOT been exercised in a browser this run (no Playwright allowed).
> That exercise is the user's manual regression pass. Part 9 must not begin until it passes.

---

## 1. Starting state

- Incoming HEAD: `08feb45` (Part 5 era). Parts 1–5 DONE and locked (see `MIGRATION-MAP.md` part
  table); ruke-websearch crate FROZEN; chat SSE transport, upstream client, `skills`/`attach`
  cores and the decision engine already ported.
- Live TS oracles (`app/api/**`, `lib/**`) intact (Rule 18). User's pre-existing `next dev` server
  on :3000 (pid 5672, started 2026-10-27 11:08:56 — pre-session) left untouched all run.

## 2. Part statuses & commits

| Part | Scope | Status | Commit |
|---|---|---|---|
| 6 | Web-search pipeline port (ruke-server seam: search/search-more services on top of the frozen ruke-websearch crate; google-maps/youtube evidence modules, extractor cascade already in) | **DONE** | `00597ba` |
| 7 | Server state services to Rust: settings, conversations CRUD + title policy/queue, model-stats, skills registry/install, attach-notes, persistence (disk/merge), titles generator — all parity-pinned against TS oracles | **DONE** | `7e405b5` |
| 8 | Thin-proxy cutover + unified `npm run dev` lifecycle + Windows process supervision + Tier-3b browser-read RPC seam + chat web-research seam LIVE in Rust | **DONE** | `33b5a85` |

Gate trail per part: full gate block (vitest + tsc + cargo test + clippy) → docs updated
(MIGRATION-MAP row + STATE.md session block) → commit. All three parts completed their gates
before the next began.

## 3. What Part 8 actually puts in motion (the thing to regression-test)

- **`npm run dev` = `scripts/dev-supervisor.mjs`** — spawns `ruke-server.exe` (loopback
  `:RUKE_BACKEND_PORT`, default 3101) and `next dev` (`:PORT`, default 3000) as DIRECT children
  (Rule 12), pre-checks both ports with a wildcard bind, fails fast (exit 1, no orphans) if held,
  generates a random per-run bridge secret, hands off env (`RUKE_RUST_BACKEND=1` arms the Next
  side; `RUKE_PROJECT_ROOT`, `RUKE_BACKEND_PORT`, `RUKE_BROWSER_BRIDGE_BASE_URL/SECRET` for the
  Rust side), and on Ctrl+C / child death tears down with `taskkill /PID <pid> /T /F` cascades.
  Prereq: the binary must exist — supervisor prints the exact `cargo build --manifest-path
  rust-backend/Cargo.toml` command if missing. Plain `next dev` (TS-only mode) preserved as
  **`npm run dev:next`**.
- **Thin proxy `lib/server/rustProxy.ts`** — every migrated handler in the 14 `app/api/**` route
  files (20 handlers: chat, search, search-more, decision, settings GET/PUT/DELETE, model-stats,
  conversations family, attach notes, skills family) early-forwards to Rust ONLY when
  `RUKE_RUST_BACKEND=1`. Unset ⇒ TS handler runs verbatim (vitest goldens, `dev:next`, any
  non-supervisor process). `/api/chat` is proxied to the SAME path on Rust; other plain paths 404
  there (guard test). Streams (SSE) pass through byte-for-byte; hop-by-hop headers filtered both
  legs; client cancel propagates via `req.signal`.
- **Proxy failure stance:** if Rust is unreachable, the route logs and answers an honest 502
  `{"error":"Rust backend unreachable at <base>"}` — there is deliberately NO silent TS fallback
  (one turn must never span two backends; a half-TS/half-Rust turn is worse than a clean 502).
- **Tier-3b bridge:** `ruke-server`'s `HttpBrowserBridge` POSTs `{url,timeoutMs?}` +
  `x-ruke-internal-secret` to `app/api/internal/browser-read` on the Next origin; the Next route
  answers with the live `extractPageInOnePass` (SSRF guard chain re-runs on the Next leg; Rust
  pre-validates too). Without the supervisor env pair the Rust side runs `NoBrowserBridge` and
  vertical/browser evidence degrades to zeroed results — by design, with a boolean-only log line
  (Rule 17: secret never logged).

## 4. Automated checks actually executed (all from the Part-8 tree)

| Check | Command | Result |
|---|---|---|
| Rust unit/integration | `cargo test --manifest-path rust-backend/Cargo.toml --workspace` | **548 passed / 0 failed**, exit 0 (final rerun from the COMMITTED tree; binaries per-crate: 44, 8, 19, 11, 9, 98, 0, 6, 19, 2, 6, 52, 274) |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0, clean |
| Rust build | `cargo build` | debug exe produced (`ruke-server.exe`, used by smokes) |
| TypeScript | `npx tsc --noEmit` | exit 0 (proves optional-`req` signatures + `duplex:"half"` typing clean) |
| Vitest (TS oracles, env unset ⇒ in-process TS) | `npx vitest run` | **664 passed / 1 skipped**, 63 files, exit 0 (on rerun — see flake note) |
| Lint suites | not run this run (no repo lint gate in the established sequence) | n/a |

**Vitest flake adjudications (×3 total across the run, zero test mutation):** one `web.test.ts`
(Part 4/5 family) and two `chatEngine.test.ts` full-suite 5000 ms timeouts under parallel load;
each standalone-reran green (≈565 ms) and the full suite re-ran green 664/1-skipped. Per the brief,
only a DETERMINISTIC standalone failure would block; these were adjudicated non-deterministic load
flakes. No test was weakened, no golden edited, no production behavior changed to continue.

**Brief compliance:** NO Playwright (`npx playwright test` never invoked; no
`.ai-coordination/playwright.lock` created); Strata `:8080` never contacted (dead-upstream smoke arm
used `127.0.0.1:9`); live user data never written destructively — all binary/conversations smokes
ran against temp `RUKE_PROJECT_ROOT`/`WEBUI_DATA_DIR` dirs; live repo-root `settings.json` and
conversations store were READ-ONLY in smokes (byte-identical comparison used the live TS server as a
read-only oracle); no deleted-module resurrection (no `lib/browser/**`, no :8790/:8791, no Python
router); TS implementations NOT deleted (Rule 18); Parts 9/10 untouched.

## 5. Smoke evidence (curl-only; no Playwright)

**Direct-binary smoke** (temp project root, dead upstream `127.0.0.1:9`, port 3999) — every body
byte-exact vs recorded TS contract: health `{"ok":true,"version":"0.1.0","user_turn_active":false}`;
GET settings; decision 200 chart envelope (snake_case, `confidence:1`,
`decided_by:"in-process-deliverable-match"`) + bad-JSON 400 `{"error":"invalid JSON body"}` +
blank-message 400 `{"error":"message required"}`; search no-q ⇒ `{"results":[]}`; search-more empty
⇒ 400 `{"error":"queries array is required (1-3 string entries)"}`; conversations
`[]`→POST→GET meta→DELETE; model-stats dead-upstream ⇒ `{"ok":false}`; boot log shows the
NoBrowserBridge degrade line.

**Supervisor live smokes:**
1. Die path: pre-spawn refusal — `port 3000 is already in use (next dev (PORT))`, exit 1, no orphans
   (real holder: the user's :3000 server).
2. Custom ports (`PORT=3200 RUKE_BACKEND_PORT=3998`): ready in ~2 s, banner pids/ports correct,
   bridge configured; proxied `GET /api/settings` byte-identical to the live TS control on :3000;
   proxied decision/search 400 arms exact; `:3998` direct health ok; teardown cascade freed both
   ports; ONLY the user's :3000 server remained.
3. (First incidental run on :3001/:3101 after the wildcard-probe fix exposed Next's silent
   3000→3001 fallback — repurposed for the same green evidence: proxied settings byte-identical,
   conversations proxied read, `browser-read` no-secret ⇒ 401 `{"error":"unauthorized"}`.)

**Windows gotchas recorded (fixed/handled):** MSYS `$!` ≠ Windows PID (find real PIDs via
`Get-CimInstance Win32_Process` CommandLine match before `taskkill`); a 127.0.0.1-only port probe
FALSE-PASSES on Windows beside a `0.0.0.0`/`[::]` holder — the supervisor now probes the wildcard
bind the way the listeners actually bind; `next dev` silently falls back to the next port on clash,
which would break the bridge base-URL/proxy-port contract — the pre-spawn refusal is the fix.

## 6. Known deviations & risks (recorded in MIGRATION-MAP §7 / part row)

1. **Supervisor is the ONLY arming path.** `RUKE_RUST_BACKEND=1` must never be set by hand in a way
   that outlives a supervisor session — the proxy has no TS fallback by design. Running `dev:next`
   (or any bare `next dev`) keeps the entire old TS behavior available verbatim.
2. **Honest-502 stance:** if ruke-server is down or the port is wrong, migrated routes 502 with
   `{"error":"Rust backend unreachable at <base>"}` (console.error, not pino — `logger.ts` is
   DELETE_AFTER_PARITY). Expected UX: clean failure, never a partial turn.
3. **NoBrowserBridge degradation** outside the supervisor (e.g. running ruke-server standalone):
   browser-read evidence legs return zeroed results; search still works via non-browser verticals.
4. Recorded micro-divergences (all documented, none user-visible in normal flows): `search?raw=1`
   TS 502-catch unreachable in Rust (infallible `runGeneralWebSearch`); `search-more` `req.signal`
   not wired upstream on either side; TS uncaught throw ⇒ Next-500-HTML vs Rust logged bare-500;
   progress-frame drop possible under a full pump queue (sse.rs note); Rust force-echoes
   `out.url` on the bridge leg.
5. **Cost gate (MIGRATION-MAP §8):** the decision engine is in-process/deterministic, but full
   `/api/chat` turns go to the main model — manual regression will consume inference; keep it to
   the journeys below.

## 7. Recommended manual regression journeys (browser, user-driven)

Prereq: `cargo build --manifest-path rust-backend/Cargo.toml` (or point `RUKE_SERVER_BIN` at an
existing exe). Then `npm run dev` and confirm the supervisor banner + both ports.

1. **Chat SSE end-to-end:** normal message streams (reasoning + content deltas render), stop/cancel
   mid-stream (client cancel propagates through the proxy; no orphaned upstream turn), `<think>`
   scrub renders correctly.
2. **Web-research turn:** a query that opens the web gate — expect `web:<stage>` progress frames,
   citations panel (`x-web-citations`), and a browser-read leg working through the bridge (this is
   the Tier-3b path no curl smoke could reach).
3. **Settings UI:** load + save settings through the proxy (PUT); reload confirms persistence;
   model-stats panel (`live=1` path) works.
4. **Conversations:** create, rename (title generation), switch, delete; refresh persistence.
5. **Skills modal:** list, install (small repo), toggle scenario PATCH, delete.
6. **Attach notes** on an existing attachment.
7. **Lifecycle:** Ctrl+C `npm run dev` → both ports freed (no orphan workers); kill ruke-server
   manually → chat route shows the honest 502, Next UI stays up; `npm run dev:next` → pure-TS mode
   still works.

## 8. Remaining work (NOT done, by brief)

- **Part 9** — do NOT start until the manual checkpoint above passes.
- **Part 10** — Playwright E2E (including REAL Tier-3b browser-pool bridge tests — the one seam
  only mocks covered this run), full-journey regression against the Rust backend, perf re-measure
  vs the §8 baseline, then TS implementation retirement decisions (Rule 18 currently pins them).
- Vitest flake family (web.test/chatEngine 5 s timeouts) remains watch-noted; three adjudications,
  zero mutations. If Part 10's CI shows it deterministically, fix the test budget there, not here.

## 9. Process hygiene

Session-started dev/mock processes: all terminated (taskkill cascades verified; ports 3001/3101/
3200/3998/3999 re-probed free). The user's pre-session :3000 TS server (pid 5672) was NEVER touched
and remains running. Working tree clean at `33b5a85`; fixtures/goldens git-unchanged. This machine
was scheduled to shut down (`shutdown.exe /s /t 60`) after this report; no migration work ran after
that point.
