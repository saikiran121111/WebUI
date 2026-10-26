//! Rule 6 cancellation hierarchy + Rule 17 turn-id observability.
//!
//! One [`TurnContext`] (root token + turn id + tracing span) is created
//! per request/turn. Every child facility — decision, attachment
//! retrieval, gate, extraction, web search, vision, the future Node
//! bridge hop, and upstream generation — gets its token from
//! [`TurnContext::child`], so a client disconnect or server-side fatal
//! cancels the whole tree, and a single failing sub-facility (non-fatal
//! per Rule 7) can cancel only its own subtree.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct TurnCounter {
    next: AtomicU64,
}

pub struct TurnContext {
    pub turn_id: u64,
    root: CancellationToken,
    pub span: tracing::Span,
}

impl TurnCounter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Monotonic per-process turn id (Rule 17: every log line for a turn
    /// carries `turn_id` via the span; secrets never appear in spans).
    pub fn turn(&self) -> Arc<TurnContext> {
        let turn_id = self.next.fetch_add(1, Ordering::Relaxed);
        let span = tracing::info_span!("turn", turn_id = turn_id);
        Arc::new(TurnContext { turn_id, root: CancellationToken::new(), span })
    }
}

impl TurnContext {
    /// Derived token: cancelled when the root cancels; cancelling it does
    /// NOT affect the root or siblings (Rule 7 non-fatal sub-failures).
    pub fn child(&self) -> CancellationToken {
        self.root.child_token()
    }

    pub fn root_token(&self) -> &CancellationToken {
        &self.root
    }

    pub fn cancel(&self) {
        self.root.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.root.is_cancelled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_monotonic_and_unique() {
        let c = TurnCounter::new();
        let a = c.turn();
        let b = c.turn();
        assert_ne!(a.turn_id, b.turn_id);
        assert!(b.turn_id > a.turn_id);
    }

    #[test]
    fn root_cancel_kills_all_descendants_tree_wide() {
        let t = TurnCounter::new().turn();
        let decision = t.child();
        let generation = t.child();
        let nested = generation.child_token(); // child of a child (sub-facility)
        assert!(!nested.is_cancelled());
        t.cancel();
        assert!(decision.is_cancelled() && generation.is_cancelled() && nested.is_cancelled());
        assert!(t.is_cancelled());
    }

    #[test]
    fn cancelling_one_subtree_leaves_siblings_and_root_alive_rule7_nonfatal() {
        let t = TurnCounter::new().turn();
        let search = t.child();
        let retrieval = t.child();
        search.child_token().cancel(); // grandchild cancel
        search.cancel();               // the search facility itself fails (non-fatal)
        assert!(search.is_cancelled());
        assert!(!retrieval.is_cancelled(), "sibling subtree untouched");
        assert!(!t.is_cancelled(), "root untouched by a non-fatal sub-failure");
    }

    #[tokio::test]
    async fn await_cancellation_pattern_used_by_all_child_work() {
        // The tokio-util documented pattern the server will use everywhere:
        // `tokio::select! { _ = token.cancelled() => ..., work => ... }`.
        let t = TurnCounter::new().turn();
        let gen = t.child();
        let joiner = tokio::spawn(async move {
            tokio::select! {
                _ = gen.cancelled() => "cancelled",
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => "finished",
            }
        });
        tokio::task::yield_now().await;
        t.cancel();
        assert_eq!(joiner.await.unwrap(), "cancelled");
    }
}
