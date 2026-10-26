//! `ruke-websearch` — PART 6 of the Rust backend migration: a PARITY port
//! of `lib/web-search/` (no redesign, no "improvements"; TypeScript quirks
//! are recorded in module docs, not fixed).
//!
//! Ownership split across the Part-6 work packages (placeholder modules
//! carry an `OWNER:` doc line; W0 shipped the shared substrate + seams):
//! - **W0 (this crate, shipped):** `types`, `ssrf`, `net`, `url_detector`,
//!   `llm_json`, `cache`.
//! - **W2:** `engines`, `metasearch`, `reranker`, `query_planner`, `search_gate`.
//! - **W3:** `extractor`, `schema_extract`, `hydration_unpacker`,
//!   `charset_normalizer`, `universal_extractor`.
//! - **W4:** `platform_api`, `redirect_unwrap`, `google_maps`, `youtube`,
//!   `vision_prepass` (dead-code proof per fixtures README discovery #3),
//!   and the real `browser_bridge` client.
//! - **Part 6 integration owner:** `pipeline`.
//!
//! Mock boundary (mirrors `rust-backend/fixtures/README.md` §"Web-search
//! mock boundary"): the I/O seams are [`net::Net`] (scripted `fetch_page`
//! pages, `fetch_url = None` kill switch for local verticals),
//! [`cache::SearchCache`] (deterministic miss + injectable throw), and the
//! engine SERP table (W2's scripted seam). Everything pure — `ssrf::is_safe_url`,
//! dedup, RRF, reranking — runs REAL in fixture replays.

// ── W0 (shipped) ─────────────────────────────────────────────────────────
pub mod cache;
pub mod llm_json;
pub mod net;
pub mod ssrf;
pub mod types;
pub mod url_detector;

// ── Tier-3b browser-read RPC contract (placeholder; lands in W4 with the
//    extractor integration)
pub mod browser_bridge;

// ── W2 (planned placeholder files compile; modules land in W2's pass) ────
pub mod engines;
pub mod metasearch;
pub mod query_planner;
pub mod reranker;
pub mod search_gate;

// ── W3 ───────────────────────────────────────────────────────────────────
pub mod charset_normalizer;
pub mod extractor;
pub mod hydration_unpacker;
pub mod schema_extract;
pub mod universal_extractor;

// ── W4 ───────────────────────────────────────────────────────────────────
pub mod google_maps;
pub mod platform_api;
pub mod redirect_unwrap;
pub mod vision_prepass;
pub mod youtube;

// ── Part-6 integration (chat-pipeline glue; owned by the Part-6 integrator)
pub mod pipeline;
