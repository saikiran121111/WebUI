//! Port of `lib/server/titles/queue.ts` — the in-process title job queue.
//!
//! Semantics carried verbatim from TS:
//! - `chain` is a MODULE-LEVEL global: ALL title jobs (every conversation)
//!   serialize process-wide, one job at a time. Reproduced with one
//!   `tokio::sync::Mutex<()>` held across a job's ENTIRE do/while rerun
//!   loop (TS `chain = chain.then(task)` chains the whole task, not one
//!   `runJob` pass). tokio's Mutex is fair (waiters get the lock in
//!   arrival order) which reproduces `chain = chain.then(task)` ordering.
//! - Per-conversation coalescing: a request landing mid-job sets the
//!   entry's `pending` flag and the job loops once more on the freshest
//!   history; the coalesced request gets NO awaited job promise (TS
//!   returns `done` but the route only awaits the QUEUED branch).
//! - Bounded retries ([`MAX_ATTEMPTS`] attempts, [`RETRY_DELAY_MS`]
//!   apart); the last valid title simply stays.
//! - Jobs are NOT tied to any HTTP request; they ARE tied to the shared
//!   inference-slot registry: the job waits for an idle window
//!   ([`IDLE_WAIT_MS`] with the 1 s poll step — inference-busy.ts
//!   defaults) and yields instantly when a user turn cancels its token
//!   mid-call.
//! - The guarded write (policy) makes an older job losing against a newer
//!   one impossible, even across queued generations.
//!
//! RECORDED MICRO-DIVERGENCES:
//! - TS `entries` check-and-remove at the loop tail is atomic by JS
//!   single-threading (no await between `while (e.pending)` and
//!   `entries.delete(id)`); Rust holds the entries lock across the
//!   pending check and the removal — same atomic window. The map guard
//!   NEVER spans an await anywhere, so a std Mutex suffices (no
//!   parking_lot dependency added to this crate).
//! - TS `startJob`'s `e.running = false;` → `entries.delete(id);` pair has
//!   no await between them either, so requestTitleGeneration's
//!   `else { e.running = true; }` branch is dead code in TS; the Rust
//!   presence-implies-running map reproduces the same unreachability.
//! - TS `runJob` THROWING (applyTitleToDoc's strict-mode TypeError, or a
//!   disk save failure) skips `entries.delete(id)` entirely: the entry
//!   leaks with running=true and every later request for that
//!   conversation returns "coalesced" forever (title never regenerates
//!   again) while the awaiting route 500s. The Rust Err path reproduces
//!   the leak exactly (entry kept, tx sends Err → route 500).
//! - A panicking job task in TS rejects the `done` promise → 500. Rust:
//!   the oneshot sender drops → the route observes a closed channel and
//!   answers 200 `{queued:true, ok:false, reason:"no-job"}`. Panic-only
//!   path; normal failures never take this branch.
//! - The `reason:"gone"` initializer of TS `startJob` is unreachable (the
//!   do-body always assigns); the Rust do-loop declares `result`
//!   uninitialized instead of carrying the dead value.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

use ruke_core::slot::InferenceSlot;
use ruke_skills::jsstr;

use crate::persistence::{now_ms, ConversationStore};
use crate::titles::generate::{self, TitleCallModel};
use crate::titles::policy::{apply_title_to_doc, first_user_text, looks_auto_title, should_generate};

const MAX_ATTEMPTS: usize = 2;
const RETRY_DELAY_MS: u64 = 3000;
/// How long a job waits for the user's slot to free up before giving up
/// (the next user turn re-requests the title anyway).
const IDLE_WAIT_MS: u64 = 30_000;

static EMPTY_MSGS: LazyLock<Value> = LazyLock::new(|| Value::Array(Vec::new()));

/// `TitleJobResult` — exactly `ok` plus optional `title`/`reason`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobResult {
    pub ok: bool,
    pub title: Option<String>,
    pub reason: Option<String>,
}

impl JobResult {
    fn ok_title(title: String) -> Self {
        Self { ok: true, title: Some(title), reason: None }
    }
    fn fail(reason: &str) -> Self {
        Self { ok: false, title: None, reason: Some(reason.to_string()) }
    }
    /// Spread into the route response: `{ queued: true, ...done }`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(self.ok));
        if let Some(t) = &self.title {
            m.insert("title".into(), Value::String(t.clone()));
        }
        if let Some(r) = &self.reason {
            m.insert("reason".into(), Value::String(r.clone()));
        }
        Value::Object(m)
    }
}

/// `TitleRequestOutcome` mapped onto the route branches:
/// - `Skipped(reason)` ⇒ `{ queued: false, reason }`
/// - `Coalesced`       ⇒ `{ queued: true, coalesced: true }` (NEVER awaited)
/// - `Queued(rx)`      ⇒ await the job (TS `done`), then `{ queued: true, ...done }`;
///   `Err` carries a TS-propagated job rejection (⇒ route 500), a closed
///   channel is the panic-only "no-job" 200 (see header).
pub enum RequestOutcome {
    Skipped(String),
    Coalesced,
    Queued(oneshot::Receiver<Result<JobResult, String>>),
}

/// `Entry { running, pending, done }` — `running` needs no field: an entry
/// lives in `entries` ONLY while running (inserted at request, removed
/// under the lock at the loop tail — TS's unreachable `running:false`
/// state, see header). `done` is the oneshot in the spawned task.
struct EntryFlag {
    pending: AtomicBool,
}

struct Inner {
    store: Arc<ConversationStore>,
    slot: Arc<InferenceSlot>,
    model: Arc<dyn TitleCallModel>,
    entries: Mutex<HashMap<String, Arc<EntryFlag>>>,
    /// The TS module-global `chain` promise: every job task awaits the
    /// previous task's COMPLETE result (held across the whole rerun loop).
    chain: AsyncMutex<()>,
}

pub struct TitleQueue {
    inner: Arc<Inner>,
}

impl Clone for TitleQueue {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

/// `parseDoc(raw)`: falsy ⇒ null; unparseable ⇒ null; a non-object
/// (number/string/bool/null) ⇒ null. Objects AND arrays pass.
fn parse_doc(raw: Option<String>) -> Option<Value> {
    let raw = raw?;
    if raw.is_empty() {
        return None; // `if (!raw)`
    }
    let doc: Value = serde_json::from_str(&raw).ok()?;
    match doc {
        Value::Object(_) | Value::Array(_) => Some(doc),
        _ => None, // `doc && typeof doc === "object"`
    }
}

/// `Array.isArray(doc.messages) ? doc.messages : []` as a borrowed view.
fn msgs_of(doc: &Value) -> &Value {
    match doc.get("messages") {
        Some(a @ Value::Array(_)) => a,
        _ => &EMPTY_MSGS,
    }
}

impl TitleQueue {
    pub fn new(store: Arc<ConversationStore>, slot: Arc<InferenceSlot>, model: Arc<dyn TitleCallModel>) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                slot,
                model,
                entries: Mutex::new(HashMap::new()),
                chain: AsyncMutex::new(()),
            }),
        }
    }

    /// `requestTitleGeneration` — eligibility decided ONLY from the STORED
    /// document; never awaits; jobs are spawned onto the serial chain.
    pub fn request(&self, id: &str, model: Option<String>, force: bool) -> RequestOutcome {
        let doc = match parse_doc(self.inner.store.get(id)) {
            Some(d) => d,
            None => return RequestOutcome::Skipped("not-found".into()),
        };
        // `const meta = doc.meta ?? {}` — a stand-in whose keys all read
        // missing matches every non-object meta too (Value::get → None).
        let meta = doc.get("meta").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        if meta.get("titleSource").and_then(Value::as_str) == Some("manual") {
            return RequestOutcome::Skipped("manual".into());
        }

        let msgs = msgs_of(&doc);
        let msg_count = msgs.as_array().map_or(0, |a| a.len()) as i64;

        if force {
            // The force "is it an auto title?" gate and the non-force
            // shouldGenerate gate are MUTUALLY EXCLUSIVE in TS
            // (`if (opts.force) { … } else if (!shouldGenerate) …`).
            // `String(meta.title ?? "")` — missing/null ⇒ "", else stringify.
            let title = match meta.get("title") {
                Some(v) if !v.is_null() => jsstr::js_to_string(v),
                _ => String::new(),
            };
            let auto = meta.get("titleSource").and_then(Value::as_str) == Some("auto")
                || looks_auto_title(&title, &first_user_text(msgs));
            if !auto {
                return RequestOutcome::Skipped("not-auto-title".into());
            }
        } else if !should_generate(&meta, msg_count, false) {
            return RequestOutcome::Skipped("fresh".into());
        }

        let flag = {
            let mut entries = self.inner.entries.lock().unwrap();
            if let Some(existing) = entries.get(id) {
                // `if (e?.running)` — presence ⇔ running (see Entry note).
                existing.pending.store(true, Ordering::Release);
                return RequestOutcome::Coalesced;
            }
            let flag = Arc::new(EntryFlag { pending: AtomicBool::new(false) });
            entries.insert(id.to_string(), Arc::clone(&flag));
            flag
        };

        let inner = Arc::clone(&self.inner);
        let id = id.to_string();
        let (tx, rx) = oneshot::channel();
        // `startJob`: task = chain.then(do/while loop); chain = task.catch(()
        // => {}) — a rejection never poisons the chain for later jobs (the
        // async Mutex guard releases on panic/cancel the same way).
        tokio::spawn(async move {
            // The chain lock spans the WHOLE loop (coalesced reruns
            // included) ⇔ TS chaining the entire task.
            let _chain = inner.chain.lock().await;
            // The TS do-body's unreachable `reason:"gone"` initializer is
            // omitted (rustc rejects the dead assignment); every path to
            // `break` assigns first, exactly like the do-body.
            let mut result: JobResult;
            loop {
                flag.pending.store(false, Ordering::Release);
                match inner.run_job(&id, model.as_deref()).await {
                    Ok(r) => result = r,
                    Err(e) => {
                        // TS: the throw skips entries.delete — the entry
                        // leaks and the awaiting route 500s. Reproduced.
                        let _ = tx.send(Err(e));
                        return;
                    }
                }
                let mut entries = inner.entries.lock().unwrap();
                if flag.pending.load(Ordering::Acquire) {
                    continue; // newer request landed mid-job — rerun on fresh history
                }
                entries.remove(&id);
                break;
            }
            let _ = tx.send(Ok(result)); // send errors ignored (client navigated away)
        });
        RequestOutcome::Queued(rx)
    }
}

impl Inner {
    /// `runJob` verbatim; TS throws (→ job promise rejects → route 500)
    /// surface as the `Err` arm.
    async fn run_job(self: &Arc<Inner>, id: &str, model: Option<&str>) -> Result<JobResult, String> {
        let doc = match parse_doc(self.store.get(id)) {
            Some(d) => d,
            None => return Ok(JobResult::fail("not-found")),
        };
        let msgs = msgs_of(&doc);
        let gen_count = msgs.as_array().map_or(0, |a| a.len()) as i64;

        // Initial title only once a meaningful assistant reply exists:
        // `m?.role === "assistant" && String(m?.content ?? "").trim()` —
        // absent/null content ⇒ "" (never "null"), trim = JS trim.
        let has_assistant = msgs.as_array().into_iter().flatten().any(|m| {
            if m.get("role").and_then(Value::as_str) != Some("assistant") {
                return false;
            }
            let text = match m.get("content") {
                None | Some(Value::Null) => String::new(),
                Some(v) => jsstr::js_to_string(v),
            };
            !jsstr::js_trim(&text).is_empty()
        });
        if !has_assistant {
            return Ok(JobResult::fail("no-assistant-reply"));
        }

        // The user's conversation always owns the shared inference slot:
        // wait for an idle window (30 s, 1 s step — inference-busy.ts).
        if !self.slot.wait_for_user_idle(Duration::from_secs(IDLE_WAIT_MS), Duration::from_secs(1)).await {
            return Ok(JobResult::fail("user-inference-busy"));
        }

        for attempt in 0..MAX_ATTEMPTS {
            let token = CancellationToken::new();
            // registerTitleCall / finally unregisterTitleCall — the guard
            // drops on EVERY path out of the plan call.
            let _guard = self.slot.title_call(token.clone());
            let title = generate::plan_title(msgs, model, &*self.model, &token).await;
            drop(_guard);
            if token.is_cancelled() {
                // A real user turn claimed the slot mid-call (`ctrl.signal
                // .aborted`). Never retry into the user's traffic — the
                // next turn's request re-runs.
                tracing::info!(id, "title job yielded to user inference");
                return Ok(JobResult::fail("yielded-to-user"));
            }
            if let Some(t) = title {
                // TS writeTitle THROW propagates out of runJob.
                match self.write_title(id, &t, gen_count)? {
                    true => {
                        tracing::info!(id, title = %t, gen_count, attempt = attempt as u64, "title generated");
                        return Ok(JobResult::ok_title(t));
                    }
                    false => return Ok(JobResult::fail("stale-or-manual")),
                }
            }
            tracing::warn!(id, attempt = attempt as u64, "title generation produced nothing usable");
            if attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
            }
        }
        Ok(JobResult::fail("generation-failed"))
    }

    /// `writeTitle` — read-modify-write under the policy guard. TS lets a
    /// `saveConversationOnDisk` throw AND propagates it out of `runJob`
    /// (the awaited job rejects → route 500); the non-object-`meta`
    /// strict-mode TypeError from `applyTitleToDoc` propagates the same
    /// way. Rust Err → route 500 (`{error}` body shape recorded).
    fn write_title(&self, id: &str, title: &str, gen_count: i64) -> Result<bool, String> {
        let mut doc = match parse_doc(self.store.get(id)) {
            Some(d) => d,
            None => return Ok(false),
        };
        match apply_title_to_doc(&mut doc, title, gen_count, now_ms()) {
            Err(e) => Err(e),
            Ok(false) => Ok(false),
            Ok(true) => self
                .store
                .save(id, &serde_json::to_string(&doc).map_err(|e| e.to_string())?)
                .map(|()| true),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use futures_util::future::BoxFuture;

    fn doc_json(msgs: &str, meta: &str) -> String {
        format!(r#"{{"id":"c","meta":{meta},"messages":{msgs}}}"#)
    }

    /// Scripted seam: one canned answer per call (None past the end), call
    /// count visible; optional gate (the FIRST call blocks until the
    /// oneshot closes) + a start Notify (pre-registered via
    /// Notified::enable — immune to notify_waiters races) + an
    /// on-call hook for mutate-the-store races + token-cancel-only mode.
    type OnCall = Box<dyn Fn(usize) + Send + Sync>;

    struct AnswerMock {
        answers: Vec<Option<String>>,
        calls: AtomicUsize,
        gate: Mutex<Option<oneshot::Receiver<()>>>,
        started: tokio::sync::Notify,
        on_call: Mutex<Option<OnCall>>,
        wait_cancel: bool,
    }

    impl AnswerMock {
        fn new(answers: Vec<Option<String>>) -> Self {
            Self {
                answers,
                calls: AtomicUsize::new(0),
                gate: Mutex::new(None),
                started: tokio::sync::Notify::new(),
                on_call: Mutex::new(None),
                wait_cancel: false,
            }
        }
        fn count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
        fn set_gate(&self, rx: oneshot::Receiver<()>) {
            *self.gate.lock().unwrap() = Some(rx);
        }
        fn set_on_call(&self, cb: impl Fn(usize) + Send + Sync + 'static) {
            *self.on_call.lock().unwrap() = Some(Box::new(cb));
        }
    }

    impl TitleCallModel for AnswerMock {
        fn call(
            &self,
            _system: String,
            _user: String,
            _model: String,
            _max_tokens: u32,
            token: CancellationToken,
        ) -> BoxFuture<'static, Option<String>> {
            let i = self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(cb) = self.on_call.lock().unwrap().as_ref() {
                cb(i);
            }
            self.started.notify_waiters();
            let gate = self.gate.lock().unwrap().take();
            let answers = self.answers.clone();
            let cancel_only = self.wait_cancel;
            Box::pin(async move {
                if cancel_only {
                    token.cancelled().await;
                    return None;
                }
                if let Some(rx) = gate {
                    let _ = rx.await;
                }
                answers.get(i).cloned().flatten()
            })
        }
    }

    /// Keep the concrete mock beside the erased Arc for assertions.
    fn mock_pair(model: Arc<AnswerMock>) -> (Arc<dyn TitleCallModel>, Arc<AnswerMock>) {
        let m: Arc<dyn TitleCallModel> = model.clone();
        (m, model)
    }

    /// Request, insisting on the Queued arm (RequestOutcome is not Debug).
    macro_rules! queued {
        ($q:expr, $id:expr, $mdl:expr, $force:expr) => {
            match $q.request($id, $mdl, $force) {
                RequestOutcome::Queued(rx) => rx,
                RequestOutcome::Skipped(r) => panic!("expected queued for $id, got skip {r}"),
                RequestOutcome::Coalesced => panic!("expected queued for $id, got coalesced"),
            }
        };
    }

    fn two_msg_store() -> (Arc<ConversationStore>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        store
            .save(
                "c1",
                &doc_json(
                    r#"[{"role":"user","content":"first ask"},{"role":"assistant","content":"a real reply"}]"#,
                    "{}",
                ),
            )
            .unwrap();
        (store, tmp)
    }

    #[test]
    fn parse_doc_table() {
        assert!(parse_doc(None).is_none());
        assert!(parse_doc(Some("".into())).is_none());
        assert!(parse_doc(Some("not json".into())).is_none());
        assert!(parse_doc(Some("42".into())).is_none());
        assert!(parse_doc(Some("\"str\"".into())).is_none());
        assert!(parse_doc(Some("null".into())).is_none());
        assert!(parse_doc(Some("true".into())).is_none());
        assert!(parse_doc(Some("[]".into())).is_some()); // arrays pass
        assert!(parse_doc(Some("{\"a\":1}".into())).is_some());
    }

    #[tokio::test]
    async fn request_skip_branches() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        let (model, _m) = mock_pair(Arc::new(AnswerMock::new(vec![])));
        let q = TitleQueue::new(store.clone(), slot, model);

        // not-found
        assert!(matches!(q.request("missing", None, false), RequestOutcome::Skipped(r) if r == "not-found"));
        // manual — the manual guard runs BEFORE the force gate (TS order)
        store
            .save(
                "man",
                &doc_json(r#"[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]"#, r#"{"titleSource":"manual"}"#),
            )
            .unwrap();
        assert!(matches!(q.request("man", None, true), RequestOutcome::Skipped(r) if r == "manual"));
        // fresh (count delta < 4)
        store.save("fr", &doc_json(r#"[{"role":"user","content":"a"}]"#, r#"{"titleGenCount":10}"#)).unwrap();
        assert!(matches!(q.request("fr", None, false), RequestOutcome::Skipped(r) if r == "fresh"));
        // force + user-authored title (not an auto prefix) ⇒ not-auto-title
        store
            .save(
                "ua",
                &doc_json(
                    r#"[{"role":"user","content":"please build the widget dashboard for us today please thanks"}]"#,
                    r#"{"title":"Widget Board"}"#,
                ),
            )
            .unwrap();
        assert!(matches!(q.request("ua", None, true), RequestOutcome::Skipped(r) if r == "not-auto-title"));
        // force + placeholder title ⇒ auto ⇒ queued (job then fails for
        // lack of an assistant reply — force SKIPS the shouldGenerate gate).
        store
            .save("ph", &doc_json(r#"[{"role":"user","content":"one user msg"}]"#, r#"{"title":"New conversation"}"#))
            .unwrap();
        let rx = queued!(q, "ph", None, true);
        let job = rx.await.unwrap().unwrap();
        assert_eq!(job, JobResult::fail("no-assistant-reply"));
    }

    #[tokio::test]
    async fn request_queued_writes_title() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        let (model, m) = mock_pair(Arc::new(AnswerMock::new(vec![Some("First Sidebar Title".into())])));
        let q = TitleQueue::new(store.clone(), slot, model);
        let rx = queued!(q, "c1", None, false);
        let job = rx.await.unwrap().unwrap();
        assert_eq!(job, JobResult::ok_title("First Sidebar Title".into()));
        assert_eq!(m.count(), 1);
        // Saved doc carries the guarded-write fields; updatedAt untouched.
        let saved: Value = serde_json::from_str(&store.get("c1").unwrap()).unwrap();
        assert_eq!(saved["meta"]["title"], Value::String("First Sidebar Title".into()));
        assert_eq!(saved["meta"]["titleSource"], Value::String("auto".into()));
        assert_eq!(saved["meta"]["titleGenCount"], Value::from(2));
        // Entry removed under the lock BEFORE the send ⇒ empty right after await.
        assert!(q.inner.entries.lock().unwrap().is_empty());
        // Second immediate request: titleGenCount=2, msgs=2 ⇒ fresh.
        assert!(matches!(q.request("c1", None, false), RequestOutcome::Skipped(r) if r == "fresh"));
    }

    #[tokio::test(start_paused = true)]
    async fn retries_then_generation_failed() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        let (model, m) = mock_pair(Arc::new(AnswerMock::new(vec![None, None])));
        let q = TitleQueue::new(store.clone(), slot, model);
        let rx = queued!(q, "c1", None, false);
        // Paused time auto-advances the 3000 ms retry sleep.
        let job = rx.await.unwrap().unwrap();
        assert_eq!(job, JobResult::fail("generation-failed"));
        assert_eq!(m.count(), MAX_ATTEMPTS);
        // No title written.
        let saved: Value = serde_json::from_str(&store.get("c1").unwrap()).unwrap();
        assert!(saved["meta"].get("title").is_none());
    }

    #[tokio::test]
    async fn coalescing_reruns_on_fresh_history() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        let mock = Arc::new(AnswerMock::new(vec![Some("First Title Kept".into()), Some("Second Title Kept".into())]));
        let (tx, rx_gate) = oneshot::channel();
        mock.set_gate(rx_gate);
        let (model, m) = mock_pair(mock);
        let q = TitleQueue::new(store.clone(), slot, model);

        // tokio 1.54: enable() registers the waiter NOW (pre-request),
        // immune to the notify_waiters race — the subscribe() analogue.
        let mut started = std::pin::pin!(m.started.notified());
        started.as_mut().enable();
        let rx1 = queued!(q, "c1", None, false);
        started.await; // job is mid-call (gate holding)
        // A newer request lands mid-job ⇒ coalesced, never awaited.
        assert!(matches!(q.request("c1", None, true), RequestOutcome::Coalesced));
        drop(tx); // release the first call
        let job = rx1.await.unwrap().unwrap();
        assert_eq!(job, JobResult::ok_title("Second Title Kept".into())); // LAST result wins
        assert_eq!(m.count(), 2);
        let saved: Value = serde_json::from_str(&store.get("c1").unwrap()).unwrap();
        assert_eq!(saved["meta"]["title"], Value::String("Second Title Kept".into()));
        assert!(q.inner.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn chain_serializes_across_conversations() {
        let (store, _t) = two_msg_store();
        store
            .save(
                "c2",
                &doc_json(r#"[{"role":"user","content":"ask two"},{"role":"assistant","content":"reply two"}]"#, "{}"),
            )
            .unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let mock = Arc::new(AnswerMock::new(vec![Some("Title One".into()), Some("Title Two".into())]));
        let (tx, rx_gate) = oneshot::channel();
        mock.set_gate(rx_gate);
        let (model, m) = mock_pair(mock);
        let q = TitleQueue::new(store.clone(), slot, model);

        let mut started = std::pin::pin!(m.started.notified());
        started.as_mut().enable(); // registered NOW (pre-request)
        let rx1 = queued!(q, "c1", None, false);
        started.await;
        let rx2 = queued!(q, "c2", None, false);
        // c2's job must NOT reach the model while c1's job holds the chain
        // (the global chain spans each task's whole run).
        assert_eq!(m.count(), 1);
        drop(tx);
        assert_eq!(rx1.await.unwrap().unwrap(), JobResult::ok_title("Title One".into()));
        assert_eq!(rx2.await.unwrap().unwrap(), JobResult::ok_title("Title Two".into()));
        assert_eq!(m.count(), 2);
    }

    #[tokio::test]
    async fn user_turn_mid_call_yields_without_retry() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        // Each call returns ONLY on token cancel (TS: the registered
        // controller aborts the fetch → plan null, aborted=true).
        let mock = Arc::new(AnswerMock { wait_cancel: true, ..AnswerMock::new(vec![]) });
        let (model, m) = mock_pair(mock);
        let q = TitleQueue::new(store.clone(), slot.clone(), model);

        let mut started = std::pin::pin!(m.started.notified());
        started.as_mut().enable(); // registered NOW (pre-request)
        let rx = queued!(q, "c1", None, false);
        started.await; // model call in flight, slot idle
        // A real user turn claims the slot mid-call: begin_user_turn
        // cancels every registered title token.
        slot.begin_user_turn();
        let job = rx.await.unwrap().unwrap();
        assert_eq!(job, JobResult::fail("yielded-to-user"));
        assert_eq!(m.count(), 1); // NEVER retries into the user's traffic
        slot.end_user_turn();
        assert!(q.inner.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_or_manual_when_doc_flips_midjob() {
        let (store, _t) = two_msg_store();
        let slot = Arc::new(InferenceSlot::new());
        let mock = Arc::new(AnswerMock::new(vec![Some("Would-be Title".into())]));
        // Mid-call the user renames manually (writeTitle's RELOAD sees manual).
        let st = store.clone();
        mock.set_on_call(move |_i| {
            st.save(
                "c1",
                &doc_json(
                    r#"[{"role":"user","content":"first ask"},{"role":"assistant","content":"a real reply"}]"#,
                    r#"{"titleSource":"manual","title":"My Own Name"}"#,
                ),
            )
            .unwrap();
        });
        let (model, _m) = mock_pair(mock);
        let q = TitleQueue::new(store.clone(), slot, model);
        let rx = queued!(q, "c1", None, false);
        let job = rx.await.unwrap().unwrap();
        assert_eq!(job, JobResult::fail("stale-or-manual"));
        let saved: Value = serde_json::from_str(&store.get("c1").unwrap()).unwrap();
        assert_eq!(saved["meta"]["title"], Value::String("My Own Name".into())); // manual rename wins
    }

    #[tokio::test]
    async fn write_throw_500s_and_leaks_the_entry_like_ts() {
        // Truthy string meta: the request gate reads no keys off it (not
        // manual, first-time count), run_job plans a title, then
        // applyTitleToDoc TypeErrors (strict-mode parity) → TS rejects the
        // task, SKIPS entries.delete, and the route 500s. Rust: tx Err +
        // entry kept (the coalesced-forever quirk reproduced).
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        store
            .save(
                "weird",
                r#"{"id":"weird","meta":"oops","messages":[{"role":"user","content":"ask"},{"role":"assistant","content":"reply body"}]}"#,
            )
            .unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let (model, _m) = mock_pair(Arc::new(AnswerMock::new(vec![Some("Any Title Here".into())])));
        let q = TitleQueue::new(store, slot, model);
        let rx = queued!(q, "weird", None, false);
        let res = rx.await.unwrap();
        assert!(res.is_err(), "apply TypeError must surface as Err (route 500)");
        assert!(q.inner.entries.lock().unwrap().contains_key("weird")); // leaked, like TS
        // Later requests coalesce forever against the dead entry.
        assert!(matches!(q.request("weird", None, true), RequestOutcome::Coalesced));
    }

    #[tokio::test]
    async fn no_assistant_reply_never_calls_the_model() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        // 3 messages pass the count gate but the only assistant reply is
        // blank (trim parity counts it as none).
        store
            .save(
                "noret",
                &doc_json(
                    r#"[{"role":"user","content":"one"},{"role":"assistant","content":"   "},{"role":"user","content":"two"}]"#,
                    "{}",
                ),
            )
            .unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let (model, m) = mock_pair(Arc::new(AnswerMock::new(vec![Some("Nope".into())])));
        let q = TitleQueue::new(store, slot, model);
        let rx = queued!(q, "noret", None, false);
        assert_eq!(rx.await.unwrap().unwrap(), JobResult::fail("no-assistant-reply"));
        assert_eq!(m.count(), 0);
    }
}
