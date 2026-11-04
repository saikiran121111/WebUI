//! SHARED_CONTRACT wire types. This crate is the single auditable home for
//! the client-visible JSON shapes defined in `rust-backend/MIGRATION-MAP.md`
//! §2 (Rules 5 and 14). Field names, spellings, null-vs-omitted behavior,
//! and serialization order reproduce the TypeScript baselines verbatim:
//!
//! - `lib/decision/types.ts`  → [`decision`]
//! - `lib/types.ts` (StageEvent) + chat route frame helpers → [`stages`]
//! - `lib/server/settings.ts` (SettingsShape) → [`settings`]
//!
//! TS definitions are generated from (or drift-tested against) these types
//! starting in Part 9; until then the golden tests in this crate pin the
//! contract to the TS source-of-truth strings.

pub mod decision;
pub mod settings;
pub mod stages;
