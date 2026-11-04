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
//!
//! Transport bounds (brief §10, 2026-11-04): the header await is raced
//! against the turn token at EVERY call site (create/close used to be
//! un-raced — a wedged Next stalled the turn holding the busy slot), and
//! the research header phase additionally carries a wall budget because
//! the TS route returns its NDJSON Response synchronously — the
//! legitimately-minutes-long part is BODY streaming, which stays
//! uncapped. Individual stream frames are capped so a runaway unterminated
//! line can never grow the read buffer unbounded.

use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::ipc::{ENV_BASE_URL, ENV_SECRET, SECRET_HEADER};

pub const RESEARCH_PATH: &str = "/api/internal/web-research";
pub const TOOLS_PATH: &str = "/api/internal/web-tools";

/// Research header-phase budget: the TS route builds its Response
/// synchronously, so response headers arrive in milliseconds; only the
/// BODY legitimately streams for minutes. Headers missing within this
/// budget mean a wedged Next — `Unreachable`, not an eternal stall.
pub const RESEARCH_HEADER_BUDGET: Duration = Duration::from_secs(30);

/// Best-effort session close must never hang the turn (§10 bounded waits).
pub const CLOSE_HEADER_BUDGET: Duration = Duration::from_secs(10);

/// Cap on one buffered NDJSON line. Generous: terminal frames carry the
/// whole systemBlock + citations.
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

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
            // Deliberately NO whole-request timeout: the TS research pass
            // legitimately runs for minutes (slow local gate model
            // included). §10 bounds the phases that can NEVER legitimately
            // take long: connect (loopback — instant, so a stalled
            // handshake is a dead loopback) and, at the research call
            // site, the header phase.
            http: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| Client::new()),
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

    /// §10: the header await (connect + response headers) is raced against
    /// the turn token at EVERY call site — dropping the send future closes
    /// the loopback socket exactly like the body-read cancel path. An
    /// optional wall budget bounds the wait for phases that can never
    /// legitimately take long (research headers, close); exec/create/
    /// discover keep it unbounded because a JSON RPC only completes
    /// headers when the server's work finishes.
    async fn send_checked(
        &self,
        req: reqwest::RequestBuilder,
        token: &CancellationToken,
        header_budget: Option<Duration>,
    ) -> Result<reqwest::Response, BridgeError> {
        let sent = match header_budget {
            Some(budget) => tokio::select! { biased;
                _ = token.cancelled() => return Err(BridgeError::Cancelled),
                r = tokio::time::timeout(budget, req.send()) => match r {
                    Ok(r) => r,
                    Err(_) => {
                        return Err(BridgeError::Unreachable(
                            "no response headers from the search service within the header budget"
                                .to_string(),
                        ))
                    }
                },
            },
            None => tokio::select! { biased;
                _ = token.cancelled() => return Err(BridgeError::Cancelled),
                r = req.send() => r,
            },
        };
        let resp = sent.map_err(|e| BridgeError::Unreachable(err_chain(&e)))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let excerpt: String = text.chars().take(400).collect();
            return Err(BridgeError::Http(status.as_u16(), excerpt));
        }
        Ok(resp)
    }

    /// Plain JSON↔JSON RPC (the web-tools create/exec/discover/close actions).
    pub async fn post_json(
        &self,
        path: &str,
        body: &Value,
        token: &CancellationToken,
        header_budget: Option<Duration>,
    ) -> Result<Value, BridgeError> {
        let resp = self
            .send_checked(self.post(path, body), token, header_budget)
            .await?;
        let text = resp
            .text()
            .await
            .map_err(|e| BridgeError::Unreachable(err_chain(&e)))?;
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
            .send_checked(
                self.post(RESEARCH_PATH, body),
                token,
                Some(RESEARCH_HEADER_BUDGET),
            )
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
                    // §10 bounded frames: whatever survives line draining
                    // is a partial tail; if the partial tail itself blows
                    // the cap, the stream is runaway — drop it (socket
                    // close ⇒ Next aborts retrieval).
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
                    if buf.len() > MAX_FRAME_BYTES {
                        return Err(BridgeError::Protocol(format!(
                            "research stream line exceeded the {MAX_FRAME_BYTES}-byte frame cap without terminating — aborting runaway stream"
                        )));
                    }
                }
                Ok(None) => {
                    return Err(BridgeError::Protocol(
                        "research stream ended without a result frame".to_string(),
                    ))
                }
                Err(e) => return Err(BridgeError::Unreachable(err_chain(&e))),
            }
        }
    }
}

/// Flatten a reqwest/hyper error's whole source chain into one line. The
/// top-level Display repeats the same generic sentence for every transport
/// failure ("error sending request for url …"); the actionable cause
/// (incomplete body, reset, header parse) only lives in `source()`.
fn err_chain(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = std::error::Error::source(s);
    }
    msg
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

    // ── §10 transport-bound tests ────────────────────────────────────────
    //
    // Raw loopback responders (no axum/hyper test harness): we need exact
    // control over WHAT the "Next" side emits — no headers at all,
    // truncated bodies, oversized frames. The bridge only needs a
    // base+secret, so tests construct it directly.

    fn test_bridge(port: u16) -> NextSearchBridge {
        NextSearchBridge {
            // POOLING DISABLED: tests share one process; a pooled keep-
            // alive socket from a test whose responder task died (task
            // abort on panic, or abrupt test end) would poison the next
            // test with "received unexpected message from connection".
            // Production keeps pooling (real Next doesn't reset sockets).
            http: Client::builder()
                .pool_idle_timeout(None)
                .build()
                .unwrap(),
            base: format!("http://127.0.0.1:{port}"),
            secret: "test-secret".to_string(),
        }
    }

    /// Bind an ephemeral loopback listener; the OS accepts handshakes into
    /// the backlog even before `accept`, so "connected but silent Next"
    /// needs no spawned task at all. Arc so responder tasks can hold a
    /// clone while the TEST keeps its own alive until the bridge call has
    /// finished — dropping the listener early would reset connections that
    /// connect after the listener dies.
    async fn silent_listener() -> std::sync::Arc<tokio::net::TcpListener> {
        std::sync::Arc::new(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap())
    }

    /// Responder for the body-phase tests: a REAL HTTP server (axum) on
    /// an ephemeral port streaming exactly `chunks` as the research body —
    /// clean end, mid-stream Err (transport break), or one colossal
    /// unterminated chunk, whatever the case models. Hand-rolled raw
    /// sockets were tried first and fought hyper's dispatcher (responses
    /// written before the request was fully flushed surfaced as
    /// "operation was canceled" instead of the modeled EOF/RST).
    /// Returns the port.
    async fn serve_chunked_stream(chunks: Vec<String>, break_at_end: bool) -> u16 {
        let app = axum::Router::new().route(
            RESEARCH_PATH,
            axum::routing::post(move || {
                let items: Vec<Result<String, std::io::Error>> = chunks
                    .iter()
                    .map(|c| Ok(c.clone()))
                    .chain((break_at_end).then(|| {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::BrokenPipe,
                            "simulated transport break",
                        ))
                    }))
                    .collect();
                async move {
                    axum::response::Response::new(axum::body::Body::from_stream(
                        futures_util::stream::iter(items),
                    ))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    #[tokio::test]
    async fn header_wait_is_cancellable_mid_send() {
        // NO HEADERS case: Next accepted the socket but never answers.
        // The turn token must free the call — not the old bare send().await.
        let listener = silent_listener().await;
        let port = listener.local_addr().unwrap().port();
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            t2.cancel();
        });
        let started = std::time::Instant::now();
        let res = bridge
            .research(&serde_json::json!({"prompt": "x"}), &token, |_| {})
            .await;
        assert!(matches!(res, Err(BridgeError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn header_wait_is_bounded_when_token_never_fires() {
        // NO HEADERS case, bounded variant: a caller that keeps no live
        // token (deadlocked turn) still gets Unreachable at the budget.
        let listener = silent_listener().await;
        let port = listener.local_addr().unwrap().port();
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let res = bridge
            .post_json(TOOLS_PATH, &serde_json::json!({"action": "ping"}), &token, Some(Duration::from_millis(80)))
            .await;
        match res {
            Err(BridgeError::Unreachable(m)) => assert!(m.contains("headers"), "msg was {m}"),
            other => panic!("expected bounded Unreachable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn research_partial_frames_without_terminal_is_protocol_error() {
        // PARTIAL FRAMES case: one whole progress line plus an unterminated
        // tail, then a clean EOF — the buffered partial must not be parsed,
        // and the missing terminal frame must surface as Protocol.
        let port = serve_chunked_stream(
            vec!["{\"type\":\"progress\",\"stage\":\"searching\"}\n{\"type\":\"resu".to_string()],
            false,
        )
        .await;
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let res = bridge.research(&serde_json::json!({"prompt": "x"}), &token, |_| {}).await;
        match res {
            Err(BridgeError::Protocol(m)) => assert!(m.contains("without a result"), "msg was {m}"),
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn research_abrupt_disconnect_mid_body_is_unreachable() {
        // DISCONNECT case: the body stream ERRORS mid-delivery (socket
        // break) — the body read must error, not hang and not pretend.
        let port = serve_chunked_stream(
            vec!["{\"type\":\"progress\",\"stage\":\"searching\"}\n".to_string()],
            true, // transport break after the last whole chunk
        )
        .await;
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let res = bridge.research(&serde_json::json!({"prompt": "x"}), &token, |_| {}).await;
        assert!(
            matches!(res, Err(BridgeError::Unreachable(_))),
            "expected Unreachable, got {res:?}"
        );
    }

    #[tokio::test]
    async fn research_oversized_unterminated_frame_hits_the_stream_cap() {
        // BOUNDED FRAMES case: one line larger than MAX_FRAME_BYTES never
        // terminates — the cap aborts the stream instead of buffering forever.
        let mut huge = String::from("{\"type\":\"progress\",\"stage\":\"");
        huge.push_str(&"x".repeat(MAX_FRAME_BYTES + 64)); // no closing newline
        let port = serve_chunked_stream(vec![huge], false).await;
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let res = bridge.research(&serde_json::json!({"prompt": "x"}), &token, |_| {}).await;
        match res {
            Err(BridgeError::Protocol(m)) => assert!(m.contains("frame cap"), "msg was {m}"),
            other => panic!("expected frame-cap Protocol, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn research_terminal_frame_is_delivered_exactly_once() {
        // EXACTLY-ONCE TERMINAL case: progress frames flow to on_progress;
        // the FIRST result frame is returned and never reaches on_progress;
        // a decoy second result frame after it is ignored.
        let port = serve_chunked_stream(
            vec![
                "{\"type\":\"progress\",\"stage\":\"searching\"}\n".to_string(),
                "{\"type\":\"progress\",\"stage\":\"reading\"}\n".to_string(),
                "{\"type\":\"result\",\"status\":\"bundle\",\"systemBlock\":\"first\"}\n".to_string(),
                "{\"type\":\"result\",\"status\":\"error\",\"message\":\"decoy\"}\n".to_string(),
            ],
            false,
        )
        .await;
        let bridge = test_bridge(port);
        let token = CancellationToken::new();
        let mut seen: Vec<String> = Vec::new();
        let res = bridge
            .research(&serde_json::json!({"prompt": "x"}), &token, |f| {
                seen.push(f["type"].as_str().unwrap_or("").to_string());
            })
            .await;
        let frame = res.expect("terminal frame");
        assert_eq!(frame["status"], "bundle"); // FIRST result wins
        assert_eq!(seen, vec!["progress".to_string(), "progress".to_string()]);
    }
}
