//! Part 4 chat transport/core — the Rust reproduction of the frozen
//! `POST /api/chat` wire contract (`app/api/chat/route.ts`, oracle frozen
//! per MIGRATION-MAP.md §2; the TS route REMAINS authoritative for live
//! traffic — nothing here is proxied to or from Next, §25/§26).
//!
//! Module map (one responsibility each, mirroring the oracle's regions):
//! - [`handler`] — `POST` body parse, compaction passthrough, decision
//!   gate, path selection (`stream !== false`), common tail.
//! - [`pipeline`] — `runTurnPipeline` + the progress pump orchestration
//!   (`decision_done` frame, skill block, Part-5/6 seams).
//! - [`forward`] — `forwardStream` (legacy) + `forwardStreamInto`
//!   (progress), bounded backpressure, cancellation, the exactly-once
//!   inference-slot guard.
//! - [`scrubber`] — incremental UTF-8-safe `<think>` scrubber implementing
//!   the APPROVED FIX (atomic-scrub semantics; the TS per-network-chunk
//!   bug is NOT reproduced — §10/§21).
//! - [`sse`] — `ProgressChannel`: `ruke_stage`/`ruke_error`/`[DONE]`
//!   grammar with the closed latch.
//! - [`headers`] — `streamHeaders` (application headers).
//! - [`error`] — the exact error contract (upstream status mirror,
//!   502 no-body, 503 unreachable) in both paths.
//! - [`attach`] — payload shape helpers (attachment_ref stripping,
//!   history slicing, order-preserving key removal).
//! - [`answer_release`] — WS06 grounded answer release check: the
//!   server-enforced action/citation/claim audit every web-loop answer
//!   unit passes BEFORE it reaches the client (⇔ TS
//!   `lib/chat/answer-release.ts`; wired by [`web_loop`]).

pub mod answer_release;
pub mod attach;
pub mod browser_loop;
pub mod clock;
pub mod error;
pub mod forward;
pub mod handler;
pub mod headers;
pub mod log_safety;
pub mod next_search;
pub mod pipeline;
pub mod scrubber;
pub mod sse;
pub mod web_loop;

pub use handler::chat_post;
