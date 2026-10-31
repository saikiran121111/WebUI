//! # ruke-browser — the Browser Use engine
//!
//! Layering (RUKE-IMPLEMENTATION-PLAN §0):
//! - `contract` (Phase 1): the closed command vocabulary registry, the
//!   command envelope (turn-metadata rule verbatim from the recovered
//!   contract: the metadata-missing error enumerates the missing keys),
//!   and the typed dispatch of every command to its payload schema.
//! - `schemas` (Phase 1): typed payloads mirroring the recovered zod
//!   shapes (gk/yk/qR/$R/p1/VR/…) and the api.json option surfaces,
//!   plus the AX action union (click/drag/paste/press_key/scroll/
//!   select_text/set_value/type_text/perform_secondary_action).
//! - `errors` (Phase 1): typed `BrowserError` with the recovered
//!   model-facing strings kept verbatim where they are behavioral
//!   contracts (staleness, click-failure, JS-dialog interrupt,
//!   input-prepare timeout) and the four blocked codes verbatim
//!   (`browser_security_unavailable`, `browser_capability_blocked`,
//!   `browser_context_unavailable`, `webmcp_disabled`).
//! - Host/session/tab lifecycle, CDP bridge, DOM CUA, AX, locators,
//!   input/dialogs/files, security: Phases 2–9 (added as modules).
//!
//! Every production string in this crate is either recovered evidence
//! or explicitly marked `[adapted]` (a documented behavioral equivalent
//! at the native boundary). No placeholders, no fixture knowledge.

pub mod auth_handoff;
pub mod authority;
pub mod ax;
pub mod ax_action;
pub mod cdp;
pub mod cdp_buffer;
pub mod contract;
pub mod dom_cua;
pub mod engine;
pub mod errors;
pub mod executor;
pub mod host;
pub mod io_state;
pub mod pw;
pub mod schemas;
pub mod session;
pub mod tools;
pub mod ui;
