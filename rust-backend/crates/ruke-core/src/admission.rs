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
//!
//! HANDOFF LEASE (2026-11-17 resource-aware handoff amendment): the shared
//! endpoint is capacity 1 for a reason: the
//! model weights live ONCE. A heavyweight document/media job (Python
//! `ruke_ml.handoff`) therefore takes an EXCLUSIVE cross-process lease and
//! parks the main model while it runs. An in-process semaphore cannot bound
//! an independent client (a coding CLI, a title job, another Ruke route),
//! so admission ALSO consults that lease FILE before touching the semaphore:
//! while a live lease is held, Ruke's own generation paths (chat forward,
//! web/browser rounds, titles, attachment notes, the TS helpers'
//! internal-completion route) are refused instead of auto-waking the model
//! into a window that the processing worker owns.
//!   * Refusal is BOUNDED: poll briefly ([`DEFAULT_LEASE_WAIT`]) in case the
//!     window is ending, then return [`AdmissionError::HandoffHeld`].
//!   * Fail-OPEN only on PROOF. A record that is ABSENT, or whose newest
//!     evidence (the heartbeat field OR the file mtime) is older than
//!     [`DEFAULT_LEASE_STALE`], is provably not held. A record that merely
//!     CANNOT BE READ (permission, sharing violation, a directory in its
//!     place) or CANNOT BE PARSED (blank, truncated, wrong shape) is NOT free:
//!     we cannot prove nobody owns the parked model, so admission waits behind
//!     it exactly as behind a live holder. Its own file age is the only thing
//!     that can age it out, and an age that cannot be read is UNKNOWN, never
//!     zero — never treated as "infinitely old" (which would silently admit)
//!     nor "infinitely fresh" (which would park the endpoint forever).
//!   * The lease is never created, deleted or overwritten here. Ruke does
//!     not steal a foreign lock, it declines to enter.

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

/// How stale a handoff lease heartbeat must be before that is PROOF the
/// holder is gone. The holder refreshes every ~5 s, so 60 s is ~12 missed
/// refreshes: conservative enough that a minutes-long OCR page cannot be
/// mistaken for a dead holder, and still bounded so a crashed supervisor
/// cannot park the endpoint forever.
pub const DEFAULT_LEASE_STALE: Duration = Duration::from_secs(60);

/// How long admission waits for a handoff window to end before answering
/// "busy" (bounded-wait law, never an unbounded block).
pub const DEFAULT_LEASE_WAIT: Duration = Duration::from_millis(2_000);

/// Lease re-read interval. Cheap: a fixed-width local file read.
const LEASE_POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    /// The bounded wait queue is full — fail fast, never pile up.
    QueueFull,
    /// The caller's cancellation fired while queued.
    Cancelled,
    /// A live heavyweight processing job holds the exclusive endpoint lease,
    /// so the main model is deliberately parked. Distinct from QueueFull so
    /// the caller can report WHY and retry later rather than looking like
    /// generic overload.
    HandoffHeld,
}

/// Cross-process lease probe (see the module rule above).
#[derive(Debug, Clone)]
struct LeaseProbe {
    path: std::path::PathBuf,
    max_wait: Duration,
    stale_after: Duration,
}

#[derive(Debug)]
enum LeaseReading {
    /// Nothing to honour: the record genuinely is not there.
    Free(&'static str),
    /// A record exists but its newest evidence predates the stale window,
    /// i.e. it is provably abandoned.
    Stale(u64),
    /// A live holder owns the endpoint right now.
    Held { age_secs: u64, owner: String, phase: String },
    /// A record exists but this reader cannot read or parse it. NOT free: an
    /// unreadable record is not evidence that the model is unowned. It is held
    /// until its own age proves it was abandoned (`abandoned: true`), which is
    /// bounded so a broken record can never park the endpoint forever.
    Uncertain {
        age_secs: Option<u64>,
        abandoned: bool,
        why: String,
    },
}

/// Age of a coordination record in whole seconds, or `None` when its age
/// CANNOT be established. Never a fabricated zero.
fn record_age_secs(path: &std::path::Path) -> Option<u64> {
    let modified = path.metadata().and_then(|m| m.modified()).ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(now.as_secs().saturating_sub(since_epoch.as_secs()))
}

/// The single way a record we cannot use becomes an `Uncertain` reading.
fn uncertain(path: &std::path::Path, stale_after: Duration, why: &str) -> LeaseReading {
    let age_secs = record_age_secs(path);
    LeaseReading::Uncertain {
        abandoned: age_secs.map(|age| age >= stale_after.as_secs()).unwrap_or(false),
        age_secs,
        why: format!("{why} (at {})", path.display()),
    }
}

fn lease_reading(path: &std::path::Path, stale_after: Duration) -> LeaseReading {
    // Small LOCAL read. Deliberately synchronous: routing a stat + a 512-byte
    // read of a project-local file through tokio::fs would only add a
    // blocking-pool hop, and every caller is already off the hot path.
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return LeaseReading::Free("no lease file")
        }
        Err(err) => {
            // The record exists as far as this reader can tell and it simply
            // could not read it. Reporting that as "free" is the defect this
            // replaces: it let a second generation wake a model that a live
            // processing job had deliberately parked.
            return uncertain(path, stale_after, &format!("the lease record could not be read: {err}"));
        }
    };
    // The record is fixed-width and NUL-padded: everything after the first
    // NUL is padding, never a second record.
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    let text = String::from_utf8_lossy(&bytes[..end]);
    let text = text.trim();
    if text.is_empty() {
        // A writer created the file and never got a record into it. That says
        // nothing about whether the model is parked.
        return uncertain(path, stale_after, "the lease record is blank/unwritten");
    }
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(err) => {
            return uncertain(path, stale_after, &format!("the lease record is not parseable: {err}"))
        }
    };
    if !value.is_object() {
        return uncertain(path, stale_after, "the lease record is not an object");
    }
    if value.get("token").is_none() && value.get("owner").is_none() {
        // Nothing identifies a holder, so nothing can rule one out either.
        return uncertain(
            path,
            stale_after,
            "the lease record carries neither a token nor an owner",
        );
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or_default();
    let written = value.get("heartbeat").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let mtime_age = record_age_secs(path);
    let mtime = now - mtime_age.unwrap_or(0) as f64;
    // Heartbeat OR mtime: whichever is fresher. A holder that refreshed 1 s
    // ago is live even if the file was created an hour ago.
    let newest = written.max(mtime);
    if newest <= 0.0 {
        // A parseable record with NO timestamp: we cannot age it out, and we
        // cannot confirm a live heartbeat. Fail-safe = treat it as claimed,
        // bounded by the file's own age when that is readable at all.
        return uncertain(path, stale_after, "the lease record carries no timestamp evidence");
    }
    let age_secs = (now - newest).max(0.0) as u64;
    if age_secs >= stale_after.as_secs() {
        return LeaseReading::Stale(age_secs);
    }
    LeaseReading::Held {
        age_secs,
        owner: value
            .get("owner")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        phase: value
            .get("phase")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    }
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
    lease: Option<LeaseProbe>,
    /// How many acquires a live handoff lease refused (telemetry: an operator
    /// can SEE the gate working instead of inferring it from a 503).
    lease_refusals: AtomicUsize,
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
            lease: None,
            lease_refusals: AtomicUsize::new(0),
        }
    }

    /// Turn on the cross-process handoff lease check. Production wires this
    /// to `.ai-coordination/llm-handoff.lock`; tests leave it OFF by default
    /// so the existing capacity/queue semantics are unaffected.
    pub fn with_lease(mut self, path: impl Into<std::path::PathBuf>, max_wait: Duration) -> Self {
        self.lease = Some(LeaseProbe {
            path: path.into(),
            max_wait,
            stale_after: DEFAULT_LEASE_STALE,
        });
        self
    }

    /// Override the stale-proof window (tests). Production keeps the default.
    pub fn with_lease_stale(mut self, stale_after: Duration) -> Self {
        if let Some(p) = self.lease.as_mut() {
            p.stale_after = stale_after;
        }
        self
    }

    /// The lease path being honoured, if any (status/telemetry).
    pub fn lease_path(&self) -> Option<std::path::PathBuf> {
        self.lease.as_ref().map(|p| p.path.clone())
    }

    /// Live-handoff refusals so the gate is observable, not a guess.
    pub fn lease_refusals(&self) -> usize {
        self.lease_refusals.load(Ordering::SeqCst)
    }

    /// True right now if a LIVE handoff lease is held (status/monitoring
    /// only; the admission decision re-reads the file itself).
    pub fn handoff_held(&self) -> bool {
        match &self.lease {
            None => false,
            Some(p) => matches!(
                lease_reading(&p.path, p.stale_after),
                LeaseReading::Held { .. }
                    | LeaseReading::Uncertain {
                        abandoned: false,
                        ..
                    }
            ),
        }
    }

    /// Wait out a live lease for at most `max_wait`. Ok(()) = free to
    /// proceed; Err(HandoffHeld) = a live holder is still there;
    /// Err(Cancelled) = our own caller gave up.
    async fn await_lease(
        &self,
        probe: &LeaseProbe,
        cancel: &CancellationToken,
    ) -> Result<(), AdmissionError> {
        let started = std::time::Instant::now();
        loop {
            // What a claim looks like, for the bounded wait below.
            let (owner, phase, age_secs, uncertain_record, why);
            match lease_reading(&probe.path, probe.stale_after) {
                LeaseReading::Free(why) => {
                    if probe.path.exists() {
                        // Worth recording: a lease file EXISTS but is not
                        // honourable. If it ever happens outside a window,
                        // the evidence says which rule let us admit.
                        tracing::debug!(
                            lease = %probe.path.display(),
                            reason = why,
                            "handoff lease present but not honourable: admitting"
                        );
                    }
                    return Ok(());
                }
                LeaseReading::Stale(age) => {
                    tracing::warn!(
                        lease = %probe.path.display(),
                        age_secs = age,
                        "handoff lease is provably stale: admitting anyway (fail-open on proof)"
                    );
                    return Ok(());
                }
                LeaseReading::Uncertain {
                    age_secs: age,
                    abandoned: true,
                    why: reason,
                } => {
                    // We could not read it, but its own age proves it was
                    // abandoned. That is the BOUND that keeps a broken record
                    // from parking the endpoint forever.
                    tracing::warn!(
                        lease = %probe.path.display(),
                        age_secs = age.unwrap_or(0),
                        age_known = age.is_some(),
                        reason = %reason,
                        "handoff lease is unreadable but its own age proves it was abandoned: admitting"
                    );
                    return Ok(());
                }
                LeaseReading::Uncertain {
                    age_secs: age,
                    abandoned: false,
                    why: reason,
                } => {
                    // No usable record, no proof of abandonment: we do not get
                    // to wake a model another client may have parked.
                    owner = "unknown".to_string();
                    phase = "unreadable-record".to_string();
                    age_secs = age.unwrap_or(0);
                    uncertain_record = true;
                    why = reason;
                }
                LeaseReading::Held {
                    age_secs: age,
                    owner: who,
                    phase: stage,
                } => {
                    owner = who;
                    phase = stage;
                    age_secs = age;
                    uncertain_record = false;
                    why = String::new();
                }
            }
            if started.elapsed() >= probe.max_wait {
                self.lease_refusals.fetch_add(1, Ordering::SeqCst);
                if uncertain_record {
                    tracing::warn!(
                        lease = %probe.path.display(),
                        age_secs,
                        reason = %why,
                        waited_ms = started.elapsed().as_millis() as u64,
                        "refusing an upstream generation: a handoff lease exists that this \
                         reader cannot read or parse, so no holder can be ruled out"
                    );
                } else {
                    tracing::warn!(
                        lease = %probe.path.display(),
                        owner = %owner,
                        phase = %phase,
                        age_secs,
                        waited_ms = started.elapsed().as_millis() as u64,
                        "refusing an upstream generation: a heavyweight document/media job \
                         holds the endpoint lease and the main model is parked"
                    );
                }
                return Err(AdmissionError::HandoffHeld);
            }
            let remaining = probe.max_wait.saturating_sub(started.elapsed());
            let nap = LEASE_POLL.min(remaining);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(AdmissionError::Cancelled),
                _ = tokio::time::sleep(nap) => {}
            }
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
        // The lease gate comes FIRST: a parked model must not be woken by our
        // own retry loops, and the check costs nothing when no lease is wired.
        if let Some(probe) = self.lease.clone() {
            self.await_lease(&probe, cancel).await?;
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

    /// Write a lease record in the holder's own wire format: JSON followed by
    /// NUL padding out of a fixed width.
    fn write_lease(path: &std::path::Path, heartbeat: f64, owner: &str, phase: &str) {
        let text = format!(
            "{{\"token\":\"tok\",\"owner\":\"{owner}\",\"pid\":4242,\"phase\":\"{phase}\",\
             \"started\":{heartbeat},\"heartbeat\":{heartbeat}}}"
        );
        let mut data = text.into_bytes();
        let raw = std::fs::read(path).unwrap_or_default();
        let width = raw.len().max(512);
        data.resize(width, 0);
        std::fs::write(path, data).unwrap();
    }

    fn now_secs() -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
    }

    #[tokio::test]
    async fn a_live_handoff_lease_refuses_admission_without_touching_the_permit() {
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        write_lease(&lease, now_secs(), "handoff-cli", "processing");

        let a = UpstreamAdmission::new().with_lease(&lease, Duration::from_millis(300));
        assert!(a.handoff_held(), "a fresh heartbeat is a LIVE holder");
        let t0 = Instant::now();
        let err = a.acquire(&CancellationToken::new()).await.unwrap_err();
        assert_eq!(err, AdmissionError::HandoffHeld);
        assert!(t0.elapsed() >= Duration::from_millis(300), "it waits, not instant refusal");
        assert_eq!(a.lease_refusals(), 1, "the refusal is observable");
        assert_eq!(a.queued(), 0, "the lease gate never occupies a queue slot");
        assert!(
            !a.generation_in_flight(),
            "a refused acquire must not consume the single endpoint permit"
        );
    }

    #[tokio::test]
    async fn lease_refusal_survives_a_stale_permit_state_and_retries_are_refused() {
        // The gate is re-read per acquire: a window that is still open when
        // the client retries must still be refused (no "one free generation"
        // leak into the processing window).
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        write_lease(&lease, now_secs(), "handoff-cli", "processing");
        let a = UpstreamAdmission::new().with_lease(&lease, Duration::from_millis(50));
        for _ in 0..3 {
            assert_eq!(a.acquire(&CancellationToken::new()).await.unwrap_err(), AdmissionError::HandoffHeld);
        }
        assert_eq!(a.lease_refusals(), 3);
    }

    #[tokio::test]
    async fn a_stale_lease_fails_open_only_on_proof() {
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        // Staleness must be provable from BOTH signals, because a file that
        // was just written has a fresh mtime even if its heartbeat field is
        // ancient. So: an old heartbeat AND then real elapsed time, against
        // a one-second stale window.
        write_lease(&lease, now_secs() - 100.0, "dead-cli", "processing");
        assert!(
            matches!(lease_reading(&lease, Duration::from_secs(60)), LeaseReading::Held { .. }),
            "a file written a moment ago is still a live holder regardless of its \
             heartbeat field - mtime is the other proof"
        );
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let a = UpstreamAdmission::new()
            .with_lease(&lease, Duration::from_millis(50))
            .with_lease_stale(Duration::from_secs(1));
        assert!(!a.handoff_held(), "a dead-man lease is not a live holder");
        let permit = a.acquire(&CancellationToken::new()).await;
        assert!(permit.is_ok(), "an abandoned lease must not park the endpoint forever");
        assert_eq!(a.lease_refusals(), 0);
    }

    #[tokio::test]
    async fn unreadable_or_unparseable_lease_records_are_not_free() {
        // The defect this replaces: a blank/garbage/truncated record used to
        // read as "nobody owns the model", so a second generation woke a model
        // that a LIVE processing job had deliberately parked. An unusable
        // record is HELD-UNCERTAIN: no holder can be ruled out.
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        for (label, bytes) in [
            ("all-NUL padding", vec![0u8; 512]),
            ("not JSON at all", b"this is not json at all".to_vec()),
            ("truncated mid-write", b"{\"token\":\"aaa".to_vec()),
            ("JSON but not an object", b"[1,2,3]".to_vec()),
            ("no identity fields", b"{\"phase\":\"processing\"}".to_vec()),
        ] {
            std::fs::write(&lease, bytes).unwrap();
            assert!(
                matches!(
                    lease_reading(&lease, DEFAULT_LEASE_STALE),
                    LeaseReading::Uncertain { abandoned: false, .. }
                ),
                "{label}: an unusable record must be uncertain, never free"
            );
            if let LeaseReading::Uncertain { age_secs, .. } = lease_reading(&lease, DEFAULT_LEASE_STALE) {
                assert!(age_secs.is_some(), "{label}: the record is on disk, so its age IS knowable");
            }
            let a = UpstreamAdmission::new().with_lease(&lease, Duration::from_millis(50));
            assert!(a.handoff_held(), "{label}: uncertain counts as claimed");
            assert_eq!(
                a.acquire(&CancellationToken::new()).await.unwrap_err(),
                AdmissionError::HandoffHeld,
                "{label}: admission refuses rather than waking the model"
            );
            assert_eq!(a.lease_refusals(), 1, "{label}: the refusal is observable");
        }
    }

    #[tokio::test]
    async fn an_unreadable_record_ages_out_so_a_broken_lease_cannot_park_forever() {
        // The BOUND: an unusable record is held while it is young, and becomes
        // provably abandoned once its OWN file age passes the window.
        // The window is deliberately NOT 1s: record_age_secs() is a difference of
        // floored wall-clock seconds, so a record's measured age is up to a whole
        // second COARSER than its true elapsed time. A 1s window puts the
        // "young" assertions exactly on that quantum - a write at X.999 read at
        // X+1.000 already measures age 1, and a load spike in the full-suite run
        // does the same. 3s leaves a 2s margin for the young checks, and a 3.5s
        // real sleep guarantees age >= 3 for the aged-out checks.
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        std::fs::write(&lease, b"{" ).unwrap();
        let a = UpstreamAdmission::new()
            .with_lease(&lease, Duration::from_millis(50))
            .with_lease_stale(Duration::from_secs(3));
        assert!(a.handoff_held(), "a fresh corrupt record is not evidence of a free endpoint");
        assert_eq!(
            a.acquire(&CancellationToken::new()).await.unwrap_err(),
            AdmissionError::HandoffHeld
        );
        tokio::time::sleep(Duration::from_millis(3_500)).await;
        assert!(!a.handoff_held(), "its own age is now proof it was abandoned");
        assert!(
            a.acquire(&CancellationToken::new()).await.is_ok(),
            "the uncertainty window is bounded"
        );
    }

    #[test]
    fn a_record_that_exists_but_cannot_be_read_is_not_reported_absent() {
        // A directory where the record should be: the read fails with something
        // other than NotFound, and "absent" would be a false claim.
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        std::fs::create_dir_all(&lease).unwrap();
        match lease_reading(&lease, DEFAULT_LEASE_STALE) {
            LeaseReading::Uncertain { why, abandoned, .. } => {
                assert!(!abandoned, "it was just created, so it is not provably abandoned");
                assert!(why.contains("could not be read"), "got: {why}");
            }
            other => panic!("a directory in the record's place must be Uncertain, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_gate_waits_and_admits_once_the_window_closes() {
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        write_lease(&lease, now_secs(), "handoff-cli", "restoring_main_model");
        let release_lease = lease.clone();
        let closer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(350)).await;
            let _ = std::fs::remove_file(&release_lease);
        });
        let a = UpstreamAdmission::new().with_lease(&lease, Duration::from_millis(3_000));
        let permit = a.acquire(&CancellationToken::new()).await;
        assert!(permit.is_ok(), "a window that ends inside the wait must not be refused");
        assert_eq!(a.lease_refusals(), 0);
        closer.await.unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_caller_abandons_the_lease_wait_without_refusal_counters() {
        let dir = tempfile::tempdir().unwrap();
        let lease = dir.path().join("llm-handoff.lock");
        write_lease(&lease, now_secs(), "handoff-cli", "processing");
        let a = UpstreamAdmission::new().with_lease(&lease, Duration::from_secs(30));
        let tok = CancellationToken::new();
        let tok2 = tok.clone();
        let a = Arc::new(a);
        let a2 = Arc::clone(&a);
        let waiter = tokio::spawn(async move { a2.acquire(&tok2).await });
        tokio::time::sleep(Duration::from_millis(120)).await;
        tok.cancel();
        assert_eq!(waiter.await.unwrap().unwrap_err(), AdmissionError::Cancelled);
        assert_eq!(a.lease_refusals(), 0, "a cancel is not a refusal");
    }

    #[tokio::test]
    async fn no_lease_wired_means_the_gate_is_inert() {
        // The ~10 existing test constructors keep their exact behaviour.
        let a = UpstreamAdmission::new();
        assert!(a.lease_path().is_none());
        assert!(!a.handoff_held());
        assert!(a.acquire(&CancellationToken::new()).await.is_ok());
    }

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
