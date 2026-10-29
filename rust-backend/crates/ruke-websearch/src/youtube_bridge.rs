//! OWNER: W4 — the InnerTube TRANSPORT seam in production (youtube.rs
//! module header, "a later part" clause, lands here).
//!
//! `HttpInnerTube` implements [`InnerTubeClient`] over the Next-hosted
//! evidence RPC `POST /api/internal/youtube-evidence`
//! (app/api/internal/youtube-evidence/route.ts). Same Tier-3b trust
//! model as browser_bridge: loopback-only, [`SECRET_HEADER`] carrying the
//! process-local secret from [`ENV_SECRET`], base URL from
//! [`ENV_BASE_URL`] — both exported to the Rust child by
//! dev-supervisor.mjs.
//!
//! WHY a Next-hosted RPC and not a native InnerTube client: YouTube's
//! Proof-of-Origin rollout means no plain-HTTP client (Rust or Node) can
//! fetch caption tracks anymore — `get_transcript` 400s and the signed
//! caption baseUrl answers 200 with an EMPTY body. Only the watch-page
//! player's own requests carry the token, so the transcript tier answers
//! through the Node/Playwright side: the route tries youtubei.js
//! `getTranscript()` first and falls back to the UNIVERSAL browser
//! caption engine (lib/web-search/media-captions.ts — DOM text tracks,
//! accessible-name CC controls, the player's own caption XHRs; no
//! provider hardcoding), normalizing to the `{segments:[{text,start_ms}]}`
//! shape `transcript_lines` already parses.
//!
//! Failure contract: the trait returns `Option` (no Err channel) — every
//! transport/status/parse failure maps to `None`, which is exactly the TS
//! catch-arm behavior the callers already implement (transcript "" /
//! comments [] / info null ⇒ oEmbed degradation). A SUCCESSFUL response
//! (even one with all-null fields) is cached per video id (clear at 64)
//! so a gated video never re-triggers the ~60s browser capture.

use futures_util::future::BoxFuture;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::browser_bridge::{ENV_BASE_URL, ENV_SECRET, SECRET_HEADER};
use crate::youtube::InnerTubeClient;

/// Next-side endpoint path (mirrors the route file).
pub const EVIDENCE_PATH: &str = "/api/internal/youtube-evidence";
/// Client deadline: worst-case TS server cost is getInfo (~4s) +
/// getTranscript (~2s) + the browser capture budget (goto 30s + video
/// wait 12s + probe 20s) + comments (~2s) ≈ 70s; the 90s deadline is
/// that plus slack (mirrors browser_bridge's deadline+slack idiom).
pub const RPC_DEADLINE_MS: u64 = 90_000;

/// Cache cap — mirrors the evidence-cache "clear at 64" rule.
const CACHE_MAX: usize = 64;

/// The three InnerTube payloads for one video, as the route emits them.
#[derive(Clone, Debug, Default)]
pub struct InnerTubePayload {
    pub info: Option<Value>,
    pub transcript: Option<Value>,
    pub comments: Option<Value>,
}

/// Wire shape of the route's response (extra fields tolerated by design;
/// the route also stamps `videoId` + `captionSource`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadWire {
    #[serde(default)]
    info: Option<Value>,
    #[serde(default)]
    transcript: Option<Value>,
    #[serde(default)]
    comments: Option<Value>,
}

/// Pull the video id back out of an info payload for the transcript /
/// comments calls (the trait hands us `info`, not the id). Covers every
/// shape the route or youtubei.js can emit: the route's snake_case stamp,
/// camelCase raw payloads, and the `basic_info` / `video_details` nests.
fn video_id_from_info(info: &Value) -> Option<&str> {
    let candidates = [
        info.get("video_id"),
        info.get("videoId"),
        info.get("basic_info").and_then(|b| b.get("video_id")),
        info.get("basic_info").and_then(|b| b.get("videoId")),
        info.get("video_details").and_then(|b| b.get("video_id")),
        info.get("video_details").and_then(|b| b.get("id")),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|s| s.len() == 11)
}

/// Real client: `POST {base}/api/internal/youtube-evidence` with
/// `{"videoId":…}` + [`SECRET_HEADER`]. Payloads are memoized per video
/// id for the process lifetime (the youtube-level evidence cache layers
/// a 10-min TTL on top; this one just avoids re-paying the browser
/// capture inside one server run).
pub struct HttpInnerTube {
    client: Client,
    base_url: String,
    secret: String,
    cache: Mutex<HashMap<String, Arc<InnerTubePayload>>>,
}

impl HttpInnerTube {
    pub fn new(base_url: &str, secret: &str) -> Self {
        Self {
            client: Client::builder()
                .build()
                .expect("static reqwest client builds"),
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// `None` when either env var is unset/empty → the caller wires
    /// [`crate::youtube::NoInnerTube`] (oEmbed-only degradation).
    /// NOTE: deliberately NO from_env unit test here — the env handoff
    /// is already covered by browser_bridge's `env_handoff_gates_the_
    /// http_bridge`, which mutates the SAME two vars in-process; a second
    /// test touching them would race under parallel test execution.
    pub fn from_env() -> Option<HttpInnerTube> {
        let base = std::env::var(ENV_BASE_URL).ok()?;
        let secret = std::env::var(ENV_SECRET).ok()?;
        if base.is_empty() || secret.is_empty() {
            return None;
        }
        Some(HttpInnerTube::new(&base, &secret))
    }

    async fn payload(&self, video_id: &str) -> Option<Arc<InnerTubePayload>> {
        if let Some(hit) = self.cache.lock().unwrap().get(video_id) {
            return Some(hit.clone());
        }
        let sent = self
            .client
            .post(format!("{}{}", self.base_url, EVIDENCE_PATH))
            .header(SECRET_HEADER, self.secret.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(Duration::from_millis(RPC_DEADLINE_MS))
            .body(json!({ "videoId": video_id }).to_string())
            .send()
            .await;
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "youtube-evidence RPC transport failed");
                return None;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            tracing::warn!(status = status.as_u16(), "youtube-evidence endpoint HTTP error");
            return None;
        }
        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "youtube-evidence RPC body failed");
                return None;
            }
        };
        let wire: PayloadWire = match serde_json::from_str(&text) {
            Ok(w) => w,
            Err(_) => {
                tracing::warn!("youtube-evidence endpoint returned invalid JSON");
                return None;
            }
        };
        let payload = Arc::new(InnerTubePayload {
            info: wire.info,
            transcript: wire.transcript,
            comments: wire.comments,
        });
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(video_id.to_string(), payload.clone());
        Some(payload)
    }
}

impl InnerTubeClient for HttpInnerTube {
    fn get_info<'a>(&'a self, video_id: &str) -> BoxFuture<'a, Option<Value>> {
        // The trait's BoxFuture<'a> is pinned to `&'a self` only — the
        // elided id lifetime can't cross the await, so own the id first.
        // (get_transcript/get_comments are exempt: the trait pins their
        // `info` param to the same `'a`.)
        let vid = video_id.to_string();
        Box::pin(async move { self.payload(&vid).await?.info.clone() })
    }

    fn get_transcript<'a>(&'a self, info: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move {
            let vid = video_id_from_info(info)?;
            self.payload(vid).await?.transcript.clone()
        })
    }

    fn get_comments<'a>(&'a self, info: &'a Value) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move {
            let vid = video_id_from_info(info)?;
            self.payload(vid).await?.comments.clone()
        })
    }
}

/// Deadline sanity guard, compile-time: goto 30s + video wait 12s +
/// probe 20s + InnerTube ~8s ≈ 70s worst case; 90s is that plus slack
/// and must never drift past a 2-minute user-visible stall.
const _: () = assert!(RPC_DEADLINE_MS >= 70_000 && RPC_DEADLINE_MS <= 120_000);

/* ── tests (mock/wire only — the Playwright capture is exercised by the
   Next endpoint, and the endpoint itself by vitest) ─────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_wire_parses_the_route_shape() {
        let wire: PayloadWire = serde_json::from_str(
            r#"{"videoId":"G0szOwYwqjI","info":{"video_id":"G0szOwYwqjI","title":"Khao Soi"},
               "transcript":{"segments":[{"text":"first line","start_ms":1500}]},
               "comments":[{"content":{"text":{"content":"yum"}}}],
               "captionSource":"browser-cc"}"#,
        )
        .unwrap();
        assert_eq!(
            wire.info.as_ref().unwrap()["title"].as_str(),
            Some("Khao Soi")
        );
        assert_eq!(wire.transcript.as_ref().unwrap()["segments"].as_array().unwrap().len(), 1);
        assert_eq!(wire.comments.as_ref().unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn payload_wire_tolerates_all_null_fields() {
        let wire: PayloadWire =
            serde_json::from_str(r#"{"videoId":"G0szOwYwqjI","info":null,"transcript":null,"comments":null,"captionSource":null}"#)
                .unwrap();
        assert!(wire.info.is_none() && wire.transcript.is_none() && wire.comments.is_none());
    }

    #[test]
    fn video_id_extraction_covers_every_info_shape() {
        let shapes = [
            json!({"video_id": "G0szOwYwqjI"}),
            json!({"videoId": "G0szOwYwqjI"}),
            json!({"basic_info": {"video_id": "G0szOwYwqjI"}}),
            json!({"basic_info": {"videoId": "G0szOwYwqjI"}}),
            json!({"video_details": {"video_id": "G0szOwYwqjI"}}),
            json!({"video_details": {"id": "G0szOwYwqjI"}}),
        ];
        for s in shapes {
            assert_eq!(video_id_from_info(&s), Some("G0szOwYwqjI"), "shape: {s}");
        }
        // Negatives: wrong length, non-string, missing.
        assert_eq!(video_id_from_info(&json!({"video_id": "short"})), None);
        assert_eq!(video_id_from_info(&json!({"video_id": 12345678901u64})), None);
        assert_eq!(video_id_from_info(&json!({"title": "no id here"})), None);
    }

    #[tokio::test]
    async fn transport_failure_degrades_to_none_like_the_ts_catch_arms() {
        // Dead port: everything must come back None (oEmbed degradation),
        // never a panic and never a poisoned cache entry.
        let bridge = HttpInnerTube::new("http://127.0.0.1:1", "test-secret");
        assert!(bridge.get_info("G0szOwYwqjI").await.is_none());
        assert!(bridge
            .get_transcript(&json!({"video_id": "G0szOwYwqjI"}))
            .await
            .is_none());
        assert!(bridge
            .get_comments(&json!({"video_id": "G0szOwYwqjI"}))
            .await
            .is_none());
        assert!(bridge.cache.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cached_payload_short_circuits_the_transport() {
        let bridge = HttpInnerTube::new("http://127.0.0.1:1", "test-secret");
        bridge.cache.lock().unwrap().insert(
            "G0szOwYwqjI".to_string(),
            Arc::new(InnerTubePayload {
                info: Some(json!({"video_id": "G0szOwYwqjI", "title": "cached"})),
                transcript: Some(json!({"segments": [{"text": "line", "start_ms": 0}]})),
                comments: None,
            }),
        );
        assert_eq!(
            bridge.get_info("G0szOwYwqjI").await.unwrap()["title"].as_str(),
            Some("cached")
        );
        // Transcript/comments resolve their id FROM the info shape and hit
        // the same cache entry — no transport on the dead port.
        let info = bridge.get_info("G0szOwYwqjI").await.unwrap();
        assert!(bridge.get_transcript(&info).await.is_some());
        assert!(bridge.get_comments(&info).await.is_none()); // cached None field
    }
}
