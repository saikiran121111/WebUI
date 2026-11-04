//! Part 7: `lib/server/titles/**` — server-owned conversation titles.
//!
//! - [`policy`]      → policy.ts   (ownership, refresh eligibility, guarded write)
//! - [`transcript`]  → transcript.ts (chronological capped transcript)
//! - [`generate`]    → generate.ts (title plan via the MAIN model, map-reduce for long docs)
//! - [`queue`]       → queue.ts    (global serial chain, per-conversation
//!   coalescing, slot-aware yield, bounded retries)
//!
//! Micro-divergences are recorded per module. The big ones: the
//! non-object-`meta` strict-mode TypeError becomes a propagated Err with the
//! SAME route status (500); the `chain` serial-queue check-and-remove is made
//! atomic under the entries lock; task panic surfaces as the TS "no-job"
//! shape instead of a 500 (recorded in [`queue`]).

pub mod generate;
pub mod policy;
pub mod queue;
pub mod transcript;
