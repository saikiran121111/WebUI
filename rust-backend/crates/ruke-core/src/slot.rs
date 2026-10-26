//! Parity port of `lib/server/inference-busy.ts` — the single inference
//! slot accounting shared by chat turns and title jobs.
//!
//! Rule 6: turn release is EXACTLY-ONCE. The TS baseline achieves it with
//! a `settled` latch; here [`UserTurnGuard`] releases on `Drop`, which
//! covers success, error, and future cancellation paths uniformly.
//!
//! Rule 16: the `parking_lot` guard is always dropped before any await;
//! `begin_user_turn` collects the title tokens under the lock, cancels
//! after releasing it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct SlotState {
    active_user_turns: usize,
    title_calls: HashMap<u64, CancellationToken>,
    next_title_id: u64,
}

#[derive(Default)]
pub struct InferenceSlot {
    state: Mutex<SlotState>,
}

impl InferenceSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parity of `beginUserTurn()`: increment the counter and abort every
    /// in-flight title call (titles yield to user inference).
    pub fn begin_user_turn(&self) {
        let handles = {
            let mut s = self.state.lock();
            s.active_user_turns += 1;
            s.title_calls.values().cloned().collect::<Vec<_>>()
        };
        for h in handles {
            h.cancel();
        }
    }

    /// Parity of `endUserTurn()`: `Math.max(0, n-1)`.
    pub fn end_user_turn(&self) {
        let mut s = self.state.lock();
        s.active_user_turns = s.active_user_turns.saturating_sub(1);
    }

    /// Rule 6 exactly-once: the returned guard releases the slot on drop
    /// (success, error, or cancellation).
    pub fn begin_guard(self: &Arc<Self>) -> UserTurnGuard {
        self.begin_user_turn();
        UserTurnGuard { slot: Arc::clone(self) }
    }

    pub fn user_turn_active(&self) -> bool {
        self.state.lock().active_user_turns > 0
    }

    pub fn active_user_turns(&self) -> usize {
        self.state.lock().active_user_turns
    }

    /// Parity of `registerTitleCall(controller)` /
    /// `unregisterTitleCall(controller)`; the token's cancel() maps to
    /// AbortController.abort().
    pub fn register_title_call(&self, token: CancellationToken) -> u64 {
        let mut s = self.state.lock();
        let id = s.next_title_id;
        s.next_title_id += 1;
        s.title_calls.insert(id, token);
        id
    }

    pub fn unregister_title_call(&self, id: u64) {
        self.state.lock().title_calls.remove(&id);
    }

    /// RAII equivalent of the titles route's `finally { unregister }`.
    pub fn title_call(self: &Arc<InferenceSlot>, token: CancellationToken) -> TitleCallGuard {
        let id = self.register_title_call(token);
        TitleCallGuard { slot: Arc::clone(self), id }
    }

    /// Parity of `waitForUserIdle(timeoutMs, stepMs = 1000)`: poll the
    /// counter; never sleep holding the lock. Returns whether idle was seen.
    pub async fn wait_for_user_idle(&self, timeout: Duration, step: Duration) -> bool {
        let start = Instant::now();
        loop {
            if !self.user_turn_active() {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(step).await;
        }
    }
}

pub struct UserTurnGuard {
    slot: Arc<InferenceSlot>,
}

impl Drop for UserTurnGuard {
    fn drop(&mut self) {
        self.slot.end_user_turn();
    }
}

pub struct TitleCallGuard {
    slot: Arc<InferenceSlot>,
    id: u64,
}

impl TitleCallGuard {
    pub fn token(&self) -> Option<CancellationToken> {
        self.slot.state.lock().title_calls.get(&self.id).cloned()
    }
}

impl Drop for TitleCallGuard {
    fn drop(&mut self) {
        self.slot.unregister_title_call(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn begin_user_turn_aborts_registered_title_tokens() {
        let slot = Arc::new(InferenceSlot::new());
        let t1 = CancellationToken::new();
        let t2 = CancellationToken::new();
        let g1 = slot.title_call(t1.clone());
        let g2 = slot.title_call(t2.clone());
        assert!(!t1.is_cancelled() && !t2.is_cancelled());

        slot.begin_user_turn();
        assert!(t1.is_cancelled() && t2.is_cancelled(), "titles yield to user turns");

        drop(g1);
        drop(g2);
        slot.end_user_turn();
        assert_eq!(slot.active_user_turns(), 0);
    }

    #[tokio::test]
    async fn guard_releases_exactly_once_on_drop_and_panics_unwind_ok() {
        let slot = Arc::new(InferenceSlot::new());
        {
            let _g = slot.begin_guard();
            assert_eq!(slot.active_user_turns(), 1);
            let _inner = slot.begin_guard();
            assert_eq!(slot.active_user_turns(), 2);
        } // both guards drop here ⇒ each releases exactly once
        assert_eq!(slot.active_user_turns(), 0);

        // Unwinding path (catch_unwind) still drops the guard exactly once.
        // AssertUnwindSafe is sound here: parking_lot guards release on
        // unwind and the slot state is a plain counter/map (no torn state).
        let s2 = Arc::clone(&slot);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _g = s2.begin_guard();
            panic!("boom");
        }));
        assert_eq!(slot.active_user_turns(), 0, "panic unwind released the turn");
    }

    #[tokio::test]
    async fn end_clamps_at_zero_like_math_max() {
        let slot = InferenceSlot::new();
        slot.end_user_turn();
        slot.end_user_turn();
        assert_eq!(slot.active_user_turns(), 0);
    }

    #[tokio::test]
    async fn title_guard_drop_unregisters() {
        let slot = Arc::new(InferenceSlot::new());
        let tok = CancellationToken::new();
        let g = slot.title_call(tok.clone());
        let id = g.id;
        drop(g);
        assert!(!slot.state.lock().title_calls.contains_key(&id));
        // A later begin must not see (or cancel) an unregistered call.
        assert!(!tok.is_cancelled());
        slot.begin_user_turn();
        assert!(!tok.is_cancelled());
    }

    #[tokio::test]
    async fn wait_for_user_idle_returns_true_when_released_and_false_on_timeout() {
        let slot = Arc::new(InferenceSlot::new());
        // Idle immediately.
        assert!(slot.wait_for_user_idle(Duration::from_millis(50), Duration::from_millis(5)).await);

        let s2 = Arc::clone(&slot);
        let releaser = tokio::spawn(async move {
            let guard = s2.begin_guard();
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(guard); // guard dropped in the task ⇒ slot freed exactly once
        });
        // Let the task register the turn before we start polling, so the
        // "released while waiting" path is actually exercised.
        tokio::task::yield_now().await;
        assert!(slot.user_turn_active());
        assert!(slot.wait_for_user_idle(Duration::from_millis(500), Duration::from_millis(5)).await);
        releaser.await.unwrap();

        // Timeout path.
        let _g = slot.begin_guard();
        assert!(!slot.wait_for_user_idle(Duration::from_millis(20), Duration::from_millis(5)).await);
    }
}
