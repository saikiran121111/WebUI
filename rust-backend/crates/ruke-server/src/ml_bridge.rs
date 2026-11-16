//! ml_bridge.rs — the Rust side of the Python capability backend (brief §6, §9).
//!
//! `scripts/dev-supervisor.mjs` starts the lightweight `ruke_ml` supervisor,
//! waits for its `/health`, and exports the rendezvous to this process
//! (`RUKE_ML_DISCOVERY` + `RUKE_ML_URL` / `RUKE_ML_TOKEN` /
//! `RUKE_ML_SECRET_FILE` / `RUKE_ML_PID`). This module is the consumer of
//! that rendezvous: Rust normally owns Python calls, so the endpoint must not
//! be a one-sided env handoff.
//!
//! Scope of THIS seam (deliberately narrow, and honest about it):
//! * resolve and validate the endpoint — loopback-only, bounded secret read,
//!   a discovery record that may point at a restarted supervisor;
//! * answer `GET /api/ruke/ml-status` with what the capability backend really
//!   is: live/dead, its state, its worker table and its declared per-capability
//!   status (`not_configured` / `evaluation_required` /
//!   `license_acceptance_required` …), never a guess;
//! * cache the capability answer briefly so status traffic cannot hammer the
//!   supervisor, and re-resolve the discovery record when the record changes.
//!
//! It NEVER: starts a model, downloads anything, runs a capability job, or
//! leaks the per-run token into a response or a log (Rule 17 — log booleans).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

/// Path of the supervisor's atomic discovery record (JSON), exported by the
/// dev supervisor. Preferred over the loose env pair because it also carries
/// the live port/pid/secret-file of the supervisor that is actually answering.
pub const ENV_ML_DISCOVERY: &str = "RUKE_ML_DISCOVERY";
pub const ENV_ML_URL: &str = "RUKE_ML_URL";
pub const ENV_ML_TOKEN: &str = "RUKE_ML_TOKEN";
pub const ENV_ML_SECRET_FILE: &str = "RUKE_ML_SECRET_FILE";
pub const ENV_ML_PID: &str = "RUKE_ML_PID";

/// Status probes are loopback: a header that does not arrive inside this
/// budget means the supervisor is gone, not slow. The probe must never become
/// the reason a status page hangs.
pub const PROBE_BUDGET: Duration = Duration::from_millis(1500);
/// Capability statuses come from a registry, not a model, so they only change
/// when a worker stage runs or an install finishes. Ten seconds is enough to
/// dedupe status polling and short enough to notice a supervisor restart.
pub const CAPABILITY_TTL: Duration = Duration::from_secs(10);
/// Hard response bound: the supervisor's own answers are small JSON. A larger
/// body is a wrong endpoint, not a big capability table.
const MAX_BODY_BYTES: usize = 512 * 1024;
/// A per-run secret is ~44 bytes; 8 KiB bounds a hostile/rotated secret file.
const MAX_SECRET_BYTES: u64 = 8 * 1024;

/// A validated capability-backend rendezvous point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlEndpoint {
    pub base: String,
    pub token: String,
    pub supervisor_pid: Option<u32>,
    /// Where the configuration came from, reported (not the values).
    pub source: &'static str,
}

/// Errors carry an operator-actionable step and must never contain the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointError {
    /// Nothing was exported: the capability backend was never started.
    NotConfigured(String),
    /// Something was exported but unusable (bad URL, non-loopback, unreadable
    /// record, oversized/empty secret file). Message names the field, never
    /// the value.
    Invalid(String),
}

fn read_bounded(path: &Path, limit: u64) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    if meta.len() > limit {
        return Err(format!("{} is larger than {limit} bytes", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8", path.display()))?;
    Ok(text.trim().to_string())
}

/// Loopback rule (brief §6): the capability backend may bind only to
/// loopback, so a client that resolves to anything else is refused rather
/// than sent a bearer token.
fn loopback_authority(raw: &str) -> Result<String, EndpointError> {
    let url = url::Url::parse(raw.trim())
        .map_err(|_| EndpointError::Invalid(format!("{ENV_ML_URL} is not a valid URL")))?;
    if url.scheme() != "http" {
        return Err(EndpointError::Invalid(format!(
            "the capability backend is loopback http only (got scheme {:?})",
            url.scheme()
        )));
    }
    if !url.path().trim_end_matches('/').is_empty() {
        // The supervisor answers /health, /capabilities and /job at the root; a path
        // prefix would silently produce /prefix/health and a 404 that reads exactly
        // like a dead supervisor. Refuse the misconfiguration instead.
        return Err(EndpointError::Invalid(format!(
            "the capability backend endpoint must not carry a path (got {:?})",
            url.path()
        )));
    }
    let host = url.host_str().unwrap_or("");
    let loopback = host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|v4| v4.is_loopback())
            .unwrap_or(false);
    if !loopback {
        return Err(EndpointError::Invalid(format!(
            "the capability backend endpoint must be loopback; {host:?} was refused \
             (the per-run token is never sent off-box)"
        )));
    }
    let port = url.port_or_known_default().unwrap_or(0);
    Ok(format!("http://{host}:{port}"))
}

/// Resolve the endpoint from the process environment. Precedence:
/// discovery record → explicit URL + token/secret-file pair.
pub fn endpoint_from_env() -> Result<MlEndpoint, EndpointError> {
    if let Some(raw) = std::env::var_os(ENV_ML_DISCOVERY) {
        let path = PathBuf::from(&raw);
        if !path.as_os_str().is_empty() {
            return endpoint_from_discovery(&path).map_err(|m| EndpointError::Invalid(m));
        }
    }
    let base_raw = std::env::var(ENV_ML_URL).unwrap_or_default();
    if base_raw.trim().is_empty() {
        return Err(EndpointError::NotConfigured(format!(
            "neither {ENV_ML_DISCOVERY} nor {ENV_ML_URL} is set: the capability \
             backend (python-backend) is not running under this supervisor"
        )));
    }
    let base = loopback_authority(&base_raw)?;
    let mut token = std::env::var(ENV_ML_TOKEN).unwrap_or_default().trim().to_string();
    if token.is_empty() {
        let secret_file = std::env::var(ENV_ML_SECRET_FILE).unwrap_or_default();
        if secret_file.trim().is_empty() {
            return Err(EndpointError::Invalid(format!(
                "{ENV_ML_URL} is set but no token is available: {ENV_ML_TOKEN} is empty \
                 and {ENV_ML_SECRET_FILE} is unset"
            )));
        }
        token = read_bounded(Path::new(&secret_file), MAX_SECRET_BYTES)
            .map_err(|e| EndpointError::Invalid(format!("{ENV_ML_SECRET_FILE}: {e}")))?;
    }
    if token.is_empty() {
        return Err(EndpointError::Invalid("the capability backend token is empty".into()));
    }
    let pid = std::env::var(ENV_ML_PID)
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok());
    Ok(MlEndpoint { base, token, supervisor_pid: pid, source: "env" })
}

fn endpoint_from_discovery(path: &Path) -> Result<MlEndpoint, String> {
    let text = read_bounded(path, MAX_BODY_BYTES as u64)
        .map_err(|e| format!("{ENV_ML_DISCOVERY}: {e}"))?;
    let record: Value =
        serde_json::from_str(&text).map_err(|e| format!("{ENV_ML_DISCOVERY}: corrupt JSON ({e})"))?;
    let host = record.get("host").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = record
        .get("port")
        .and_then(Value::as_u64)
        .filter(|p| *p > 0 && *p < 65536)
        .ok_or_else(|| format!("{ENV_ML_DISCOVERY}: record has no usable port"))?;
    let base = loopback_authority(&format!("http://{host}:{port}"))
        .map_err(|e| match e {
            EndpointError::Invalid(m) => m,
            EndpointError::NotConfigured(m) => m,
        })?;
    let mut token = String::new();
    if let Some(secret_file) = record.get("secret_file").and_then(Value::as_str) {
        if !secret_file.trim().is_empty() {
            token = read_bounded(Path::new(secret_file), MAX_SECRET_BYTES)?;
        }
    }
    if token.is_empty() {
        token = std::env::var(ENV_ML_TOKEN).unwrap_or_default().trim().to_string();
    }
    if token.is_empty() {
        return Err(format!(
            "{ENV_ML_DISCOVERY}: the record names no readable secret file and \
             {ENV_ML_TOKEN} is empty"
        ));
    }
    Ok(MlEndpoint {
        base,
        token,
        supervisor_pid: record.get("pid").and_then(Value::as_u64).map(|p| p as u32),
        source: "discovery",
    })
}

// ---------------------------------------------------------------- cache ----

fn capability_cache() -> &'static Mutex<Option<(Instant, Value)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// A cached capability table is reused while it is younger than `now`, and
/// dropped as soon as it is stale.
pub fn cached_capabilities(now: Instant) -> Option<Value> {
    let slot = capability_cache();
    let guard = slot.lock().ok()?;
    let (expires_at, value) = guard.as_ref()?;
    if now < *expires_at {
        Some(value.clone())
    } else {
        None
    }
}

pub fn remember_capabilities(now: Instant, value: Value) {
    if let Ok(mut guard) = capability_cache().lock() {
        *guard = Some((now + CAPABILITY_TTL, value));
    }
}

/// Test/back-compat helper: the cache entry expires on its own; an explicit
/// invalidate keeps a unit test from depending on the 10 s window.
pub fn invalidate_capabilities() {
    if let Ok(mut guard) = capability_cache().lock() {
        *guard = None;
    }
}

// ------------------------------------------------------------- requests ----

fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(PROBE_BUDGET)
        .connect_timeout(Duration::from_millis(400))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn get_json(endpoint: &MlEndpoint, client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let response = client
        .get(format!("{}{}", endpoint.base, path))
        .header("X-Ruke-Token", endpoint.token.as_str())
        .send()
        .await
        .map_err(|e| format!("{path}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{path}: capability backend answered {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("{path}: unreadable response ({e})"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!("{path}: response exceeded {MAX_BODY_BYTES} bytes"));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("{path}: non-JSON response ({e})"))
}

/// Trim a health answer to the fields that are safe and meaningful outside the
/// capability backend: no secret file path, no request/audit lines.
fn public_health(health: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["state", "uptime_s", "active_jobs", "heavy_imports_at_startup", "limits"] {
        if let Some(v) = health.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if let Some(workers) = health.get("workers") {
        out.insert("workers".to_string(), workers.clone());
    }
    Value::Object(out)
}

/// The supervisor answers `/capabilities` with an ENVELOPE: the flat
/// capability->status table sits under the `"capabilities"` key, next to the
/// richer per-family answers (speech / alignment / diarization / ocr) that also
/// carry a human step. This endpoint's published contract is the flat map, so the
/// envelope is unwrapped here. Handing the envelope through verbatim gave the UI
/// `capabilities.capabilities.embeddings.status`, i.e. a status table no consumer
/// could read (source-confirmed 2026-11-16). The per-family answers are kept, but
/// under their own key instead of being silently dropped.
fn split_capabilities(envelope: &Value) -> (Value, Option<Value>) {
    let outer = match envelope.as_object() {
        Some(map) => map,
        None => return (envelope.clone(), None),
    };
    let inner = match outer.get("capabilities").and_then(Value::as_object) {
        Some(inner) => inner,
        None => return (envelope.clone(), None),
    };
    let mut map = serde_json::Map::new();
    for (key, value) in inner {
        map.insert(key.clone(), value.clone());
    }
    let mut details = serde_json::Map::new();
    for (key, value) in outer {
        if key != "capabilities" {
            details.insert(key.clone(), value.clone());
        }
    }
    let details = if details.is_empty() {
        None
    } else {
        Some(Value::Object(details))
    };
    (Value::Object(map), details)
}

/// `GET /api/ruke/ml-status` — the honest answer about the capability backend.
/// 200 always: "not configured" and "unreachable" are documented states the UI
/// renders, not HTTP failures.
pub async fn status_get() -> impl IntoResponse {
    // Resolved exactly once: reading the environment twice could report a
    // `configured` flag that disagrees with the endpoint actually probed.
    match endpoint_from_env() {
        Err(err) => {
            let (reason, detail, configured) = match err {
                EndpointError::NotConfigured(d) => ("not_configured", d, false),
                EndpointError::Invalid(d) => ("invalid_endpoint", d, true),
            };
            (
                StatusCode::OK,
                Json(json!({
                    "configured": configured,
                    "live": false,
                    "reason": reason,
                    "detail": detail,
                    "human_step": "start the capability backend with `npm run dev` \
                                   (it bootstraps python-backend and the supervisor)"
                })),
            )
                .into_response()
        }
        Ok(endpoint) => {
            let client = probe_client();
            match get_json(&endpoint, &client, "/health").await {
                Err(e) => (
                    StatusCode::OK,
                    Json(json!({
                        "configured": true,
                        "live": false,
                        "reason": "unreachable",
                        "endpoint": endpoint.base.trim_start_matches("http://").to_string(),
                        "configured_pid": endpoint.supervisor_pid,
                        "detail": e,
                        "human_step": "the supervisor is not answering its loopback port; \
                                       restart it (Ctrl+C then `npm run dev`)"
                    })),
                )
                    .into_response(),
                Ok(health) => {
                    let now = Instant::now();
                    let envelope = match cached_capabilities(now) {
                        Some(cached) => cached,
                        None => match get_json(&endpoint, &client, "/capabilities").await {
                            Ok(table) => {
                                remember_capabilities(now, table.clone());
                                table
                            }
                            Err(e) => json!({"detail": e}),
                        },
                    };
                    let (capabilities, capability_details) = split_capabilities(&envelope);
                    (
                        StatusCode::OK,
                        Json(json!({
                            "configured": true,
                            "live": true,
                            "source": endpoint.source,
                            "endpoint": endpoint.base.trim_start_matches("http://").to_string(),
                            "supervisor_pid": endpoint.supervisor_pid,
                            "supervisor": public_health(&health),
                            "capabilities": capabilities,
                            "capability_details": capability_details,
                        })),
                    )
                        .into_response()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::sync::MutexGuard;

    /// Cargo runs these tests on parallel threads and `set_var` is process
    /// global, so every test that touches the ML env pair serializes here —
    /// the same rule that fixed the internal_completion "401 counted as a
    /// pass" defect (brief §R05).
    static ENV: StdMutex<()> = StdMutex::new(());

    const ML_ENV_KEYS: [&str; 5] =
        [ENV_ML_DISCOVERY, ENV_ML_URL, ENV_ML_TOKEN, ENV_ML_SECRET_FILE, ENV_ML_PID];

    /// Holds the env mutex for the whole test, then clears the pair on the way
    /// out. Poison-tolerant so an earlier panic cannot cascade into this suite.
    struct EnvPin {
        _guard: MutexGuard<'static, ()>,
    }

    impl EnvPin {
        fn new() -> Self {
            let guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            for k in ML_ENV_KEYS {
                std::env::remove_var(k);
            }
            EnvPin { _guard: guard }
        }
        fn set(&self, key: &str, value: &str) {
            std::env::set_var(key, value);
        }
    }

    impl Drop for EnvPin {
        fn drop(&mut self) {
            for k in ML_ENV_KEYS {
                std::env::remove_var(k);
            }
        }
    }

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn a_absent_configuration_is_reported_as_not_configured() {
        let pin = EnvPin::new();
        match endpoint_from_env() {
            Err(EndpointError::NotConfigured(detail)) => {
                assert!(detail.contains(ENV_ML_DISCOVERY), "{detail}");
            }
            other => panic!("expected NotConfigured, got {other:?}"),
        }
        drop(pin);
    }

    #[test]
    fn b_discovery_record_supplies_endpoint_token_and_pid() {
        let pin = EnvPin::new();
        let dir = tempfile::tempdir().unwrap();
        let secret = write(dir.path(), "supervisor.secret", "tok-discovery-xyz\n");
        let record = write(
            dir.path(),
            "supervisor.json",
            &json!({"host": "127.0.0.1", "port": 64030, "pid": 4242,
                    "secret_file": secret.to_string_lossy()}).to_string(),
        );
        pin.set(ENV_ML_DISCOVERY, &record.to_string_lossy());
        let endpoint = endpoint_from_env().expect("discovery record must resolve");
        assert_eq!(endpoint.base, "http://127.0.0.1:64030");
        assert_eq!(endpoint.token, "tok-discovery-xyz", "secret must be trimmed");
        assert_eq!(endpoint.supervisor_pid, Some(4242));
        assert_eq!(endpoint.source, "discovery");
    }

    #[test]
    fn c_off_box_endpoint_is_refused_and_the_token_stays_local() {
        let pin = EnvPin::new();
        pin.set(ENV_ML_URL, "http://api.example.com:8080");
        pin.set(ENV_ML_TOKEN, "tok-must-not-travel");
        let err = endpoint_from_env().expect_err("a non-loopback endpoint must be refused");
        let detail = format!("{err:?}");
        assert!(detail.contains("loopback"), "{detail}");
        assert!(!detail.contains("tok-must-not-travel"), "the token leaked: {detail}");
    }

    #[test]
    fn d_discovery_record_cannot_point_off_loopback() {
        let pin = EnvPin::new();
        let dir = tempfile::tempdir().unwrap();
        let secret = write(dir.path(), "s.secret", "tok-record");
        let record = write(
            dir.path(),
            "supervisor.json",
            &json!({"host": "10.0.0.7", "port": 64030,
                    "secret_file": secret.to_string_lossy()})
                .to_string(),
        );
        pin.set(ENV_ML_DISCOVERY, &record.to_string_lossy());
        let err = endpoint_from_env().expect_err("a non-loopback record must be refused");
        assert!(!format!("{err:?}").contains("tok-record"), "token leaked");
    }

    #[test]
    fn e_env_token_wins_and_a_corrupt_record_is_typed() {
        let pin = EnvPin::new();
        pin.set(ENV_ML_URL, "http://localhost:64030/");
        pin.set(ENV_ML_TOKEN, "  tok-env  ");
        pin.set(ENV_ML_PID, "99");
        let endpoint = endpoint_from_env().expect("env pair must resolve");
        assert_eq!(endpoint.base, "http://localhost:64030", "trailing slash normalized");
        assert_eq!(endpoint.token, "tok-env", "token trimmed, never re-derived");
        assert_eq!(endpoint.supervisor_pid, Some(99));

        let dir = tempfile::tempdir().unwrap();
        let record = write(dir.path(), "supervisor.json", "{ not json");
        pin.set(ENV_ML_DISCOVERY, &record.to_string_lossy());
        match endpoint_from_env() {
            Err(EndpointError::Invalid(detail)) => assert!(detail.contains("corrupt"), "{detail}"),
            other => panic!("expected Invalid for a corrupt record, got {other:?}"),
        }
    }

    #[test]
    fn f_secret_file_must_be_present_and_bounded() {
        let pin = EnvPin::new();
        pin.set(ENV_ML_URL, "http://127.0.0.1:64030");
        match endpoint_from_env() {
            Err(EndpointError::Invalid(detail)) => {
                assert!(detail.contains(ENV_ML_SECRET_FILE), "{detail}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.secret");
        std::fs::write(&big, "x".repeat(MAX_SECRET_BYTES as usize + 10)).unwrap();
        pin.set(ENV_ML_SECRET_FILE, &big.to_string_lossy());
        match endpoint_from_env() {
            Err(EndpointError::Invalid(detail)) => assert!(detail.contains("larger"), "{detail}"),
            other => panic!("oversized secret must be refused, got {other:?}"),
        }
    }

    #[test]
    fn g_capability_cache_respects_only_its_ttl() {
        invalidate_capabilities();
        let base = Instant::now();
        remember_capabilities(base, json!({"embeddings": {"status": "not_installed"}}));
        let inside = cached_capabilities(base + Duration::from_millis(1)).expect("fresh entry");
        assert_eq!(inside["embeddings"]["status"], "not_installed");
        assert!(cached_capabilities(base + CAPABILITY_TTL).is_none(), "stale entry must be dropped");
        invalidate_capabilities();
        assert!(cached_capabilities(base).is_none(), "invalidation must clear the entry");
    }

    #[test]
    fn h_public_health_never_carries_secrets_or_paths() {
        let health = json!({
            "state": "ready",
            "secret_file": "C:\\data\\python\\supervisor.secret",
            "audit": ["GET /health 200"],
            "workers": {"count": 0},
            "limits": {"heavy_concurrency": 1}
        });
        let out = public_health(&health).to_string();
        assert!(out.contains("ready"));
        assert!(!out.contains("supervisor.secret"), "secret path leaked: {out}");
        assert!(!out.contains("GET /health 200"), "audit line leaked: {out}");
    }

    #[test]
    fn j_capabilities_envelope_is_flattened_for_the_ui() {
        // The supervisor's real shape (python-backend/ruke_ml/supervisor.py
        // /capabilities): a capability map INSIDE an envelope plus per-family
        // answers. The UI contract is a flat capability -> status map, plus the
        // family answers under capability_details.
        let envelope = json!({
            "capabilities": {
                "embeddings": {"status": "available", "models": [{"id": "ruke-lexical-hash"}]},
                "video.timeline": {"status": "not_installed", "detail": "needs ffmpeg"}
            },
            "ocr": {"status": "evaluation_required", "human_step": "run the OCR quality gate"},
            "speech": {"status": "evaluation_required"}
        });
        let (map, details) = split_capabilities(&envelope);
        assert_eq!(map["embeddings"]["status"], "available", "{map}");
        assert_eq!(map["video.timeline"]["status"], "not_installed");
        assert!(map.get("capabilities").is_none(), "envelope leaked into the flat map: {map}");
        assert!(map.get("ocr").is_none(), "family answer belongs in capability_details: {map}");
        let details = details.expect("family answers must survive the unwrap");
        assert_eq!(details["ocr"]["human_step"], "run the OCR quality gate");
        // A body that is already flat (or an error object) must pass through unchanged.
        let flat = json!({"embeddings": {"status": "not_installed"}});
        let (same, none) = split_capabilities(&flat);
        assert_eq!(same, flat);
        assert!(none.is_none());
        let err = json!({"detail": "connection refused"});
        let (same2, none2) = split_capabilities(&err);
        assert_eq!(same2, err);
        assert!(none2.is_none());
    }

    #[tokio::test]
    async fn k_status_end_to_end_unwraps_a_live_supervisor() {
        // A canned loopback supervisor, so the whole status_get path - not just the
        // helper - is proven to hand the UI a readable capability table.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                use std::io::{Read, Write};
                let mut buf = [0u8; 4096];
                let mut got = String::new();
                while !got.contains("\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => got.push_str(&String::from_utf8_lossy(&buf[..n])),
                    }
                }
                let path = got.split_whitespace().nth(1).unwrap_or("").to_string();
                let body = if path.starts_with("/capabilities") {
                    r#"{"capabilities":{"embeddings":{"status":"available"}},
                        "ocr":{"status":"evaluation_required","human_step":"gate first"}}"#
                        .to_string()
                } else {
                    r#"{"state":"ready","uptime_s":1.0,"active_jobs":0,"limits":{},"workers":{}}"#
                        .to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        let pin = EnvPin::new();
        pin.set(ENV_ML_URL, &format!("http://127.0.0.1:{port}"));
        pin.set(ENV_ML_TOKEN, "tok-flat");
        invalidate_capabilities();
        let response = status_get().await.into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["live"], json!(true), "{body}");
        assert_eq!(body["capabilities"]["embeddings"]["status"], "available",
                   "the UI must be able to read the capability table directly: {body}");
        assert!(body["capabilities"].get("capabilities").is_none(), "nested envelope: {body}");
        assert_eq!(body["capability_details"]["ocr"]["human_step"], "gate first");
        assert!(!body.to_string().contains("tok-flat"), "token leaked into the response");
        invalidate_capabilities();
    }

    #[tokio::test]
    async fn i_status_reports_a_dead_supervisor_without_hanging() {
        let pin = EnvPin::new();
        // Bind then drop a listener so the port is almost certainly refused.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        pin.set(ENV_ML_URL, &format!("http://127.0.0.1:{port}"));
        pin.set(ENV_ML_TOKEN, "tok-dead");
        let started = Instant::now();
        let response = status_get().await.into_response();
        let elapsed = started.elapsed();
        assert!(elapsed < PROBE_BUDGET * 4, "status call hung for {elapsed:?}");
        assert_eq!(response.status(), StatusCode::OK);
        let body = async {
            let bytes = http_body_util::BodyExt::collect(response.into_body())
                .await
                .unwrap()
                .to_bytes();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        }
        .await;
        assert_eq!(body["reason"], "unreachable", "{body}");
        assert_eq!(body["configured"], json!(true));
        assert!(!body.to_string().contains("tok-dead"), "token leaked into the response");
    }
}
