//! Server-state foundation shared by every migrated route.
//!
//! - [`config`] — Rule 13: repo-relative paths resolve from an EXPLICIT
//!   project root, never from the process cwd.
//! - [`settings`] — parity port of `lib/server/settings.ts` (mtime-gated
//!   cache, corrupted-file behavior, atomic tmp+rename write).
//! - [`slot`] — parity port of `lib/server/inference-busy.ts`: one
//!   inference slot accounting with title-job aborts; Rule 6 exactly-once
//!   turn release via RAII guard.
//! - [`turn`] — Rule 6 cancellation hierarchy: one root token per
//!   request/turn, every child work token derived from it, plus the Rule 17
//!   turn-id tracing span.
//!
//! Rule 16: no lock is ever held across an `.await` — every critical
//! section here is a synchronous `parking_lot` guard that is dropped
//! before any await point (see `slot.rs`, which collects handles under the
//! lock and cancels after releasing it).

pub mod config;
pub mod settings;
pub mod slot;
pub mod turn;
