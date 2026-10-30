//! cdp_buffer.rs — Phase-4 bounded per-tab CDP event replay buffer
//! (`dom-snapshot-and-cdp.md` §6/§8: "Main buffers CDP events per tab
//! with `sequence` + cursor paging (`limit` 1..1000, `hasMore`,
//! `truncated`, `source:{…sessionId?,tabId?,targetId?}`)"; spec.md:
//! "Event ring buffer semantics (sequence/hasMore/truncated) are
//! load-bearing for `tab_cdp_events`").
//!
//! The buffer layers on top of the single CDP event channel (cdp.rs):
//! the lifecycle pump pushes every event that belongs to a registered
//! tab BEFORE its registry routing, and `tab_cdp_events` serves bounded
//! replay pages from it.
//!
//! Semantics (pinned by the tests below):
//! - `sequence` is per-tab, strictly increasing, starting at 1; each
//!   event carries its `source` captured at receive time
//!   (`{tab_id, session_id, target_id}` — `extension_id` is the
//!   reference's browser-extension origin and has no Ruke analogue).
//! - Paging is cursor-exclusive: events with `sequence > cursor`,
//!   ascending, at most `limit` (engine clamps to `1..=1000`, default
//!   [`EVENTS_PAGE_DEFAULT`]; the payload schema rejects out-of-range
//!   limits up front — the clamp is the second, engine-side half of
//!   the recovered contract).
//! - `next_cursor` is the last returned sequence (or the echoed cursor
//!   when the page is empty): feeding it back resumes exactly where the
//!   page left off.
//! - `has_more` = buffered events remain beyond this page.
//! - `truncated` = the requested cursor range is INCOMPLETE because the
//!   ring evicted older events: the cursor sits strictly before the
//!   oldest retained sequence (cursor 0 — "from the beginning" — is
//!   truncated exactly when anything has been evicted).
//!
//! `Page.screencastFrame` is deliberately NOT buffered: JPEG frames are
//! UiHub's fan-out path (ref-counted screencast, Phase 3), not protocol
//! evidence, and replaying stale frames through the event buffer would
//! be both meaningless and a memory leak.

use std::collections::{HashMap, VecDeque};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::cdp::CdpEvent;
use crate::session::TabRecord;

/// Ring capacity per tab. Deliberately generous against the page cap:
/// a full 1000-event page still leaves headroom, and a tab's protocol
/// events are small JSON (frames are excluded above).
pub const TAB_EVENT_CAPACITY: usize = 2_000;

/// Default page size when `tab_cdp_events` omits `limit`.
pub const EVENTS_PAGE_DEFAULT: u64 = 100;

/// Recovered page cap (payload-validated AND engine-enforced).
pub const EVENTS_PAGE_MAX: u64 = 1_000;

/// Methods excluded from the replay buffer (see module header).
pub fn buffered_method(method: &str) -> bool {
    method != "Page.screencastFrame"
}

#[derive(Clone, Debug)]
struct BufferedEvent {
    sequence: u64,
    method: String,
    params: Value,
    tab_id: String,
    session_id: String,
    target_id: String,
}

#[derive(Default)]
struct TabEvents {
    /// Last assigned sequence (events are 1..=seq, minus evictions).
    seq: u64,
    ring: VecDeque<BufferedEvent>,
}

#[derive(Default)]
struct Buffer {
    tabs: HashMap<String, TabEvents>,
}

/// The engine-wide CDP replay buffer, one ring per tab.
#[derive(Default)]
pub struct CdpEventBuffer {
    inner: Mutex<Buffer>,
}

impl CdpEventBuffer {
    /// Buffer one pump event for its (already-resolved) tab. Returns the
    /// assigned sequence.
    pub fn push(&self, tab: &TabRecord, ev: &CdpEvent) -> u64 {
        let mut inner = self.inner.lock();
        let t = inner.tabs.entry(tab.tab_id.clone()).or_default();
        t.seq += 1;
        t.ring.push_back(BufferedEvent {
            sequence: t.seq,
            method: ev.method.clone(),
            params: ev.params.clone(),
            tab_id: tab.tab_id.clone(),
            session_id: tab.cdp_session_id.clone(),
            target_id: tab.target_id.clone(),
        });
        if t.ring.len() > TAB_EVENT_CAPACITY {
            t.ring.pop_front();
        }
        t.seq
    }

    /// One bounded replay page for a tab, `limit` already payload-
    /// validated upstream; the engine clamps independently (schema
    /// comment: cursor semantics are "enforced by the engine").
    pub fn page(&self, tab: &TabRecord, cursor: Option<u64>, limit: Option<u64>) -> Value {
        let cursor = cursor.unwrap_or(0);
        let limit = limit
            .unwrap_or(EVENTS_PAGE_DEFAULT)
            .clamp(1, EVENTS_PAGE_MAX) as usize;

        let inner = self.inner.lock();
        let t = inner.tabs.get(&tab.tab_id);
        let (oldest, newest) = match t.map(|t| t.ring.front().zip(t.ring.back())) {
            Some(Some((first, last))) => (first.sequence, last.sequence),
            _ => (0, 0),
        };
        // Gap = the cursor sits strictly before the oldest retained
        // event. With an empty ring nothing exists to be truncated;
        // with cursor 0 this is exactly "something was evicted".
        let truncated = oldest > 0 && cursor < oldest - 1;
        let start = cursor.saturating_add(1).max(oldest);

        let events: Vec<Value> = t
            .map(|t| {
                t.ring
                    .iter()
                    .filter(|e| e.sequence >= start)
                    .take(limit)
                    .map(|e| {
                        json!({
                            "sequence": e.sequence,
                            "method": e.method,
                            "params": e.params,
                            "source": {
                                "tab_id": e.tab_id,
                                "session_id": e.session_id,
                                "target_id": e.target_id,
                            },
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let next = events
            .last()
            .and_then(|e| e["sequence"].as_u64())
            .map(|s| s + 1)
            .unwrap_or(start);
        let has_more = next <= newest;
        let next_cursor = if next > cursor { next - 1 } else { cursor };

        json!({
            "tab_id": tab.tab_id,
            "source": {
                "tab_id": tab.tab_id,
                "session_id": tab.cdp_session_id,
                "target_id": tab.target_id,
            },
            "events": events,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "truncated": truncated,
        })
    }

    /// Tab gone (closed / turn cleanup): drop its ring outright.
    pub fn forget_tab(&self, tab_id: &str) {
        self.inner.lock().tabs.remove(tab_id);
    }

    /// Host death / shutdown: every ring belongs to a dead browser.
    pub fn clear(&self) {
        self.inner.lock().tabs.clear();
    }

    /// Test/inspection aid: retained event count for a tab.
    pub fn retained(&self, tab_id: &str) -> usize {
        self.inner
            .lock()
            .tabs
            .get(tab_id)
            .map(|t| t.ring.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab(id: &str) -> TabRecord {
        TabRecord {
            tab_id: id.into(),
            target_id: format!("target-{id}"),
            cdp_session_id: format!("session-{id}"),
            url: "https://x.test/".into(),
            title: String::new(),
            created_by_turn: None,
        }
    }

    fn ev(method: &str) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            session_id: Some("session-1".into()),
            params: json!({"marker": method}),
        }
    }

    fn push_n(b: &CdpEventBuffer, n: usize) {
        for i in 1..=n {
            b.push(&tab("1"), &ev(&format!("Test.event{i}")));
        }
    }

    fn events(v: &Value) -> Vec<u64> {
        v["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["sequence"].as_u64().unwrap())
            .collect()
    }

    #[test]
    fn sequences_are_per_tab_monotonic_starting_at_one() {
        let b = CdpEventBuffer::default();
        assert_eq!(b.push(&tab("1"), &ev("A.a")), 1);
        assert_eq!(b.push(&tab("1"), &ev("A.b")), 2);
        assert_eq!(b.push(&tab("2"), &ev("B.a")), 1, "per-tab numbering");
        let p1 = b.page(&tab("1"), None, None);
        assert_eq!(events(&p1), [1, 2]);
        assert_eq!(p1["source"]["session_id"], json!("session-1"));
        assert_eq!(p1["source"]["target_id"], json!("target-1"));
        assert_eq!(p1["events"][0]["source"]["tab_id"], json!("1"));
    }

    #[test]
    fn screencast_frames_are_never_buffered() {
        assert!(buffered_method("Page.loadEventFired"));
        assert!(!buffered_method("Page.screencastFrame"));
    }

    #[test]
    fn cursor_paging_walks_the_whole_ring_without_gaps_or_overlap() {
        let b = CdpEventBuffer::default();
        push_n(&b, 250);
        let mut cursor = 0u64;
        let mut seen = Vec::new();
        loop {
            let p = b.page(&tab("1"), Some(cursor), Some(100));
            let page = events(&p);
            assert!(!page.is_empty(), "paging stalled at cursor {cursor}");
            assert_eq!(page[0], cursor + 1, "cursor is exclusive");
            seen.extend(page);
            cursor = p["next_cursor"].as_u64().unwrap();
            assert_eq!(cursor, *seen.last().unwrap());
            if !p["has_more"].as_bool().unwrap() {
                break;
            }
        }
        assert_eq!(seen.len(), 250);
        assert_eq!(seen.first(), Some(&1));
        assert_eq!(seen.last(), Some(&250));
        // Every page except the last reported has_more; none truncated.
        let p = b.page(&tab("1"), Some(250), None);
        assert_eq!(events(&p).len(), 0);
        assert_eq!(p["has_more"], json!(false));
        assert_eq!(p["truncated"], json!(false));
        assert_eq!(p["next_cursor"], json!(250), "empty page echoes the cursor");
    }

    #[test]
    fn default_page_size_is_capped_and_limit_is_engine_clamped() {
        let b = CdpEventBuffer::default();
        push_n(&b, 250);
        let p = b.page(&tab("1"), None, None);
        assert_eq!(events(&p).len(), EVENTS_PAGE_DEFAULT as usize);
        assert_eq!(p["has_more"], json!(true));
        // Schema rejects 0/>1000 upstream; the engine clamps anyway
        // (defense-in-depth half of the recovered 1..=1000 rule). Push
        // past the cap so the clamp is observable, not just available.
        push_n(&b, (EVENTS_PAGE_MAX + 100) as usize);
        let big = b.page(&tab("1"), None, Some(EVENTS_PAGE_MAX + 500));
        assert_eq!(events(&big).len(), EVENTS_PAGE_MAX as usize);
        assert_eq!(events(&big).last(), Some(&EVENTS_PAGE_MAX));
        let zero = b.page(&tab("1"), None, Some(0));
        assert_eq!(events(&zero).len(), 1, "limit 0 clamps up to 1");
    }

    #[test]
    fn eviction_marks_truncated_only_for_lost_ranges() {
        let b = CdpEventBuffer::default();
        push_n(&b, TAB_EVENT_CAPACITY + 7);
        assert_eq!(b.retained("1"), TAB_EVENT_CAPACITY);
        let oldest = (7 + 1) as u64; // 7 events evicted

        // From-the-beginning query lost the evicted head.
        let p = b.page(&tab("1"), Some(0), Some(EVENTS_PAGE_MAX));
        assert_eq!(p["truncated"], json!(true));
        assert_eq!(events(&p)[0], oldest);
        assert_eq!(p["has_more"], json!(true), "the rest still pages");

        // A cursor that lands exactly on the oldest retained boundary
        // lost nothing before it.
        let p = b.page(&tab("1"), Some(oldest - 1), Some(EVENTS_PAGE_MAX));
        assert_eq!(p["truncated"], json!(false));
        assert_eq!(events(&p)[0], oldest);

        // A cursor inside the retained window: not truncated either.
        let p = b.page(&tab("1"), Some(oldest + 10), Some(5));
        assert_eq!(p["truncated"], json!(false));
        assert_eq!(events(&p), (oldest + 11..=oldest + 15).collect::<Vec<_>>());

        // A cursor in the LOST region is truncated even if it resumes
        // at the oldest.
        let p = b.page(&tab("1"), Some(3), Some(5));
        assert_eq!(p["truncated"], json!(true));
        assert_eq!(events(&p), (oldest..=oldest + 4).collect::<Vec<_>>());
    }

    #[test]
    fn empty_and_unknown_tabs_answer_an_empty_page_not_an_error() {
        let b = CdpEventBuffer::default();
        let p = b.page(&tab("9"), None, None);
        assert_eq!(events(&p).len(), 0);
        assert_eq!(p["has_more"], json!(false));
        assert_eq!(p["truncated"], json!(false));
        assert_eq!(p["next_cursor"], json!(0));
        // The tab source still describes the tab that was queried
        // (handle liveness is the registry's fail-closed job).
        assert_eq!(p["source"]["tab_id"], json!("9"));
    }

    #[test]
    fn event_params_and_methods_flow_through_verbatim() {
        let b = CdpEventBuffer::default();
        b.push(
            &tab("1"),
            &CdpEvent {
                method: "Page.frameNavigated".into(),
                session_id: Some("session-1".into()),
                params: json!({"frame": {"id": "F1", "url": "https://x.test/"}}),
            },
        );
        let p = b.page(&tab("1"), None, None);
        assert_eq!(p["events"][0]["method"], json!("Page.frameNavigated"));
        assert_eq!(
            p["events"][0]["params"]["frame"]["url"],
            json!("https://x.test/")
        );
    }

    #[test]
    fn forget_and_clear_drop_rings_outright() {
        let b = CdpEventBuffer::default();
        push_n(&b, 5);
        b.push(&tab("2"), &ev("B.a"));
        b.forget_tab("1");
        assert_eq!(b.retained("1"), 0);
        assert_eq!(b.retained("2"), 1);
        // A re-pushed tab starts its sequence fresh (tab ids are never
        // reused by the registry, so no replay ambiguity arises).
        assert_eq!(b.push(&tab("1"), &ev("A.x")), 1);
        b.clear();
        assert_eq!(b.retained("1"), 0);
        assert_eq!(b.retained("2"), 0);
    }
}
