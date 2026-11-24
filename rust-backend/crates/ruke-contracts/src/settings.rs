//! Typed view of `settings.json` (mirror of `SettingsShape` in
//! `lib/server/settings.ts`). The STORE (ruke-core) keeps the raw
//! `serde_json::Map` so unknown fields survive merge/write exactly like the
//! TS spread (`{...readSettings(), ...patch}`); this typed view documents
//! the validated fields and is used by getters.

use serde::{Deserialize, Serialize};

/// `compact_thresholds.auto` is `0 | 1` in the zod-side contract; kept as a
/// raw u8 here so passthrough persistence can never corrupt other shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactThresholds {
    pub auto: u8,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SettingsShape {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_api_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_thresholds: Option<CompactThresholds>,
    /// The ASR preference. Since the final decision 2026-11-22 there is ONE
    /// engine (Parakeet); the key stays so an obsolete selection is migrated
    /// VISIBLY to the fixed id (settings_routes::migrate_engines), and its
    /// value then records that fact. Model IDs, never paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speech_model: Option<String>,
    /// The named OCR engine; unset means the PaddleOCR default. An explicit
    /// "tesseract" is the Tesseract-only choice and is PRESERVED by migration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_engine: Option<String>,
    // `model_mirror` and `hf_token` are REMOVED (final-decision addendum
    // 2026-11-22): the Hugging Face search/picker/token/mirror/download
    // surface is gone; the settings routes purge any stored value.
}
