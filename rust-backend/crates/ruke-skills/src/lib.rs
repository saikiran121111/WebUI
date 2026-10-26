//! Rust port of the TS two-tier skill engine.
//!
//! Oracle sources (frozen, NOT modified by this port):
//! - `lib/skills/registry.ts`  -> [`registry`]  (user tier: names, scenarios, bundles)
//! - `lib/skills/lazy.ts`      -> [`lazy`]      (slash-command routing, §11 helpers)
//! - `lib/decision/skill-loader.ts` (core half) -> [`core_skill`] (.cskills bundles)
//!
//! Parity rules: identical regexes, identical caps, identical
//! swallow-IO-errors-means-null semantics. Length/cap arithmetic runs in
//! UTF-16 code units because JS `String.length`/`slice`/`lastIndexOf` do —
//! see [`jsstr`]. All loading is uncached (the TS reads files fresh per
//! call), matching Part-3's sync near-zero-latency requirement.

pub mod core_skill;
pub mod jspath;
pub mod jsstr;
pub mod lazy;
pub mod registry;
