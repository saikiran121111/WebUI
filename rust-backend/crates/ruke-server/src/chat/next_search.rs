//! next_search.rs — Rust→Next loopback client for the TS-owned web search
//! (rollback 2026-11-03).
//!
//! Web search ownership moved back to TypeScript: the gate, planning,
//! retrieval, extraction, rerank, citations, and the web-tool session all
//! live in the Next process (`/api/internal/web-research` and
//! `/api/internal/web-tools`). The Rust chat pipeline, web tool loop and
//! browser destination discovery drive them through this client and keep
//! only the generic model-round + SSE transport.
//!
//! Auth reuses the existing internal-bridge contract verbatim (same env
//! pair the browser bridge and the ruke-attach embedder use — Rule 17:
//! nothing here ever logs the secret):
//! `RUKE_BROWSER_BRIDGE_BASE_URL` + `RUKE_BROWSER_BRIDGE_SECRET`, sent as
//! the `x-ruke-internal-secret` header. The supervisor exports the pair to
//! BOTH children on every run, so the bridge is auto-wired in dev.
//!
//! Honest degradation: when the pair is unset `from_env()` returns `None`
//! and the callers skip research / discovery with a log — there is no
//! Rust-side search fallback and no retry into a second engine.
//!
//! Cancellation: the research stream is read chunk-by-chunk under the
//! turn's `CancellationToken`; dropping the response future closes the
//! socket, which Next observes as a request abort and stops retrieval
//! (mirrors the old in-process cancel flag).

use reqwest::Client;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ipc::{ENV_BASE_URL, ENV_SECRET, SECRET_HEADER};

pub const RESEARCH_PATH: &str = "/api/internal/web-research";
pub const TOOLS_PATH: &str = "/api/internal/web-tools";

#[derive(Debug)]
pub enum BridgeError {
    /// The turn's cancellation token fired mid-RPC.
    Cancelled,
    /// Loopback connect/transport failure (Next down or not listening).
    Unreachable(String),
    /// Non-2xx status with a short body excerpt.
    Http(u16, String),
    /// Response body could not be parsed as the expected JSON/NDJSON.
    Protocol(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::Cancelled => write!(f, "cancelled with the turn"),
            BridgeError::Unreachable(m) => write!(f, "next search service unreachable: {m}"),
            BridgeError::Http(s, m) => write!(f, "next search service returned {s}: {m}"),
            BridgeError::Protocol(m) => write!(f, "next search service protocol error: {m}"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Clone)]
pub struct NextSearchBridge {
    http: Client,
    base: String,
    secret: String,
}

impl NextSearchBridge {
    /// Configured only when BOTH env vars are present and non-empty — the
    /// exact same Option-pair precedent as `ruke_attach::HttpQueryEmbedder`.
    /// Deliberately NO from_env unit test: process env is global state and
    /// cargo tests run in parallel (same precedent, same rationale).
    pub fn from_env() -> Option<NextSearchBridge> {
        let base = std::env::var(ENV_BASE_URL).ok()?;
        let secret = std::env::var(ENV_SECRET).ok()?;
        if base.is_empty() || secret.is_empty() {
            return None;
        }
        Some(NextSearchBridge {
            // Deliberately no client timeout: the TS research pass
            // legitimately runs for minutes (slow local gate model
            // included); a dead loopback errors on connect immediately.
            http: Client::new(),
            base: base.trim_end_matches('/').to_string(),
            secret,
        })
    }

    fn post(&self, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{}", self.base, path))
            .header(SECRET_HEADER, self.secret.as_str())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            // The workspace reqwest carries no `json` feature (SSE bytes
            // must travel verbatim); encode/decode text by hand — the
            // exact pattern of ruke_attach::HttpQueryEmbedder.
            .body(body.to_string())
    }

    async fn send_checked(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, BridgeError> {
        let resp = req
            .send()
            .await
            .map_err(|e| BridgeError::Unreachable(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let excerpt: String = text.chars().take(400).collect();
            return Err(BridgeError::Http(status.as_u16(), excerpt));
        }
        Ok(resp)
    }

    /// Plain JSON↔JSON RPC (the web-tools create/exec/discover/close actions).
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, BridgeError> {
        let resp = self.send_checked(self.post(path, body)).await?;
        let text = resp
            .text()
            .await
            .map_err(|e| BridgeError::Unreachable(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| BridgeError::Protocol(e.to_string()))
    }

    /// Research RPC: the reply is NDJSON — zero or more progress frames
    /// (handed to `on_progress`) and exactly one terminal `result` frame,
    /// which is returned. Cancellation drops the body stream mid-read
    /// (socket close ⇒ Next request abort ⇒ retrieval stops).
    pub async fn research(
        &self,
        body: &Value,
        token: &CancellationToken,
        mut on_progress: impl FnMut(&Value),
    ) -> Result<Value, BridgeError> {
        let mut resp = self
            .send_checked(self.post(RESEARCH_PATH, body))
            .await?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let chunk = tokio::select! { biased;
                _ = token.cancelled() => return Err(BridgeError::Cancelled),
                c = resp.chunk() => c,
            };
            match chunk {
                Ok(Some(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    for line in drain_lines(&mut buf) {
                        if line.is_empty() {
                            continue;
                        }
                        let frame: Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            // A malformed frame never ends the turn: the
                            // terminal frame decides the outcome.
                            Err(_) => continue,
                        };
                        if frame.get("type").and_then(Value::as_str) == Some("result") {
                            return Ok(frame);
                        }
                        on_progress(&frame);
                    }
                }
                Ok(None) => {
                    return Err(BridgeError::Protocol(
                        "research stream ended without a result frame".to_string(),
                    ))
                }
                Err(e) => return Err(BridgeError::Unreachable(e.to_string())),
            }
        }
    }
}

/// Pull every complete `\n`-terminated line out of `buf` (the remainder
/// stays buffered across chunk boundaries — frames can split anywhere).
fn drain_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
        let raw: Vec<u8> = buf.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&raw[..raw.len() - 1]).trim().to_string());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_framing_survives_arbitrary_chunk_splits() {
        // The NDJSON parser must reassemble frames split across chunks and
        // keep the partial tail buffered (the terminal frame arrives whole).
        let mut buf = Vec::new();
        buf.extend_from_slice(b"{\"type\":\"progress\",\"stage\":\"searching");
        assert!(drain_lines(&mut buf).is_empty());
        buf.extend_from_slice(b"\"}\n{\"type\":\"result\",\"status\":\"no_");
        let lines = drain_lines(&mut buf);
        assert_eq!(lines.len(), 1);
        let frame: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(frame["stage"], "searching");
        assert!(!buf.is_empty());
        buf.extend_from_slice(b"bundle\"}\n");
        let lines = drain_lines(&mut buf);
        assert_eq!(lines.len(), 1);
        let frame: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(frame["status"], "no_bundle");
        assert!(buf.is_empty());
    }
}
