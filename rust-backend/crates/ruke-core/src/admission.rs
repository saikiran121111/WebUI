//! Shared-endpoint admission control (2026-11-15 brief §3.1).
//!
//! [`crate::slot::InferenceSlot`] counts LOGICAL user turns (a turn lease:
//! it lets titles yield to chat, and it allows N concurrent turns). This
//! module is the separate, authoritative CAPACITY-1 gate for UPSTREAM
//! GENERATION REQUESTS: at most one HTTP generation may be in flight
//! against the shared model endpoint at any instant, and the permit is
//! held across the ENTIRE streamed response (through the pump), not
//! merely until response headers arrive.
//!
//! Rules:
//! - One permit (`Semaphore::new(1)`); acquisition is FIFO-fair (tokio).
//! - Bounded queue: at most [`UpstreamAdmission::max_waiters`] callers may
//!   wait; anyone beyond that gets [`AdmissionError::QueueFull`]
//!   immediately (bounded resource law — never an unbounded queue).
//! - Queued acquisition is cancellable: dropping the wait (client abort,
//!   title yielding to a user turn) never leaks a permit
//!   (`acquire_owned` is cancel-safe).
//! - Release is exactly-once by Drop of [`AdmissionPermit`] — success,
//!   error, cancel, or panic unwind.
//! - Release of an ABANDONED generation is not instantaneous: dropping the
//!   request's read side is the only "stop generating" signal an HTTP-local
//!   model server receives, and no provider here acknowledges the stop back
//!   to us. The permit therefore stays OUT of the pool for a bounded
//!   teardown hold ([`DEFAULT_TEARDOWN_HOLD`]) so the next generation cannot
//!   be admitted onto an endpoint that may still be busy
//!   (brief 2026-11-15 R02, shared-endpoint ownership).
//! - NON-REENTANT: a caller must NEVER hold an admission permit while
//!   awaiting another admission acquire (a parent turn holds only its
//!   [`crate::slot::UserTurnGuard`] lease while its helper requests run).
//!   Call sites enforce this by acquiring immediately before each upstream
//!   POST and moving the permit into whatever pumps the response.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Default bound on simultaneously QUEUED requesters (not counting the
/// one permit holder). Beyond this, the endpoint is honestly "busy".
pub const DEFAULT_MAX_WAITERS: usize = 4;

/// How long an ABANDONED generation keeps the endpoint reserved before the
/// permit returns to the pool (see the module rule above). It is a BOUND on
/// an unobservable teardown, not a claim that the GPU stopped: no provider
/// contract in this deployment reports "generation stopped", so the safe
/// ordering is close our socket, hold, then admit the next one.
/// Measured effect: without it a client disconnect mid-body let the queued
/// request reach the mock endpoint while the abandoned generation was still
/// open there, i.e. the shared-endpoint generation high-water hit 2.
pub const DEFAULT_TEARDOWN_HOLD: Duration = Duration::from_millis(350);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    /// The bounded wait queue is full — fail fast, never pile up.
    QueueFull,
    /// The caller's cancellation fired while queued.
    Cancelled,
}

/// Hands a reserved waiter slot back on EVERY exit of [`UpstreamAdmission::acquire`],
/// including the future being DROPPED mid-await (client disconnect ⇒ axum
/// drops the handler future; a bare `fetch_sub` after the select would be
/// skipped on that path and leak queue capacity).
struct WaiterGuard<'a>(&'a AtomicUsize);

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// RAII upstream-request permit. Held from just-before the POST through
/// the full response (headers + streamed body + body drain, or the
/// request/error/cancel path). Drop releases exactly once.
#[derive(Debug)]
pub struct AdmissionPermit {
    // Option so Drop can MOVE the semaphore permit into the bounded
    // teardown task instead of returning it to the pool immediately.
    permit: Option<OwnedSemaphorePermit>,
    /// The requesting operation's cancellation token. "Cancelled" is how a
    /// Drop distinguishes an abandoned generation from a completed one.
    cancel: Option<CancellationToken>,
    teardown: Duration,
    quiescing: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else {
            return; // already handed to the teardown task
        };
        let abandoned = self.cancel.as_ref().is_some_and(|t| t.is_cancelled());
        let teardown = self.teardown;
        let quiescing = self.quiescing.clone();
        let in_runtime = tokio::runtime::Handle::try_current().ok();
        if abandoned && !self.teardown.is_zero() {
            if let Some(handle) = in_runtime {
                quiescing.store(true, Ordering::SeqCst);
                handle.spawn(async move {
                    tokio::time::sleep(teardown).await;
                    drop(permit);
                    quiescing.store(false, Ordering::SeqCst);
                });
                return;
            }
            // No runtime to schedule the hold on (process teardown): the
            // endpoint is going away with us, so release normally.
        }
        drop(permit);
    }
}

#[derive(Debug)]
pub struct UpstreamAdmission {
    sem: Arc<Semaphore>,
    waiters: AtomicUsize,
    max_waiters: usize,
    teardown: Duration,
    quiescing: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for UpstreamAdmission {
    fn default() -> Self {
        Self::new()
    }
}

impl UpstreamAdmission {
    pub fn new() -> Self {
        Self::with_queue(DEFAULT_MAX_WAITERS)
    }

    pub fn with_queue(max_waiters: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(1)),
            waiters: AtomicUsize::new(0),
            max_waiters,
            teardown: DEFAULT_TEARDOWN_HOLD,
            quiescing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Override the bounded teardown hold (tests). Not a tuning knob for
    /// production: it exists so the mechanism can be probed deterministically.
    pub fn with_teardown(mut self, teardown: Duration) -> Self {
        self.teardown = teardown;
        self
    }

    /// True while an upstream generation holds the permit (monitoring /
    /// tests; never used for the admission decision itself).
    pub fn generation_in_flight(&self) -> bool {
        self.sem.available_permits() == 0
    }

    /// True while the endpoint is reserved by a teardown hold: the
    /// generation is gone but the next one is deliberately not admitted yet.
    pub fn teardown_pending(&self) -> bool {
        self.quiescing.load(Ordering::SeqCst)
    }

    /// Current queued count (approximate; tests + telemetry).
    pub fn queued(&self) -> usize {
        self.waiters.load(Ordering::SeqCst)
    }

    /// Acquire the single upstream-generation permit, FIFO-fair, bounded
    /// queue, cancellation-aware. See module rules — the caller MUST
    /// move the returned permit into whatever owns the response pump so
    /// it is released when the RESPONSE (not the headers) completes.
    pub async fn acquire(
        &self,
        cancel: &CancellationToken,
    ) -> Result<AdmissionPermit, AdmissionError> {
        if cancel.is_cancelled() {
            return Err(AdmissionError::Cancelled);
        }
        // Bounded queue: reserve a waiter slot first, hand it back on
        // every exit path. The counter is an admission bound, not a lock —
        // a slightly racy read only shifts WHO is told "QueueFull".
        if self.waiters.fetch_add(1, Ordering::SeqCst) >= self.max_waiters {
            self.waiters.fetch_sub(1, Ordering::SeqCst);
            return Err(AdmissionError::QueueFull);
        }
        // Future-drop safety: an axum handler future can be DROPPED (not
        // polled to a cancel arm) when the client disconnects, which would
        // strand the reserved slot without this RAII hand-back.
        let _waiter = WaiterGuard(&self.waiters);
        let acquired = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            p = self.sem.clone().acquire_owned() => Some(p),
        };
        match acquired {
            None => Err(AdmissionError::Cancelled),
            Some(Ok(permit)) => Ok(AdmissionPermit {
                permit: Some(permit),
                cancel: Some(cancel.clone()),
                teardown: self.teardown,
                quiescing: self.quiescing.clone(),
            }),
            // The semaphore is never close()d in this process.
            Some(Err(_)) => Err(AdmissionError::Cancelled),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn permit_is_capacity_one_and_serializes() {
        let a = Arc::new(UpstreamAdmission::new());
        let p1 = a.acquire(&CancellationToken::new()).await.unwrap();
        assert!(a.generation_in_flight());

        let a2 = Arc::clone(&a);
        let t2 = tokio::spawn(async move {
            let p = a2.acquire(&CancellationToken::new()).await.unwrap();
            // Only reached after p1 released ⇒ overlap count is 1.
            p
        });
        tokio::task::yield_now().await;
        assert!(!t2.is_finished(), "second acquire must WAIT behind the first");

        drop(p1);
        let p2 = t2.await.unwrap();
        assert!(a.generation_in_flight());
        drop(p2);
        assert!(!a.generation_in_flight());
        assert_eq!(a.queued(), 0, "waiter slots returned on every path");
    }

    #[tokio::test]
    async fn cancel_while_queued_never_leaks_the_permit() {
        let a = Arc::new(UpstreamAdmission::new());
        let held = a.acquire(&CancellationToken::new()).await.unwrap();

        let tok = CancellationToken::new();
        let a2 = Arc::clone(&a);
        let tok2 = tok.clone();
        let waiter = tokio::spawn(async move {
            a2.acquire(&tok2).await
        });
        tokio::task::yield_now().await;
        tok.cancel();
        assert_eq!(waiter.await.unwrap().unwrap_err(), AdmissionError::Cancelled);
        assert_eq!(a.queued(), 0);

        // The permit is still intact for the next caller.
        drop(held);
        let next = a.acquire(&CancellationToken::new()).await;
        assert!(next.is_ok(), "cancelled waiter must not strand the permit");
    }

    #[tokio::test]
    async fn queue_is_bounded_fail_fast() {
        // with_queue(2): holder + 2 queued; the 4th caller is QueueFull.
        let a = Arc::new(UpstreamAdmission::with_queue(2));
        let held = a.acquire(&CancellationToken::new()).await.unwrap();
        let mut waiters = Vec::new();
        for _ in 0..2 {
            let a2 = Arc::clone(&a);
            waiters.push(tokio::spawn(async move {
                a2.acquire(&CancellationToken::new()).await
            }));
        }
        // Let both queued waiters register before probing the overflow.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let overflow = a.acquire(&CancellationToken::new()).await;
        assert_eq!(overflow.unwrap_err(), AdmissionError::QueueFull);

        drop(held);
        for w in waiters {
            assert!(w.await.unwrap().is_ok());
        }
    }

    #[tokio::test]
    async fn dropped_acquire_future_hands_back_the_waiter_slot() {
        // The axum-drop path: a handler future can be DROPPED (never
        // polled to a cancel arm) on client disconnect. The WaiterGuard
        // must return the reserved slot or queue capacity leaks forever.
        let a = Arc::new(UpstreamAdmission::new());
        let held = a.acquire(&CancellationToken::new()).await.unwrap();
        let a2 = Arc::clone(&a);
        let waiter = tokio::spawn(async move { a2.acquire(&CancellationToken::new()).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(a.queued(), 1, "waiter registered while queued");
        waiter.abort(); // drops the acquire future mid-await
        waiter.await.unwrap_err();
        assert_eq!(a.queued(), 0, "RAII guard released the slot on future-drop");
        drop(held);
        assert!(a.acquire(&CancellationToken::new()).await.is_ok());
    }

    #[tokio::test]
    async fn pre_cancelled_caller_never_enters_the_queue() {
        let a = UpstreamAdmission::new();
        let tok = CancellationToken::new();
        tok.cancel();
        assert_eq!(
            a.acquire(&tok).await.unwrap_err(),
            AdmissionError::Cancelled
        );
        assert_eq!(a.queued(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn max_concurrent_holders_is_one_under_contention() {
        // 8 racing acquirers; each holds briefly. The high-water mark of
        // simultaneous holders MUST be 1 (the endpoint capacity law).
        let a = Arc::new(UpstreamAdmission::with_queue(8));
        let active = Arc::new(AtomicUsize::new(0));
        let high = Arc::new(AtomicUsize::new(0));
        let mut js = Vec::new();
        for _ in 0..8 {
            let a = Arc::clone(&a);
            let active = Arc::clone(&active);
            let high = Arc::clone(&high);
            js.push(tokio::spawn(async move {
                let p = a.acquire(&CancellationToken::new()).await.unwrap();
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                high.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                drop(p);
            }));
        }
        for j in js {
            j.await.unwrap();
        }
        assert_eq!(high.load(Ordering::SeqCst), 1, "never more than ONE generation");
    }

    #[test]
    fn panic_unwind_releases_the_permit() {
        // Drop-on-unwind: the permit rides RAII, exactly like UserTurnGuard.
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let a = Arc::new(UpstreamAdmission::new());
        let a2 = Arc::clone(&a);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            // `_permit` lives to the closure's end — the panic unwinds it.
            let _permit = rt.block_on(a2.acquire(&CancellationToken::new())).unwrap();
            panic!("boom while holding");
        }));
        assert!(!a.generation_in_flight(), "unwind released exactly once");
    }

    #[tokio::test]
    async fn completed_generation_releases_immediately() {
        // The teardown hold is for ABANDONED generations only. A response
        // that drained to EOF cannot still be generating, so a long hold
        // would just add latency between an answer and the next request.
        let a = Arc::new(
            UpstreamAdmission::with_queue(4).with_teardown(Duration::from_millis(500)),
        );
        let token = CancellationToken::new();
        let permit = a.acquire(&token).await.unwrap();
        assert!(a.generation_in_flight());
        drop(permit); // token still live: this was a COMPLETED generation
        assert!(
            !a.generation_in_flight(),
            "a completed generation does not reserve the endpoint"
        );
        assert!(!a.teardown_pending());
    }

    #[tokio::test]
    async fn abandoned_generation_holds_the_endpoint_for_the_teardown_window() {
        // R02 (Rust side): a client that walks away mid-body must not let the
        // NEXT generation onto an endpoint that may still be generating for
        // the abandoned one. Closing our read side is the only stop signal,
        // and it is unacknowledged, hence the bounded hold.
        let hold = Duration::from_millis(150);
        let a = Arc::new(UpstreamAdmission::with_queue(4).with_teardown(hold));
        let token = CancellationToken::new();
        let permit = a.acquire(&token).await.unwrap();
        token.cancel(); // client disconnect / deadline fired mid-generation
        let t0 = Instant::now();
        drop(permit);
        assert!(
            a.generation_in_flight(),
            "the endpoint stays reserved while the abandoned read is torn down"
        );
        assert!(
            a.teardown_pending(),
            "the reservation is labelled as a teardown hold, not a live generation"
        );

        let a2 = Arc::clone(&a);
        let waiter = tokio::spawn(async move { a2.acquire(&CancellationToken::new()).await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !waiter.is_finished(),
            "no admission may happen in the middle of a teardown hold"
        );

        let got = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("the permit returns to the pool when the hold ends")
            .expect("waiter task did not panic")
            .expect("the waiter was eventually admitted");
        let total = t0.elapsed();
        assert!(
            total >= hold * 4 / 5,
            "held {total:?} for a {hold:?} window - a near-zero hold is not a bound"
        );
        assert!(!a.teardown_pending(), "the hold flag cleared with the real release");
        drop(got);
        assert!(!a.generation_in_flight());
    }
}
