//! session.rs — the Ruke-side session/tab bookkeeping (plan §2.4, pure
//! logic: no CDP, fully unit-testable). The reference's per-conversation
//! browser *sessions* are a Rust construct over one shared Chromium:
//! tab groups + per-turn claims + deliverable/handoff marks + turn
//! cleanup.
//!
//! Invariants (from the claims/cleanup contract):
//! - Every tab id the model ever saw is a `tab_id`; a handle that no
//!   longer exists fails closed (`ContextUnavailable`) — stale handles are
//!   never silently re-resolved.
//! - Claims are turn-scoped and release at turn end.
//! - Deliverable/handoff marks are per-turn and latest-wins; those tabs
//!   survive turn cleanup, everything else the turn created is closed.
//! - User tabs (owner `None`) are never turn-cleaned; the agent may act
//!   on them only after an explicit claim.

use std::collections::HashMap;

use crate::errors::BrowserError;

/// `(session_id, turn_id)` — the envelope metadata pair (§2.2).
pub type TurnKey = (String, String);

#[derive(Clone, Debug, PartialEq)]
pub struct TabRecord {
    pub tab_id: String,
    pub target_id: String,
    /// Flattened CDP session for the tab; empty only in the transient
    /// pre-attach window (attach happens at registration, so in practice
    /// a registered tab always has one).
    pub cdp_session_id: String,
    pub url: String,
    pub title: String,
    /// `Some((session,turn))` ⇒ agent-created (turn-cleanup candidate);
    /// `None` ⇒ user tab.
    pub created_by_turn: Option<TurnKey>,
}

#[derive(Default, Debug)]
struct TurnBookkeeping {
    created: Vec<String>,
    deliverable: Option<String>,
    handoff: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    next_tab: u64,
    /// Insertion order — listing is deterministic, not HashMap-random.
    order: Vec<String>,
    tabs: HashMap<String, TabRecord>,
    by_target: HashMap<String, String>,
    by_session: HashMap<String, String>,
    /// tab_id → turn_id of the turn that claimed it.
    claims: HashMap<String, String>,
    turns: HashMap<TurnKey, TurnBookkeeping>,
}

impl Registry {
    /// Register a tab; ids are the reference's numeric strings
    /// ("Browser tab: N" style, N starts at 1).
    pub fn add_tab(
        &mut self,
        target_id: &str,
        cdp_session_id: &str,
        url: &str,
        title: &str,
        owner: Option<TurnKey>,
    ) -> TabRecord {
        self.next_tab += 1;
        let tab_id = self.next_tab.to_string();
        let rec = TabRecord {
            tab_id: tab_id.clone(),
            target_id: target_id.to_string(),
            cdp_session_id: cdp_session_id.to_string(),
            url: url.to_string(),
            title: title.to_string(),
            created_by_turn: owner.clone(),
        };
        self.order.push(tab_id.clone());
        self.by_target.insert(target_id.to_string(), tab_id.clone());
        if !cdp_session_id.is_empty() {
            self.by_session
                .insert(cdp_session_id.to_string(), tab_id.clone());
        }
        self.tabs.insert(tab_id.clone(), rec.clone());
        if let Some((session, turn)) = owner {
            let bk = self.turns.entry((session, turn)).or_default();
            bk.created.push(tab_id);
        }
        rec
    }

    pub fn get(&self, tab_id: &str) -> Option<&TabRecord> {
        self.tabs.get(tab_id)
    }

    /// Every model-visible tab operation enters here: a stale/unknown
    /// handle fails closed.
    pub fn require(&self, tab_id: &str) -> Result<TabRecord, BrowserError> {
        self.get(tab_id)
            .cloned()
            .ok_or(BrowserError::ContextUnavailable)
    }

    pub fn by_target(&self, target_id: &str) -> Option<&TabRecord> {
        self.by_target.get(target_id).and_then(|id| self.get(id))
    }

    pub fn by_session(&self, session_id: &str) -> Option<&TabRecord> {
        self.by_session.get(session_id).and_then(|id| self.get(id))
    }

    pub fn remove_tab(&mut self, tab_id: &str) -> Option<TabRecord> {
        let rec = self.tabs.remove(tab_id)?;
        self.order.retain(|t| t != tab_id);
        self.by_target.remove(&rec.target_id);
        self.by_session.remove(&rec.cdp_session_id);
        self.claims.remove(tab_id);
        for bk in self.turns.values_mut() {
            bk.created.retain(|t| t != tab_id);
            if bk.deliverable.as_deref() == Some(tab_id) {
                bk.deliverable = None;
            }
            if bk.handoff.as_deref() == Some(tab_id) {
                bk.handoff = None;
            }
        }
        Some(rec)
    }

    pub fn remove_by_target(&mut self, target_id: &str) -> Option<TabRecord> {
        let tab_id = self.by_target.get(target_id).cloned()?;
        self.remove_tab(&tab_id)
    }

    pub fn claim(&mut self, tab_id: &str, key: &TurnKey) -> Result<(), BrowserError> {
        self.require(tab_id)?;
        self.claims.insert(tab_id.to_string(), key.1.clone());
        Ok(())
    }

    pub fn is_claimed_by(&self, tab_id: &str, key: &TurnKey) -> bool {
        self.claims.get(tab_id).is_some_and(|t| t == &key.1)
    }

    /// Phase-2 tab-ownership floor for mutations: agent-created tabs or
    /// explicitly claimed tabs. (Phase 9 layers the per-origin authority
    /// facets on top; this rule survives it.)
    pub fn can_act_on(&self, tab_id: &str, key: &TurnKey) -> bool {
        self.get(tab_id).is_some_and(|t| {
            t.created_by_turn.as_ref() == Some(key) || self.is_claimed_by(tab_id, key)
        })
    }

    pub fn mark_deliverable(&mut self, key: &TurnKey, tab_id: &str) -> Result<(), BrowserError> {
        self.require(tab_id)?;
        // Latest-wins per the cleanup contract.
        self.turns.entry(key.clone()).or_default().deliverable = Some(tab_id.to_string());
        Ok(())
    }

    pub fn mark_handoff(&mut self, key: &TurnKey, tab_id: &str) -> Result<(), BrowserError> {
        self.require(tab_id)?;
        self.turns.entry(key.clone()).or_default().handoff = Some(tab_id.to_string());
        Ok(())
    }

    /// Keep records fresh from CDP lifecycle events. Returns whether the
    /// tab is known (unknown targets — e.g. a devtools target — are
    /// ignored by callers).
    pub fn update_by_target(
        &mut self,
        target_id: &str,
        url: Option<&str>,
        title: Option<&str>,
    ) -> bool {
        let Some(tab_id) = self.by_target.get(target_id).cloned() else {
            return false;
        };
        if let Some(rec) = self.tabs.get_mut(&tab_id) {
            if let Some(u) = url {
                rec.url = u.to_string();
            }
            if let Some(t) = title {
                rec.title = t.to_string();
            }
        }
        true
    }

    pub fn update_by_session(
        &mut self,
        session_id: &str,
        url: Option<&str>,
        title: Option<&str>,
    ) -> bool {
        let Some(tab_id) = self.by_session.get(session_id).cloned() else {
            return false;
        };
        if let Some(rec) = self.tabs.get_mut(&tab_id) {
            if let Some(u) = url {
                rec.url = u.to_string();
            }
            if let Some(t) = title {
                rec.title = t.to_string();
            }
        }
        true
    }

    pub fn set_session(&mut self, tab_id: &str, target_id: &str, cdp_session_id: &str) -> bool {
        let Some(rec) = self.tabs.get_mut(tab_id) else {
            return false;
        };
        self.by_target.remove(&rec.target_id);
        self.by_session.remove(&rec.cdp_session_id);
        rec.target_id = target_id.to_string();
        rec.cdp_session_id = cdp_session_id.to_string();
        self.by_target
            .insert(target_id.to_string(), tab_id.to_string());
        self.by_session
            .insert(cdp_session_id.to_string(), tab_id.to_string());
        true
    }

    /// Every tab, insertion order (agent + user).
    pub fn list(&self) -> Vec<TabRecord> {
        self.order
            .iter()
            .filter_map(|id| self.get(id))
            .cloned()
            .collect()
    }

    pub fn user_tabs(&self) -> Vec<TabRecord> {
        self.list()
            .into_iter()
            .filter(|t| t.created_by_turn.is_none())
            .collect()
    }

    /// End-of-turn: release this turn's claims and return the tabs turn
    /// cleanup must close — everything the turn created that is neither
    /// the deliverable nor the handoff tab (latest-wins marks). The turn
    /// bookkeeping entry is removed.
    pub fn end_turn(&mut self, key: &TurnKey) -> Vec<TabRecord> {
        self.claims.retain(|_, turn| turn != &key.1);
        let Some(bk) = self.turns.remove(key) else {
            return Vec::new();
        };
        bk.created
            .iter()
            .filter(|id| {
                bk.deliverable.as_deref() != Some(id.as_str())
                    && bk.handoff.as_deref() != Some(id.as_str())
            })
            .filter_map(|id| self.tabs.get(id).cloned())
            .collect()
    }

    /// Host death: every handle is gone; drop all tab state (claims and
    /// turn bookkeeping included). Session *names* live outside the
    /// registry and survive.
    pub fn clear_all(&mut self) {
        self.order.clear();
        self.tabs.clear();
        self.by_target.clear();
        self.by_session.clear();
        self.claims.clear();
        self.turns.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(turn: &str) -> TurnKey {
        ("sess-A".into(), turn.into())
    }

    #[test]
    fn tab_ids_are_numeric_strings_starting_at_one() {
        let mut r = Registry::default();
        let a = r.add_tab("t1", "s1", "about:blank", "", Some(key("1")));
        let b = r.add_tab("t2", "s2", "about:blank", "", Some(key("1")));
        assert_eq!(a.tab_id, "1");
        assert_eq!(b.tab_id, "2");
        assert_eq!(r.list().len(), 2);
    }

    #[test]
    fn stale_handles_fail_closed() {
        let mut r = Registry::default();
        r.add_tab("t1", "s1", "u", "ti", Some(key("1")));
        assert_eq!(
            r.require("does-not-exist").unwrap_err().code(),
            BrowserError::ContextUnavailable.code()
        );
        r.remove_tab("1");
        assert!(r.require("1").is_err());
        assert!(r.by_target("t1").is_none());
        assert!(r.by_session("s1").is_none());
    }

    #[test]
    fn claims_release_at_turn_end_and_gate_mutations() {
        let mut r = Registry::default();
        r.add_tab("user-target", "us", "https://ex.com/", "Ex", None); // user tab
        assert!(!r.can_act_on("1", &key("5")));
        r.claim("1", &key("5")).unwrap();
        assert!(r.can_act_on("1", &key("5")));
        assert!(!r.can_act_on("1", &key("6"))); // claim does not leak to another turn
        r.end_turn(&key("5"));
        assert!(!r.can_act_on("1", &key("5"))); // claim released
    }

    #[test]
    fn turn_cleanup_closes_unmarked_agent_tabs_keeps_marks() {
        let mut r = Registry::default();
        r.add_tab("a", "sa", "u1", "", Some(key("1"))); // 1: plain agent tab
        r.add_tab("b", "sb", "u2", "", Some(key("1"))); // 2: deliverable
        r.add_tab("c", "sc", "u3", "", Some(key("1"))); // 3: handoff
        r.add_tab("d", "sd", "u4", "", None); // 4: user tab
        r.claim("4", &key("1")).unwrap();
        r.mark_deliverable(&key("1"), "2").unwrap();
        r.mark_handoff(&key("1"), "3").unwrap();

        let to_close = r.end_turn(&key("1"));
        let ids: Vec<_> = to_close.iter().map(|t| t.tab_id.as_str()).collect();
        assert_eq!(ids, ["1"]); // 2,3 marked; 4 is a user tab (not turn-created)
    }

    #[test]
    fn deliverable_and_handoff_are_latest_wins() {
        let mut r = Registry::default();
        r.add_tab("a", "sa", "u", "", Some(key("1")));
        r.add_tab("b", "sb", "u", "", Some(key("1")));
        r.mark_deliverable(&key("1"), "1").unwrap();
        r.mark_deliverable(&key("1"), "2").unwrap(); // latest wins
        let closed: Vec<_> = r
            .end_turn(&key("1"))
            .iter()
            .map(|t| t.tab_id.clone())
            .collect();
        assert_eq!(closed, ["1"]); // 2 survived (re-marked), 1 did not
    }

    #[test]
    fn marks_on_closed_tabs_do_not_resurrect_or_block() {
        let mut r = Registry::default();
        r.add_tab("a", "sa", "u", "", Some(key("1")));
        r.mark_deliverable(&key("1"), "1").unwrap();
        r.remove_tab("1"); // user closed the deliverable tab mid-turn
        let to_close = r.end_turn(&key("1"));
        assert!(to_close.is_empty()); // no phantom close attempt
    }

    #[test]
    fn marking_an_unknown_tab_fails_closed() {
        let mut r = Registry::default();
        assert!(r.mark_deliverable(&key("1"), "9").is_err());
        assert!(r.mark_handoff(&key("1"), "9").is_err());
        assert!(r.claim("9", &key("1")).is_err());
    }

    #[test]
    fn lifecycle_events_update_and_remove() {
        let mut r = Registry::default();
        r.add_tab("t1", "s1", "https://a/", "A", Some(key("1")));
        assert!(r.update_by_target("t1", Some("https://b/"), Some("B")));
        assert_eq!(r.require("1").unwrap().url, "https://b/");
        assert_eq!(r.require("1").unwrap().title, "B");
        assert!(r.update_by_session("s1", None, Some("B2")));
        assert_eq!(r.require("1").unwrap().title, "B2");
        assert!(!r.update_by_target("unknown", Some("x"), None));
        assert_eq!(r.remove_by_target("t1").unwrap().tab_id, "1");
        assert!(r.list().is_empty());
    }

    #[test]
    fn clear_all_kills_every_handle_after_host_death() {
        let mut r = Registry::default();
        r.add_tab("t1", "s1", "u", "", Some(key("1")));
        r.add_tab("t2", "s2", "u", "", None);
        r.claim("2", &key("1")).unwrap();
        r.clear_all();
        assert!(r.list().is_empty());
        assert!(r.user_tabs().is_empty());
        assert!(r.require("1").is_err());
        assert!(r.require("2").is_err());
    }

    #[test]
    fn user_tabs_exclude_agent_created() {
        let mut r = Registry::default();
        r.add_tab("a", "sa", "u", "", Some(key("1")));
        r.add_tab("b", "sb", "u", "", None);
        let u = r.user_tabs();
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].tab_id, "2");
    }

    #[test]
    fn set_session_reindexes_target_and_session_maps() {
        let mut r = Registry::default();
        r.add_tab("t1", "", "u", "", None); // pre-attach placeholder
        assert!(r.by_target("t1").is_some());
        assert!(r.set_session("1", "t2", "s2"));
        assert!(r.by_target("t1").is_none());
        assert_eq!(r.by_target("t2").unwrap().tab_id, "1");
        assert_eq!(r.by_session("s2").unwrap().tab_id, "1");
    }
}
