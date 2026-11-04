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
}
