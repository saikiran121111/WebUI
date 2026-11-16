//! ml_job.rs - the Rust side of a Python capability JOB (brief SS6, SS8).
//!
//! `ml_bridge` only ever READ the supervisor's `/health` and `/capabilities`,
//! so the capability jobs the supervisor can actually run had no production
//! caller: the Python video/document capabilities were reachable from a status
//! page and from nothing else (gap G1, source-confirmed 2026-11-16). This
//! module closes that seam for the MEDIA-TIMELINE family, which is the family
//! with a real TS consumer already waiting for it
//! (`lib/server/attachindex/media-hints.ts` reads `meta.observations`, and
//! nothing produced them).
//!
//! Deliberate scope, and why:
//! * the allowlist is MEDIA EVIDENCE capabilities only (`video.*`). Opening
//!   `speech.*` / `documents.*` / model-backed retrieval here would let an
//!   unauthenticated-by-model caller trigger a multi-GB worker on an arbitrary
//!   path; those families stay gated behind their own measured quality gates
//!   (they report `evaluation_required` / `license_acceptance_required`, which
//!   is a real state, not a missing feature).
//! * paths in the payload are validated against EXPLICIT ALLOWED ROOTS before
//!   anything is forwarded, so this route is not a file-read primitive. The
//!   check is canonical-path based (Windows junctions/reparse points and
//!   symlinks resolved) and tolerant of a leaf that does not exist yet, which
//!   the timeline store legitimately creates.
//! * every capability-level outcome is an HTTP 200 ENVELOPE with a typed
//!   reason. "No backend configured", "backend unreachable", "backend said
//!   failed" and "call was malformed" are different facts, and the UI/caller
//!   must be able to tell them apart. Only AUTH failures use a status code,
//!   matching the browser RPC surface (browser_routes.rs).
//! * the per-run supervisor token never enters a response body or a log line
//!   (Rule 17: log booleans).
//!
//! This module never starts a model, never downloads anything and never holds
//! an upstream inference permit: a capability job is not an inference request,
//! and conflating the two would put ffmpeg/OCR work behind the capacity-1
//! chat admission (brief SS3).

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::browser_routes::{bridge_ok, bridge_secret_present};
use crate::ml_bridge::{endpoint_from_env, EndpointError, MlEndpoint};
use crate::AppState;

/// Wire contract version shared with python-backend/ruke_ml/contracts.py.
/// A mismatch is REFUSED, never coerced (contracts.py says so explicitly).
pub const SCHEMA_VERSION: u64 = 1;

/// The capability families this route may run. See the module header: this is
/// an ALLOWLIST, and it is the mechanism by which a route that forwards file
/// paths stays safe.
pub const ALLOWED_CAPABILITIES: [&str; 4] = [
    "video.timeline",
    "video.scenes",
    "video.observations",
    "video.search_hints",
];

/// Request bound. The supervisor's own cap is 1 MiB (`config.Limits`), so a
/// larger body is refused here with an honest 413 instead of being forwarded
/// and answered by a foreign 413.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Response bound. A timeline record is bounded JSON, not a media file; the
/// frames themselves are referenced by path, never inlined.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Payload depth/fan-out/string bounds. Every one of these is a
/// general-well-formedness rule (not an example-specific rule): it bounds a
/// hostile or buggy caller while leaving a real timeline untouched.
pub const MAX_PAYLOAD_DEPTH: usize = 8;
pub const MAX_PAYLOAD_ARRAY_ITEMS: usize = 512;
pub const MAX_PAYLOAD_OBJECT_KEYS: usize = 256;
pub const MAX_PAYLOAD_STRING_CHARS: usize = 4096;
pub const MAX_PAYLOAD_TOTAL_CHARS: usize = 200_000;
pub const MAX_ID_CHARS: usize = 64;

/// Deadline law: a deadline the caller names is honoured, but bounded. An
/// absent deadline gets the default; `0`/negative/NaN is a caller bug, not a
/// request to run forever.
pub const MIN_DEADLINE_SECS: u64 = 1;
pub const MAX_DEADLINE_SECS: u64 = 600;
pub const DEFAULT_DEADLINE_SECS: u64 = 120;
/// The supervisor enforces `deadline_s` itself and answers
/// `deadline_exceeded`, which is strictly more informative than our own
/// transport timeout. So the client bound is the caller's deadline PLUS a
/// grace window, never less.
pub const CLIENT_GRACE_SECS: u64 = 5;

/// The supervisor's "the job ran and genuinely failed" status. It is a 200
/// envelope one level up, never a transport fault.
const SUPERVISOR_FAILED_STATUS: u16 = 552;

const HUMAN_START_BACKEND: &str = "start the capability backend with `npm run dev` \
    (it bootstraps python-backend and starts the supervisor)";

/// A validated job, ready to forward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec {
    pub request_id: String,
    pub run_id: String,
    pub job_id: String,
    pub capability: String,
    pub payload: Value,
    pub deadline_s: u64,
}

/// Rejections split by HTTP class: a malformed contract is 400, a bound that
/// the request itself is too big to satisfy is 413. Collapsing them would hide
/// "your payload is wrong" behind "your payload is big".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    Bad(String),
    TooLarge(String),
}

/// Why a job could not be run even though the call was well-formed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobFault {
    Timeout(String),
    Unreachable(String),
    TooLarge(String),
    /// The supervisor answered with a contract-level failure (bad contract,
    /// stale token after a restart, its own oversized-body refusal).
    Contract(String),
}

/// Canonicalize a root for containment comparison. A root that does not exist
/// yet is kept verbatim: it can still legitimately contain a path the job is
/// about to create, and refusing it would be a false negative.
pub fn canonical_root(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// The allowed roots for payload paths: the server's project root (the attach
/// index lives under `<project>/.data/attach-index`, store.ts) plus the
/// data-dir overrides the app itself understands. Anything outside these is
/// refused regardless of how it is spelled.
pub fn job_roots(project_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![canonical_root(project_root)];
    for key in ["WEBUI_DATA_DIR", "RUKE_DATA_DIR"] {
        if let Some(raw) = std::env::var_os(key) {
            let path = PathBuf::from(&raw);
            if !path.as_os_str().is_empty() {
                roots.push(canonical_root(&path));
            }
        }
    }
    roots
}

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
}

fn validated_id(body: &Value, field: &str) -> Result<String, Rejection> {
    let raw = body
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Rejection::Bad(format!("{field} must be a string")))?;
    if raw.is_empty()
        || raw.len() > MAX_ID_CHARS
        || !raw.chars().all(is_id_char)
    {
        return Err(Rejection::Bad(format!(
            "{field} must match [A-Za-z0-9._-]{{1,{MAX_ID_CHARS}}}; got a value of \
             {} characters",
            raw.chars().count()
        )));
    }
    Ok(raw.to_string())
}

/// Bound a caller-supplied payload structurally. Depth, fan-out, string size
/// and total text are all bounded; nothing here inspects VALUES, so a real
/// timeline of any size within the bounds passes untouched.
fn bound_payload(value: &Value, depth: usize, budget: &mut usize) -> Result<(), Rejection> {
    if depth > MAX_PAYLOAD_DEPTH {
        return Err(Rejection::Bad(format!(
            "payload nests deeper than {MAX_PAYLOAD_DEPTH} levels"
        )));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(s) => {
            let chars = s.chars().count();
            if chars > MAX_PAYLOAD_STRING_CHARS {
                return Err(Rejection::TooLarge(format!(
                    "a payload string is {chars} characters, above the {MAX_PAYLOAD_STRING_CHARS} \
                     per-string bound (pass a reference to a staged file, not the content)"
                )));
            }
            if chars > *budget {
                return Err(Rejection::TooLarge(format!(
                    "payload text exceeds the {MAX_PAYLOAD_TOTAL_CHARS} character bound"
                )));
            }
            *budget -= chars;
            Ok(())
        }
        Value::Array(items) => {
            if items.len() > MAX_PAYLOAD_ARRAY_ITEMS {
                return Err(Rejection::Bad(format!(
                    "payload array of {} items exceeds the {MAX_PAYLOAD_ARRAY_ITEMS} item bound",
                    items.len()
                )));
            }
            for item in items {
                bound_payload(item, depth + 1, budget)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            if map.len() > MAX_PAYLOAD_OBJECT_KEYS {
                return Err(Rejection::Bad(format!(
                    "payload object of {} keys exceeds the {MAX_PAYLOAD_OBJECT_KEYS} key bound",
                    map.len()
                )));
            }
            for (key, child) in map {
                let key_chars = key.chars().count();
                if key_chars > *budget {
                    return Err(Rejection::TooLarge(format!(
                        "payload text exceeds the {MAX_PAYLOAD_TOTAL_CHARS} character bound"
                    )));
                }
                *budget -= key_chars;
                bound_payload(child, depth + 1, budget)?;
            }
            Ok(())
        }
    }
}

/// Path law. Rejects: empty, anything containing `..`, and any path whose
/// RESOLVED location escapes the allowed roots. `canonicalize` resolves
/// Windows junctions/reparse points and symlinks, so an escape hidden behind
/// a link is caught rather than reported as "inside".
///
/// The leaf may legitimately not exist yet (the timeline store creates its
/// directory), so containment is checked on the nearest EXISTING ancestor and
/// re-checked on the full path when it does exist.
pub fn contained_path(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, Rejection> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Rejection::Bad("a payload path is empty".into()));
    }
    let given = PathBuf::from(trimmed);
    if given.components().any(|c| c == Component::ParentDir) {
        return Err(Rejection::Bad(
            "a payload path may not contain '..'; name the path directly".into(),
        ));
    }
    let absolute = if given.is_absolute() {
        given.clone()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(&given),
            Err(_) => {
                return Err(Rejection::Bad(
                    "a relative payload path could not be resolved".into(),
                ))
            }
        }
    };

    let mut anchor = absolute.clone();
    let mut tail: Vec<PathBuf> = Vec::new();
    loop {
        if anchor.exists() {
            break;
        }
        match anchor.file_name() {
            Some(name) => {
                tail.push(PathBuf::from(name));
                match anchor.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => anchor = parent.to_path_buf(),
                    _ => {
                        return Err(Rejection::Bad(
                            "a payload path has no existing ancestor to validate against".into(),
                        ))
                    }
                }
            }
            None => {
                return Err(Rejection::Bad(
                    "a payload path has no existing ancestor to validate against".into(),
                ))
            }
        }
    }
    let resolved_anchor = anchor.canonicalize().map_err(|e| {
        Rejection::Bad(format!("a payload path could not be resolved on disk ({e})"))
    })?;
    let inside = |candidate: &Path| roots.iter().any(|root| candidate.starts_with(root));
    if !inside(&resolved_anchor) {
        return Err(Rejection::Bad(
            "a payload path resolves outside the allowed data roots, so it was refused \
             (attachment indexes and staged uploads live under the project/.data roots)"
                .into(),
        ));
    }
    let mut rebuilt = resolved_anchor;
    for name in tail.iter().rev() {
        rebuilt.push(name);
    }
    if rebuilt.exists() {
        let resolved = rebuilt.canonicalize().map_err(|e| {
            Rejection::Bad(format!("a payload path could not be resolved on disk ({e})"))
        })?;
        if !inside(&resolved) {
            return Err(Rejection::Bad(
                "a payload path resolves through a link to a location outside the allowed \
                 data roots, so it was refused".into(),
            ));
        }
        return Ok(resolved);
    }
    Ok(rebuilt)
}

/// The payload keys that name a path on disk. Both are attachment-scoped
/// roots/files; the timeline store root and the media source are the only two
/// path-bearing fields the media family accepts.
const PATH_KEYS: [&str; 2] = ["root", "source"];

fn validate_paths(payload: &Value, roots: &[PathBuf]) -> Result<(), Rejection> {
    let map = match payload.as_object() {
        Some(map) => map,
        None => return Ok(()),
    };
    for key in PATH_KEYS {
        if let Some(value) = map.get(key) {
            let raw = match value.as_str() {
                Some(raw) => raw,
                None => {
                    return Err(Rejection::Bad(format!(
                        "payload.{key} must be a path string when present"
                    )))
                }
            };
            contained_path(raw, roots)?;
        }
    }
    Ok(())
}

fn validated_deadline(body: &Value) -> Result<u64, Rejection> {
    match body.get("deadline_s") {
        None | Some(Value::Null) => Ok(DEFAULT_DEADLINE_SECS),
        Some(value) => {
            let raw = value
                .as_f64()
                .ok_or_else(|| Rejection::Bad("deadline_s must be a number".into()))?;
            if !raw.is_finite() || raw <= 0.0 {
                return Err(Rejection::Bad(
                    "deadline_s must be a positive number of seconds".into(),
                ));
            }
            let secs = raw.round() as u64;
            let bounded = secs.max(MIN_DEADLINE_SECS).min(MAX_DEADLINE_SECS);
            if bounded != secs {
                tracing::warn!(
                    requested = secs,
                    clamped_to = bounded,
                    "capability job deadline clamped into the supported window"
                );
            }
            Ok(bounded)
        }
    }
}

/// Validate the caller's request. Nothing here forwards anything: it is the
/// gate, and it is a pure function so the gate itself is testable without a
/// supervisor, an environment or a network.
pub fn validate_request(body: &Value, roots: &[PathBuf]) -> Result<JobSpec, Rejection> {
    let schema = body
        .get("schema_version")
        .and_then(Value::as_u64)
        .unwrap_or(SCHEMA_VERSION);
    if schema != SCHEMA_VERSION {
        return Err(Rejection::Bad(format!(
            "schema_version {schema} is not supported by this build (it is {SCHEMA_VERSION})"
        )));
    }
    let request_id = validated_id(body, "request_id")?;
    let run_id = validated_id(body, "run_id")?;
    let job_id = validated_id(body, "job_id")?;

    let capability = body
        .get("capability")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !ALLOWED_CAPABILITIES.contains(&capability.as_str()) {
        return Err(Rejection::Bad(format!(
            "capability {capability:?} is not reachable through this route; this build exposes \
             only the media-evidence family: {}",
            ALLOWED_CAPABILITIES.join(", ")
        )));
    }

    let payload = match body.get("payload") {
        None | Some(Value::Null) => json!({}),
        Some(value @ Value::Object(_)) => value.clone(),
        Some(_) => return Err(Rejection::Bad("payload must be a JSON object".into())),
    };
    let mut budget = MAX_PAYLOAD_TOTAL_CHARS;
    bound_payload(&payload, 0, &mut budget)?;
    validate_paths(&payload, roots)?;
    let deadline_s = validated_deadline(body)?;

    Ok(JobSpec {
        request_id,
        run_id,
        job_id,
        capability,
        payload,
        deadline_s,
    })
}

fn client_timeout_for(deadline_s: u64) -> Duration {
    Duration::from_secs(deadline_s.saturating_add(CLIENT_GRACE_SECS))
}

/// Run one job against the capability backend. The token travels ONLY to the
/// already-validated loopback endpoint (ml_bridge refuses a non-loopback
/// endpoint before this is ever reached).
pub async fn run_job(
    endpoint: &MlEndpoint,
    spec: &JobSpec,
) -> Result<Value, JobFault> {
    let envelope = json!({
        "request_id": spec.request_id,
        "run_id": spec.run_id,
        "job_id": spec.job_id,
        "capability": spec.capability,
        "payload": spec.payload,
        "deadline_s": spec.deadline_s,
        "schema_version": SCHEMA_VERSION,
    });
    let payload = serde_json::to_vec(&envelope).map_err(|_| {
        JobFault::Contract("the job envelope could not be serialized".to_string())
    })?;
    let client = reqwest::Client::builder()
        .timeout(client_timeout_for(spec.deadline_s))
        .connect_timeout(Duration::from_millis(800))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let sent = client
        .post(format!("{}/job", endpoint.base))
        .header("X-Ruke-Token", endpoint.token.as_str())
        .header(CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(err) => {
            // The transport message is reqwest's own (a URL, never a header)
            // and is kept only in a log field, never in a response body.
            // Ordering matters: reqwest reports a CONNECT timeout with
            // is_timeout() too. "The connection never completed" is a
            // reachability fact, not "the job ran past its deadline", and
            // collapsing them tells the operator to raise a deadline that was
            // never the problem.
            if err.is_connect() {
                tracing::warn!(detail = %err, "capability backend unreachable for a job");
                return Err(JobFault::Unreachable(
                    "the capability backend is not answering its loopback port \
                     (the connection never completed)"
                        .to_string(),
                ));
            }
            if err.is_timeout() {
                return Err(JobFault::Timeout(format!(
                    "the capability backend did not answer within {}s",
                    spec.deadline_s + CLIENT_GRACE_SECS
                )));
            }
            tracing::warn!(detail = %err, "capability backend unreachable for a job");
            return Err(JobFault::Unreachable(
                "the capability backend is not answering its loopback port".to_string(),
            ));
        }
    };

    let status = response.status();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            if err.is_timeout() {
                return Err(JobFault::Timeout(format!(
                    "the capability backend stopped mid-response (deadline {}s + {}s grace)",
                    spec.deadline_s, CLIENT_GRACE_SECS
                )));
            }
            return Err(JobFault::Unreachable(
                "the capability backend's response could not be read".to_string(),
            ));
        }
    };
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(JobFault::TooLarge(format!(
            "the capability backend answered {} bytes, above the {MAX_RESPONSE_BYTES} byte bound",
            bytes.len()
        )));
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| {
        JobFault::Contract(format!(
            "the capability backend answered {status} with a non-JSON body"
        ))
    })?;

    if status.is_success() || status.as_u16() == SUPERVISOR_FAILED_STATUS {
        // 552 is the supervisor's "the job ran and failed" status: the body is
        // a real JobResult with a typed error, so it is passed through as a
        // result, not turned into a transport fault.
        return Ok(parsed);
    }
    let reason = parsed
        .get("error")
        .and_then(|error| error.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("unspecified");
    Err(JobFault::Contract(format!(
        "the capability backend rejected the job with HTTP {status} ({reason})"
    )))
}

fn rejection_status(rejection: &Rejection) -> StatusCode {
    match rejection {
        Rejection::Bad(_) => StatusCode::BAD_REQUEST,
        Rejection::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
    }
}

fn err(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

/// The one envelope shape every capability-level outcome uses. `state` is the
/// caller-visible lifecycle word, `reason` the typed cause (empty when the job
/// genuinely succeeded), and `result` the supervisor's JobResult when there is
/// one.
pub fn envelope(
    spec: &JobSpec,
    state: &str,
    reason: Option<&str>,
    message: Option<&str>,
    retryable: bool,
    human_step: Option<&str>,
    result: Option<Value>,
) -> Value {
    let mut out = json!({
        "state": state,
        "capability": spec.capability,
        "job_id": spec.job_id,
        "run_id": spec.run_id,
        "request_id": spec.request_id,
        "deadline_s": spec.deadline_s,
        "source": "rust-ml-job",
    });
    let has_error = reason.is_some() || message.is_some();
    if has_error {
        out["error"] = json!({
            "reason": reason.unwrap_or("internal"),
            "message": message.unwrap_or("the capability job did not complete"),
            "retryable": retryable,
            "capability": spec.capability,
            "human_step": human_step.unwrap_or(""),
        });
    }
    if let Some(value) = result {
        out["result"] = value;
    }
    out
}

/// The decision core, split from the HTTP plumbing so every branch is
/// reachable from a unit test WITHOUT touching the process environment (the
/// endpoint is passed in, which is exactly the R05 lesson: never let an
/// accidental env state stand in for the branch a test claims to cover).
pub(crate) async fn dispatch(
    endpoint: Result<MlEndpoint, EndpointError>,
    body: &Value,
    roots: &[PathBuf],
) -> Response {
    let spec = match validate_request(body, roots) {
        Ok(spec) => spec,
        Err(rejection) => {
            let message = match &rejection {
                Rejection::Bad(m) | Rejection::TooLarge(m) => m.clone(),
            };
            tracing::warn!(status = rejection_status(&rejection).as_u16(), "capability job request refused");
            return err(rejection_status(&rejection), &message);
        }
    };

    let endpoint = match endpoint {
        Ok(endpoint) => endpoint,
        Err(EndpointError::NotConfigured(detail)) => {
            return axum::Json(envelope(
                &spec,
                "unavailable",
                Some("not_configured"),
                Some(&detail),
                true,
                Some(HUMAN_START_BACKEND),
                None,
            ))
            .into_response();
        }
        Err(EndpointError::Invalid(detail)) => {
            tracing::warn!("capability backend endpoint is configured but unusable");
            return axum::Json(envelope(
                &spec,
                "unavailable",
                Some("invalid_endpoint"),
                Some(&detail),
                false,
                Some("check the supervisor rendezvous exported by the dev supervisor"),
                None,
            ))
            .into_response();
        }
    };

    match run_job(&endpoint, &spec).await {
        Ok(result) => {
            // Owned copies of the fields the envelope needs, taken before
            // `result` itself is moved into the envelope as `result`.
            let state = result
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let failed = state == "failed";
            let (reason, message, retryable, human_step) = if failed {
                let error = result.get("error");
                (
                    error
                        .and_then(|e| e.get("reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("internal")
                        .to_string(),
                    error
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("the capability job failed")
                        .to_string(),
                    error
                        .and_then(|e| e.get("retryable"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    error
                        .and_then(|e| e.get("human_step"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                )
            } else {
                (String::new(), String::new(), false, None)
            };
            (
                StatusCode::OK,
                axum::Json(envelope(
                    &spec,
                    if failed { "failed" } else { state.as_str() },
                    failed.then_some(reason.as_str()),
                    failed.then_some(message.as_str()),
                    retryable,
                    human_step.as_deref(),
                    Some(result),
                )),
            )
                .into_response()
        }
        Err(JobFault::Timeout(detail)) => (
            StatusCode::OK,
            axum::Json(envelope(
                &spec,
                "unavailable",
                Some("deadline_exceeded"),
                Some(&detail),
                true,
                Some("the job may still be running; retry, or raise the deadline deliberately"),
                None,
            )),
        )
            .into_response(),
        Err(JobFault::Unreachable(detail)) => (
            StatusCode::OK,
            axum::Json(envelope(
                &spec,
                "unavailable",
                Some("unreachable"),
                Some(&detail),
                true,
                Some("restart the capability backend (Ctrl+C then `npm run dev`)"),
                None,
            )),
        )
            .into_response(),
        Err(JobFault::TooLarge(detail)) => (
            StatusCode::OK,
            axum::Json(envelope(
                &spec,
                "unavailable",
                Some("contract_mismatch"),
                Some(&detail),
                false,
                Some("narrow the requested range or capability"),
                None,
            )),
        )
            .into_response(),
        Err(JobFault::Contract(detail)) => {
            tracing::warn!(%detail, "capability backend rejected a job envelope");
            (
                StatusCode::OK,
                axum::Json(envelope(
                    &spec,
                    "unavailable",
                    Some("contract_mismatch"),
                    Some(&detail),
                    false,
                    Some("the backend may have restarted: retry once, then check `npm run dev` health output"),
                    None,
                )),
            )
                .into_response()
        }
    }
}

/// `POST /api/ruke/ml/job` - run one media-evidence capability job.
pub async fn job_post(State(state): State<AppState>, headers: HeaderMap, req: Request) -> Response {
    if !bridge_ok(&headers) {
        tracing::warn!(
            configured = bridge_secret_present(),
            "capability job RPC refused: bridge secret mismatch"
        );
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }

    let bytes = match to_bytes(req.into_body(), MAX_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body exceeded the capability-job bound or could not be read",
            )
        }
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(value @ Value::Object(_)) => value,
        _ => return err(StatusCode::BAD_REQUEST, "invalid JSON object body"),
    };

    let roots = job_roots(&state.root);
    // Resolved exactly once, then handed to the decision core.
    dispatch(endpoint_from_env(), &body, &roots).await
}

#[cfg(test)]
mod tests {
    // Gate tests are PURE (no env, no supervisor): the R05 lesson from
    // internal_completion is that an accidental process state (an unset
    // secret, a leftover RUKE_ML_URL) silently turns a behaviour test into an
    // authentication accident. So every gate assertion goes through
    // validate_request/dispatch with the endpoint handed in explicitly.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use axum::body::Body;
    use axum::http::{header::CONTENT_TYPE, Request as HttpRequest, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt; // oneshot

    use super::*;

    const TEST_TOKEN: &str = "run-scoped-token-never-echoed";

    fn roots_under(dir: &Path) -> Vec<PathBuf> {
        vec![canonical_root(dir)]
    }

    fn body_with(capability: &str, payload: Value) -> Value {
        json!({
            "request_id": "req-1",
            "run_id": "run-1",
            "job_id": "job-1",
            "capability": capability,
            "payload": payload,
            "schema_version": SCHEMA_VERSION,
        })
    }

    fn rejection_text(rejection: &Rejection) -> String {
        match rejection {
            Rejection::Bad(message) | Rejection::TooLarge(message) => message.clone(),
        }
    }

    async fn json_body(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ── the gate ───────────────────────────────────────────────────────────

    #[test]
    fn a_capability_outside_the_allowlist_is_refused_and_named() {
        let tmp = tempfile::tempdir().unwrap();
        let rejection =
            validate_request(&body_with("embeddings", json!({})), &roots_under(tmp.path()))
                .expect_err("an off-allowlist capability must never be forwarded");
        let text = rejection_text(&rejection);
        assert!(matches!(rejection, Rejection::Bad(_)), "{text}");
        assert!(text.contains("embeddings"), "must name what was refused: {text}");
        assert!(
            text.contains("video.timeline"),
            "must name the reachable family so the caller can correct itself: {text}"
        );
    }

    #[test]
    fn a_declared_media_capability_passes_the_gate() {
        // Positive control: the allowlist is a gate, not a blocklist.
        let tmp = tempfile::tempdir().unwrap();
        let spec = validate_request(
            &body_with("video.timeline", json!({ "op": "init" })),
            &roots_under(tmp.path()),
        )
        .expect("a declared capability must pass");
        assert_eq!(spec.capability, "video.timeline");
        assert_eq!(spec.job_id, "job-1");
    }

    #[test]
    fn ids_are_validated_before_anything_else_about_them_is_assumed() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let mut body = body_with("video.timeline", json!({}));
        body["request_id"] = json!("bad id!");
        let text = rejection_text(&validate_request(&body, &roots).unwrap_err());
        assert!(text.contains("request_id"), "must name the field: {text}");

        let mut body = body_with("video.timeline", json!({}));
        body["job_id"] = json!("");
        assert!(validate_request(&body, &roots).is_err(), "an empty id is refused");

        let mut body = body_with("video.timeline", json!({}));
        body["run_id"] = json!("x".repeat(MAX_ID_CHARS + 1));
        assert!(
            validate_request(&body, &roots).is_err(),
            "an over-long id is refused"
        );
    }

    #[test]
    fn a_schema_version_mismatch_is_refused_not_coerced() {
        let tmp = tempfile::tempdir().unwrap();
        let mut body = body_with("video.timeline", json!({}));
        body["schema_version"] = json!(SCHEMA_VERSION + 1);
        let text = rejection_text(&validate_request(&body, &roots_under(tmp.path())).unwrap_err());
        assert!(text.contains("schema_version"), "{text}");
    }

    #[test]
    fn deadlines_are_defaulted_clamped_and_never_silently_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let base = body_with("video.timeline", json!({}));
        assert_eq!(
            validate_request(&base, &roots).unwrap().deadline_s,
            DEFAULT_DEADLINE_SECS,
            "an absent deadline must be the documented default, not zero"
        );
        assert_eq!(
            validate_request(
                &json!({
                    "request_id": "req-1", "run_id": "run-1", "job_id": "job-1",
                    "capability": "video.timeline", "deadline_s": 0.4
                }),
                &roots
            )
            .unwrap()
            .deadline_s,
            MIN_DEADLINE_SECS,
            "a sub-second deadline clamps up to the floor, it is never dropped"
        );
        assert_eq!(
            validate_request(
                &json!({
                    "request_id": "req-1", "run_id": "run-1", "job_id": "job-1",
                    "capability": "video.timeline", "deadline_s": 99_999
                }),
                &roots
            )
            .unwrap()
            .deadline_s,
            MAX_DEADLINE_SECS,
            "an absurd deadline clamps to the ceiling"
        );
        for bad in [json!(-5), json!("x"), json!(true), json!(0.0)] {
            let body = json!({
                "request_id": "req-1", "run_id": "run-1", "job_id": "job-1",
                "capability": "video.timeline", "deadline_s": bad
            });
            assert!(
                validate_request(&body, &roots).is_err(),
                "{bad} is not a valid deadline"
            );
        }
    }

    #[test]
    fn payload_bounds_separate_a_wrong_shape_from_a_big_call() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let wide = json!({
            "observations": (0u32..(MAX_PAYLOAD_ARRAY_ITEMS as u32 + 1)).collect::<Vec<u32>>()
        });
        let rejection = validate_request(&body_with("video.timeline", wide), &roots).unwrap_err();
        assert!(
            matches!(rejection, Rejection::Bad(_)),
            "an oversized array is a shape error, not a too-large call: {}",
            rejection_text(&rejection)
        );

        // One level past the documented ceiling, built from the constant so
        // the assertion cannot drift when the bound changes.
        let mut deep = json!({ "leaf": 1 });
        for _ in 0..(MAX_PAYLOAD_DEPTH + 2) {
            deep = json!({ "n": deep });
        }
        assert!(
            matches!(
                validate_request(&body_with("video.timeline", deep), &roots).unwrap_err(),
                Rejection::Bad(_)
            ),
            "unbounded nesting is refused"
        );

        let long = json!({ "text": "x".repeat(MAX_PAYLOAD_STRING_CHARS + 1) });
        let rejection = validate_request(&body_with("video.timeline", long), &roots).unwrap_err();
        assert!(
            matches!(rejection, Rejection::TooLarge(_)),
            "an oversized string is a TOO LARGE call, told apart from a wrong shape: {}",
            rejection_text(&rejection)
        );
    }

    // ── path law ───────────────────────────────────────────────────────────

    #[test]
    fn a_timeline_root_inside_the_allowlist_is_accepted_even_before_it_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let not_yet = tmp.path().join("timelines").join("abc123");
        let resolved = contained_path(not_yet.to_str().unwrap(), &roots)
            .expect("the timeline store legitimately creates its directory");
        assert!(resolved.starts_with(&canonical_root(tmp.path())));
    }

    #[test]
    fn a_timeline_root_outside_the_allowlist_is_refused() {
        // Hard negative: the process' own project root is NOT an allowed root
        // here, so a caller cannot name arbitrary repository files.
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let outside = std::env::current_dir()
            .unwrap()
            .join("package.json")
            .to_string_lossy()
            .to_string();
        let text = rejection_text(&contained_path(&outside, &roots).unwrap_err());
        assert!(text.contains("outside"), "must say why: {text}");
    }

    #[test]
    fn traversal_and_non_string_paths_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let sneaky = format!(
            "{}{}..",
            tmp.path().to_str().unwrap(),
            std::path::MAIN_SEPARATOR_STR
        );
        let text = rejection_text(&contained_path(&sneaky, &roots).unwrap_err());
        assert!(text.contains(".."), "must reject the spelled form: {text}");

        assert!(
            contained_path("   ", &roots).is_err(),
            "an empty path is refused"
        );

        let payload = json!({ "root": 42 });
        let text = rejection_text(
            &validate_request(&body_with("video.timeline", payload), &roots).unwrap_err(),
        );
        assert!(text.contains("root"), "must name the offending key: {text}");
    }

    #[test]
    fn the_source_key_is_held_to_the_same_law_as_the_root_key() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = roots_under(tmp.path());
        let outside = std::env::current_dir()
            .unwrap()
            .join("secret.bin")
            .to_string_lossy()
            .to_string();
        let payload = json!({ "source": outside });
        assert!(
            validate_request(&body_with("video.observations", payload), &roots).is_err(),
            "the media source path is as untrusted as the root"
        );
    }

    #[test]
    fn the_client_deadline_always_outlives_the_jobs_own_deadline() {
        assert_eq!(client_timeout_for(600), Duration::from_secs(605));
        assert_eq!(
            client_timeout_for(MIN_DEADLINE_SECS),
            Duration::from_secs(MIN_DEADLINE_SECS + CLIENT_GRACE_SECS)
        );
    }

    // ── the call to the capability backend ─────────────────────────────────

    /// A canned loopback backend: drains the request body, then answers with a
    /// fixed status/body and closes. One accept per test.
    fn stub_backend(status: u16, body: &str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = body.to_string();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let mut got = String::new();
            while !got.contains("\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => got.push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
            let head_end = match got.find("\r\n\r\n") {
                Some(at) => at,
                None => return,
            };
            let declared = got[..head_end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.trim().eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let mut have = got.len().saturating_sub(head_end + 4);
            while have < declared {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => have += n,
                }
            }
            let response = format!(
                "HTTP/1.1 {status} Answer\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        port
    }

    fn endpoint_on(port: u16) -> MlEndpoint {
        MlEndpoint {
            base: format!("http://127.0.0.1:{port}"),
            token: TEST_TOKEN.to_string(),
            supervisor_pid: None,
            source: "unit-test",
        }
    }

    fn dead_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    /// A backend that accepts the connection and then goes silent. Proving the
    /// deadline actually BOUNDS the call (R01/R04 lesson: an unbounded await
    /// is how a dev server ends up holding a job forever).
    fn silent_backend() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            std::thread::sleep(Duration::from_secs(30));
        });
        port
    }

    const FAILED_BODY: &str = r#"{"job_id":"job-1","capability":"video.timeline","state":"failed","payload":null,"schema_version":1,"error":{"reason":"model_unavailable","message":"the timeline worker is not installed","retryable":false,"human_step":"run the evaluation gate first"}}"#;

    #[tokio::test]
    async fn a_ready_job_is_passed_through_verbatim() {
        let port = stub_backend(
            200,
            r#"{"job_id":"job-1","capability":"video.timeline","state":"ready","payload":{"record":{"observations":[{"start":1.0,"end":2.0,"kind":"scene"}]}},"schema_version":1}"#,
        );
        let spec = validate_request(
            &body_with("video.timeline", json!({ "op": "init" })),
            &roots_under(Path::new(".")),
        )
        .unwrap();
        let result = run_job(&endpoint_on(port), &spec).await.unwrap();
        assert_eq!(result["state"], json!("ready"));
        assert_eq!(
            result["payload"]["record"]["observations"][0]["kind"],
            json!("scene"),
            "the timeline evidence must survive the hop untouched"
        );
    }

    #[tokio::test]
    async fn a_backend_failed_job_is_a_result_not_a_transport_fault() {
        // 552 is the supervisor's "it ran and failed" status: the typed reason
        // is a capability fact the caller must see, not a broken connection.
        let port = stub_backend(552, FAILED_BODY);
        let spec = validate_request(
            &body_with("video.timeline", json!({ "op": "observe" })),
            &roots_under(Path::new(".")),
        )
        .unwrap();
        let result = run_job(&endpoint_on(port), &spec)
            .await
            .expect("552 carries a real JobResult");
        assert_eq!(result["state"], json!("failed"));
        assert_eq!(result["error"]["reason"], json!("model_unavailable"));
    }

    #[tokio::test]
    async fn dispatch_surfaces_the_backends_own_reason_and_human_step() {
        let port = stub_backend(552, FAILED_BODY);
        let response = dispatch(
            Ok(endpoint_on(port)),
            &body_with("video.timeline", json!({ "op": "observe" })),
            &roots_under(Path::new(".")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "capability state rides the envelope");
        let body = json_body(response).await;
        assert_eq!(body["state"], json!("failed"));
        assert_eq!(body["error"]["reason"], json!("model_unavailable"));
        assert_eq!(body["error"]["human_step"], json!("run the evaluation gate first"));
        assert_eq!(body["error"]["retryable"], json!(false));
        assert_eq!(body["result"]["state"], json!("failed"));
        assert_eq!(body["source"], json!("rust-ml-job"));
        assert!(
            !body.to_string().contains(TEST_TOKEN),
            "the per-run token leaked into a response: {body}"
        );
    }

    #[tokio::test]
    async fn a_rejected_contract_is_a_named_fault_and_never_leaks_the_token() {
        let port = stub_backend(401, r#"{"error":{"reason":"contract_mismatch","message":"no token"}}"#);
        let spec = validate_request(
            &body_with("video.scenes", json!({ "duration": 12 })),
            &roots_under(Path::new(".")),
        )
        .unwrap();
        let fault = run_job(&endpoint_on(port), &spec)
            .await
            .expect_err("a 401 from the backend is not a job result");
        let text = format!("{fault:?}");
        assert!(matches!(fault, JobFault::Contract(_)), "{text}");
        assert!(text.contains("401"), "{text}");
        assert!(text.contains("contract_mismatch"), "{text}");
        assert!(
            !text.contains(TEST_TOKEN),
            "the token leaked into a fault value: {text}"
        );
    }

    #[tokio::test]
    async fn a_non_json_answer_is_a_contract_fault() {
        let port = stub_backend(200, "this is not json");
        let spec = validate_request(
            &body_with("video.search_hints", json!({})),
            &roots_under(Path::new(".")),
        )
        .unwrap();
        let fault = run_job(&endpoint_on(port), &spec)
            .await
            .expect_err("an unparseable answer cannot be a success");
        let text = format!("{fault:?}");
        assert!(matches!(fault, JobFault::Contract(_)), "{text}");
        assert!(text.contains("non-JSON"), "{text}");
    }

    #[tokio::test]
    async fn a_dead_backend_becomes_a_retryable_unavailable_envelope() {
        let response = dispatch(
            Ok(endpoint_on(dead_port())),
            &body_with("video.scenes", json!({ "duration": 12 })),
            &roots_under(Path::new(".")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["state"], json!("unavailable"));
        assert_eq!(body["error"]["reason"], json!("unreachable"));
        assert_eq!(body["error"]["retryable"], json!(true));
        assert!(!body.to_string().contains(TEST_TOKEN), "{body}");
    }

    #[tokio::test]
    async fn a_silent_backend_returns_a_deadline_fault_instead_of_hanging() {
        let port = silent_backend();
        let spec = validate_request(
            &json!({
                "request_id": "r1", "run_id": "u1", "job_id": "j1",
                "capability": "video.timeline",
                "deadline_s": MIN_DEADLINE_SECS
            }),
            &roots_under(Path::new(".")),
        )
        .unwrap();
        assert_eq!(spec.deadline_s, MIN_DEADLINE_SECS);
        let started = Instant::now();
        let fault = run_job(&endpoint_on(port), &spec)
            .await
            .expect_err("a backend that never answers cannot be a success");
        let elapsed = started.elapsed();
        let text = format!("{fault:?}");
        assert!(matches!(fault, JobFault::Timeout(_)), "{text}");
        assert!(
            elapsed < Duration::from_secs(MIN_DEADLINE_SECS + CLIENT_GRACE_SECS + 5),
            "the client deadline did not bound the call: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn no_backend_configured_says_so_with_the_real_human_step() {
        let response = dispatch(
            Err(EndpointError::NotConfigured(
                "no supervisor rendezvous was exported".to_string(),
            )),
            &body_with("video.timeline", json!({ "op": "init" })),
            &roots_under(Path::new(".")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["state"], json!("unavailable"));
        assert_eq!(body["error"]["reason"], json!("not_configured"));
        assert!(
            body["error"]["human_step"]
                .as_str()
                .unwrap_or("")
                .contains("npm run dev"),
            "the answer must carry the actual resume step: {body}"
        );
    }

    #[tokio::test]
    async fn an_unusable_endpoint_says_invalid_endpoint_not_unreachable() {
        let response = dispatch(
            Err(EndpointError::Invalid("RUKE_ML_URL is not loopback".to_string())),
            &body_with("video.timeline", json!({ "op": "init" })),
            &roots_under(Path::new(".")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["error"]["reason"], json!("invalid_endpoint"));
        assert_eq!(body["error"]["retryable"], json!(false));
    }

    #[tokio::test]
    async fn the_gate_runs_before_the_endpoint_so_a_bad_call_never_dials() {
        // If validation ran after endpoint resolution, this dead port would
        // answer with the "unreachable" envelope and the test would pass for
        // the wrong reason. It must answer 400 instead.
        let response = dispatch(
            Ok(endpoint_on(dead_port())),
            &body_with("embeddings", json!({})),
            &roots_under(Path::new(".")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    // ── the route itself ───────────────────────────────────────────────────

    fn route_state() -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let slot = Arc::new(ruke_core::slot::InferenceSlot::new());
        let store = Arc::new(crate::persistence::ConversationStore::new(
            tmp.path().join("conversations"),
        ));
        let state = crate::AppState {
            settings: Arc::new(ruke_core::settings::SettingsStore::new(
                tmp.path().join("settings.json"),
            )),
            slot: slot.clone(),
            turns: Arc::new(ruke_core::turn::TurnCounter::new()),
            admission: Arc::new(ruke_core::admission::UpstreamAdmission::with_queue(1)),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(ruke_attach::UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(crate::titles::queue::TitleQueue::new(
                store,
                slot,
                Arc::new(crate::titles::generate::UnconfiguredTitleModel),
            )),
            next_search: None,
            browser: Arc::new(ruke_browser::engine::BrowserRuntime::new(
                tmp.path().to_path_buf(),
            )),
        };
        (state, tmp)
    }

    /// The bridge secret is process-global, so it is pinned under the shared
    /// guard for the whole request, and the PINNED value and the PRESENTED
    /// header stay independent (R05).
    async fn dial_job_route(
        state: &crate::AppState,
        body: &str,
        pin: &str,
        present_header: bool,
    ) -> (tokio::sync::MutexGuard<'static, ()>, StatusCode) {
        let guard = crate::ipc::test_guard::pin_bridge_secret(pin).await;
        let mut builder = HttpRequest::builder()
            .method("POST")
            .uri("/api/ruke/ml/job")
            .header(CONTENT_TYPE, "application/json");
        if present_header {
            builder = builder.header(crate::ipc::SECRET_HEADER, pin);
        }
        let request = builder.body(Body::from(body.to_string())).unwrap();
        let status = crate::build_router(state.clone())
            .oneshot(request)
            .await
            .unwrap()
            .status();
        (guard, status)
    }

    #[tokio::test]
    async fn the_route_demands_the_bridge_secret() {
        let (state, _tmp) = route_state();
        let (_env, status) = dial_job_route(
            &state,
            r#"{"request_id":"r1","run_id":"u1","job_id":"j1","capability":"video.timeline"}"#,
            "route-must-match",
            false,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "a capability job reads files by path: it must never be open without the per-run secret"
        );
    }

    #[tokio::test]
    async fn an_authenticated_call_actually_reaches_the_gate() {
        let (state, _tmp) = route_state();
        let (_env, status) = dial_job_route(
            &state,
            r#"{"request_id":"r1","run_id":"u1","job_id":"j1","capability":"embeddings"}"#,
            "route-must-match",
            true,
        )
        .await;
        assert_ne!(
            status,
            StatusCode::UNAUTHORIZED,
            "auth accident: the gate under test was never reached"
        );
        assert_ne!(
            status,
            StatusCode::NOT_FOUND,
            "the capability route is not registered on the router"
        );
        assert_eq!(status, StatusCode::BAD_REQUEST, "the off-allowlist capability must be refused by the gate");
    }
}
