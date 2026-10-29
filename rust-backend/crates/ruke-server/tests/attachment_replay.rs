//! PART 5 golden acceptance — replay of the attachment fixtures 01–06
//! recorded by `__tests__/rust-golden/attachments.test.ts`, through the
//! FULL Part-4+5 chat pipeline (`POST /api/chat` on the library router).
//!
//! Cross-language store: the attachment indexes are seeded by copying the
//! committed PRODUCTION-WRITER bytes (`fixtures/attachments/store/…`, §27)
//! into the repo's `.data/attach-index` — the SAME cwd-pinned location the
//! TS harness uses (gitignored; the same `att_golden*` ids, so a later
//! `attachments.test.ts` run cleans them like it always does). Rust never
//! rebuilds the store.
//!
//! Everything else reuses the Part-4 harness: `assert_response` (status,
//! full header set, ms-normalized or byte-exact body, logical frames, tail)
//! and `assert_upstream_call` (BYTE-IDENTICAL forwarded body — so the
//! injection/strip behavior, the recorded `lastUserIdx + 1` quirk, and the
//! keyframe data-url are all compared verbatim against TypeScript).

mod common;

use std::sync::Arc;
use std::sync::OnceLock;

use common::{
    assert_response, assert_slot_idle, assert_upstream_call, copy_tree, load_fixture,
    post_chat, store_fixture_dir, test_state, MockUpstream, Script,
};
use ruke_attach::FixedEmbedder;

/// Ids with committed store bytes (att_golden1b = the missing-index case).
const SEEDED: &[&str] = &["att_golden1a", "att_golden1c", "att_golden1d"];

/// Seed once per test-binary process (the six tests share the store and
/// only READ it; copying is byte-for-byte from the committed fixture).
fn ensure_store_seeded() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let store = common::repo_root().join(".data").join("attach-index");
        for a in SEEDED {
            copy_tree(&store_fixture_dir(a), &store.join(a));
        }
    });
}

/// The attachment harness's recorded upstream script (`SSE_STD`): a1,
/// content "noted" — distinct from the Part-4 chat default.
fn sse_std() -> Script {
    Script::stream(vec![
        b"data: {\"id\":\"a1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"noted\"}}]}\n\n".to_vec(),
        b"data: [DONE]\n\n".to_vec(),
    ])
}

async fn replay(rel: &str) {
    ensure_store_seeded();
    let fixture = load_fixture(rel);
    let upstream = MockUpstream::start(vec![sse_std()]).await;
    let (mut state, _tmp) = test_state(Some((upstream.url().as_str(), "golden-key")));
    // The recorded embed seam: embedOne fixed pseudo-vector [1,0,0.05].
    state.attach_embedder = Arc::new(FixedEmbedder(vec![1.0, 0.0, 0.05]));

    let raw = fixture["request"]["rawBody"].as_str().unwrap();
    let (status, headers, bytes) = post_chat(&state, raw).await;
    assert_response(&fixture, rel, status, &headers, &bytes);
    assert_upstream_call(&fixture, rel, &upstream.calls());
    assert_slot_idle(&state, rel).await;
}

#[tokio::test]
async fn attachment_01_retrieval_success() {
    replay("attachments/01-retrieval-success.json").await;
}

#[tokio::test]
async fn attachment_02_missing_index_honest_block() {
    replay("attachments/02-missing-index-honest-block.json").await;
}

#[tokio::test]
async fn attachment_03_empty_index_zero_evidence() {
    replay("attachments/03-empty-index-zero-evidence.json").await;
}

#[tokio::test]
async fn attachment_04_video_time_range_keyframes_dropped() {
    replay("attachments/04-video-time-range-keyframes-dropped.json").await;
}

#[tokio::test]
async fn attachment_05_video_frames_with_skill_shift() {
    replay("attachments/05-video-frames-with-skill-shift.json").await;
}

#[tokio::test]
async fn attachment_06_legacy_parity() {
    replay("attachments/06-legacy-parity.json").await;
}
