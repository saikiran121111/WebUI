//! Part 9 contract-drift binder for the internal-RPC seam (Rust side):
//! binds browser_bridge.rs / youtube_bridge.rs wire constants, deadline
//! rules, and the extraction response ledger to the committed contract
//! manifest (`rust-backend/fixtures/contracts/manifest.json`).
//!
//! The TS counterpart (`__tests__/rust-golden/contract-manifest.test.ts`)
//! binds the same manifest to the Next-side handlers, so a rename/add/remove
//! of a wire fact on EITHER side trips the drift gate.

use std::fs;
use std::path::PathBuf;

use ruke_websearch::browser_bridge::{
    deadline_ms, OnePassExtraction, ENV_BASE_URL, ENV_SECRET, READ_PATH, SECRET_HEADER,
};
use ruke_websearch::youtube_bridge::{EVIDENCE_PATH, RPC_DEADLINE_MS};
use serde_json::{json, Value};

fn manifest() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts/manifest.json");
    let text = fs::read_to_string(&path)
        .expect("rust-backend/fixtures/contracts/manifest.json missing — run `npm run contracts:generate`");
    serde_json::from_str(&text).expect("manifest.json must be valid JSON")
}

#[test]
fn rpc_wire_constants_match_manifest() {
    let m = manifest();
    let rpc = &m["rpc"];
    assert_eq!(SECRET_HEADER, rpc["secretHeader"].as_str().unwrap());
    assert_eq!(READ_PATH, rpc["browserRead"]["path"].as_str().unwrap());
    assert_eq!(EVIDENCE_PATH, rpc["youtubeEvidence"]["path"].as_str().unwrap());
    assert_eq!(ENV_BASE_URL, rpc["env"]["rustBridgeBaseUrl"].as_str().unwrap());
    assert_eq!(ENV_SECRET, rpc["env"]["rustBridgeSecret"].as_str().unwrap());
}

#[test]
fn browser_read_deadline_rule_matches_manifest() {
    let m = manifest();
    let br = &m["rpc"]["browserRead"];
    let default = br["timeoutDefaultMs"].as_u64().unwrap();
    let slack = br["clientDeadlineSlackMs"].as_u64().unwrap();
    assert_eq!(deadline_ms(None), default + slack, "default deadline");
    assert_eq!(deadline_ms(Some(5_000)), 5_000 + slack, "explicit timeoutMs + slack");
}

#[test]
fn youtube_deadline_matches_manifest() {
    let m = manifest();
    assert_eq!(RPC_DEADLINE_MS, m["rpc"]["youtubeEvidence"]["deadlineMs"].as_u64().unwrap());
}

#[test]
fn one_pass_extraction_accepts_exactly_the_manifest_response_key_set() {
    let m = manifest();
    let fields: Vec<&str> = m["rpc"]["browserRead"]["responseFields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();

    // Build a payload carrying every manifest-declared key with the right
    // primitive kind. `deny_unknown_fields` + `#[serde(default)]` mean this
    // deserializes iff the manifest key set is exactly Rust's accepted set
    // (plus `error` omitted-on-success is already exercised as absent).
    let mut obj = serde_json::Map::new();
    for f in &fields {
        let v = match *f {
            "status" => json!(200),
            "jsonLd" => json!([]),
            "meta" | "windowState" => json!({}),
            "ok" => json!(true),
            "url" | "finalUrl" | "title" | "bodyText" | "ariaSnapshot" => json!("x"),
            "error" => continue, // omitted on success; presence tested separately
            other => panic!("unmapped response field {other} — extend this test AND the manifest together"),
        };
        obj.insert((*f).to_string(), v);
    }
    let ok: Result<OnePassExtraction, _> = serde_json::from_value(Value::Object(obj.clone()));
    assert!(ok.is_ok(), "manifest key set must deserialize: {:?}", ok.err());

    // Presence of `error` as a string is accepted (failure payload).
    obj.insert("error".into(), json!("nav timeout"));
    assert!(serde_json::from_value::<OnePassExtraction>(Value::Object(obj.clone())).is_ok());

    // An unknown/renamed key must be REJECTED — a TS producer field rename
    // therefore trips this binder the moment the regenerated manifest (or the
    // TS-side presence assertions) move.
    obj.insert("definitelyNotAWireField".into(), json!(1));
    assert!(
        serde_json::from_value::<OnePassExtraction>(Value::Object(obj)).is_err(),
        "deny_unknown_fields guard"
    );
}

/// Rule 17: the bridge secret is never logged. Scan the bridge modules for
/// any log/println site that also mentions "secret" (the degrade log lines
/// are boolean-only by contract). Plumbing that DEFINES or ATTACHES the
/// value is fine; anything printing/inserting it into a log is not.
#[test]
fn bridge_secret_is_never_logged() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let log_markers = ["println!", "eprintln!", "info!", "warn!", "error!", "debug!", "tracing::"];
    for file in ["browser_bridge.rs", "youtube_bridge.rs"] {
        let src = fs::read_to_string(dir.join(file)).unwrap();
        for (i, line) in src.lines().enumerate() {
            let lower = line.to_ascii_lowercase();
            if lower.contains("secret") && log_markers.iter().any(|m| lower.contains(m)) {
                panic!("{file}:{} logs near 'secret': {}", i + 1, line.trim());
            }
        }
    }
}
