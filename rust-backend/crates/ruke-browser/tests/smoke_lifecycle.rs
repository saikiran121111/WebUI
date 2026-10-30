//! Phase-2 end-to-end smoke: launch the bundled Chromium for real
//! (headless), drive the Phase-2 lifecycle commands through the exact
//! `BrowserRuntime::command` entry the Phase-10 tool loop will use, and
//! assert every answer against REAL page state — a test-local loopback
//! HTTP fixture with deterministic titles, plus a real back/forward
//! history walk. "Model text alone is never proof" applies to tests too:
//! the assertions read back `location.href`/`document.title` through
//! CDP, not the echoed intent of the command payload.
//!
//! `#[ignore]`d by design: this launches a real browser, binds a
//! loopback port, and takes the persistent `.data/ruke-browser-profile`
//! profile lock, so it must not run inside the ordinary `cargo test`
//! pass and must not run while a Ruke server holds the same profile.
//! Explicit invocation (documented in RUKE-IMPLEMENTATION-PLAN):
//!
//! ```text
//! cargo test -p ruke-browser --test smoke_lifecycle -- --ignored
//! ```

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::Duration;

use ruke_browser::contract::parse_envelope;
use ruke_browser::engine::BrowserRuntime;
use ruke_browser::errors::BrowserError;
use serde_json::{json, Value};

const PAGE_A: &str = "Ruke Smoke Page A";
const PAGE_B: &str = "Ruke Smoke Page B";
const PAGE_R: &str = "Ruke Receipt Page";

/// Phase-3 addition: every page carries a fixed 100×300 px click target
/// whose handler navigates to `/receipt` — so a real CDP `Input.*` click
/// (the Browser Panel path) is verified by REAL navigation state, not an
/// echoed payload. The headless default viewport (800×600) comfortably
/// contains the target.
fn page_html(title: &str) -> String {
    format!(
        "<!doctype html><html><head><title>{title}</title></head>\
         <body><h1>{title}</h1><a href=\"/b\">go to B</a>\
         <div id=\"hit\" onclick=\"location.href='/receipt'\" \
          style=\"position:fixed;left:100px;top:100px;width:200px;height:200px\">click me</div>\
         </body></html>"
    )
}

/// Deterministic two-route fixture on an ephemeral loopback port.
/// `Connection: close` keeps the single accept loop from blocking on a
/// kept-alive socket; unknown paths (favicon) answer 404 with HTML.
fn start_fixture() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture bind");
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
            eprintln!(
                "[fixture] {n} bytes, request: {:?}",
                head.lines().next().unwrap_or("(empty)")
            );
            let (status, body) = match path.as_str() {
                "/a" => ("200 OK", page_html(PAGE_A)),
                "/b" => ("200 OK", page_html(PAGE_B)),
                "/receipt" => ("200 OK", page_html(PAGE_R)),
                _ => (
                    "404 Not Found",
                    "<!doctype html><html><head><title>fixture 404</title></head><body>404</body></html>".to_string(),
                ),
            };
            eprintln!(
                "[fixture] sending {status} body[:60]={:?}",
                &body[..body.len().min(60)]
            );
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    base
}

/// Envelope → runtime.command, mirroring the route handler's path so the
/// smoke exercises the real parse/dispatch chain, not a shortcut.
async fn cmd(
    rt: &BrowserRuntime,
    session: &str,
    turn: &str,
    envelope: Value,
) -> Result<Value, BrowserError> {
    let env = parse_envelope(&envelope)
        .unwrap_or_else(|e| panic!("test-authored envelope {envelope} rejected: {e}"));
    assert_eq!(env.session_id, session);
    assert_eq!(env.turn_id, turn);
    rt.command(session, turn, &env.command).await
}

fn ok(result: Result<Value, BrowserError>, what: &str) -> Value {
    result.unwrap_or_else(|e| panic!("{what} failed: {e}"))
}

/// Same fail-loud rule for the panel helpers that answer `()`.
fn okx<T>(result: Result<T, BrowserError>, what: &str) -> T {
    result.unwrap_or_else(|e| panic!("{what} failed: {e}"))
}

fn tab_id_of(v: &Value) -> String {
    v["tab_id"]
        .as_str()
        .unwrap_or_else(|| panic!("no tab_id in {v}"))
        .to_string()
}

fn find_tab<'a>(tabs: &'a [Value], id: &str) -> &'a Value {
    tabs.iter()
        .find(|t| t["tab_id"] == json!(id))
        .unwrap_or_else(|| panic!("tab {id} missing from {tabs:?}"))
}

#[tokio::test]
#[ignore = "launches real Chromium and takes the product profile lock (see file header)"]
async fn phase2_lifecycle_smoke_against_real_chromium() {
    // crates/ruke-browser lives three levels under the WebUI project
    // root (`<root>/rust-backend/crates/ruke-browser`) — that root is
    // where `.data/` (bundle + profile) lives.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate sits three levels below the project root")
        .to_path_buf();
    // Product precondition, not a fixture: the Playwright Chromium must
    // be installed under `.data/` (host.rs discovers it, never hardcodes
    // the bundle version).
    let ms = root.join(".data").join("ms-playwright");
    assert!(
        ms.is_dir(),
        "Playwright Chromium bundle missing at {}",
        ms.display()
    );

    let base = start_fixture();
    let rt = BrowserRuntime::new(root);
    let url_a = format!("{base}/a");
    let url_b = format!("{base}/b");

    // ── create + navigate (real page state comes back) ───────────────
    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"tab_new","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default"}}),
        )
        .await,
        "tab_new",
    );
    let tab1 = tab_id_of(&r);

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_a}}),
        )
        .await,
        "navigate /a",
    );
    assert_eq!(r["url"], json!(url_a));
    assert_eq!(r["title"], json!(PAGE_A));

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"get_tab","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "get_tab",
    );
    assert_eq!(r["url"], json!(url_a));
    assert_eq!(r["title"], json!(PAGE_A));
    assert_eq!(r["created_by_agent"], json!(true));

    // ── real history walk: /b → back → forward ───────────────────────
    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_b}}),
        )
        .await,
        "navigate /b",
    );
    assert_eq!(r["url"], json!(url_b));
    assert_eq!(r["title"], json!(PAGE_B));

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_back","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "back",
    );
    assert_eq!(r["url"], json!(url_a));
    assert_eq!(r["title"], json!(PAGE_A));

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_forward","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "forward",
    );
    assert_eq!(r["url"], json!(url_b));
    assert_eq!(r["title"], json!(PAGE_B));

    // Reload re-answers the same grounded state.
    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_reload","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "reload",
    );
    assert_eq!(r["url"], json!(url_b));
    assert_eq!(r["title"], json!(PAGE_B));

    // ── Browser Panel (Phase 3): live screencast + real input into the
    // SAME tab the commands drive (one shared session, no parallel
    // browser) ──────────────────────────────────────────────────────
    let (panel, mut hub_rx) = rt.ui_open();
    let sub = ok(
        rt.ui_subscribe(panel, &tab1).await,
        "panel subscribe (starts the ref-counted screencast)",
    );
    assert_eq!(sub["tab_id"], json!(tab1));
    assert_eq!(sub["url"], json!(url_b));

    // A real JPEG frame rides the hub channel (ignoring `tabs`
    // broadcasts that arrive alongside).
    let frame = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let msg = hub_rx.recv().await.expect("hub channel stays open");
            if msg["type"] == json!("frame") && msg["tab_id"] == json!(tab1) {
                return msg;
            }
        }
    })
    .await
    .expect("no screencast frame within 15s");
    assert!(
        !frame["data"].as_str().unwrap_or("").is_empty(),
        "the first frame carries image bytes, not a placeholder"
    );

    // A real click through the panel path: press + release inside the
    // fixture's fixed click target. The page's own handler navigates to
    // /receipt — verified against REAL navigated state (the pump
    // propagating url + title into the registry), never a command echo.
    okx(
        rt.ui_input(
            panel,
            &tab1,
            &json!({"kind":"mouse","action":"press","x":200.0,"y":200.0,
                    "button":"left","click_count":1}),
        )
        .await,
        "panel mouse press",
    );
    okx(
        rt.ui_input(
            panel,
            &tab1,
            &json!({"kind":"mouse","action":"release","x":200.0,"y":200.0,
                    "button":"left","click_count":1}),
        )
        .await,
        "panel mouse release",
    );
    let receipt_url = format!("{base}/receipt");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let r = ok(
            cmd(
                &rt,
                "s1",
                "t1",
                json!({"commandType":"get_tab","session_id":"s1","turn_id":"t1",
                       "payload":{"browser_id":"default","tab_id":tab1}}),
            )
            .await,
            "get_tab after panel click",
        );
        if r["url"] == json!(receipt_url) && r["title"] == json!(PAGE_R) {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("panel click never reached the page (registry: {r})");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // Acting without a live subscription is a typed refusal (the panel
    // gate), and unsubscribing leaves no capture running behind it.
    okx(
        rt.ui_unsubscribe(panel, &tab1).await,
        "panel unsubscribe (last viewer stops the screencast)",
    );
    rt.ui_close(panel).await;

    // ── turn cleanup: unmarked tab closes, deliverable survives ──────
    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"tab_new","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default"}}),
        )
        .await,
        "tab_new (helper)",
    );
    let tab2 = tab_id_of(&r);

    ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"tab_mark_deliverable","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "mark deliverable",
    );

    rt.end_turn("s1", "t1").await;

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t2",
            json!({"commandType":"tabs","session_id":"s1","turn_id":"t2",
                   "payload":{}}),
        )
        .await,
        "tabs after end_turn",
    );
    let tabs = r["tabs"].as_array().unwrap();
    assert!(
        find_tab(tabs, &tab1)["url"] == json!(receipt_url),
        "deliverable tab must survive turn cleanup (still on the panel-\
         navigated receipt page): {tabs:?}"
    );
    assert!(
        !tabs.iter().any(|t| t["tab_id"] == json!(tab2)),
        "unmarked agent tab must be closed by turn cleanup: {tabs:?}"
    );

    // ── explicit close + stale-handle fail-closed ────────────────────
    let r = ok(
        cmd(
            &rt,
            "s1",
            "t1",
            json!({"commandType":"tab_close","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "tab_close",
    );
    assert_eq!(r["closed"], json!(true));

    let err = cmd(
        &rt,
        "s1",
        "t1",
        json!({"commandType":"get_tab","session_id":"s1","turn_id":"t1",
               "payload":{"browser_id":"default","tab_id":tab1}}),
    )
    .await
    .expect_err("closed tab handle must fail closed");
    assert!(
        matches!(err, BrowserError::ContextUnavailable),
        "expected ContextUnavailable, got {err:?}"
    );

    // A wrong browser_id is a typed refusal, not a silent default.
    let err = cmd(
        &rt,
        "s1",
        "t1",
        json!({"commandType":"tabs","session_id":"s1","turn_id":"t1",
               "payload":{"browser_id":"nope"}}),
    )
    .await
    .expect_err("unknown browser_id must be refused");
    assert!(
        matches!(err, BrowserError::CapabilityBlocked { .. }),
        "expected CapabilityBlocked, got {err:?}"
    );

    // ── graceful shutdown: state cleared, handles dead ───────────────
    rt.shutdown().await;

    let r = ok(
        cmd(
            &rt,
            "s1",
            "t3",
            json!({"commandType":"tabs","session_id":"s1","turn_id":"t3",
                   "payload":{}}),
        )
        .await,
        "tabs after shutdown",
    );
    assert_eq!(
        r["tabs"].as_array().unwrap().len(),
        0,
        "shutdown must clear the registry (listing never relaunches)"
    );

    let err = cmd(
        &rt,
        "s1",
        "t1",
        json!({"commandType":"get_tab","session_id":"s1","turn_id":"t1",
               "payload":{"browser_id":"default","tab_id":tab1}}),
    )
    .await
    .expect_err("post-shutdown handle must fail closed");
    assert!(
        matches!(err, BrowserError::ContextUnavailable),
        "expected ContextUnavailable, got {err:?}"
    );
}
