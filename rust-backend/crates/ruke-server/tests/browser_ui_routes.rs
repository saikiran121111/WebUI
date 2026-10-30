//! Phase-3 panel socket routes: the ticket hop is bridge-authed, and the
//! WS admission gate (Origin allowlist + one-shot ticket) refuses with a
//! real 403 BEFORE the upgrade, and admits with 101. The socket protocol
//! itself is exercised end-to-end against real Chromium by
//! `ruke-browser`'s smoke; here we pin admission over a REAL hyper
//! transport (a `tower::oneshot` cannot carry a WS upgrade: axum's
//! WebSocketUpgrade extractor needs the `OnUpgrade` extension hyper
//! injects per connection, which hyper exposes no public constructor
//! for), plus the ticket HTTP contract via oneshot. No Chromium ever
//! launches: refused handshakes never reach the engine, and the ticket
//! hop only mints entropy.
//!
//! One test fn on purpose: the bridge-secret env var is process-global,
//! so the whole sequence serializes in a single task (the in-binary
//! browser route tests use the same pattern). The ticket store lives in
//! the shared `Arc<BrowserRuntime>` inside `AppState`, so the oneshot
//! router and the served router are built from clones of the SAME state.

mod common;

use axum::body::Body;
use axum::http::{HeaderName, HeaderValue, Request, StatusCode};
use axum::Router;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tower::ServiceExt; // oneshot

const SECRET: &str = "ui-routes-test-secret";

fn secret_header() -> HeaderName {
    HeaderName::from_static(ruke_websearch::browser_bridge::SECRET_HEADER)
}

async fn body_json(res: axum::http::Response<Body>) -> Value {
    let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
        .await
        .expect("body reads");
    serde_json::from_slice(&bytes).expect("route answers JSON")
}

async fn mint_ticket(app: Router) -> Value {
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/ruke/browser/ws-ticket")
                .header(secret_header(), HeaderValue::from_static(SECRET))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res).await
}

/// A hand-rolled WS upgrade handshake over a real socket: we pin the
/// server's admission decision from the raw response, never the WS
/// protocol (a 403 refusal is plain HTTP; a 101 answer is read only
/// through the headers — any frames the hub pushes after the upgrade
/// are left unread and the server cleans the client up on disconnect).
async fn raw_handshake(
    addr: std::net::SocketAddr,
    origin: &str,
    ticket: &str,
) -> axum::http::StatusCode {
    let probe = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut stream = TcpStream::connect(addr).await.expect("connect server");
        let req = format!(
            "GET /api/ruke/browser/ws?ticket={ticket} HTTP/1.1\r\n\
                 Host: {addr}\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.expect("send");
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 512];
        loop {
            let n = stream.read(&mut tmp).await.expect("read");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
                break;
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
    .await
    .expect("handshake response within 5s");
    let head = probe.lines().next().unwrap_or("").to_string();
    let code: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or_else(|| panic!("no HTTP status in raw answer: {probe:?}"));
    // Refusal bodies ride the header block we already captured.
    if code == 403 {
        assert!(
            probe.to_lowercase().contains("content-length"),
            "a 403 refusal answers a JSON body: {probe:?}"
        );
    }
    axum::http::StatusCode::from_u16(code).expect("valid status code")
}

#[tokio::test]
async fn panel_ticket_and_socket_admission() {
    std::env::set_var(ruke_websearch::browser_bridge::ENV_SECRET, SECRET);
    let (state, _tmp) = common::test_state(None);
    // Same AppState ⇒ same Arc<BrowserRuntime> ⇒ the oneshot ticket hop
    // and the served socket share one ticket store.
    let app = ruke_server::build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral server");
    let addr = listener.local_addr().unwrap();
    let served = ruke_server::build_router(state);
    tokio::spawn(async move {
        axum::serve(listener, served).await.expect("test server");
    });

    // 1) No bridge secret ⇒ 401 (auth is the only status-code failure
    //    on the ticket hop; the wire contract keeps command errors on
    //    HTTP 200 but this is an auth refusal, same stance as the RPC).
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/ruke/browser/ws-ticket")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // 2) Authed ticket: 32 hex chars, the mounted ws path, 60s TTL,
    //    entropy between mints (no derivable sequence).
    let v = mint_ticket(app.clone()).await;
    assert_eq!(v["ok"], serde_json::json!(true));
    let first = v["data"]["ticket"]
        .as_str()
        .expect("ticket present")
        .to_string();
    assert_eq!(first.len(), 32);
    assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    let v2 = mint_ticket(app.clone()).await;
    assert!(v2["data"]["ws_url"]
        .as_str()
        .unwrap()
        .ends_with("/api/ruke/browser/ws"));
    assert_eq!(v2["data"]["ttl_ms"], serde_json::json!(60000));
    let second = v2["data"]["ticket"].as_str().unwrap().to_string();
    assert_ne!(first, second);

    // 3) Wrong Origin ⇒ 403 before the upgrade, and the ticket survives
    //    (Origin is checked first; a refused handshake never burns it —
    //    proven by step 5 admitting with it).
    assert_eq!(
        raw_handshake(addr, "http://evil.example", &first).await,
        StatusCode::FORBIDDEN
    );

    // 4) Allowed Origin, junk ticket ⇒ 403 (unknown tickets fail
    //    closed; failed attempts consume nothing).
    assert_eq!(
        raw_handshake(addr, "http://localhost:3000", "not-a-ticket").await,
        StatusCode::FORBIDDEN
    );

    // 5) Allowed Origin + the still-valid first ticket ⇒ 101 upgrade.
    assert_eq!(
        raw_handshake(addr, "http://127.0.0.1:3000", &first).await,
        StatusCode::SWITCHING_PROTOCOLS
    );

    // 6) Replay: a claimed ticket never admits twice.
    let fresh = mint_ticket(app.clone()).await;
    let fresh = fresh["data"]["ticket"].as_str().unwrap().to_string();
    assert_eq!(
        raw_handshake(addr, "http://localhost:3000", &fresh).await,
        StatusCode::SWITCHING_PROTOCOLS
    );
    assert_eq!(
        raw_handshake(addr, "http://localhost:3000", &fresh).await,
        StatusCode::FORBIDDEN
    );
}
