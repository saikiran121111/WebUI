//! Decision Engine contract — mirror of `lib/decision/types.ts`.
//! Field order of [`DecisionEnvelope`] matches the TS construction sites
//! (`passthroughEnvelope` in the chat route and `getDecisionSync`) so the
//! serialized object order is byte-comparable for the Part 2 goldens.

use serde::{Deserialize, Serialize};

/// Exact spelling set from `RENDERER_MODES` (order preserved).
pub const RENDERER_MODE_STRS: [&str; 9] = [
    "excel", "docs", "pdf", "ppt", "3d_asset", "cad_blueprint", "chart", "html_render",
    "standard_chat",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RendererMode {
    #[serde(rename = "excel")]
    Excel,
    #[serde(rename = "docs")]
    Docs,
    #[serde(rename = "pdf")]
    Pdf,
    #[serde(rename = "ppt")]
    Ppt,
    #[serde(rename = "3d_asset")]
    Asset3D,
    #[serde(rename = "cad_blueprint")]
    CadBlueprint,
    #[serde(rename = "chart")]
    Chart,
    #[serde(rename = "html_render")]
    HtmlRender,
    #[serde(rename = "standard_chat")]
    StandardChat,
}

impl RendererMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Excel => "excel",
            Self::Docs => "docs",
            Self::Pdf => "pdf",
            Self::Ppt => "ppt",
            Self::Asset3D => "3d_asset",
            Self::CadBlueprint => "cad_blueprint",
            Self::Chart => "chart",
            Self::HtmlRender => "html_render",
            Self::StandardChat => "standard_chat",
        }
    }

    /// Mirror of `isRendererMode`: unknown spellings are simply not a mode.
    pub fn parse(value: &str) -> Option<RendererMode> {
        RENDERER_MODE_STRS
            .iter()
            .position(|m| *m == value)
            .map(|i| match i {
                0 => Self::Excel,
                1 => Self::Docs,
                2 => Self::Pdf,
                3 => Self::Ppt,
                4 => Self::Asset3D,
                5 => Self::CadBlueprint,
                6 => Self::Chart,
                7 => Self::HtmlRender,
                _ => Self::StandardChat,
            })
    }

    /// `RENDERER_MODES.filter((m) => m !== mode)` — order preserved.
    pub fn disable_validators_for(mode: RendererMode) -> Vec<RendererMode> {
        RENDERER_MODE_STRS
            .iter()
            .filter_map(|m| RendererMode::parse(m))
            .filter(|m| *m != mode)
            .collect()
    }
}

/// mode → single core skill in ./.cskills/ (mirror of `MODE_SKILL`; the TS
/// table is pinned by `mode_tables_match_typescript_baseline`).
pub fn mode_skill(mode: RendererMode) -> Option<&'static str> {
    match mode {
        RendererMode::Excel => Some("xlsx"),
        RendererMode::Docs => Some("docx"),
        RendererMode::Pdf => Some("pdf"),
        RendererMode::Ppt => Some("pptx"),
        RendererMode::Asset3D => Some("threejs-skills"),
        RendererMode::CadBlueprint => Some("archify"),
        RendererMode::Chart => None,
        RendererMode::HtmlRender => Some("html-viewer"),
        RendererMode::StandardChat => None,
    }
}

/// mode → the ONE code fence its renderer accepts (`MODE_FENCE`).
pub fn mode_fence(mode: RendererMode) -> Option<&'static str> {
    match mode {
        RendererMode::Excel => Some("xlsx"),
        RendererMode::Docs => Some("docx"),
        RendererMode::Pdf => Some("html"),
        RendererMode::Ppt => Some("pptx"),
        RendererMode::Asset3D => Some("scene3d"),
        RendererMode::CadBlueprint => Some("cad"),
        RendererMode::Chart => Some("chart"),
        RendererMode::HtmlRender => Some("html"),
        RendererMode::StandardChat => None,
    }
}

/// JS `JSON.stringify` number rendering: a double with no fractional part
/// inside the safe-integer range prints as an integer literal (`1`, not
/// `1.0`). The in-process engine hardcodes `confidence: 1`, so this is what
/// the byte-exact decision fixtures pin. Non-integral values still print via
/// serde's shortest-roundtrip float formatting (matches JS for the values
/// this field can actually hold, 0..=1).
fn serialize_confidence<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992f64 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

/// The exact `DecisionEnvelope` shape. `null` fields serialize as JSON null
/// (JS writes them explicitly); `lfm_input`/`lfm_raw` are OMITTED unless
/// present (TS `?:` — never emitted on fallback/passthrough envelopes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionEnvelope {
    pub active_mode: RendererMode,
    /// PART-3 RESOLUTION of the Part-2 parity note: the serializer below
    /// emits integral confidences as JSON integers, so the bytes match the
    /// JS oracle (`fixtures/decision/01` pins `"confidence":1`).
    #[serde(serialize_with = "serialize_confidence")]
    pub confidence: f64,
    pub decided_by: String,
    pub stripped_prompt: String,
    pub skill_to_load: Option<&'static str>,
    pub allowed_code_fence: Option<&'static str>,
    pub disable_validators: Vec<RendererMode>,
    pub enable_validator: RendererMode,
    pub task_constraints: Vec<String>,
    pub extracted_entities: Vec<String>,
    pub lfm_latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lfm_input: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lfm_raw: Option<Option<String>>,
}

impl DecisionEnvelope {
    /// Mirror of `passthroughEnvelope(mode, text)` in `app/api/chat/route.ts`.
    pub fn passthrough(mode: RendererMode, text: &str) -> Self {
        Self {
            active_mode: mode,
            confidence: 1.0,
            decided_by: "repair-passthrough".into(),
            stripped_prompt: text.into(),
            skill_to_load: mode_skill(mode),
            allowed_code_fence: mode_fence(mode),
            disable_validators: RendererMode::disable_validators_for(mode),
            enable_validator: mode,
            task_constraints: Vec::new(),
            extracted_entities: Vec::new(),
            lfm_latency_ms: 0,
            lfm_input: None,
            lfm_raw: None,
        }
    }

    /// Mirror of `fallbackEnvelope(message)` in `lib/decision/client.ts`.
    pub fn fallback(message: &str) -> Self {
        Self {
            active_mode: RendererMode::StandardChat,
            confidence: 1.0,
            decided_by: "in-process-fallback".into(),
            stripped_prompt: message.into(),
            skill_to_load: None,
            allowed_code_fence: None,
            disable_validators: RendererMode::disable_validators_for(RendererMode::StandardChat),
            enable_validator: RendererMode::StandardChat,
            task_constraints: Vec::new(),
            extracted_entities: Vec::new(),
            lfm_latency_ms: 0,
            lfm_input: None,
            lfm_raw: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_mode_spellings_roundtrip_and_reject_unknown() {
        for s in RENDERER_MODE_STRS {
            let m = RendererMode::parse(s).expect("mode parses");
            assert_eq!(m.as_str(), s);
            let json = serde_json::to_string(&m).unwrap();
            assert_eq!(json, format!("\"{s}\""));
            assert_eq!(serde_json::from_str::<RendererMode>(&json).unwrap(), m);
        }
        for bad in ["Internal", "standard-chat", "", "3d", "excel2"] {
            assert_eq!(RendererMode::parse(bad), None, "isRendererMode parity for {bad:?}");
        }
    }

    #[test]
    fn mode_tables_match_typescript_baseline() {
        // Frozen snapshot of MODE_SKILL / MODE_FENCE in lib/decision/types.ts.
        let skill: [(&str, Option<&str>); 9] = [
            ("excel", Some("xlsx")),
            ("docs", Some("docx")),
            ("pdf", Some("pdf")),
            ("ppt", Some("pptx")),
            ("3d_asset", Some("threejs-skills")),
            ("cad_blueprint", Some("archify")),
            ("chart", None),
            ("html_render", Some("html-viewer")),
            ("standard_chat", None),
        ];
        let fence: [(&str, Option<&str>); 9] = [
            ("excel", Some("xlsx")),
            ("docs", Some("docx")),
            ("pdf", Some("html")),
            ("ppt", Some("pptx")),
            ("3d_asset", Some("scene3d")),
            ("cad_blueprint", Some("cad")),
            ("chart", Some("chart")),
            ("html_render", Some("html")),
            ("standard_chat", None),
        ];
        for (i, s) in RENDERER_MODE_STRS.iter().enumerate() {
            let m = RendererMode::parse(s).unwrap();
            assert_eq!(mode_skill(m), skill[i].1, "MODE_SKILL[{i}]");
            assert_eq!(mode_fence(m), fence[i].1, "MODE_FENCE[{i}]");
        }
    }

    #[test]
    fn disable_validators_excludes_only_active_mode_in_order() {
        let dv = RendererMode::disable_validators_for(RendererMode::Excel);
        assert_eq!(
            dv.iter().map(|m| m.as_str()).collect::<Vec<_>>(),
            vec!["docs", "pdf", "ppt", "3d_asset", "cad_blueprint", "chart", "html_render", "standard_chat"]
        );
    }

    #[test]
    fn envelope_serialization_field_order_null_and_omission_golden() {
        let env = DecisionEnvelope::passthrough(RendererMode::Excel, "make a spreadsheet");
        let json = serde_json::to_string(&env).unwrap();
        assert_eq!(
            json,
            r#"{"active_mode":"excel","confidence":1,"decided_by":"repair-passthrough","stripped_prompt":"make a spreadsheet","skill_to_load":"xlsx","allowed_code_fence":"xlsx","disable_validators":["docs","pdf","ppt","3d_asset","cad_blueprint","chart","html_render","standard_chat"],"enable_validator":"excel","task_constraints":[],"extracted_entities":[],"lfm_latency_ms":0}"#
        );

        // Optional diagnostics: ABSENT (not null) when never set; explicit
        // JSON null when set to Some(None) (TS `lfm_input: null`).
        let mut d = DecisionEnvelope::fallback("hi");
        d.lfm_input = Some(None);
        let v: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
        assert_eq!(v["lfm_input"], serde_json::Value::Null);
        assert!(!v.contains_key("lfm_raw"), "omitted field must not serialize");
    }

    #[test]
    fn confidence_js_number_rendering_integers_and_floats() {
        // JSON.stringify(1) == "1"; JSON.stringify(0) == "0"; JSON.stringify(0.85) == "0.85".
        let mut env = DecisionEnvelope::fallback("hi");
        for (value, expect) in [(1.0, "\"confidence\":1"), (0.0, "\"confidence\":0"), (0.85, "\"confidence\":0.85")] {
            env.confidence = value;
            let json = serde_json::to_string(&env).unwrap();
            assert!(json.contains(expect), "confidence {value} must serialize as {expect}: {json}");
        }
    }
}
