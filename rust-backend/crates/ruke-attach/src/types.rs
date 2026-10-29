//! Mirror of `lib/server/attachindex/types.ts` — READ side only.
//!
//! These are the frozen disk-format types the Node writer produces
//! (`chunks.jsonl` line objects + `meta.json`). Rust never writes an index,
//! so every field is read-tolerant: the format carries no schema/version
//! marker (and Part 5 must NOT add one), so a missing field falls back to
//! the type's natural empty rather than failing the whole read. TS runtime
//! would surface `undefined` and typically throw later (the store's
//! whole-body `try` turns that into `null`); Rust's per-field defaults are
//! a documented deviation that only diverges for files the frozen Node
//! writer cannot produce.

use serde::Deserialize;

/// `IndexChunk` — one line of `chunks.jsonl`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexChunk {
    /// Chunk ordinal. NOTE: this is the chunk's ID, not necessarily its
    /// position in the array — TS `chunks.map(c => c.i)` uses it as the ID
    /// everywhere; retrieve/pack guard on `0 <= i < chunks.len()`.
    pub i: i64,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub text: String,
    #[serde(default)]
    pub vec: Vec<f64>,
}

/// `FrameEntry` — a scene-change keyframe, `file` relative to the INDEX
/// dir (not to `frames/`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FrameEntry {
    pub at: f64,
    pub file: String,
}

/// `SpineBlock` — read for the notes pass (chunk range + degrade
/// opening/closing), never for spine building.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpineBlock {
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    pub chunk_from: i64,
    pub chunk_to: i64,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub opening: String,
    pub closing: String,
}

/// `IndexMeta` — `meta.json`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexMeta {
    pub att_id: String,
    pub name: String,
    pub category: String,
    pub created_at: f64,
    pub duration_sec: Option<f64>,
    pub chunk_count: i64,
    pub spine: String,
    #[serde(default)]
    pub spine_blocks: Vec<SpineBlock>,
    #[serde(default)]
    pub frames: Vec<FrameEntry>,
}

/// `LoadedIndex` — meta + parsed chunks (assembled by the store, never a
/// single JSON object on disk).
#[derive(Debug, Clone, Default)]
pub struct LoadedIndex {
    pub meta: IndexMeta,
    pub chunks: Vec<IndexChunk>,
}
