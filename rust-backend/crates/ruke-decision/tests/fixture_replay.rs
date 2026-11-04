//! Part 3 golden replays — every fixture under `rust-backend/fixtures/
//! {decision,skills}` recorded from the TypeScript oracle is replayed
//! through the Rust port and compared with the fixture's declared
//! comparison class (byte-exact where marked, semantic field-for-field for
//! the vector corpus). Fixtures are NEVER edited to make Rust pass: the
//! oracle's bytes are the spec.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use ruke_contracts::decision::{mode_fence, DecisionEnvelope, RendererMode};
use ruke_decision::contracts::mode_contract;
use ruke_decision::engine::{decision_route, get_decision_sync};
use ruke_decision::skill_block::build_decision_skill_block;
use ruke_skills::jsstr::js_len;
use ruke_skills::lazy::apply_slash_skill_routing;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// Repo root (holds lib/, skills/, .cskills/) — the root the TS loaders use.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn load(rel: &str) -> Value {
    let path = fixtures_dir().join(rel);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("fixture {rel}: {e} — run the recording vitest harness first"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("fixture {rel} is not valid JSON: {e}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Upstream chat payload system message content (first upstream call).
fn upstream_system_content(fix: &Value) -> String {
    let body: Value = fix["upstreamCalls"][0]["bodyText"]
        .as_str()
        .expect("upstreamCalls[0].bodyText")
        .parse()
        .expect("forwarded upstream body must be JSON");
    body["messages"]
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["role"] == "system"))
        .and_then(|m| m["content"].as_str().map(String::from))
        .expect("a system message in the forwarded upstream body")
}

fn upstream_body(fix: &Value) -> Value {
    fix["upstreamCalls"][0]["bodyText"].as_str().unwrap().parse().unwrap()
}

// ————— decision route: byte-exact envelope wire bytes (fixtures 01-05) —————

#[test]
fn decision_route_fixtures_replay_byte_exact() {
    for rel in [
        "decision/01-route-excel-match.json",
        "decision/02-route-standard-with-history.json",
        "decision/03-route-whitespace-rejected.json",
        "decision/04-route-invalid-json.json",
        "decision/05-route-missing-message.json",
    ] {
        let fix = load(rel);
        let raw = fix["request"]["rawBody"].as_str().unwrap();
        let r = decision_route(raw);
        assert_eq!(r.status, fix["response"]["status"].as_u64().unwrap() as u16, "{rel} status");
        assert_eq!(r.body, fix["response"]["bodyBytes"].as_str().unwrap(), "{rel} body bytes");
    }
}

#[test]
fn envelope_confidence_and_key_order_bytes() {
    // §14 resolution: confidence renders as integer `1`, never `1.0`.
    let fix = load("decision/01-route-excel-match.json");
    let r = decision_route(fix["request"]["rawBody"].as_str().unwrap());
    assert!(r.body.contains("\"confidence\":1,"), "confidence must serialize as `1`: {}", r.body);
    assert!(!r.body.contains("lfm_input") && !r.body.contains("lfm_raw"), "lfm fields must be OMITTED");
    // Recorded key order must be reproduced verbatim.
    let order: Vec<&str> = fix["envelopeKeyOrder"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let body_order: Vec<String> = serde_json::from_str::<serde_json::Map<String, Value>>(&r.body)
        .unwrap().keys().cloned().collect();
    assert_eq!(body_order, order, "envelope key order must match JSON.stringify insertion order");
}

// ————— intent vectors (decision/06) —————

#[test]
fn intent_matcher_vectors_replay_full_envelope_fields() {
    let fix = load("decision/06-intent-matcher-vectors.json");
    let vectors = fix["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 55);
    for v in vectors {
        let prompt = v["prompt"].as_str().unwrap();
        let env = get_decision_sync(prompt, &[]);
        let want_mode = RendererMode::parse(v["active_mode"].as_str().unwrap()).unwrap();
        assert_eq!(env.active_mode, want_mode, "active_mode for {prompt:?}");
        let want_skill = v["skill_to_load"].as_str();
        assert_eq!(env.skill_to_load, want_skill, "skill_to_load for {prompt:?}");
        assert_eq!(env.decided_by, v["decided_by"].as_str().unwrap(), "decided_by for {prompt:?}");
        assert_eq!(env.stripped_prompt, v["stripped_prompt"].as_str().unwrap(), "trim for {prompt:?}");
        assert_eq!(env.confidence, 1.0);
    }
    let blank = &fix["blankMessage"];
    let env = get_decision_sync(blank["prompt"].as_str().unwrap(), &[]);
    assert_eq!(env.decided_by, blank["decided_by"].as_str().unwrap()); // internal-only fallback
    assert_eq!(env.active_mode, RendererMode::StandardChat);
    assert_eq!(env.stripped_prompt, "");
    assert_eq!(env.skill_to_load, None);
}

// ————— mode contracts bound by hash (skills/06) —————

#[test]
fn generated_mode_contract_constants_hash_match_the_ts_oracle() {
    let fix = load("skills/06-mode-contracts-hashes.json");
    for e in fix["entries"].as_array().unwrap() {
        let mode = RendererMode::parse(e["mode"].as_str().unwrap()).unwrap();
        if e["present"].as_bool().unwrap() {
            let c = mode_contract(mode).unwrap_or_else(|| panic!("no contract embedded for {mode:?}"));
            assert_eq!(sha256_hex(c.as_bytes()), e["sha256"].as_str().unwrap(), "sha for {:?}", e["mode"]);
            assert_eq!(c.len(), e["bytes"].as_u64().unwrap() as usize, "bytes for {:?}", e["mode"]);
            assert_eq!(js_len(c), e["utf16Length"].as_u64().unwrap() as usize, "utf16 units for {:?}", e["mode"]);
        } else {
            assert!(mode_contract(mode).is_none(), "{:?} must have no contract", e["mode"]);
        }
    }
}

// ————— user-tier slash routing (skills/01-03) —————

#[test]
fn slash_routing_user_tier_block_and_header_fixture_01() {
    let fix = load("skills/01-slash-user-skill-progress.json");
    let mut payload: Value = serde_json::from_str(fix["request"]["rawBody"].as_str().unwrap()).unwrap();
    let used = apply_slash_skill_routing(&mut payload, &repo_root());
    assert_eq!(used.as_deref(), Some("humanizer"));
    // The header the TS emitted for the user tier must match our return.
    assert_eq!(fix["response"]["headers"]["x-used-skill"].as_str().unwrap(), "humanizer");

    let msgs = payload["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "system");
    let expected = upstream_system_content(&fix);
    assert_eq!(msgs[0]["content"].as_str().unwrap(), expected, "active_skill block must be byte-identical");
    // Slash prefix stripped from the forwarded user turn.
    assert_eq!(msgs[1]["content"].as_str().unwrap(), "rewrite this paragraph plainly");

    let anchor = &fix["upstreamCalls"][0]["anchors"][0];
    assert_eq!(sha256_hex(expected.as_bytes()), anchor["block_sha256"].as_str().unwrap());
    assert_eq!(expected.len(), anchor["block_bytes"].as_u64().unwrap() as usize);
    let src = fs::read(repo_root().join("skills/humanizer/SKILL.md")).unwrap();
    assert_eq!(sha256_hex(&src), anchor["sources"][0]["sha256"].as_str().unwrap(), "skill source drifted since recording");
    assert_eq!(src.len(), anchor["sources"][0]["bytes"].as_u64().unwrap() as usize);
}

#[test]
fn slash_routing_preserves_other_payload_keys_fixture_02() {
    let fix = load("skills/02-slash-user-skill-legacy.json");
    let mut payload: Value = serde_json::from_str(fix["request"]["rawBody"].as_str().unwrap()).unwrap();
    let used = apply_slash_skill_routing(&mut payload, &repo_root());
    assert_eq!(used.as_deref(), Some("humanizer"));
    // Routing must not disturb sibling keys (legacy path carried `stream`).
    assert_eq!(payload["stream"], upstream_body(&fix)["stream"]);
    assert_eq!(payload["messages"][0]["content"].as_str().unwrap(), upstream_system_content(&fix));
}

#[test]
fn unknown_slash_is_a_total_payload_noop_fixture_03() {
    let fix = load("skills/03-unknown-slash-passthrough.json");
    let raw = fix["request"]["rawBody"].as_str().unwrap();
    let mut payload: Value = serde_json::from_str(raw).unwrap();
    let before = payload.clone();
    assert_eq!(apply_slash_skill_routing(&mut payload, &repo_root()), None);
    assert_eq!(payload, before, "unknown slash must not touch the payload");
    assert!(fix["response"]["headers"].get("x-used-skill").is_none());
}

// ————— core-tier decision_skill block (skills/04, 05) —————

#[test]
fn core_skill_decision_block_fixture_04_string_equal() {
    let fix = load("skills/04-core-skill-decision.json");
    let prompt = "build me a spreadsheet with the quarterly sales";
    let env = get_decision_sync(prompt, &[]);
    assert_eq!(env.active_mode, RendererMode::Excel);
    assert_eq!(env.skill_to_load, Some("xlsx"));

    let block = build_decision_skill_block(&env, &repo_root()).expect("excel block");
    let expected = upstream_system_content(&fix);
    assert_eq!(block, expected, "<decision_skill> block must be string-identical to the injected system content");
    // 11144 = JS content length (UTF-16 units); block_bytes 11204 = UTF-8
    // bytes — the gap is the skill text's non-ASCII characters.
    assert_eq!(js_len(&block), 11144, "UTF-16 units of the recorded block");

    let anchor = &fix["upstreamCalls"][0]["anchors"][0];
    assert_eq!(sha256_hex(block.as_bytes()), anchor["block_sha256"].as_str().unwrap());
    assert_eq!(block.len(), anchor["block_bytes"].as_u64().unwrap() as usize);
    let src = fs::read(repo_root().join(".cskills/xlsx/SKILL.md")).unwrap();
    assert_eq!(sha256_hex(&src), anchor["sources"][0]["sha256"].as_str().unwrap(), ".cskills source drifted since recording");
    assert_eq!(src.len(), anchor["sources"][0]["bytes"].as_u64().unwrap() as usize);

    // §9 core-tier invisibility: the TS never sent a skill header here.
    assert!(fix["response"]["headers"].get("x-used-skill").is_none());
}

#[test]
fn repair_passthrough_envelope_block_fixture_05() {
    let fix = load("skills/05-decision-mode-excel-passthrough.json");
    let env = DecisionEnvelope::passthrough(RendererMode::Excel, "re-emit the deliverable for this request");
    assert_eq!(env.decided_by, "repair-passthrough");
    assert_eq!(env.confidence, 1.0);
    assert_eq!(env.skill_to_load, Some("xlsx"));
    assert_eq!(env.allowed_code_fence, mode_fence(RendererMode::Excel));
    assert_eq!(env.allowed_code_fence, Some("xlsx"));

    let block = build_decision_skill_block(&env, &repo_root()).unwrap();
    let expected = upstream_system_content(&fix);
    assert_eq!(block, expected, "passthrough block must be string-identical");

    let anchor = &fix["upstreamCalls"][0]["anchors"][0];
    assert_eq!(sha256_hex(block.as_bytes()), anchor["block_sha256"].as_str().unwrap());
    assert_eq!(block.len(), anchor["block_bytes"].as_u64().unwrap() as usize);
    let src = fs::read(repo_root().join(".cskills/xlsx/SKILL.md")).unwrap();
    assert_eq!(sha256_hex(&src), anchor["sources"][0]["sha256"].as_str().unwrap());
}
