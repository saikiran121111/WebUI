//! Part-10 production embedder seam: the [`QueryEmbedder`] vector comes
//! from Node's ONNX model over an authenticated loopback RPC —
//! `POST {base}/api/internal/embed` on `app/api/internal/embed/route.ts`,
//! which wraps `embedOne` from `lib/server/attachindex/embed.ts`. The
//! model itself STAYS Node-owned (extraction and index BUILD already ran
//! it in-process; the migration keeps ONNX embedding in Node); only the
//! chat-time QUERY vector now crosses the hop, exactly like Tier-3b
//! shipped the Playwright pool behind `/api/internal/browser-read`.
//!
//! Why the seam had to close: with [`crate::UnavailableEmbedder`] in
//! production, cosine slots all tie at 0.0, stable-sort seeds the top cos
//! slots with chunks 0..19, and RRF then ranks those fusion hits above the
//! lone BM25 hit that actually matches a deep rare-word marker. The
//! long-document E2E (`tests/long-doc-retrieval.spec.ts`) is the
//! behavioral contract that caught this regression.
//!
//! Env handoff: the SAME per-run pair the supervisor already exports to
//! both children for Tier-3b — [`ENV_BASE_URL`] (the Next origin) and
//! [`ENV_SECRET`] (random per run; Rule 17: never logged anywhere, only
//! the boolean wiring outcome is logged at startup). Unset ⇒
//! [`HttpQueryEmbedder::from_env`] is `None` and `main.rs` wires
//! [`crate::UnavailableEmbedder`], keeping the documented degradation.
//!
//! Failure parity: any RPC failure (connection refused, non-2xx,
//! malformed body, empty/non-finite vector) yields [`EmbedUnavailable`];
//! `build_attachment_turn`'s `unwrap_or_default()` keeps the empty vector
//! ⇔ the TS `try { queryVec = await embedOne(rq) } catch {}` path — BM25
//! alone ranks. Like the TS in-process await this client carries NO
//! timeout: a slow local model (first call lazy-loads ONNX) is normal
//! operation, and a dead loopback endpoint errors immediately anyway.
//!
//! Threading: the seam is synchronous (`embed_one` is called once per
//! chat turn from the pipeline) while reqwest is async, so each call runs
//! the request to completion on a dedicated thread with its own
//! current-thread runtime. A chat turn does 0–1 embeddings, so the
//! thread-per-call cost is noise; this keeps the multi-threaded tokio
//! worker that serves the turn from ever blocking on the RPC.

use crate::{EmbedUnavailable, QueryEmbedder};
use serde_json::Value;

pub const SECRET_HEADER: &str = "x-ruke-internal-secret";
pub const EMBED_PATH: &str = "/api/internal/embed";
pub const ENV_BASE_URL: &str = "RUKE_BROWSER_BRIDGE_BASE_URL";
pub const ENV_SECRET: &str = "RUKE_BROWSER_BRIDGE_SECRET";

/// Real client: `POST {base}/api/internal/embed` with `{"text":…}` +
/// [`SECRET_HEADER`]; everything ONNX-side stays in Node.
pub struct HttpQueryEmbedder {
    client: reqwest::Client,
    base_url: String,
    secret: String,
}

impl HttpQueryEmbedder {
    pub fn new(base_url: &str, secret: &str) -> Self {
        Self {
            // Client construction only fails on TLS-backend init; the
            // workspace pins reqwest default-tls (schannel on Windows).
            client: reqwest::Client::builder()
                .build()
                .expect("static reqwest client builds"),
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.to_string(),
        }
    }

    /// `None` when either env var is unset/empty → wire
    /// [`crate::UnavailableEmbedder`] (documented degradation).
    /// NOTE: deliberately NO from_env unit test — process env is global
    /// state and cargo tests run in parallel (same precedent as
    /// `ruke-websearch::youtube_bridge::HttpInnerTube::from_env`).
    pub fn from_env() -> Option<HttpQueryEmbedder> {
        let base = std::env::var(ENV_BASE_URL).ok()?;
        let secret = std::env::var(ENV_SECRET).ok()?;
        if base.is_empty() || secret.is_empty() {
            return None;
        }
        Some(HttpQueryEmbedder::new(&base, &secret))
    }

    /// Extract the `vector` row from the RPC response. Any shape
    /// deviation is [`EmbedUnavailable`] (degrade, never panic) ⇔ TS
    /// `embedOne` throw ⇒ route 500 ⇒ client catch.
    fn parse_vector(body: &Value) -> Result<Vec<f64>, EmbedUnavailable> {
        if body.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(EmbedUnavailable);
        }
        let rows = body.get("vector").and_then(Value::as_array).ok_or(EmbedUnavailable)?;
        if rows.is_empty() {
            return Err(EmbedUnavailable);
        }
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let v = r.as_f64().filter(|f| f.is_finite()).ok_or(EmbedUnavailable)?;
            out.push(v);
        }
        Ok(out)
    }
}

impl QueryEmbedder for HttpQueryEmbedder {
    fn embed_one(&self, text: &str) -> Result<Vec<f64>, EmbedUnavailable> {
        let client = self.client.clone();
        let url = format!("{}{}", self.base_url, EMBED_PATH);
        let secret = self.secret.clone();
        let payload = serde_json::json!({ "text": text });
        let worker = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()?;
            rt.block_on(async move {
                let resp = client
                    .post(&url)
                    .header(SECRET_HEADER, secret.as_str())
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(payload.to_string())
                    .send()
                    .await
                    .ok()?;
                if !resp.status().is_success() {
                    return None;
                }
                // The workspace reqwest carries no `json` feature (SSE
                // bytes must travel verbatim); decode text ourselves.
                let text = resp.text().await.ok()?;
                let body: Value = serde_json::from_str(&text).ok()?;
                Self::parse_vector(&body).ok()
            })
        });
        // A panicked worker thread is just another failed vector: join
        // yields Result<Option<..>>, and either layer failing is
        // EmbedUnavailable.
        worker
            .join()
            .ok()
            .flatten()
            .ok_or(EmbedUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(v: serde_json::Value) -> Value {
        serde_json::json!({ "ok": true, "vector": v })
    }

    #[test]
    fn parses_a_good_row() {
        let got = HttpQueryEmbedder::parse_vector(&body(serde_json::json!([0.5, -0.25, 1.0])));
        assert_eq!(got.unwrap(), vec![0.5, -0.25, 1.0]);
    }

    #[test]
    fn degrades_on_every_shape_deviation() {
        // ok:false / missing ok / missing vector / empty vector /
        // non-numeric entry / string vector — all EmbedUnavailable.
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&serde_json::json!({"ok": false, "vector": [1.0]})),
            Err(EmbedUnavailable)
        );
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&serde_json::json!({"vector": [1.0]})),
            Err(EmbedUnavailable)
        );
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&serde_json::json!({"ok": true})),
            Err(EmbedUnavailable)
        );
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&body(serde_json::json!([]))),
            Err(EmbedUnavailable)
        );
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&body(serde_json::json!([1.0, "x"]))),
            Err(EmbedUnavailable)
        );
        assert_eq!(
            HttpQueryEmbedder::parse_vector(&body(serde_json::json!("1,2,3"))),
            Err(EmbedUnavailable)
        );
    }

    #[test]
    fn new_trims_trailing_slash() {
        let e = HttpQueryEmbedder::new("http://127.0.0.1:3000/", "s3cr3t");
        assert_eq!(e.base_url, "http://127.0.0.1:3000");
    }
}
