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
//!
//! Since Phase 9, page-content commands on an AGENT turn park on a
//! Browser Panel approval card (`cmd` below drives that real
//! park→resolve loop end-to-end by connecting a dedicated approver
//! socket and answering every card with `accept`). The turn stays a
//! real agent turn (`t1`/`t2`), preserving the created_by_agent and
//! end_turn cleanup coverage the smoke exists for.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;

use ruke_browser::contract::parse_envelope;
use ruke_browser::engine::BrowserRuntime;
use ruke_browser::errors::BrowserError;
use serde_json::{json, Value};

const PAGE_A: &str = "Ruke Smoke Page A";
const PAGE_B: &str = "Ruke Smoke Page B";
const PAGE_R: &str = "Ruke Receipt Page";
const PAGE_F: &str = "Ruke Form Page";

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

/// Phase-5 fixture: interactive controls the DOM-CUA walker must render,
/// a JS-set password value that must NEVER leak into a snapshot, a
/// pre-selected option (`value="two"`), a tall body so a real wheel
/// scroll changes real scroll state, and a walker-addressed button whose
/// handler navigates (verified against real navigated state).
fn form_html() -> String {
    "<!doctype html><html><head><title>Ruke Form Page</title></head><body>\
     <h1>Form</h1>\
     <input id=\"name\" placeholder=\"your name\">\
     <textarea id=\"msg\">pre-filled message</textarea>\
     <select id=\"pick\"><option value=\"one\">One</option>\
     <option value=\"two\" selected>Two</option></select>\
     <input id=\"pw\" type=\"password\" name=\"password\">\
     <script>document.getElementById('pw').value='Sup3rS3cret!';</script>\
     <button onclick=\"location.href='/receipt'\">Go to receipt</button>\
     <div style=\"height:1800px\">tall spacer</div>\
     </body></html>"
        .to_string()
}

/// Phase-5 frame fixture: one anchored same-origin iframe hosting
/// `/inner`. The fixed geometry gives the frame walk real quads for its
/// per-hop geometry transform; the inner input is what the click/type
/// path must reach THROUGH the iframe anchor.
fn frames_html() -> String {
    "<!doctype html><html><head><title>Ruke Frames Page</title></head><body>\
     <h1>Frames</h1>\
     <iframe src=\"/inner\" title=\"inner frame\" \
      style=\"position:fixed;left:60px;top:90px;width:300px;height:200px\"></iframe>\
     </body></html>"
        .to_string()
}

fn inner_html() -> String {
    "<!doctype html><html><head><title>Ruke Inner Page</title></head><body>\
     <input id=\"inner-in\" placeholder=\"inner field\">\
     </body></html>"
        .to_string()
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
                "/form" => ("200 OK", form_html()),
                "/frames" => ("200 OK", frames_html()),
                "/inner" => ("200 OK", inner_html()),
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
///
/// The Phase-9 approval contract runs THROUGH this helper: a gated
/// command registers its approval card and parks, so the test watches
/// the dedicated approver socket (`gate_rx`) while the command is in
/// flight and answers every `approval_request` with `accept` — the
/// product's real park→resolve loop, not a bypass. `accept` persists
/// nothing, so each gated command earns (and the smoke resolves) its
/// own card. Ungated bookkeeping commands simply complete before any
/// card could arrive; broadcasts that do arrive are ignored.
async fn cmd(
    rt: &BrowserRuntime,
    gate_rx: &mut UnboundedReceiver<Value>,
    session: &str,
    turn: &str,
    envelope: Value,
) -> Result<Value, BrowserError> {
    let env = parse_envelope(&envelope)
        .unwrap_or_else(|e| panic!("test-authored envelope {envelope} rejected: {e}"));
    assert_eq!(env.session_id, session);
    assert_eq!(env.turn_id, turn);
    let fut = rt.command(session, turn, &env.command);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            biased;
            r = &mut fut => return r,
            card = gate_rx.recv() => match card {
                Some(m) if m["type"] == json!("approval_request") => {
                    let id = m["id"].as_str().expect("an approval card carries an id");
                    assert!(
                        rt.resolve_approval(id, &json!({"decision": "accept"})),
                        "card {id} was already resolved"
                    );
                }
                // `tabs` broadcasts etc. — not a card.
                Some(_) => {}
                // Only reachable once the runtime shuts the hub down
                // (post-shutdown probes): the command still answers
                // with its own typed refusal then.
                None => return (&mut fut).await,
            }
        }
    }
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

/// Public node id of the first snapshot line containing `needle`
/// (`node_id=` is always the first emitted attribute — see `se`).
fn dom_node_id(dom: &str, needle: &str) -> u64 {
    let line = dom
        .lines()
        .find(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("snapshot has no line containing {needle:?}: {dom}"));
    line.split_whitespace()
        .find_map(|tok| tok.strip_prefix("node_id="))
        // The first attribute abuts `>` when the element has no others
        // (`<button node_id=5>`), so take only the leading digits.
        .and_then(|id| {
            id.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .ok()
        })
        .unwrap_or_else(|| panic!("line {line:?} carries no node_id"))
}

/// Live-page read through the Phase-4 raw-CDP command path (real
/// Runtime.evaluate, returnByValue): the assertions in the Phase-5 block
/// all read REAL page state this way, never a command echo.
async fn eval_value(
    rt: &BrowserRuntime,
    gate_rx: &mut UnboundedReceiver<Value>,
    session: &str,
    turn: &str,
    tab: &str,
    expression: &str,
) -> Value {
    let r = ok(
        cmd(
            rt,
            gate_rx,
            session,
            turn,
            json!({"commandType":"tab_cdp_call","session_id":session,"turn_id":turn,
                   "payload":{"browser_id":"default","tab_id":tab,
                              "method":"Runtime.evaluate",
                              "params":{"expression":expression,"returnByValue":true}}}),
        )
        .await,
        "tab_cdp_call evaluate",
    );
    r.pointer("/result/result/value")
        .cloned()
        .unwrap_or(Value::Null)
}

/// Phase-6 helper: `tab_ax_get_state` over the axState content mode
/// (the screenshot modes land with Phase 8), optionally disabling the
/// diff so the full-tree answer is testable too.
async fn ax_state(
    rt: &BrowserRuntime,
    gate_rx: &mut UnboundedReceiver<Value>,
    session: &str,
    turn: &str,
    tab: &str,
    disable_diffing: Option<bool>,
) -> Value {
    let mut payload = json!({"browser_id": "default", "tab_id": tab, "content": "axState"});
    if let Some(d) = disable_diffing {
        payload["disable_diffing"] = json!(d);
    }
    ok(
        cmd(
            rt,
            gate_rx,
            session,
            turn,
            json!({"commandType":"tab_ax_get_state","session_id":session,"turn_id":turn,
                   "payload":payload}),
        )
        .await,
        "tab_ax_get_state",
    )
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

    // Phase-9 contract: with NO panel connected, page-content commands
    // on an agent turn fail closed ("no Browser Panel is connected to
    // grant it"). Connect a dedicated approver socket for the whole run
    // — `cmd` reads the cards off this receiver and answers each with
    // `accept` (the human decision path: `resolve_approval`, the same
    // one the Panel's WS inbound drives).
    let (_approver_client, mut gate_rx) = rt.ui_open();

    // ── create + navigate (real page state comes back) ───────────────
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
                &mut gate_rx,
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

    // ── Phase 4: raw CDP bridge + bounded event replay (the SAME
    // session and tab the commands drove) ───────────────────────────
    // tab_cdp_call runs a real Runtime.evaluate on the tab's own
    // flattened session — the answer comes from the live page, never
    // from an echoed payload (conn.call already unwrapped the wire
    // `result`, so the evaluate RemoteObject nests under result.result).
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"tab_cdp_call","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,
                              "method":"Runtime.evaluate",
                              "params":{"expression":"document.title","returnByValue":true}}}),
        )
        .await,
        "tab_cdp_call Runtime.evaluate",
    );
    assert_eq!(r["method"], json!("Runtime.evaluate"));
    assert_eq!(
        r["result"]["result"]["value"],
        json!(PAGE_R),
        "the raw CDP read must come from live page state (the panel-\
         navigated receipt page): {r}"
    );

    // tab_cdp_events: real protocol events the pump buffered during the
    // navigations above. limit=1 paging walks the whole ring: sequences
    // are strictly consecutive, the cursor resumes exactly where each
    // page left off, and only the final page drops has_more. The walk
    // runs on the turn-"ui" key (gate- and budget-exempt) because the
    // limit=1 paging is test scaffolding, not agent traffic: one page
    // per ring event would blow the real 120-commands-per-turn cap that
    // the agent turns must respect.
    let mut cursor = 0u64;
    let mut methods: Vec<String> = Vec::new();
    let mut pages = 0usize;
    let mut truncated_seen = false;
    loop {
        let r = ok(
            cmd(
                &rt,
                &mut gate_rx,
                "s1",
                "ui",
                json!({"commandType":"tab_cdp_events","session_id":"s1","turn_id":"ui",
                       "payload":{"browser_id":"default","tab_id":tab1,
                                  "cursor":cursor,"limit":1}}),
            )
            .await,
            "tab_cdp_events page",
        );
        pages += 1;
        assert!(pages <= 5_000, "paging did not terminate at {cursor}");
        truncated_seen |= r["truncated"].as_bool().unwrap();
        let evs = r["events"].as_array().unwrap();
        assert_eq!(evs.len(), 1, "paging stalled at cursor {cursor}: {r}");
        let e = &evs[0];
        let seq = e["sequence"].as_u64().unwrap();
        assert_eq!(seq, cursor + 1, "the cursor is exclusive");
        assert_eq!(e["source"]["tab_id"], json!(tab1));
        assert_eq!(
            r["source"]["tab_id"],
            json!(tab1),
            "every page describes the tab it was queried for: {r}"
        );
        assert_eq!(r["next_cursor"], json!(seq));
        methods.push(e["method"].as_str().unwrap().to_string());
        cursor = seq;
        if !r["has_more"].as_bool().unwrap() {
            break;
        }
    }
    assert!(
        methods.iter().any(|m| m == "Page.frameNavigated"),
        "replay must contain the REAL navigation events: {methods:?}"
    );
    assert!(
        methods.iter().any(|m| m == "Page.loadEventFired"),
        "the pump's load sightings are replayable: {methods:?}"
    );
    assert!(
        !methods.iter().any(|m| m == "Page.screencastFrame"),
        "JPEG frames are UiHub fan-out, never replay evidence: {methods:?}"
    );
    assert!(
        !truncated_seen,
        "nothing evicted from a 2000-deep ring at this traffic level"
    );

    // An unknown method on a live session is a real CDP wire error, not
    // a fabricated success.
    let err = cmd(
        &rt,
        &mut gate_rx,
        "s1",
        "t1",
        json!({"commandType":"tab_cdp_call","session_id":"s1","turn_id":"t1",
               "payload":{"browser_id":"default","tab_id":tab1,
                          "method":"NotReal.method"}}),
    )
    .await
    .expect_err("unknown CDP method must fail");
    assert!(
        matches!(err, BrowserError::CdpFailed { .. }),
        "expected CdpFailed, got {err:?}"
    );

    // ── Phase 5: DOM CUA — walker snapshot, deterministic refs, click,
    // type, scroll, frames descend, and stale-ref recovery, all against
    // REAL page state through the SAME session/tab commands path ─────
    let url_form = format!("{base}/form");
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_form}}),
        )
        .await,
        "navigate /form",
    );
    assert_eq!(r["url"], json!(url_form));
    assert_eq!(r["title"], json!(PAGE_F));

    let snap1 = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_get_visible_dom","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "dom_cua_get_visible_dom /form",
    );
    let dom1 = snap1["dom"].as_str().expect("dom string").to_string();
    assert!(
        snap1["element_count"].as_u64().unwrap() > 0,
        "the walker found the interactive elements: {snap1}"
    );
    assert!(
        dom1.contains("placeholder=\"your name\""),
        "input line missing: {dom1}"
    );
    assert!(
        dom1.contains("pre-filled message"),
        "textarea text missing: {dom1}"
    );
    assert!(
        dom1.contains("value=\"two\""),
        "selected option value missing: {dom1}"
    );
    assert!(
        dom1.contains("type=\"password\""),
        "password input missing: {dom1}"
    );
    assert!(
        dom1.contains("value=\"<redacted>\""),
        "the credential budget must redact, not drop: {dom1}"
    );
    assert!(
        !dom1.contains("Sup3rS3cret!"),
        "a page-JS-set password value must NEVER reach the model: {dom1}"
    );

    // Same-document re-snapshot: public ids are stable (the reference's
    // main-document key keeps nodeByPublicId alive across snapshots).
    let snap2 = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_get_visible_dom","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "dom_cua_get_visible_dom /form (second)",
    );
    let dom2 = snap2["dom"].as_str().expect("dom string").to_string();
    assert_eq!(
        dom_node_id(&dom1, "placeholder=\"your name\""),
        dom_node_id(&dom2, "placeholder=\"your name\""),
        "same-document snapshots must hand back the same node ids"
    );

    // Node-less scroll: a real wheel at the viewport center over the
    // 1800px-tall body moves REAL scroll state.
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_scroll","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"x":0,"y":300}}),
        )
        .await,
        "dom_cua_scroll (node-less)",
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let top = eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.scrollingElement.scrollTop",
        )
        .await;
        if top.as_f64().unwrap_or(0.0) > 0.0 {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("wheel scroll never moved real scroll state (scrollTop {top})");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Click by snapshot node id: real press+release at the resolved
    // point — proven by REAL focus state, then typed text by REAL
    // input state (dom_cua_type lands in the FOCUSED element: the
    // TextPayload contract carries no node, so the click focuses).
    let name_node = dom_node_id(&dom1, "placeholder=\"your name\"");
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_click","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"node_id":name_node}}),
        )
        .await,
        "dom_cua_click input#name",
    );
    assert_eq!(r["node_id"], json!(name_node));
    assert!(
        r["x"].as_f64().is_some() && r["y"].as_f64().is_some(),
        "click answers the resolved point: {r}"
    );
    assert_eq!(
        eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.activeElement.id"
        )
        .await,
        json!("name"),
        "the DOM-CUA click must really focus the clicked input"
    );
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_type","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"text":"Ruke DOM CUA"}}),
        )
        .await,
        "dom_cua_type",
    );
    assert_eq!(r["typed_chars"], json!(12));
    assert_eq!(
        eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.getElementById('name').value"
        )
        .await,
        json!("Ruke DOM CUA"),
        "typed text must live in the real input value"
    );

    // Snapshot-addressed navigation: clicking the walker's button line
    // drives a REAL navigation, verified against the registry (pump).
    let btn_node = dom_node_id(&dom1, "Go to receipt");
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_click","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"node_id":btn_node}}),
        )
        .await,
        "dom_cua_click button",
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let r = ok(
            cmd(
                &rt,
                &mut gate_rx,
                "s1",
                "t1",
                json!({"commandType":"get_tab","session_id":"s1","turn_id":"t1",
                       "payload":{"browser_id":"default","tab_id":tab1}}),
            )
            .await,
            "get_tab after DOM-CUA click",
        );
        if r["url"] == json!(receipt_url) && r["title"] == json!(PAGE_R) {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("DOM-CUA click never drove the real navigation (registry: {r})");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // Stale-ref recovery: the same node id, now from a destroyed
    // document, answers the pinned stale error instead of clicking a
    // wrong or fresh element.
    let err = cmd(
        &rt,
        &mut gate_rx,
        "s1",
        "t1",
        json!({"commandType":"dom_cua_click","session_id":"s1","turn_id":"t1",
               "payload":{"browser_id":"default","tab_id":tab1,"node_id":btn_node}}),
    )
    .await
    .expect_err("a node id from a navigated-away document must fail closed");
    assert!(
        matches!(err, BrowserError::StaleDomNode { node_id } if node_id == btn_node),
        "expected StaleDomNode({btn_node}), got {err:?}"
    );
    assert_eq!(
        err.to_string(),
        format!("DOM node {btn_node} is stale or missing"),
        "the model-facing stale string is a pinned contract"
    );

    // Frames: the snapshot descends into the iframe document (the
    // inner placeholder line only exists down there), and the click /
    // type path reaches the inner input THROUGH the per-hop geometry
    // transform — proven by REAL focused element inside the iframe.
    let url_frames = format!("{base}/frames");
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_frames}}),
        )
        .await,
        "navigate /frames",
    );
    let snap3 = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_get_visible_dom","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "dom_cua_get_visible_dom /frames",
    );
    let dom3 = snap3["dom"].as_str().expect("dom string").to_string();
    assert!(
        dom3.contains("placeholder=\"inner field\""),
        "the walk must descend into the iframe document: {dom3}"
    );
    let inner_node = dom_node_id(&dom3, "placeholder=\"inner field\"");
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_click","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"node_id":inner_node}}),
        )
        .await,
        "dom_cua_click inner input",
    );
    assert_eq!(
        eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.querySelector('iframe').contentDocument.activeElement.id",
        )
        .await,
        json!("inner-in"),
        "the per-hop geometry transform must land the click inside the iframe"
    );
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_type","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"text":"inner typed"}}),
        )
        .await,
        "dom_cua_type into inner frame",
    );
    assert_eq!(
        eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.querySelector('iframe').contentDocument.getElementById('inner-in').value",
        )
        .await,
        json!("inner typed"),
        "typing must reach the real focused element inside the iframe"
    );

    // ── Phase 6: AX capture against REAL page state through the SAME
    // session/tab command path — grounded full tree with the pinned
    // header, the recovered no-change text, REAL changed lines after a
    // real focus/value mutation, full-tree mode, frame descent, and
    // full-tree restart on a new document ────────────────────────────
    const DIFF_HEADER: &str = "The following is a diff from the previous accessibility tree \
                               with ~ and + representing changed and added elements, \
                               respectively. Removed elements are summarized by ID range.";
    const NO_CHANGE: &str = "There has been no change in the accessibility tree.";

    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_form}}),
        )
        .await,
        "navigate /form (AX battery)",
    );

    // First capture: the full tree with the pinned header contract.
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, None).await;
    let ax1 = r["rendered"].as_str().expect("rendered").to_string();
    assert!(
        ax1.starts_with(&format!(
            "Browser tab: {tab1}, Title: \"Ruke Form Page\", URL: \"{url_form}\".\n"
        )),
        "the pinned header line is missing: {ax1}"
    );
    assert!(
        ax1.contains("Go to receipt"),
        "the button name is missing: {ax1}"
    );
    assert!(
        !ax1.contains("Sup3rS3cret!"),
        "the AX tree must never leak a page-JS-set password value: {ax1}"
    );
    assert!(
        r["element_count"].as_u64().unwrap() >= 6,
        "the form controls belong in the tree: {r}"
    );
    assert!(
        r["document_key"].as_str().is_some_and(|k| !k.is_empty()),
        "a committed revision answers its document key: {r}"
    );

    // Same document, no mutation: the recovered no-change text.
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, None).await;
    let ax2 = r["rendered"].as_str().expect("rendered").to_string();
    assert_eq!(
        ax2.lines().last().unwrap_or(""),
        NO_CHANGE,
        "an unchanged document must answer the no-change text: {ax2}"
    );

    // A REAL click + type mutates focus (and the input's value): the
    // next capture is a diff carrying changed/added lines.
    let snap = ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_get_visible_dom","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1}}),
        )
        .await,
        "dom_cua_get_visible_dom /form (AX battery)",
    );
    let dom = snap["dom"].as_str().expect("dom string").to_string();
    let name_node = dom_node_id(&dom, "placeholder=\"your name\"");
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_click","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"node_id":name_node}}),
        )
        .await,
        "dom_cua_click input#name (AX battery)",
    );
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"dom_cua_type","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"text":"Ruke AX"}}),
        )
        .await,
        "dom_cua_type (AX battery)",
    );
    assert_eq!(
        eval_value(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            &tab1,
            "document.getElementById('name').value"
        )
        .await,
        json!("Ruke AX"),
        "the mutation the diff must describe is real page state"
    );
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, None).await;
    let ax3 = r["rendered"].as_str().expect("rendered").to_string();
    assert!(
        ax3.contains(DIFF_HEADER),
        "the second committed revision turns the next capture into a diff: {ax3}"
    );
    assert_eq!(r["diff"], json!(true), "the answer flags the diff: {r}");
    assert!(
        ax3.lines().any(|l| {
            let t = l.trim_start();
            t.starts_with("~ ") || t.starts_with("+ ")
        }),
        "a real focus/value change must produce at least one changed \
         or added line: {ax3}"
    );

    // disable_diffing: full tree again, diff or not.
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, Some(true)).await;
    let ax4 = r["rendered"].as_str().expect("rendered").to_string();
    assert!(
        !ax4.contains(DIFF_HEADER) && ax4.contains("your name"),
        "disable_diffing must answer the full tree: {ax4}"
    );

    // Frames: the AX walk descends into the iframe document, and the
    // addressable elements carry the id tags the action path binds to.
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_frames}}),
        )
        .await,
        "navigate /frames (AX battery)",
    );
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, None).await;
    let ax5 = r["rendered"].as_str().expect("rendered").to_string();
    assert!(
        ax5.contains("inner field"),
        "the AX capture must descend into the iframe document: {ax5}"
    );
    assert!(
        ax5.contains("[id=0]"),
        "the first addressable element carries an [id=N] tag: {ax5}"
    );

    // A fresh navigation is a new document: the diff baseline resets
    // and the tree is answered in full.
    ok(
        cmd(
            &rt,
            &mut gate_rx,
            "s1",
            "t1",
            json!({"commandType":"navigate_tab_url","session_id":"s1","turn_id":"t1",
                   "payload":{"browser_id":"default","tab_id":tab1,"url":url_form}}),
        )
        .await,
        "navigate /form again (AX battery)",
    );
    let r = ax_state(&rt, &mut gate_rx, "s1", "t1", &tab1, None).await;
    let ax6 = r["rendered"].as_str().expect("rendered").to_string();
    assert!(
        !ax6.contains(DIFF_HEADER) && ax6.contains("Go to receipt"),
        "a new document must restart with the full tree: {ax6}"
    );

    // ── turn cleanup: unmarked tab closes, deliverable survives ──────
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
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
            &mut gate_rx,
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
            &mut gate_rx,
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
        find_tab(tabs, &tab1)["url"] == json!(url_form),
        "deliverable tab must survive turn cleanup (still on the page the \
         AX battery last navigated to): {tabs:?}"
    );
    assert!(
        !tabs.iter().any(|t| t["tab_id"] == json!(tab2)),
        "unmarked agent tab must be closed by turn cleanup: {tabs:?}"
    );

    // ── explicit close + stale-handle fail-closed ────────────────────
    let r = ok(
        cmd(
            &rt,
            &mut gate_rx,
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
        &mut gate_rx,
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
        &mut gate_rx,
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
            &mut gate_rx,
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
        &mut gate_rx,
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
