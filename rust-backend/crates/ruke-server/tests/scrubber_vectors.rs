//! Golden scrubber replay (`fixtures/sse/02`, `sse/03`).
//!
//! Per the approved deviation (MIGRATION-MAP §10/§21): the Rust scrubber is
//! compared against the recorded `expectedRust*` vectors (atomic-scrub
//! semantics), NOT against the mangled TS per-network-chunk output. The TS
//! `tsOutput`/`mangledSplitBytes` fields exist to document the bug that was
//! fixed — reproducing it is forbidden.

mod common;

use common::load_fixture;
use ruke_server::chat::scrubber::ThinkScrubber;

fn run(chunks: &[&[u8]]) -> Vec<u8> {
    let mut sc = ThinkScrubber::default();
    let mut out = Vec::new();
    for c in chunks {
        out.extend_from_slice(&sc.feed(c));
    }
    out.extend_from_slice(&sc.finish());
    out
}

/// Every split point of the think-tag stream must produce the atomic result:
/// tag state is content-scoped, not network-chunk-scoped.
#[test]
fn think_split_matrix_matches_expected_rust_vectors() {
    let fx = load_fixture("sse/02-think-split-matrix.json");
    let stream = fx["upstreamStream"].as_str().unwrap().as_bytes();
    let atomic = fx["atomicExpectedRust"].as_str().unwrap().as_bytes();

    assert_eq!(run(&[stream]), atomic, "single-feed == atomic expectedRust");

    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), fx["splitCount"].as_u64().unwrap() as usize);
    for case in cases {
        let at = case["splitAtByte"].as_u64().unwrap() as usize;
        let want = case["expectedRust"].as_str().unwrap().as_bytes();
        assert_eq!(
            run(&[&stream[..at], &stream[at..]]),
            want,
            "two-chunk split at byte {at} must equal the atomic vector"
        );
    }

    let per_byte: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(run(&per_byte), atomic, "byte-at-a-time feeding == atomic");
}

/// Splitting mid-code-point must never mangle bytes (the TS bug class): the
/// Rust output is byte-identical to the upstream stream at every split.
#[test]
fn utf8_split_matrix_never_mangles_bytes() {
    let fx = load_fixture("sse/03-utf8-split-matrix.json");
    let stream = fx["upstreamStreamUtf8"].as_str().unwrap().as_bytes();
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), fx["splitCount"].as_u64().unwrap() as usize);

    for case in cases {
        let at = case["splitAtByte"].as_u64().unwrap() as usize;
        let want = case["expectedRustUtf8"].as_str().unwrap().as_bytes();
        assert_eq!(
            run(&[&stream[..at], &stream[at..]]),
            want,
            "split at byte {at} (mid-codepoint: {})",
            case["cutsMidCodePoint"].as_bool().unwrap_or(false)
        );
    }

    // The approved vector set: no think tags in this stream, so every
    // expectedRustUtf8 IS the original stream — feed order never changes
    // the bytes.
    assert_eq!(stream, fx["upstreamStreamUtf8"].as_str().unwrap().as_bytes());
    let per_byte: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(run(&per_byte), stream, "byte-at-a-time keeps the stream intact");
}
