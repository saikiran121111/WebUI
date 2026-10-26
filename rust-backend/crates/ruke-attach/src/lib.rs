//! `ruke-attach` — PART 5 of the Rust backend migration: the attachment
//! READ/RETRIEVAL side of `lib/server/attachindex/`, ported as a parity
//! port (not a redesign) of the current TypeScript.
//!
//! Frozen boundary: the Node process still OWNS extraction, chunking,
//! ONNX embeddings, index BUILD, and writing the index dir. This crate
//! consumes the SAME frozen on-disk format (`<app-root>/.data/attach-index/
//! <attId>/{meta.json, chunks.jsonl, frames/, notes.json}`) with no second
//! index DB and no schema marker (none exists in TS; none added). It owns
//! store READING, BM25/query ranking, retrieval routing, evidence
//! formatting, notes read/write/merge, `buildAttachmentTurn`, and the
//! chat-time orchestration the ruke-server pipeline seam calls.
//!
//! Modules ported 1:1 from `lib/server/attachindex/`:
//! - [`store`] — index/notes disk reads + LRU + atomic notes writes
//! - [`types`] — the frozen read-tolerant index types
//! - [`bm25`] — Okapi BM25 (NO "better" variant substituted)
//! - [`router`] — regex-only query routing (`\b` parity in module docs)
//! - [`format`] — timestamps / sentence clipping helpers
//! - [`retrieve`] — hybrid cosine+BM25 → RRF fusion, budget pack
//! - [`notes`] — lazy per-spine-block course notes (the only throwing path
//!   is [`Cancelled`] ⇔ TS AbortError)
//! - [`turn`] — per-turn evidence assembly (refs, anchoring, blocks,
//!   keyframes). `stripAttachmentRefs` stays SHARED in
//!   `ruke-server::chat::attach` — this crate must not duplicate it.
//!
//! Cross-cutting documented deviations (observable only in unsupported
//! configs; each carries an inline note where it lands):
//! - Index LRU keyed by full dir path (single production root ⇒ same).
//! - Env budgets: unparseable ⇒ NaN like JS `Number()`; negative
//!   `ATTACH_TOP_K` clamps to 0 instead of JS `slice(0, -k)`.
//! - UTF-16 slicing surrogate snaps (head snaps DOWN, tail snaps UP).
//! - `cos`/`bm` position-vs-id indexing quirk reproduced, not fixed.
//! - Query embeddings come from the [`QueryEmbedder`] seam; production
//!   runs [`UnavailableEmbedder`] (Part 8 owns ONNX) ⇔ TS `embedOne`
//!   throw ⇒ empty vec ⇒ BM25-alone ranking.
//! - Frame base64 is hand-rolled standard-alphabet (no base64 crate).

pub mod bm25;
pub mod format;
pub mod notes;
pub mod retrieve;
pub mod router;
pub mod store;
pub mod turn;
pub mod types;

/// The query-embedding seam (`embedOne` in `lib/server/attachindex/
/// embed.ts`). TS runs the real ONNX model at chat time; Part 8 decides
/// how Rust obtains vectors. Until then the production seam returns
/// [`EmbedUnavailable`] and retrieval degrades exactly like the TS
/// `try { queryVec = await embedOne(rq) } catch {}` path: the vector
/// stays empty and BM25 alone ranks (cosine dots become 0.0).
pub trait QueryEmbedder: Send + Sync {
    fn embed_one(&self, text: &str) -> Result<Vec<f64>, EmbedUnavailable>;
}

/// Signal that this embedder cannot produce a vector right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbedUnavailable;

/// Production Part-5 embedder: always unavailable (no second embedding
/// model is downloaded or run on the Rust side).
pub struct UnavailableEmbedder;

impl QueryEmbedder for UnavailableEmbedder {
    fn embed_one(&self, _text: &str) -> Result<Vec<f64>, EmbedUnavailable> {
        Err(EmbedUnavailable)
    }
}

/// Deterministic cross-language test embedder: returns a fixed vector
/// regardless of text (the golden fixtures' recorded `QUERY_VEC`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FixedEmbedder(pub Vec<f64>);

impl QueryEmbedder for FixedEmbedder {
    fn embed_one(&self, _text: &str) -> Result<Vec<f64>, EmbedUnavailable> {
        Ok(self.0.clone())
    }
}

// Convenience surface used by the ruke-server pipeline seam.
pub use crate::notes::{generate_notes, Cancelled, NotesLlm};
pub use crate::retrieve::{retrieve_evidence, Evidence, RetrieveOpts};
pub use crate::router::{route_query, QueryMode, RoutedQuery};
pub use crate::store::{has_index, index_dir, read_index, read_notes, valid_att_id, write_notes};
pub use crate::turn::{anchor_query, build_attachment_turn, collect_attachment_refs, AttachmentRef};
