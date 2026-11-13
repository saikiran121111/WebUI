//! Golden field-split replay (`fixtures/sse/02`, `sse/03`).
//!
//! 2026-11-13 brief §2 changed BOTH fixture shapes (see docs/STATE.md and the
//! harness doc in `__tests__/rust-golden/sse-vectors.test.ts`): the old
//! byte-level `ThinkScrubber` matrices are retired with the scrubber itself.
//! - `sse/02` now records CONTENT-FIELD piece vectors: replaying each piece
//!   framing through `ThinkFieldSplitter` must equal the recorded atomic
//!   routing (routing is content-scoped, never network-scoped; an
//!   unterminated `<think>` tail survives as reasoning).
//! - `sse/03` is a TS-recorded raw-TRANSPORT identity matrix. The Rust
//!   forward pumps are byte-passthrough by construction (no decode), and the
//!   relay framing identity under mid-code-point splits is pinned in
//!   `browser_loop`'s unit tests; this test consumes the fixture's
//!   invariants as a cross-engine contract check.

mod common;

use common::load_fixture;
use ruke_server::chat::scrubber::ThinkFieldSplitter;

fn run_pieces(pieces: &[String]) -> (String, String) {
    let mut s = ThinkFieldSplitter::default();
    let (mut content, mut reasoning) = (String::new(), String::new());
    for p in pieces {
        let out = s.feed(p);
        content.push_str(&out.content);
        reasoning.push_str(&out.reasoning);
    }
    let tail = s.flush();
    content.push_str(&tail.content);
    reasoning.push_str(&tail.reasoning);
    (content, reasoning)
}

/// Every recorded re-framing of every text must route IDENTICALLY to the
/// atomic expectation — chunking invariance, cross-engine.
#[test]
fn think_field_split_matrix_replays_cross_engine_vectors() {
    let fx = load_fixture("sse/02-think-split-matrix.json");
    assert!(
        fx["mismatchSplitChars"]
            .as_array()
            .unwrap()
            .is_empty(),
        "the TS harness recorded a chunking-invariance violation"
    );
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), fx["splitCount"].as_u64().unwrap() as usize);

    let mut replays = 0usize;
    for case in cases {
        let pieces: Vec<String> = case["pieces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect();
        let exp = &case["expected"];
        let (content, reasoning) = run_pieces(&pieces);
        assert_eq!(
            content,
            exp["content"].as_str().unwrap(),
            "content mismatch replaying {pieces:?}"
        );
        assert_eq!(
            reasoning,
            exp["reasoning"].as_str().unwrap(),
            "reasoning mismatch replaying {pieces:?}"
        );
        assert!(
            !content.contains("<think>") && !content.contains("</think>"),
            "delimiters never leak into the answer channel"
        );
        replays += 1;
    }
    assert!(replays > 0, "the matrix must carry cases");
}

/// Regression control for the retired-scrubber deletion bug: an UNTERMINATED
/// `<think>` tail must survive as reasoning in Rust exactly as the TS splitter
/// routes it (positive control mirrored from fixture 02's texts[0] case).
#[test]
fn unterminated_think_tail_survives_as_reasoning() {
    let fx = load_fixture("sse/02-think-split-matrix.json");
    let texts = fx["texts"].as_array().unwrap();
    let first = texts[0].as_str().unwrap();
    assert!(
        first.ends_with("<think>oops"),
        "fixture drift: texts[0] must keep the unterminated-tail case"
    );
    let (content, reasoning) = run_pieces(&[first.to_string()]);
    assert_eq!(content, "<font color='red'>A</font>B");
    assert_eq!(reasoning, "secret1oops");
}

/// The TS transport matrix must record ZERO mangling (raw transport law), its
/// base64 must re-decode to the recorded stream, and mid-code-point splits
/// must actually have been exercised.
#[test]
fn utf8_transport_matrix_records_zero_mangling() {
    let fx = load_fixture("sse/03-utf8-split-matrix.json");
    assert!(
        fx["mangledSplitBytes"]
            .as_array()
            .unwrap()
            .is_empty(),
        "raw transport: some split mangled the response bytes"
    );
    assert!(fx["midCodePointSplits"].as_u64().unwrap() > 0, "the matrix must include cuts strictly inside multi-byte code points");
    let stream = fx["upstreamStreamUtf8"].as_str().unwrap();
    // Base64 cross-check WITHOUT a base64 dependency (workspace law): the
    // record must start with base64("data: ") and its padded length must
    // decode to exactly the recorded stream length.
    let b64 = fx["upstreamBytesBase64"].as_str().unwrap();
    assert!(b64.starts_with("ZGF0YTog"), "base64 record drift (must start with base64 of \"data: \")");
    let pad = b64.chars().rev().take_while(|&c| c == '=').count();
    assert_eq!((b64.len() / 4) * 3 - pad, stream.len(), "base64 length must match the stream");

    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), fx["splitCount"].as_u64().unwrap() as usize);
    for case in cases {
        assert!(
            case["byteIdenticalToUpstream"].as_bool().unwrap(),
            "split at byte {} recorded a non-identical response",
            case["splitAtByte"].as_u64().unwrap()
        );
        // The harness's bytesRecord adds a base64 escape hatch ONLY when the
        // lossy decode does not re-encode — i.e. ONLY for mangled output. Raw
        // transport must therefore never need it.
        assert!(
            case["responseBytes"].get("base64").is_none(),
            "split at byte {} recorded mangled response bytes",
            case["splitAtByte"].as_u64().unwrap()
        );
    }
}
