//! In-process Decision Engine port (Part 3) — oracle: `lib/decision/client.ts`,
//! `lib/decision/contracts.ts`, and the block builder of
//! `lib/decision/skill-loader.ts`.
//!
//! PARITY PORT, NOT A REDESIGN: same intent regexes (converted to explicit
//! ASCII word-boundary classes because Rust `\b`/`\w` are Unicode while JS
//! are ASCII), same first-match precedence, same envelope construction, same
//! `<decision_skill>` composition.
//!
//! NOT CUT OVER: `app/api/decision/route.ts` and the chat route still serve
//! live traffic; nothing outside tests and the (not-yet-wired) Rust server
//! calls into this crate. See `rust-backend/MIGRATION-MAP.md` §10.

pub mod contracts;
#[doc(hidden)]
pub mod contracts_generated;
pub mod engine;
pub mod skill_block;
