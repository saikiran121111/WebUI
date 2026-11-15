# DECISIONS — overnight 2026-11-15

- D-001 Work continues on `local` branch at HEAD ec256bd (brief: do not switch to develop). Dirty `tsconfig.tsbuildinfo` preserved untouched.
- D-002 Verbatim brief stored at docs/overnight/SPEC.md (Downloads prompt (11)==(10) byte-identical).
- D-003 Playwright live gate: proceed only under the exclusive launcher + lock. Since Claude Code itself uses the shared Strata endpoint and cannot be relaunched/reproxied unattended, per brief §3.3 the live model gate is recorded BLOCKED if coordination cannot be verified; offline gates (vitest/tsc/cargo/contracts) carry the verification load.
- D-004 Shutdown at end per brief §12 (memory: 2026-11-14 directive). Supersedes 2026-11-06 "machine left running" note in old docs.
- D-005 Never run `cargo fmt --all` (memory); fmt only touched crates.

## D-010 Bridge route is non-streaming-only (2026-11-15)
`/api/ruke/internal/completion` rejects stream:true with 400. Streaming via a polling bridge would re-buffer SSE and break the raw-passthrough law (2026-11-13 §2); instead TS streaming runs ONLY in TS-only mode (Rust mode proxies the whole chat handler, so the two authorities can never race — verified route.ts:573) and takes the process-local permit there.
## D-011 ONE TS door: lib/server/upstream-bridge.ts (2026-11-15)
All TS upstream generations go through sharedUpstreamCompletion/sharedUpstreamStream. Rust mode → loopback bridge route with internal secret headers + timeout_ms queue control (504/503/502 honest statuses; verbatim upstream passthrough). TS-only mode → LocalUpstreamAdmission: capacity-1 FIFO, MAX_WAITERS=4 (same bound as Rust DEFAULT_MAX_WAITERS), cancel-safe, exactly-once release with FIFO hand-off. No mode mixes both authorities.
## D-012 Deadlock law TS mirror (2026-11-15)
Stream permit releases when the response body FULLY drains (wrapBodyReleasing once() on done/error/cancel) — never at headers arrival — strictly before tool executors and helper generations run. Non-ok paths drain then release. Parent never awaits its own child: title/notes/gate calls are sequenced after prior releases, never nested under a held permit.
## D-013 Golden header byte-lock honored (2026-11-15)
Bridge stream fetch sends content-type → authorization → accept, byte-locked to Rust error::upstream_headers, because rust-golden fixtures record header order. Unit stubs were made Response-faithful (headers field) rather than loosening the door.

## D-014 — Lock protocol is filesystem-enforced, fail-safe-liveness (P1.4)
Chose `[File]::Open(CreateNew)` atomic acquire (two launchers can never both hold) over Test-Path/Set-Content races. Holder keeps its handle open with FileShare Read|Write but NO Delete share: a live lock is physically undeletable, so §1.2 "never delete a live foreign lock" is enforced by the OS, not politeness. Fixed-width 512-byte record lets the heartbeat child rewrite in place without truncation. Staleness is PROOF-based only: PID absent, or PID whose process started clearly after the lock (reuse); StartTime unreadable or malformed record ⇒ treated LIVE. Release verifies our runId token before deleting; a replaced lock is warned about and kept. The launcher gains -LockInfo (inspect, exit 3) and -BreakStaleLock (proof-gated), and releases owner-only in finally. Tests never touch Playwright or inference.
