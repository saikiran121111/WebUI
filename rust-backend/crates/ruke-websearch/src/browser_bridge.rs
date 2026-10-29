//! OWNER: W4 — Tier-3b browser-read RPC client (the NEW loopback hop
//! prescribed by MIGRATION-MAP §7: Rust → `POST http://127.0.0.1:<next>`
//! `/api/internal/browser-read`, loopback-only, process-local secret, SSRF
//! re-validation). This is NOT a resurrection of the deleted `lib/browser`
//! subsystem (Rule 9 — sanctioned NEW endpoint); it wraps the LIVE
//! `lib/web-search/agentBrowser.ts` pool which stays in the Next server.
//!
//! Parity surface: the RPC response mirrors `OnePassExtraction` from
//! agentBrowser.ts verbatim (camelCase wire names, `status: number | null`,
//! `error` omitted when falsy), and this client reproduces agentBrowser's
//! observable non-navigating outcomes exactly:
//! - pool-disabled → `ok:false, status:0, error:"browser pool disabled via…"`
//!   (the TS literal string, echoed by the route);
//! - SSRF-unsafe target → `ok:false, status:0, error:"unsafe URL"` — the
//!   guard runs BEFORE any RPC (mirrors `extractUrlBrowser`'s pre-pool
//!   ordering: pool-disabled check, then `isSafeUrl`, then navigation),
//!   and the Next route re-validates server-side per §7.
//! - Playwright-internal outcomes (WAF reload, settle loop, ariaSnapshot,
//!   pool exhaustion THROW that escapes `extractUrlBrowser` because
//!   `acquireContext()` sits OUTSIDE its try block) live behind the route.
//!   A transport-level failure here is the Rust counterpart of that throw:
//!   the extractor port's browser tier wraps `Err(msg)` as
//!   `"browser pool error: " + msg` exactly like `extractBrowser`'s catch.
//!
//! ## RECORDED MICRO-DIVERGENCES
//! - The client adds a hard RPC deadline `timeout_ms.unwrap_or(40_000)`
//!   (agentBrowser's `BROWSER_PAGE_BUDGET_MS` default) `+ 20_000` slack ms
//!   covering the route's WAF reload + settle + evaluate + ariaSnapshot
//!   overhead. TS has no client-side deadline (in-process call); a network
//!   hop needs one. §7 places nav/response-size/operation timeouts on the
//!   ROUTE; this is belt-and-braces on the caller.
//! - The response's `url` field is force-echoed as the REQUEST url
//!   (`extractPageInOnePass` sets `out.url = url` from the argument, never
//!   from the page). Enforcing it client-side makes the shape independent
//!   of the route implementation.
//! - Until Part 8 cutover provides the Next endpoint + startup secret +
//!   env handoff (`RUKE_BROWSER_BRIDGE_BASE_URL` / `RUKE_BROWSER_BRIDGE_`
//!   `SECRET`), production wires [`NoBrowserBridge`] — the exact Tier-3b
//!   disabled-tier degradation the TS pool-kill-switch produces. Real
//!   Playwright is exercised only in Part 10; bridge tests are mock-only.

use futures_util::future::BoxFuture;
use reqwest::Client;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::ssrf;

/// Header carrying the loopback process-local secret (§7). The Next side
/// generates it at startup and hands it to the Rust child via env (Part 8).
pub const SECRET_HEADER: &str = "x-ruke-internal-secret";
/// Next-side endpoint path (§7 — NEW endpoint, not a ported one).
pub const READ_PATH: &str = "/api/internal/browser-read";
/// Env var holding `http://127.0.0.1:<next-port>` (Part 8 handoff).
pub const ENV_BASE_URL: &str = "RUKE_BROWSER_BRIDGE_BASE_URL";
/// Env var holding the process-local shared secret (Part 8 handoff).
pub const ENV_SECRET: &str = "RUKE_BROWSER_BRIDGE_SECRET";

/// Deserialize a JSON string-map into ordered pairs. The workspace enables
/// `serde_json/preserve_order`, so `Map` iteration is DOCUMENT order —
/// which is what TS `Object.entries()` yields and what the extractor's
/// browser tier formats meta lines in. Non-string values (impossible from
/// the TS route, which only stores `getAttribute` strings) fall back to "".
fn de_string_pairs<'de, D>(d: D) -> Result<Vec<(String, String)>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    match v {
        Value::Object(m) => Ok(m
            .into_iter()
            .map(|(k, val)| (k, val.as_str().unwrap_or("").to_string()))
            .collect()),
        Value::Null => Ok(Vec::new()),
        _ => Err(serde::de::Error::custom("expected a JSON object")),
    }
}

/// RPC mirror of agentBrowser.ts `OnePassExtraction`. `meta`/`windowState`
/// are kept as ordered pair vecs (see [`de_string_pairs`]) — a plain
/// HashMap would reorder the extractor's markdown meta lines.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnePassExtraction {
    pub url: String,
    #[serde(default)]
    pub final_url: String,
    #[serde(default)]
    pub title: String,
    /// `number | null`: null = goto produced no response (nav error).
    #[serde(default)]
    pub status: Option<i64>,
    #[serde(default)]
    pub body_text: String,
    #[serde(default)]
    pub aria_snapshot: String,
    #[serde(default)]
    pub json_ld: Vec<Value>,
    #[serde(default, deserialize_with = "de_string_pairs")]
    pub meta: Vec<(String, String)>,
    #[serde(default, deserialize_with = "de_string_pairs")]
    pub window_state: Vec<(String, String)>,
    #[serde(default)]
    pub ok: bool,
    /// Omitted (not null) on success — matches the conditional spread in
    /// `extractPageInOnePass`.
    #[serde(default)]
    pub error: Option<String>,
}

/// Every zeroed-field result agentBrowser returns (disabled / unsafe /
/// catch paths): `status: 0` literals in the TS early-returns.
fn zeroed(url: &str, error: &str) -> OnePassExtraction {
    OnePassExtraction {
        url: url.to_string(),
        final_url: String::new(),
        title: String::new(),
        status: Some(0),
        body_text: String::new(),
        aria_snapshot: String::new(),
        json_ld: Vec::new(),
        meta: Vec::new(),
        window_state: Vec::new(),
        ok: false,
        error: Some(error.to_string()),
    }
}

/// Client-side RPC deadline (see module-doc micro-divergence #1).
pub fn deadline_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or(40_000).saturating_add(20_000)
}

/// Seam shape mirrors `net::Net`: object-safe, `BoxFuture`, so the
/// extractor port can hold `&dyn BrowserBridge` next to `&dyn Net`.
/// `Err(String)` is the Rust counterpart of a throw escaping
/// `extractUrlBrowser` (pool exhaustion / newPage failure); the caller
/// applies the `"browser pool error: "` prefix, TS-style.
pub trait BrowserBridge: Send + Sync {
    fn extract_page_in_one_pass<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<OnePassExtraction, String>>;
}

/// Production default until Part 8 stands up the Next endpoint: the
/// disabled-tier result, shaped exactly like agentBrowser's kill-switch.
pub struct NoBrowserBridge;

impl BrowserBridge for NoBrowserBridge {
    fn extract_page_in_one_pass<'a>(
        &'a self,
        url: &'a str,
        _timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<OnePassExtraction, String>> {
        Box::pin(async move {
            Ok(zeroed(
                url,
                "browser pool disabled: RUKE Tier-3b bridge not configured",
            ))
        })
    }
}

/// Real client: `POST {base}/api/internal/browser-read` with
/// `{"url":…,"timeoutMs":…}` + [`SECRET_HEADER`]. The Next route wraps
/// `extractPageInOnePass`; everything Playwright-side stays there.
pub struct HttpBrowserBridge {
    client: Client,
    base_url: String,
    secret: String,
}

impl HttpBrowserBridge {
    pub fn new(base_url: &str, secret: &str) -> Self {
        Self {
            // Client construction only fails on TLS-backend init; the
            // workspace pins reqwest default-tls (schannel on Windows).
            client: Client::builder()
                .build()
                .expect("static reqwest client builds"),
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
        }
    }

    /// `None` when either env var is unset/empty → wire [`NoBrowserBridge`].
    pub fn from_env() -> Option<HttpBrowserBridge> {
        let base = std::env::var(ENV_BASE_URL).ok()?;
        let secret = std::env::var(ENV_SECRET).ok()?;
        if base.is_empty() || secret.is_empty() {
            return None;
        }
        Some(HttpBrowserBridge::new(&base, &secret))
    }
}

impl BrowserBridge for HttpBrowserBridge {
    fn extract_page_in_one_pass<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<OnePassExtraction, String>> {
        Box::pin(async move {
            // Guard ordering mirrors extractUrlBrowser: safety check
            // before any navigation attempt.
            if !ssrf::is_safe_url(url) {
                return Ok(zeroed(url, "unsafe URL"));
            }
            let body = match timeout_ms {
                Some(t) => json!({ "url": url, "timeoutMs": t }),
                None => json!({ "url": url }),
            };
            let sent = self
                .client
                .post(format!("{}{}", self.base_url, READ_PATH))
                .header(SECRET_HEADER, self.secret.as_str())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .timeout(Duration::from_millis(deadline_ms(timeout_ms)))
                .body(body.to_string())
                .send()
                .await;
            let resp = match sent {
                Ok(r) => r,
                Err(e) => return Err(format!("browser-read request failed: {e}")),
            };
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("browser-read endpoint HTTP {}", status.as_u16()));
            }
            let text = match resp.text().await {
                Ok(t) => t,
                Err(e) => return Err(format!("browser-read request failed: {e}")),
            };
            let mut out: OnePassExtraction = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => return Err("browser-read endpoint returned invalid JSON".to_string()),
            };
            // Micro-divergence #2: url is always the REQUEST url.
            out.url = url.to_string();
            Ok(out)
        })
    }
}

/// Mock seam for extractor/pipeline replay tests (the ONLY Tier-3b test
/// surface this run — real Playwright is Part 10). Exact-URL keying and a
/// replay log mirror `net::ScriptedNet`. Unscripted urls return the
/// disabled-shaped result (`Ok`, `ok:false`), i.e. the pool-kill-switch
/// tier, so fixture replays that never touch Tier-3b stay deterministic.
pub struct ScriptedBridge {
    scripts: Mutex<HashMap<String, Result<OnePassExtraction, String>>>,
    pub calls: Mutex<Vec<String>>,
}

impl ScriptedBridge {
    pub fn new() -> Self {
        Self {
            scripts: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
        }
    }
    pub fn with_page(&self, url: &str, extraction: OnePassExtraction) -> &Self {
        self.scripts
            .lock()
            .unwrap()
            .insert(url.to_string(), Ok(extraction));
        self
    }
    /// The acquire-throw counterpart: extractor formats
    /// `"browser pool error: {msg}"`.
    pub fn with_error(&self, url: &str, msg: &str) -> &Self {
        self.scripts
            .lock()
            .unwrap()
            .insert(url.to_string(), Err(msg.to_string()));
        self
    }
    pub fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl Default for ScriptedBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserBridge for ScriptedBridge {
    fn extract_page_in_one_pass<'a>(
        &'a self,
        url: &'a str,
        _timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<OnePassExtraction, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(url.to_string());
            if !ssrf::is_safe_url(url) {
                return Ok(zeroed(url, "unsafe URL"));
            }
            let hit = self.scripts.lock().unwrap().get(url).cloned();
            match hit {
                Some(r) => r,
                None => Ok(zeroed(
                    url,
                    "browser pool disabled via scripted bridge (no script for url)",
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extraction(url: &str, body: &str) -> OnePassExtraction {
        OnePassExtraction {
            url: url.to_string(),
            final_url: url.to_string(),
            title: "T".into(),
            status: Some(200),
            body_text: body.to_string(),
            aria_snapshot: String::new(),
            json_ld: Vec::new(),
            meta: Vec::new(),
            window_state: Vec::new(),
            ok: true,
            error: None,
        }
    }

    #[test]
    fn wire_shape_parity_one_pass_extraction() {
        // Exact route-response shape from extractPageInOnePass: camelCase,
        // status null, error key ABSENT on success, meta in document order.
        let raw = r#"{
            "url":"https://example.com/a","finalUrl":"https://example.com/final",
            "title":"Page","status":null,"bodyText":"hello","ariaSnapshot":"- heading",
            "jsonLd":[{"@type":"Article"},{"_raw":"{broken"}],"meta":{
                "og:site_name":"S","apple-mobile":"x","og:title":"T"},
            "windowState":{"__NEXT_DATA__":"{}","ytInitialData":"{}"},
            "ok":true}"#;
        let v: OnePassExtraction = serde_json::from_str(raw).unwrap();
        assert_eq!(v.final_url, "https://example.com/final");
        assert_eq!(v.status, None); // goto produced no response
        assert_eq!(v.error, None);
        assert!(v.ok);
        assert_eq!(v.json_ld.len(), 2);
        assert_eq!(v.json_ld[1]["_raw"], "{broken");
        // INSERTION order preserved (extractor formats meta lines in it):
        assert_eq!(
            v.meta,
            vec![
                ("og:site_name".to_string(), "S".to_string()),
                ("apple-mobile".to_string(), "x".to_string()),
                ("og:title".to_string(), "T".to_string())
            ]
        );
        assert_eq!(v.window_state[0].0, "__NEXT_DATA__");
    }

    #[tokio::test]
    async fn unsafe_target_guard_runs_before_any_call() {
        // Base url is loopback but the guard tests the TARGET url, exactly
        // like isSafeUrl(url) before page.goto in agentBrowser.
        let b = HttpBrowserBridge::new("http://127.0.0.1:9", "sekret");
        let r = b.extract_page_in_one_pass("http://127.0.0.1/steal", None).await.unwrap();
        assert!(!r.ok);
        assert_eq!(r.status, Some(0));
        assert_eq!(r.error.as_deref(), Some("unsafe URL"));
        assert_eq!(r.url, "http://127.0.0.1/steal");
        // Non-URL input is also unsafe (url::Url parse fails → false).
        let r2 = b.extract_page_in_one_pass("not a url", None).await.unwrap();
        assert_eq!(r2.error.as_deref(), Some("unsafe URL"));
    }

    #[tokio::test]
    async fn transport_failure_maps_to_the_throw_counterpart_err() {
        // Dead port on loopback: connect refused is immediate and
        // deterministic on Windows. The extractor port will render this as
        // "browser pool error: browser-read request failed: …".
        let b = HttpBrowserBridge::new("http://127.0.0.1:1", "sekret");
        let e = b.extract_page_in_one_pass("https://example.com/x", None).await.unwrap_err();
        assert!(e.starts_with("browser-read request failed"), "{e}");
    }

    #[tokio::test]
    async fn no_bridge_reproduces_the_pool_kill_switch_tier() {
        let r = NoBrowserBridge
            .extract_page_in_one_pass("https://example.com/x", Some(45_000))
            .await
            .unwrap();
        assert!(!r.ok);
        assert_eq!(r.status, Some(0));
        assert!(r.error.as_deref().unwrap().contains("not configured"));
        assert_eq!(r.final_url, "");
        assert_eq!(r.body_text, "");
    }

    #[tokio::test]
    async fn scripted_bridge_scripts_pages_and_logs_calls() {
        let br = ScriptedBridge::new();
        br.with_page("https://example.com/ok", extraction("https://example.com/ok", "body"));
        br.with_error("https://example.com/boom", "agentBrowser: pool exhausted after 60000ms wait");
        let ok = br.extract_page_in_one_pass("https://example.com/ok", Some(45_000)).await.unwrap();
        assert!(ok.ok && ok.body_text == "body");
        let boom = br.extract_page_in_one_pass("https://example.com/boom", None).await.unwrap_err();
        assert!(boom.contains("pool exhausted"));
        let miss = br.extract_page_in_one_pass("https://example.com/miss", None).await.unwrap();
        assert!(!miss.ok && miss.status == Some(0));
        assert_eq!(br.call_count(), 3);
        assert_eq!(br.calls.lock().unwrap()[0], "https://example.com/ok");
    }

    #[test]
    fn deadline_covers_budget_plus_slack() {
        assert_eq!(deadline_ms(None), 60_000); // 40s budget + 20s slack
        assert_eq!(deadline_ms(Some(45_000)), 65_000);
        assert_eq!(deadline_ms(Some(u64::MAX)), u64::MAX); // saturating
    }

    #[test]
    fn env_handoff_gates_the_http_bridge() {
        // Part-8 startup will export these into the Rust child's env.
        std::env::remove_var(ENV_BASE_URL);
        std::env::remove_var(ENV_SECRET);
        assert!(HttpBrowserBridge::from_env().is_none());
        std::env::set_var(ENV_BASE_URL, "http://127.0.0.1:3000");
        std::env::set_var(ENV_SECRET, "abc123");
        let b = HttpBrowserBridge::from_env().expect("configured");
        assert_eq!(b.base_url, "http://127.0.0.1:3000");
        assert_eq!(b.secret, "abc123");
        // Empty values count as unconfigured.
        std::env::set_var(ENV_SECRET, "");
        assert!(HttpBrowserBridge::from_env().is_none());
        std::env::remove_var(ENV_BASE_URL);
        std::env::remove_var(ENV_SECRET);
    }
}
