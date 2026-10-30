//! Part 9 contract-drift binder (Rust side).
//!
//! Binds the Rust contract mirror (`decision.rs`, `stages.rs`, `settings.rs`)
//! to the committed cross-language manifest
//! (`rust-backend/fixtures/contracts/manifest.json`), which is GENERATED from
//! the live TypeScript sources. If either language renames a mode, a field, a
//! casing convention, or an omission rule, the manifest no longer matches
//! this side and these tests fail — alongside the TS-side binder
//! (`__tests__/rust-golden/contract-manifest.test.ts`) which fails the same
//! drift against the live TS sources.
//!
//! The manifest is the arbiter; regenerate with `npm run contracts:generate`
//! only when BOTH sides move together (byte-level wire parity itself remains
//! pinned by the `__tests__/rust-golden` fixture replays — those are the
//! stronger gate; this test adds the field-ledger layer the fixtures don't
//! fully exercise, e.g. fields no fixture scenario populates).

use std::fs;
use std::path::PathBuf;

use ruke_contracts::decision::{self, DecisionEnvelope, RendererMode};
use ruke_contracts::settings::{CompactThresholds, SettingsShape};
use ruke_contracts::stages::{self, stage_frame, Citation, CitationMap, GateQuery, ResearchMeta, StageEvent};
use serde_json::Value;

fn manifest() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts/manifest.json");
    let text = fs::read_to_string(&path)
        .expect("rust-backend/fixtures/contracts/manifest.json missing — run `npm run contracts:generate`");
    serde_json::from_str(&text).expect("manifest.json must be valid JSON")
}

/// A manifest `fields` ledger (array of {name, present, nullable, fields?}) ->
/// ordered name list. `fields` here is the Value that holds the array.
fn ledger_names(fields: &Value) -> Vec<String> {
    fields
        .as_array()
        .unwrap_or_else(|| panic!("fields ledger must be an array, got {fields}"))
        .iter()
        .map(|f| f["name"].as_str().expect("field.name string").to_string())
        .collect()
}

/// Nested inline-object ledger for one member (None when the TS type had no
/// inline object literal).
fn nested_ledger_names(member: &Value) -> Vec<String> {
    match member.get("fields") {
        Some(f) if f.is_array() => ledger_names(f),
        _ => panic!("expected inline-object `fields` on member {member}"),
    }
}

/// Top-level JSON object keys in DOCUMENT ORDER (serde_json's default Map
/// sorts, so key order is read from the raw serialized text instead).
fn top_level_keys(json: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escape = false;
    let mut expect_key = false;
    let mut cur = String::new();
    for ch in json.chars() {
        if in_str {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_str = false;
                if expect_key && depth == 1 {
                    keys.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
            } else {
                cur.push(ch);
            }
            continue;
        }
        match ch {
            '"' => {
                in_str = true;
                cur.clear();
            }
            '{' => {
                depth += 1;
                if depth == 1 {
                    expect_key = true; // the object's first key follows
                }
            }
            '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' => expect_key = depth == 1,
            ':' => expect_key = false,
            _ => {}
        }
    }
    keys
}

#[test]
fn decision_modes_order_skill_and_fence_match_manifest() {
    let m = manifest();
    let order: Vec<&str> = m["decisionModes"]["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(order, decision::RENDERER_MODE_STRS.to_vec(), "RENDERER_MODES order/spelling");

    for s in &order {
        let mode = RendererMode::parse(s).expect("manifest mode must parse in Rust");
        assert_eq!(
            m["decisionModes"]["skill"][s].as_str(),
            decision::mode_skill(mode),
            "MODE_SKILL[{s}]"
        );
        assert_eq!(
            m["decisionModes"]["fence"][s].as_str(),
            decision::mode_fence(mode),
            "MODE_FENCE[{s}]"
        );
    }
}

#[test]
fn decision_envelope_field_ledger_omission_and_null_rules() {
    let m = manifest();
    let fields = m["decisionEnvelope"]["fields"].as_array().unwrap();
    let all: Vec<String> = ledger_names(&m["decisionEnvelope"]["fields"]);
    let optional: Vec<String> = fields
        .iter()
        .filter(|f| f["present"].as_str() == Some("optional-omit-when-absent"))
        .map(|f| f["name"].as_str().unwrap().to_string())
        .collect();
    let always_nullable: Vec<String> = fields
        .iter()
        .filter(|f| {
            f["present"].as_str() == Some("always-present") && f["nullable"].as_bool() == Some(true)
        })
        .map(|f| f["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!optional.is_empty() && !always_nullable.is_empty(), "ledger classes populated");

    // Full envelope: exact serialized key order == manifest ledger order
    // (snake_case casing, TS declaration order, confidence integral form).
    let mut env = DecisionEnvelope::passthrough(RendererMode::Excel, "text");
    env.lfm_input = Some(Some("prompt".into()));
    env.lfm_raw = Some(Some("raw".into()));
    assert_eq!(
        top_level_keys(&serde_json::to_string(&env).unwrap()),
        all,
        "serialized envelope field order must match TS declaration order"
    );
    assert!(serde_json::to_string(&env).unwrap().contains("\"confidence\":1"), "JS-number confidence");

    // Fallback envelope: optional diagnostics OMITTED (never null)…
    let fb_keys = top_level_keys(&serde_json::to_string(&DecisionEnvelope::fallback("hi")).unwrap());
    for k in &optional {
        assert!(!fb_keys.contains(k), "{k} must be omitted when absent, got {fb_keys:?}");
    }
    // …while always-present nullable fields are explicit null keys (TS writes them).
    for k in &always_nullable {
        assert!(fb_keys.contains(k), "{k} must always be present (TS writes null), got {fb_keys:?}");
    }
    // Some(None) renders as JSON null, not omission.
    let mut probe = DecisionEnvelope::fallback("hi");
    probe.lfm_input = Some(None);
    let v: serde_json::Map<String, Value> =
        serde_json::from_str(&serde_json::to_string(&probe).unwrap()).unwrap();
    assert!(v.contains_key("lfm_input") && v["lfm_input"].is_null());

    // Wire casing rule: decision envelope is snake_case end to end.
    for name in &all {
        assert_eq!(name, &name.to_lowercase(), "envelope names are snake_case: {name}");
        assert!(!name.chars().any(|c| c.is_ascii_uppercase()), "no camelCase: {name}");
    }
}

#[test]
fn stage_event_citation_gate_field_ledgers() {
    let m = manifest();
    let st = &m["stageEvent"];
    let all = ledger_names(&st["fields"]);
    let legacy: Vec<String> = st["legacyReadOnlyFields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["field"].as_str().unwrap().to_string())
        .collect();
    // Rust-emitted ledger = manifest minus documented legacy read-only fields.
    let rust_expected: Vec<String> = all.iter().filter(|n| !legacy.contains(n)).cloned().collect();

    let mut ev = StageEvent::new("web:auth_required");
    ev.detail = Some("d".into());
    ev.mode = Some(RendererMode::Chart);
    ev.ms = Some(1);
    ev.done = Some(2);
    ev.total = Some(3);
    ev.coverage = Some(0.5);
    ev.session = Some("conv-1".into());
    ev.url = Some("https://x.test".into());
    ev.domain = Some("x.test".into());
    let mut cites = CitationMap::new();
    cites.insert(
        "S1".into(),
        serde_json::to_value(Citation {
            source_id: "S1".into(),
            url: "https://x.test/a".into(),
            title: "T".into(),
            domain: "x.test".into(),
            published_at: Some("2026".into()),
        })
        .unwrap(),
    );
    ev.web_citations = Some(cites);
    ev.search_gate = Some(ResearchMeta {
        depth: "deep".into(),
        freshness: "any".into(),
        decided_by: Some("gate".into()),
        queries: vec![GateQuery { query: "q".into(), intent: "general".into() }],
    });
    let keys = top_level_keys(&serde_json::to_string(&ev).unwrap());
    assert_eq!(keys, rust_expected, "StageEvent key order/casing vs TS ledger");

    // Nested ledgers: citation entry object, searchGate object, queries entry.
    let by_name = |n: &str| -> Value {
        st["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == n)
            .cloned()
            .unwrap_or_else(|| panic!("manifest stageEvent has no {n}"))
    };
    assert_eq!(
        top_level_keys(&serde_json::to_string(&Citation {
            source_id: "S1".into(),
            url: "u".into(),
            title: "t".into(),
            domain: "d".into(),
            published_at: Some("p".into()),
        })
        .unwrap()),
        nested_ledger_names(&by_name("webCitations")),
        "Citation casing/order"
    );
    let gf = by_name("searchGate");
    assert_eq!(
        top_level_keys(
            &serde_json::to_string(&ResearchMeta {
                depth: "d".into(),
                freshness: "f".into(),
                decided_by: Some("x".into()),
                queries: vec![GateQuery { query: "q".into(), intent: "i".into() }],
            })
            .unwrap()
        ),
        nested_ledger_names(&gf),
        "ResearchMeta casing/order"
    );
    let qf = gf["fields"].as_array().unwrap().iter().find(|f| f["name"] == "queries").cloned().unwrap();
    assert_eq!(
        top_level_keys(&serde_json::to_string(&GateQuery { query: "q".into(), intent: "i".into() }).unwrap()),
        nested_ledger_names(&qf),
        "GateQuery casing/order"
    );
}

#[test]
fn settings_shape_field_ledger() {
    let m = manifest();
    let fields = &m["settings"]["fields"];
    let all = ledger_names(fields);

    let s = SettingsShape {
        llm_api_url: Some("u".into()),
        llm_api_key: Some("k".into()),
        compact_thresholds: Some(CompactThresholds { auto: 1, tokens: 96_000 }),
    };
    assert_eq!(top_level_keys(&serde_json::to_string(&s).unwrap()), all);
    for f in fields.as_array().unwrap() {
        assert_eq!(f["present"].as_str(), Some("optional-omit-when-absent"), "{}", f["name"]);
    }
    assert_eq!(serde_json::to_string(&SettingsShape::default()).unwrap(), "{}");

    let ct = fields.as_array().unwrap().iter().find(|f| f["name"] == "compact_thresholds").cloned().unwrap();
    assert_eq!(
        top_level_keys(&serde_json::to_string(&CompactThresholds { auto: 0, tokens: 1 }).unwrap()),
        nested_ledger_names(&ct)
    );
}

#[test]
fn sse_frame_keys_match_manifest() {
    let m = manifest();
    assert!(stage_frame(&StageEvent::new("skill")).get(m["sseFrames"]["stageFrameKey"].as_str().unwrap()).is_some());
    assert!(stages::error_frame("boom").get(m["sseFrames"]["errorFrameKey"].as_str().unwrap()).is_some());
    assert_eq!(m["sseFrames"]["doneMarker"].as_str().unwrap(), "[DONE]");
}

#[test]
fn header_ledger_names_are_exact_lowercase() {
    let m = manifest();
    let names: Vec<&str> = m["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap())
        .collect();
    for expected in [
        "x-decision-mode",
        "x-used-skill",
        "x-web-citations",
        "x-search-gate",
        "x-ruke-internal-secret",
    ] {
        assert!(names.contains(&expected), "manifest headers ledger must contain {expected}: {names:?}");
    }
}
