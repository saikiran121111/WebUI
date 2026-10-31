//! Phase-16 deterministic fixture journeys: real Chromium + the shared
//! fixture server (`<root>/tests/fixtures/browser/server.mjs`, port 3210)
//! driven through the exact `BrowserRuntime::command` entry the model tool
//! loop uses. Every assertion reads REAL page state (URLs, DOM text,
//! downloaded bytes, upload echoes, History DB rows) — never an echo of
//! the command payload and never model text.
//!
//! Unlike the product-profile smoke, this test runs in a THROWAWAY root:
//! `BrowserRuntime::new(<tempdir>)` keeps the profile and downloads under
//! the tempdir (no product profile lock, no product litter), and
//! `RUKE_BROWSER_EXECUTABLE` is pointed at the product `.data/` bundle so
//! no second Chromium install is needed.
//!
//! `#[ignore]`d by design: launches real Chromium and binds port 3210.
//! Explicit invocation:
//!
//! ```text
//! cargo test -p ruke-browser --test fixture_journeys -- --ignored \
//!   --manifest-path rust-backend/Cargo.toml
//! ```
//!
//! The marker constants below mirror the fixture server EXACTLY — they are
//! the same shared contract the Playwright specs (Phase 18) consume. If a
//! marker changes, change the server and every consumer in the same edit.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ruke_browser::contract::parse_envelope;
use ruke_browser::engine::BrowserRuntime;
use ruke_browser::errors::BrowserError;
use ruke_browser::host::ENV_EXECUTABLE;
use serde_json::{json, Value};
use tokio::process::Command as TokioCommand;

// ── fixture marker contract (mirror of server.mjs) ────────────────────────
const FIXTURE_PORT: u16 = 3210;
const EASY_ARRIVED: &str = "EASY-ARRIVED-7C21";
const POPUP_CHILD_MARKER: &str = "POPUP-CHILD-MARKER-4417";
const FRAME_MARKER: &str = "VERCODE-7731";
const LATE_MARKER: &str = "LATE-CONTENT-5150";
const SHADOW_MARKER: &str = "SHADOW-SECRET-8123";
const ALERT_MESSAGE: &str = "RUKE-ALERT-2026";
const DOWNLOAD_CONTENT: &[u8] = b"RUKE-DOWNLOAD-9F3A-0123456789ABCDEF";
const DOWNLOAD_FILENAME: &str = "ruke-fixture-download.bin";
const DEVLOG_INFO: &str = "DEVLOG-INFO-6031";
const DEVLOG_ERROR: &str = "DEVLOG-ERROR-6032";
const UPLOAD_MARKER: &str = "UPLOAD-MARKER-3C8E";
const UPLOAD_FILENAME: &str = "upload-src.txt";

const SESSION: &str = "fx";
/// HUMAN_TURN_ID: gate- and budget-exempt, so journeys stay deterministic
/// without approval plumbing.
const TURN: &str = "ui";

fn base_url() -> String {
    format!("http://127.0.0.1:{FIXTURE_PORT}")
}

// ── smoke-shaped helpers (same envelope/dispatch chain) ───────────────────
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

fn tab_id_of(v: &Value) -> String {
    v["tab_id"]
        .as_str()
        .unwrap_or_else(|| panic!("no tab_id in {v}"))
        .to_string()
}

async fn list_tabs(rt: &BrowserRuntime) -> Vec<Value> {
    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"tabs","session_id":SESSION,"turn_id":TURN,"payload":{}}),
        )
        .await,
        "tabs",
    );
    r["tabs"].as_array().cloned().unwrap_or_default()
}

async fn navigate(rt: &BrowserRuntime, tab: &str, path: &str) -> Value {
    let url = format!("{}{}", base_url(), path);
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"navigate_tab_url","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":tab,"url":url}}),
        )
        .await,
        &format!("navigate {path}"),
    )
}

async fn new_tab(rt: &BrowserRuntime, turn: &str) -> String {
    let r = ok(
        cmd(
            rt,
            SESSION,
            turn,
            json!({"commandType":"tab_new","session_id":SESSION,"turn_id":turn,
                   "payload":{"browser_id":"default"}}),
        )
        .await,
        "tab_new",
    );
    tab_id_of(&r)
}

async fn get_tab(rt: &BrowserRuntime, tab: &str) -> Value {
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"get_tab","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":tab}}),
        )
        .await,
        "get_tab",
    )
}

async fn locator(rt: &BrowserRuntime, command: &str, payload: Value, what: &str) -> Value {
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":command,"session_id":SESSION,"turn_id":TURN,"payload":payload}),
        )
        .await,
        what,
    )
}

async fn click(rt: &BrowserRuntime, tab: &str, selector: &str) -> Value {
    locator(
        rt,
        "playwright_locator_click",
        json!({"browser_id":"default","tab_id":tab,"selector":selector}),
        &format!("locator_click {selector}"),
    )
    .await
}

async fn inner_text(rt: &BrowserRuntime, tab: &str, selector: &str) -> String {
    let r = locator(
        rt,
        "playwright_locator_inner_text",
        json!({"browser_id":"default","tab_id":tab,"selector":selector}),
        &format!("inner_text {selector}"),
    )
    .await;
    r["text"].as_str().unwrap_or_default().to_string()
}

/// Live-page read through raw CDP (real Runtime.evaluate, returnByValue).
async fn eval_value(rt: &BrowserRuntime, tab: &str, expression: &str) -> Value {
    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"tab_cdp_call","session_id":SESSION,"turn_id":TURN,
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

async fn pw_evaluate(rt: &BrowserRuntime, tab: &str, script: &str) -> Value {
    let r = locator(
        rt,
        "playwright_evaluate",
        json!({"browser_id":"default","tab_id":tab,"script":script}),
        "playwright_evaluate",
    )
    .await;
    r["result"].clone()
}

/// Poll the tab list until a tab NOT in `known` carries `url_suffix`.
async fn wait_for_new_tab(rt: &BrowserRuntime, known: &[String], url_suffix: &str) -> String {
    let mut found: Option<String> = None;
    for _ in 0..60 {
        for t in list_tabs(rt).await {
            let Some(id) = t["tab_id"].as_str() else {
                continue;
            };
            let url = t["url"].as_str().unwrap_or_default();
            if url.ends_with(url_suffix) && !known.iter().any(|k| k == id) {
                found = Some(id.to_string());
                break;
            }
        }
        if found.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    found.unwrap_or_else(|| panic!("no new tab with url suffix {url_suffix:?} appeared"))
}

fn tab_ids(tabs: &[Value]) -> Vec<String> {
    tabs.iter()
        .filter_map(|t| t["tab_id"].as_str().map(str::to_string))
        .collect()
}

// ── fixture server lifecycle ──────────────────────────────────────────────
/// Spawn the fixture server unless one is already answering on 3210 (a
/// leftover from an interrupted run is reused, not double-bound).
async fn start_fixture_server(project_root: &Path) -> Option<tokio::process::Child> {
    if TcpStream::connect(("127.0.0.1", FIXTURE_PORT)).is_ok() {
        eprintln!("[fixture_journeys] reusing fixture server already on {FIXTURE_PORT}");
        return None;
    }
    let script = project_root
        .join("tests")
        .join("fixtures")
        .join("browser")
        .join("server.mjs");
    assert!(
        script.is_file(),
        "fixture server missing at {}",
        script.display()
    );
    let mut child = TokioCommand::new("node")
        .arg(&script)
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn node {}: {e}", script.display()));
    for _ in 0..80 {
        if TcpStream::connect(("127.0.0.1", FIXTURE_PORT)).is_ok() {
            return Some(child);
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("fixture server exited early ({status}) before binding {FIXTURE_PORT}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("fixture server never bound {FIXTURE_PORT}");
}

/// Mirror of `HostConfig::discover`'s bundle walk over the PRODUCT root —
/// the test then pins the exe via `RUKE_BROWSER_EXECUTABLE` while the
/// runtime root stays a tempdir (throwaway profile + downloads).
fn discover_product_chromium(product_root: &Path) -> PathBuf {
    let ms = product_root.join(".data").join("ms-playwright");
    let mut best: Option<(u32, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&ms) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(digit_tail) = name.strip_prefix("chromium-") else {
                continue;
            };
            let Ok(version) = digit_tail.parse::<u32>() else {
                continue;
            };
            for sub in [
                "chrome-win64/chrome.exe",
                "chrome-win/chrome.exe",
                "chrome-linux/chrome",
                "chrome-linux64/chrome",
            ] {
                let cand = entry.path().join(sub);
                if cand.is_file() {
                    let better = match &best {
                        None => true,
                        Some((v, _)) => version > *v,
                    };
                    if better {
                        best = Some((version, cand));
                    }
                    break;
                }
            }
        }
    }
    best.unwrap_or_else(|| {
        panic!(
            "no Playwright Chromium bundle under {} (run the Playwright browser install first)",
            ms.display()
        )
    })
    .1
}

#[tokio::test]
#[ignore = "launches real Chromium against the fixture server (see file header)"]
async fn phase16_fixture_journeys_against_real_chromium() {
    // The debug-build state machine of this whole journey is multi-megabyte
    // and overflows the Windows test-thread stack when polled on-stack;
    // boxing pins it to a heap allocation so polling stays stack-cheap.
    Box::pin(run_journeys()).await;
}

async fn run_journeys() {
    let product_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate sits three levels below the project root")
        .to_path_buf();

    let exe = discover_product_chromium(&product_root);
    std::env::set_var(ENV_EXECUTABLE, &exe);

    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().to_path_buf();

    let node = start_fixture_server(&product_root).await;

    // Throwaway root: profile under <temp>/.data, downloads under
    // <temp>/downloads — no product locks taken.
    let rt = &BrowserRuntime::new(root.clone());

    // First command launches Chromium (lazy client).
    let tab_e = new_tab(rt, TURN).await;
    let startup_tab = {
        let mut startup = None;
        for t in list_tabs(rt).await {
            if Some(t["tab_id"].as_str().unwrap_or_default()) == Some(tab_e.as_str()) {
                continue;
            }
            let g = get_tab(rt, t["tab_id"].as_str().unwrap()).await;
            if g["created_by_agent"] == json!(false) {
                startup = Some(t["tab_id"].as_str().unwrap().to_string());
                break;
            }
        }
        startup.expect("a startup (user) tab must exist")
    };

    // ═══ E1: EASY — one click, one real navigation, real URL wait ═════════
    navigate(rt, &tab_e, "/easy").await;
    click(rt, &tab_e, "#go-arrived").await;
    let r = locator(
        rt,
        "playwright_wait_for_url",
        json!({"browser_id":"default","tab_id":tab_e,"url":"**/easy/arrived"}),
        "wait_for_url /easy/arrived",
    )
    .await;
    assert!(
        r["url"]
            .as_str()
            .unwrap_or_default()
            .ends_with("/easy/arrived"),
        "wait_for_url answered {r}"
    );
    assert_eq!(
        inner_text(rt, &tab_e, "#arrived-marker").await,
        EASY_ARRIVED
    );

    // ═══ E2: MEDIUM — every field kind, exact-value GET echo ══════════════
    navigate(rt, &tab_e, "/medium").await;
    locator(
        rt,
        "playwright_locator_fill",
        json!({"browser_id":"default","tab_id":tab_e,"selector":"#note-input","value":"hello world"}),
        "fill note",
    )
    .await;
    let r = locator(
        rt,
        "playwright_locator_select_option",
        json!({"browser_id":"default","tab_id":tab_e,"selector":"#tier-select","option":"business"}),
        "select tier",
    )
    .await;
    assert_eq!(r["selected_values"], json!(["business"]));
    let r = locator(
        rt,
        "playwright_locator_set_checked",
        json!({"browser_id":"default","tab_id":tab_e,"selector":"#subscribe-box","checked":true}),
        "check subscribe",
    )
    .await;
    assert_eq!(r["checked"], json!(true));
    click(rt, &tab_e, "#plan-group input[name=plan][value=annual]").await;
    click(rt, &tab_e, "#submit-btn").await;
    locator(
        rt,
        "playwright_wait_for_url",
        json!({"browser_id":"default","tab_id":tab_e,"url":"**/medium/echo*"}),
        "wait_for_url /medium/echo",
    )
    .await;
    let echo = inner_text(rt, &tab_e, "#echo-output").await;
    let lines: Vec<&str> = echo.lines().collect();
    assert!(lines.contains(&"note=hello world"), "echo {echo:?}");
    assert!(lines.contains(&"tier=business"), "echo {echo:?}");
    assert!(lines.contains(&"subscribe=yes"), "echo {echo:?}");
    assert!(lines.contains(&"plan=annual"), "echo {echo:?}");

    // ═══ E3: HARD — popup adoption inherits the opener's turn owner ══════
    // A popup opened from a tab that HAS a turn owner inherits that key
    // through the Phase-16 adoption arm ⇒ registered as an agent tab
    // (created_by_agent=true) and closed by the final end_turn below.
    // The gate-exempt "ui" turn doubles as the owning turn here; the
    // approval-gated agent-turn path itself belongs to the real-model
    // phases, not this deterministic fixture. tab_a + popup_agent stay
    // open on purpose until cleanup proves end_turn closes BOTH.
    let tab_a = new_tab(rt, TURN).await;
    navigate(rt, &tab_a, "/hard/popup").await;
    let known: Vec<String> = tab_ids(&list_tabs(rt).await);
    click(rt, &tab_a, "#open-popup").await;
    let popup_agent = wait_for_new_tab(rt, &known, "/hard/popup-child").await;
    let g = get_tab(rt, &popup_agent).await;
    assert_eq!(g["created_by_agent"], json!(true), "turn-owned popup: {g}");
    assert!(g["url"]
        .as_str()
        .unwrap_or_default()
        .ends_with("/hard/popup-child"));

    // ═══ E4: HARD — panel click adopts a popup as a USER tab ══════════════
    // The pump inherits the OPENER's owner. Clicking through the panel path
    // (ui_input → real Input.dispatchMouseEvent) on the un-owned startup
    // tab adopts the popup with NO turn owner ⇒ it lists under
    // browser_user_open_tabs and is claimable — the shared-state contract.
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_user_claim_tab","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":startup_tab}}),
        )
        .await,
        "claim startup tab",
    );
    navigate(rt, &startup_tab, "/hard/popup").await;

    let (client, mut hub_rx) = rt.ui_open();
    okx(
        rt.ui_subscribe(client, &startup_tab).await,
        "ui_subscribe startup tab",
    );
    // A static page paints once and then the screencast stays silent; this
    // DOM mutation guarantees a live paint so the frame assertion below is
    // deterministic rather than race-dependent.
    eval_value(
        rt,
        &startup_tab,
        "(() => { const d = document.createElement('div'); d.textContent = 'panel-sync'; \
         document.body.appendChild(d); return true; })()",
    )
    .await;
    let rect = eval_value(
        rt,
        &startup_tab,
        "(() => { const r = document.getElementById('open-popup').getBoundingClientRect(); \
         return { x: r.x, y: r.y, w: r.width, h: r.height }; })()",
    )
    .await;
    let cx = rect["x"].as_f64().expect("button x") + rect["w"].as_f64().expect("button w") / 2.0;
    let cy = rect["y"].as_f64().expect("button y") + rect["h"].as_f64().expect("button h") / 2.0;
    okx(
        rt.ui_input(
            client,
            &startup_tab,
            &json!({"kind":"mouse","action":"press","x":cx,"y":cy}),
        )
        .await,
        "panel mouse press",
    );
    okx(
        rt.ui_input(
            client,
            &startup_tab,
            &json!({"kind":"mouse","action":"release","x":cx,"y":cy}),
        )
        .await,
        "panel mouse release",
    );

    let known: Vec<String> = tab_ids(&list_tabs(rt).await);
    let popup_user = wait_for_new_tab(rt, &known, "/hard/popup-child").await;
    let g = get_tab(rt, &popup_user).await;
    assert_eq!(g["created_by_agent"], json!(false), "human popup: {g}");

    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_user_open_tabs","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default"}}),
        )
        .await,
        "browser_user_open_tabs",
    );
    let user_ids: Vec<String> = tab_ids(r["tabs"].as_array().unwrap());
    assert!(
        user_ids.contains(&popup_user),
        "human popup missing from user tabs: {r}"
    );

    // The panel hub proves the adoption fired: a "tabs" broadcast reached
    // the client, and the ref-counted screencast delivered a "frame".
    let mut saw_tabs = false;
    let mut saw_frame = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while (!saw_tabs || !saw_frame) && tokio::time::Instant::now() < deadline {
        if let Ok(msg) = tokio::time::timeout(Duration::from_millis(500), hub_rx.recv()).await {
            match msg.as_ref().and_then(|m| m["type"].as_str()) {
                Some("tabs") => saw_tabs = true,
                Some("frame") => saw_frame = true,
                _ => {}
            }
        }
    }
    assert!(
        saw_tabs,
        "adoption never broadcast a tabs_changed hub message"
    );
    assert!(
        saw_frame,
        "screencast delivered no frame to the subscribed client"
    );

    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_user_claim_tab","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":popup_user}}),
        )
        .await,
        "claim human popup",
    );
    assert_eq!(
        inner_text(rt, &popup_user, "#popup-marker").await,
        POPUP_CHILD_MARKER
    );
    rt.ui_close(client).await;

    // ═══ E5: HARD — file chooser upload, echoed server-side ══════════════
    // The chooser wait must arm BEFORE the click opens it (pump generations
    // only see waits begun after the call), hence the join!.
    navigate(rt, &tab_e, "/hard/upload").await;
    let upload_path = temp.path().join(UPLOAD_FILENAME);
    std::fs::write(&upload_path, UPLOAD_MARKER).expect("write upload file");
    let (chooser, _click) = tokio::join!(
        locator(
            rt,
            "playwright_wait_for_file_chooser",
            json!({"browser_id":"default","tab_id":tab_e,"timeout_ms":15000}),
            "wait_for_file_chooser",
        ),
        click(rt, &tab_e, "#file-input")
    );
    assert!(
        chooser["file_chooser_id"].is_string(),
        "file chooser answer: {chooser}"
    );
    locator(
        rt,
        "playwright_file_chooser_set_files",
        json!({"browser_id":"default","tab_id":tab_e,
               "files":[upload_path.to_string_lossy()]}),
        "file_chooser_set_files",
    )
    .await;
    click(rt, &tab_e, "#upload-submit").await;
    locator(
        rt,
        "playwright_wait_for_url",
        json!({"browser_id":"default","tab_id":tab_e,"url":"**/hard/upload-echo"}),
        "wait_for_url /hard/upload-echo",
    )
    .await;
    let echo = inner_text(rt, &tab_e, "#upload-echo").await;
    let lines: Vec<&str> = echo.lines().collect();
    assert!(
        lines.contains(&"name=upload-src.txt"),
        "upload echo {echo:?}"
    );
    assert!(
        lines.contains(&"marker=UPLOAD-MARKER-3C8E"),
        "uploaded bytes did not round-trip: {echo:?}"
    );

    // ═══ E6: HARD — download to the runtime dir, bytes verified ══════════
    navigate(rt, &tab_e, "/hard/download").await;
    let (dl, _click) = tokio::join!(
        locator(
            rt,
            "playwright_wait_for_download",
            json!({"browser_id":"default","tab_id":tab_e,"timeout_ms":20000}),
            "wait_for_download",
        ),
        click(rt, &tab_e, "#dl-link")
    );
    assert_eq!(
        dl["suggested_filename"],
        json!(DOWNLOAD_FILENAME),
        "download: {dl}"
    );
    assert!(dl["download_id"].is_string(), "download answer: {dl}");
    let mut disk_path: Option<String> = None;
    for _ in 0..40 {
        let r = locator(
            rt,
            "playwright_download_path",
            json!({"browser_id":"default","tab_id":tab_e}),
            "download_path",
        )
        .await;
        if let Some(p) = r["path"].as_str() {
            disk_path = Some(p.to_string());
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let disk_path = disk_path.expect("download never completed into the runtime dir");
    let bytes = std::fs::read(&disk_path)
        .unwrap_or_else(|e| panic!("cannot read downloaded file {disk_path:?}: {e}"));
    assert_eq!(bytes, DOWNLOAD_CONTENT, "downloaded bytes mismatch");
    // allowAndName names the file with the download guid under <root>/downloads.
    assert!(
        Path::new(&disk_path).starts_with(root.join("downloads")),
        "download landed outside the runtime downloads dir: {disk_path}"
    );

    // ═══ E7: HARD — native dialog mirror: read, accept, page reacts ══════
    navigate(rt, &tab_e, "/hard/dialog").await;
    let r = locator(
        rt,
        "tab_get_js_dialog",
        json!({"browser_id":"default","tab_id":tab_e}),
        "get_js_dialog (none yet)",
    )
    .await;
    assert_eq!(r["dialog"], json!(null), "expected no dialog: {r}");
    click(rt, &tab_e, "#show-alert").await;
    let mut dialog: Option<Value> = None;
    for _ in 0..30 {
        let r = locator(
            rt,
            "tab_get_js_dialog",
            json!({"browser_id":"default","tab_id":tab_e}),
            "get_js_dialog (poll)",
        )
        .await;
        if r["dialog"].is_object() {
            dialog = Some(r["dialog"].clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let dialog = dialog.expect("the pump never mirrored the JS dialog");
    assert_eq!(dialog["type"], json!("alert"), "dialog: {dialog}");
    assert_eq!(dialog["message"], json!(ALERT_MESSAGE), "dialog: {dialog}");
    locator(
        rt,
        "tab_handle_js_dialog",
        json!({"browser_id":"default","tab_id":tab_e,"accept":true}),
        "handle_js_dialog accept",
    )
    .await;
    let mut accepted = false;
    for _ in 0..40 {
        let state = eval_value(
            rt,
            &tab_e,
            "document.getElementById('dlg-state').textContent",
        )
        .await;
        if state == json!("dialog-accepted") {
            accepted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(accepted, "page never recorded the accepted dialog");

    // ═══ E8: HARD — same-origin iframe + open shadow root (evaluate) ═════
    navigate(rt, &tab_e, "/hard/iframe").await;
    locator(
        rt,
        "playwright_wait_for_load_state",
        json!({"browser_id":"default","tab_id":tab_e,"state":"networkidle"}),
        "wait_for_load_state networkidle",
    )
    .await;
    let got = pw_evaluate(
        rt,
        &tab_e,
        "document.getElementById('inner-frame').contentDocument.getElementById('frame-marker').textContent",
    )
    .await;
    assert_eq!(got, json!(FRAME_MARKER), "iframe read");
    navigate(rt, &tab_e, "/hard/shadow").await;
    let got = pw_evaluate(
        rt,
        &tab_e,
        "document.getElementById('the-box').shadowRoot.getElementById('shadow-secret').textContent",
    )
    .await;
    assert_eq!(got, json!(SHADOW_MARKER), "shadow root read");

    // ═══ E9: HARD — delayed / dynamic / stale-replaced nodes ═════════════
    navigate(rt, &tab_e, "/hard/delayed").await;
    locator(
        rt,
        "playwright_locator_wait_for",
        json!({"browser_id":"default","tab_id":tab_e,"selector":"#late","state":"visible","timeout_ms":8000}),
        "locator_wait_for #late",
    )
    .await;
    assert_eq!(inner_text(rt, &tab_e, "#late").await, LATE_MARKER);

    navigate(rt, &tab_e, "/hard/dynamic").await;
    let r = locator(
        rt,
        "playwright_locator_count",
        json!({"browser_id":"default","tab_id":tab_e,"selector":".item"}),
        "locator_count .item",
    )
    .await;
    assert_eq!(r["count"], json!(0));
    click(rt, &tab_e, "#add-item").await;
    click(rt, &tab_e, "#add-item").await;
    let r = locator(
        rt,
        "playwright_locator_count",
        json!({"browser_id":"default","tab_id":tab_e,"selector":".item"}),
        "locator_count .item (after)",
    )
    .await;
    assert_eq!(r["count"], json!(2));
    let r = locator(
        rt,
        "playwright_locator_all_text_contents",
        json!({"browser_id":"default","tab_id":tab_e,"selector":".item"}),
        "all_text_contents .item",
    )
    .await;
    assert_eq!(r["texts"], json!(["item-1", "item-2"]));

    navigate(rt, &tab_e, "/hard/stale").await;
    let first = inner_text(rt, &tab_e, "#stale-node").await;
    locator(
        rt,
        "playwright_wait_for_timeout",
        json!({"browser_id":"default","tab_id":tab_e,"timeout_ms":700}),
        "wait_for_timeout 700",
    )
    .await;
    let second = inner_text(rt, &tab_e, "#stale-node").await;
    let rev = |s: &str| s.trim().trim_start_matches("rev-").parse::<u32>().unwrap();
    assert!(rev(&second) > rev(&first), "stale revs {first} -> {second}");
    let r = locator(
        rt,
        "playwright_locator_is_visible",
        json!({"browser_id":"default","tab_id":tab_e,"selector":"#stale-node"}),
        "is_visible #stale-node",
    )
    .await;
    assert_eq!(r["visible"], json!(true), "selector survived the node swap");

    // ═══ E10: HARD — coordinate (CUA) click + real wheel scroll ══════════
    navigate(rt, &tab_e, "/hard/cua").await;
    locator(
        rt,
        "cua_click",
        json!({"browser_id":"default","tab_id":tab_e,"x":180.0,"y":184.0}),
        "cua_click #cua-btn center",
    )
    .await;
    let count = eval_value(
        rt,
        &tab_e,
        "document.getElementById('cua-count').textContent",
    )
    .await;
    assert_eq!(
        count,
        json!("1"),
        "coordinate click did not reach the handler"
    );

    navigate(rt, &tab_e, "/hard/scroll").await;
    locator(
        rt,
        "cua_scroll",
        json!({"browser_id":"default","tab_id":tab_e,"x":400.0,"y":300.0,"scroll_x":0.0,"scroll_y":600.0}),
        "cua_scroll 600",
    )
    .await;
    locator(
        rt,
        "playwright_wait_for_timeout",
        json!({"browser_id":"default","tab_id":tab_e,"timeout_ms":900}),
        "wait scroll settle",
    )
    .await;
    let y = eval_value(rt, &tab_e, "window.scrollY").await;
    let y = y.as_f64().unwrap_or_default();
    assert!(
        (400.0..=1200.0).contains(&y),
        "real scrollY after wheel: {y}"
    );

    // ═══ E11: HARD — dev-log mirror (console entries by level) ═══════════
    navigate(rt, &tab_e, "/hard/devlogs").await;
    let mut info_seen = false;
    let mut error_seen = false;
    for _ in 0..40 {
        let r = locator(
            rt,
            "tab_dev_logs",
            json!({"browser_id":"default","tab_id":tab_e}),
            "tab_dev_logs",
        )
        .await;
        if let Some(logs) = r["logs"].as_array() {
            for entry in logs {
                let text = entry["text"].as_str().unwrap_or_default();
                let level = entry["level"].as_str().unwrap_or_default();
                if text.contains(DEVLOG_INFO) && level == "info" {
                    info_seen = true;
                }
                if text.contains(DEVLOG_ERROR) && level == "error" {
                    error_seen = true;
                }
            }
        }
        if info_seen && error_seen {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(info_seen, "dev-log mirror never saw the info entry");
    assert!(error_seen, "dev-log mirror never saw the error entry");

    // ═══ E12: HARD — page assets + in-origin bundle ══════════════════════
    navigate(rt, &tab_e, "/hard/assets").await;
    locator(
        rt,
        "playwright_wait_for_load_state",
        json!({"browser_id":"default","tab_id":tab_e,"state":"networkidle"}),
        "wait_for_load_state assets",
    )
    .await;
    let r = locator(
        rt,
        "tab_page_assets_list",
        json!({"browser_id":"default","tab_id":tab_e}),
        "tab_page_assets_list",
    )
    .await;
    assert!(
        r["count"].as_u64().unwrap_or(0) >= 3,
        "asset list too small: {r}"
    );
    let assets: Vec<String> = r["assets"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|a| a["url"].as_str().map(str::to_string))
        .collect();
    assert!(
        assets.iter().any(|u| u.ends_with("/hard/asset-img.png")),
        "asset img missing from {assets:?}"
    );
    let r = locator(
        rt,
        "tab_page_assets_bundle",
        json!({"browser_id":"default","tab_id":tab_e}),
        "tab_page_assets_bundle",
    )
    .await;
    assert!(
        r["total_bytes"].as_u64().unwrap_or(0) > 0,
        "bundle fetched no bytes: {r}"
    );

    // ═══ E13: content export — html / text / honest urls floor ═══════════
    navigate(rt, &tab_e, "/easy").await;
    let r = locator(
        rt,
        "tab_content_export",
        json!({"browser_id":"default","tab_id":tab_e,"format":"html"}),
        "content_export html",
    )
    .await;
    let html = r["content"].as_str().unwrap_or_default().to_string();
    assert!(html.contains("go-arrived"), "html export: {html}");
    let r = locator(
        rt,
        "tab_content_export",
        json!({"browser_id":"default","tab_id":tab_e,"format":"text"}),
        "content_export text",
    )
    .await;
    assert!(
        r["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Arrive at the destination"),
        "text export: {r}"
    );
    let r = locator(
        rt,
        "tab_content_export",
        json!({"browser_id":"default","tab_id":tab_e,
               "format":"text","urls":["http://unrelated.invalid/"]}),
        "content_export urls floor",
    )
    .await;
    assert_eq!(
        r["content"].as_str().unwrap_or_default(),
        "",
        "urls floor must yield an honest empty export: {r}"
    );

    // ═══ E14: browser visibility (headless default) ══════════════════════
    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_visibility_get","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default"}}),
        )
        .await,
        "browser_visibility_get",
    );
    assert_eq!(r["running"], json!(true));
    assert_eq!(
        r["visible"],
        json!(false),
        "headless host must not report visible"
    );
    assert!(r["note"].is_string());

    // ═══ E15: History DB read (Phase-13 rusqlite path, live WAL) ═════════
    let mut hit = false;
    for _ in 0..40 {
        let r = ok(
            cmd(
                rt,
                SESSION,
                TURN,
                json!({"commandType":"browser_history","session_id":SESSION,"turn_id":TURN,
                       "payload":{"browser_id":"default","queries":["arrived"],"limit":50}}),
            )
            .await,
            "browser_history",
        );
        if let Some(entries) = r["entries"].as_array() {
            if entries.iter().any(|e| {
                e["url"]
                    .as_str()
                    .unwrap_or_default()
                    .ends_with("/easy/arrived")
            }) {
                hit = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(hit, "History DB never recorded the /easy/arrived visit");

    // ═══ cleanup: explicitly close the user-owned tabs while their claims
    // are still held (end_turn never closes un-owned user tabs), then
    // end_turn must sweep EVERY turn-owned tab: the E3 turn-owned opener
    // (tab_a) and the popup it propagated ownership to (popup_agent).
    for (tab, what) in [
        (startup_tab.as_str(), "startup tab"),
        (popup_user.as_str(), "user popup"),
    ] {
        let r = ok(
            cmd(
                rt,
                SESSION,
                TURN,
                json!({"commandType":"tab_close","session_id":SESSION,"turn_id":TURN,
                       "payload":{"browser_id":"default","tab_id":tab}}),
            )
            .await,
            &format!("tab_close {what}"),
        );
        assert_eq!(r["closed"], json!(true), "tab_close {what}: {r}");
    }

    rt.end_turn(SESSION, TURN).await;
    let after: Vec<String> = tab_ids(&list_tabs(rt).await);
    assert!(!after.contains(&tab_e), "turn cleanup missed a journey tab");
    assert!(!after.contains(&tab_a), "turn cleanup missed the E3 opener");
    assert!(
        !after.contains(&popup_agent),
        "adopted turn-owned popup survived end_turn cleanup"
    );
    assert!(
        !after.contains(&startup_tab) && !after.contains(&popup_user),
        "closed user tabs must not linger after end_turn"
    );

    rt.shutdown().await;
    drop(hub_rx);
    if let Some(mut child) = node {
        let _ = child.start_kill();
    }
}

/// Fail-loud helper for the panel calls that answer `()`.
fn okx<T>(result: Result<T, BrowserError>, what: &str) -> T {
    result.unwrap_or_else(|e| panic!("{what} failed: {e}"))
}

// ══════════════════════════════════════════════════════════════════════════
// Phase-26 gap battery (G1–G8): every command that had NO test before this
// file gets at least one REAL assertion here — page truth via live evaluate,
// bytes on disk, pump/DB state, or (for the page APIs that may legitimately
// refuse) an honest branching assertion that pins exactly one of the two
// truthful answer shapes. No model, no approval plumbing: the `ui` turn is
// gate- and budget-exempt, so this runs inside the CODE phase.
// ══════════════════════════════════════════════════════════════════════════

/// Clipboard markers — the page clipboard API is exercised on whatever page
/// the battery tab currently holds (no fixture page involvement).
const GAP_CLIP: &str = "GAP-CLIP-4471";
const GAP_CLIP_ITEMS: &str = "GAP-CLIP-ITEMS-8830";
/// Mirrors the `GET /hard/webmcp` route (server.mjs) registered through the
/// injected `document.modelContext` shim.
const WEBMCP_TOOL: &str = "gap-echo";
const WEBMCP_RESULT_PREFIX: &str = "TOOL-RESULT-";

/// Copy of the smoke helper: public node id of the first snapshot line
/// containing `needle` (`node_id=` is always the first emitted attribute).
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

#[tokio::test]
#[ignore = "launches real Chromium against the fixture server (see file header)"]
async fn phase26_gap_battery_against_real_chromium() {
    // Same heap-pinning rationale as the Phase-16 journeys entry point.
    Box::pin(run_gap_battery()).await;
}

async fn run_gap_battery() {
    let product_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate sits three levels below the project root")
        .to_path_buf();

    let exe = discover_product_chromium(&product_root);
    std::env::set_var(ENV_EXECUTABLE, &exe);

    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().to_path_buf();

    let node = start_fixture_server(&product_root).await;

    // Throwaway root: profile under <temp>/.data, downloads under
    // <temp>/downloads — no product locks taken.
    let rt = &BrowserRuntime::new(root.clone());

    // First command launches Chromium (lazy client).
    let tab = new_tab(rt, TURN).await;

    // ═══ G1: locator read surface, screenshots, dblclick navigation ═══════
    navigate(rt, &tab, "/easy").await;
    let r = locator(
        rt,
        "playwright_locator_get_attribute",
        json!({"browser_id":"default","tab_id":tab,"selector":"#go-arrived","name":"href"}),
        "get_attribute href",
    )
    .await;
    assert!(
        r["value"]
            .as_str()
            .unwrap_or_default()
            .contains("/easy/arrived"),
        "get_attribute href: {r}"
    );
    let r = locator(
        rt,
        "playwright_locator_is_enabled",
        json!({"browser_id":"default","tab_id":tab,"selector":"#go-arrived"}),
        "is_enabled",
    )
    .await;
    assert_eq!(r["enabled"], json!(true), "is_enabled: {r}");
    let r = locator(
        rt,
        "playwright_locator_text_content",
        json!({"browser_id":"default","tab_id":tab,"selector":"#go-arrived"}),
        "text_content",
    )
    .await;
    assert!(
        r["text"].as_str().unwrap_or_default().contains("Arrive"),
        "text_content: {r}"
    );
    let r = locator(
        rt,
        "playwright_locator_read_all",
        json!({"browser_id":"default","tab_id":tab,"selector":"#go-arrived"}),
        "read_all",
    )
    .await;
    let rows = r["elements"].as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1, "read_all rows: {r}");
    assert_eq!(rows[0]["tag_name"], json!("a"), "read_all row: {r}");
    assert!(
        rows[0]["href"]
            .as_str()
            .unwrap_or_default()
            .contains("/easy/arrived"),
        "read_all href: {r}"
    );

    // element_info + clipped element_screenshot at the link's REAL box.
    let center = pw_evaluate(
        rt,
        &tab,
        "(() => { const b = document.getElementById('go-arrived').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()",
    )
    .await;
    let r = locator(
        rt,
        "playwright_element_info",
        json!({"browser_id":"default","tab_id":tab,"x":center["x"],"y":center["y"]}),
        "element_info at link center",
    )
    .await;
    let hits = r["elements"].as_array().cloned().unwrap_or_default();
    assert!(
        !hits.is_empty(),
        "element_info at the link center found nothing: {r}"
    );

    let r = locator(
        rt,
        "tab_screenshot",
        json!({"browser_id":"default","tab_id":tab}),
        "tab_screenshot",
    )
    .await;
    assert!(
        r["image_base64"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "tab_screenshot image: {r}"
    );
    assert_eq!(
        r["mime_type"],
        json!("image/png"),
        "tab_screenshot mime: {r}"
    );

    let clip = pw_evaluate(
        rt,
        &tab,
        "(() => { const b = document.getElementById('go-arrived').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()",
    )
    .await;
    let r = locator(
        rt,
        "playwright_element_screenshot",
        json!({"browser_id":"default","tab_id":tab,
               "clip":{"x":clip["x"],"y":clip["y"],"width":clip["width"],"height":clip["height"]}}),
        "element_screenshot clip",
    )
    .await;
    assert!(
        r["image_base64"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "element_screenshot image: {r}"
    );
    assert_eq!(
        r["mime_type"],
        json!("image/png"),
        "element_screenshot mime: {r}"
    );
    assert!(
        r["width"].as_f64().unwrap_or(0.0) > 0.0,
        "element_screenshot size echo: {r}"
    );

    let r = locator(
        rt,
        "playwright_dom_snapshot",
        json!({"browser_id":"default","tab_id":tab}),
        "playwright_dom_snapshot",
    )
    .await;
    let snap = r["dom_snapshot"].as_str().unwrap_or_default().to_string();
    assert!(
        snap.contains("Arrive"),
        "dom_snapshot missing the link text: {snap}"
    );
    assert!(
        snap.contains("link"),
        "dom_snapshot missing the link role: {snap}"
    );

    locator(
        rt,
        "playwright_locator_dblclick",
        json!({"browser_id":"default","tab_id":tab,"selector":"#go-arrived"}),
        "locator_dblclick",
    )
    .await;
    locator(
        rt,
        "playwright_wait_for_url",
        json!({"browser_id":"default","tab_id":tab,"url":"**/easy/arrived"}),
        "wait_for_url after dblclick",
    )
    .await;
    assert_eq!(
        inner_text(rt, &tab, "#arrived-marker").await,
        EASY_ARRIVED,
        "dblclick did not actually navigate the tab"
    );

    // ═══ G2: every keyboard path writes REAL characters ══════════════════
    navigate(rt, &tab, "/medium").await;
    click(rt, &tab, "#note-input").await;
    locator(
        rt,
        "playwright_locator_press",
        json!({"browser_id":"default","tab_id":tab,"selector":"#note-input","key":"a"}),
        "locator_press a",
    )
    .await;
    assert_eq!(
        pw_evaluate(rt, &tab, "document.getElementById('note-input').value").await,
        json!("a"),
        "locator_press did not reach the input"
    );
    locator(
        rt,
        "playwright_locator_press_sequentially",
        json!({"browser_id":"default","tab_id":tab,"selector":"#note-input","text":"bc","delay":10}),
        "press_sequentially bc",
    )
    .await;
    assert_eq!(
        pw_evaluate(rt, &tab, "document.getElementById('note-input').value").await,
        json!("abc"),
        "press_sequentially did not reach the input"
    );
    locator(
        rt,
        "dom_cua_keypress",
        json!({"browser_id":"default","tab_id":tab,"keys":["d"]}),
        "dom_cua_keypress d",
    )
    .await;
    assert_eq!(
        pw_evaluate(rt, &tab, "document.getElementById('note-input').value").await,
        json!("abcd"),
        "dom_cua_keypress did not reach the focused input"
    );
    locator(
        rt,
        "cua_type",
        json!({"browser_id":"default","tab_id":tab,"text":"e"}),
        "cua_type e",
    )
    .await;
    assert_eq!(
        pw_evaluate(rt, &tab, "document.getElementById('note-input').value").await,
        json!("abcde"),
        "cua_type did not reach the focused input"
    );
    locator(
        rt,
        "cua_keypress",
        json!({"browser_id":"default","tab_id":tab,"keys":["f"]}),
        "cua_keypress f",
    )
    .await;
    assert_eq!(
        pw_evaluate(rt, &tab, "document.getElementById('note-input').value").await,
        json!("abcdef"),
        "cua_keypress did not reach the focused input"
    );

    // ═══ G3: CUA pixel double-click, move, drag (Xy path objects) ════════
    navigate(rt, &tab, "/hard/cua").await;
    locator(
        rt,
        "cua_double_click",
        json!({"browser_id":"default","tab_id":tab,"x":180.0,"y":184.0}),
        "cua_double_click",
    )
    .await;
    assert_eq!(
        eval_value(rt, &tab, "document.getElementById('cua-count').textContent").await,
        json!("2"),
        "cua_double_click did not record two click events on the fixture button"
    );
    locator(
        rt,
        "cua_move",
        json!({"browser_id":"default","tab_id":tab,"x":10.0,"y":10.0}),
        "cua_move",
    )
    .await;
    locator(
        rt,
        "cua_drag",
        json!({"browser_id":"default","tab_id":tab,
               "path":[{"x":5.0,"y":5.0},{"x":60.0,"y":60.0}]}),
        "cua_drag",
    )
    .await;

    // ═══ G4: media downloads — selector AND DOM-node paths, bytes verified ═
    navigate(rt, &tab, "/hard/media").await;
    let r = locator(
        rt,
        "playwright_locator_download_media",
        json!({"browser_id":"default","tab_id":tab,"selector":"#media-img","timeout_ms":30000}),
        "locator_download_media",
    )
    .await;
    let first = r["path"].as_str().unwrap_or_default().to_string();
    let downloads_dir = root.join("downloads");
    assert!(
        !first.is_empty() && Path::new(&first).starts_with(&downloads_dir),
        "media download {first:?} not under {downloads_dir:?}"
    );
    let bytes = std::fs::read(&first)
        .unwrap_or_else(|e| panic!("download bytes unreadable at {first}: {e}"));
    assert_eq!(
        &bytes[0..4],
        &[0x89u8, 0x50, 0x4E, 0x47],
        "downloaded media is not the fixture PNG"
    );

    let r = locator(
        rt,
        "dom_cua_get_visible_dom",
        json!({"browser_id":"default","tab_id":tab}),
        "dom_cua_get_visible_dom /hard/media",
    )
    .await;
    let dom = r["dom"].as_str().expect("dom string").to_string();
    let media_node = dom_node_id(&dom, "asset-img.png");
    locator(
        rt,
        "dom_cua_download_media",
        json!({"browser_id":"default","tab_id":tab,"node_id":media_node,"timeout_ms":30000}),
        "dom_cua_download_media",
    )
    .await;
    let mut second = String::new();
    for _ in 0..60 {
        let r = locator(
            rt,
            "playwright_download_path",
            json!({"browser_id":"default","tab_id":tab}),
            "download_path poll",
        )
        .await;
        let p = r["path"].as_str().unwrap_or_default().to_string();
        if !p.is_empty() && p != first {
            second = p;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        !second.is_empty() && Path::new(&second).starts_with(&downloads_dir),
        "the DOM-CUA media click never produced a second completed download"
    );

    // ═══ G5: clipboard pair — honest page-API mirror, both branches ══════
    // The page clipboard API refuses without focus/permission; the engine
    // carries that refusal verbatim (ok:false + error), never an empty
    // "success". The battery pins the CONTRACT either way; eprintln marks
    // which branch the live Chromium took.
    let w = locator(
        rt,
        "tab_clipboard_write_text",
        json!({"browser_id":"default","tab_id":tab,"text":GAP_CLIP}),
        "clipboard write_text",
    )
    .await;
    let wok = w["ok"].as_bool().unwrap_or(false);
    eprintln!("[gap G5] clipboard write_text ok={wok} ({w})");
    assert!(w["failed"].is_array(), "clipboard write failed list: {w}");
    let rd = locator(
        rt,
        "tab_clipboard_read_text",
        json!({"browser_id":"default","tab_id":tab}),
        "clipboard read_text",
    )
    .await;
    let rok = rd["ok"]
        .as_bool()
        .unwrap_or_else(|| panic!("clipboard read answer must carry ok: {rd}"));
    if rok {
        let text = rd["text"].as_str().unwrap_or_default();
        eprintln!("[gap G5] clipboard read branch: PERMITTED ({text:?})");
        assert!(
            !text.is_empty(),
            "a permitted clipboard read answered ok with empty text: {rd}"
        );
        if wok {
            assert!(
                text.contains(GAP_CLIP),
                "clipboard text did not round-trip write→read: {rd}"
            );
        }
    } else {
        eprintln!("[gap G5] clipboard read branch: REFUSED ({})", rd["error"]);
        assert!(
            !rd["error"].is_null(),
            "a refused clipboard read must carry the page-API error verbatim: {rd}"
        );
    }
    let w2 = locator(
        rt,
        "tab_clipboard_write",
        json!({"browser_id":"default","tab_id":tab,
               "items":[{"entries":[{"text":GAP_CLIP_ITEMS}]}]}),
        "clipboard write items",
    )
    .await;
    let w2ok = w2["ok"].as_bool().unwrap_or(false);
    eprintln!("[gap G5] clipboard write (structured items) ok={w2ok} ({w2})");
    let r2 = locator(
        rt,
        "tab_clipboard_read",
        json!({"browser_id":"default","tab_id":tab}),
        "clipboard read",
    )
    .await;
    assert!(
        r2.get("ok").is_some() && r2.get("text").is_some() && r2.get("error").is_some(),
        "clipboard read answer shape: {r2}"
    );
    if w2ok && r2["ok"].as_bool().unwrap_or(false) {
        assert!(
            r2["text"]
                .as_str()
                .unwrap_or_default()
                .contains(GAP_CLIP_ITEMS),
            "structured clipboard write did not round-trip: {r2}"
        );
    }

    // ═══ G6: WebMCP — fixture page, shim, list, invoke, unknown tool ═════
    navigate(rt, &tab, "/hard/webmcp").await;
    assert_eq!(
        inner_text(rt, &tab, "#webmcp-state").await,
        "registered",
        "the injected modelContext shim never reached the fixture page (or its native mirror)"
    );
    let r = locator(
        rt,
        "webmcp_list_tools",
        json!({"browser_id":"default","tab_id":tab}),
        "webmcp_list_tools",
    )
    .await;
    let tools = r["tools"].as_array().cloned().unwrap_or_default();
    assert!(
        tools
            .iter()
            .any(|t| t["name"].as_str() == Some(WEBMCP_TOOL)),
        "webmcp_list_tools never listed the fixture tool: {r}"
    );
    assert!(
        tools.iter().any(|t| t.get("input_schema").is_some()),
        "the listed tool carries no input_schema (pinned wire shape): {r}"
    );
    let r = locator(
        rt,
        "webmcp_invoke_tool",
        json!({"browser_id":"default","tab_id":tab,"tool":WEBMCP_TOOL,"args":{"value":"ok"}}),
        "webmcp_invoke_tool",
    )
    .await;
    assert_eq!(r["ok"], json!(true), "webmcp_invoke_tool: {r}");
    assert_eq!(
        r["result"].as_str().unwrap_or_default(),
        format!("{WEBMCP_RESULT_PREFIX}ok"),
        "webmcp_invoke_tool result: {r}"
    );
    assert_eq!(
        inner_text(rt, &tab, "#webmcp-invoke-count").await,
        "1",
        "the fixture handler never recorded the invocation"
    );
    let e = cmd(
        rt,
        SESSION,
        TURN,
        json!({"commandType":"webmcp_invoke_tool","session_id":SESSION,"turn_id":TURN,
               "payload":{"browser_id":"default","tab_id":tab,"tool":"gap-missing"}}),
    )
    .await
    .expect_err("invoking an unregistered WebMCP tool must fail closed");
    assert!(
        e.to_string().contains("webmcp_list_tools"),
        "unregistered-tool error: {e}"
    );

    // ═══ G7: site policy, submission-verified, session name, History+cLEAR ═
    let r = locator(
        rt,
        "site_status",
        json!({"browser_id":"default","url":format!("{}/easy", base_url())}),
        "site_status",
    )
    .await;
    assert!(
        r["host"].as_str().map(|h| !h.is_empty()).unwrap_or(false),
        "site_status host: {r}"
    );
    let perms = r["permissions"].as_object().cloned().unwrap_or_default();
    for facet in [
        "access",
        "uploads",
        "downloads",
        "full_cdp_access",
        "history",
    ] {
        assert!(
            perms.get(facet).map(|v| v.is_string()).unwrap_or(false),
            "site_status permissions missing {facet}: {r}"
        );
    }
    assert!(r["note"].is_string(), "site_status note: {r}");

    // Real GET form submission, then the pump's own origin verdict.
    navigate(rt, &tab, "/medium").await;
    locator(
        rt,
        "playwright_locator_fill",
        json!({"browser_id":"default","tab_id":tab,"selector":"#note-input","value":"gap-submission"}),
        "fill note (G7)",
    )
    .await;
    click(rt, &tab, "#submit-btn").await;
    let r = locator(
        rt,
        "playwright_wait_for_url",
        json!({"browser_id":"default","tab_id":tab,"url":"**/medium/echo*"}),
        "wait_for_url /medium/echo (G7)",
    )
    .await;
    let echo_url = r["url"].as_str().unwrap_or_default().to_string();
    assert!(echo_url.contains("/medium/echo"), "echo url: {r}");
    assert!(
        inner_text(rt, &tab, "#echo-output")
            .await
            .contains("gap-submission"),
        "the server echo never showed the submitted note"
    );
    let sv = locator(
        rt,
        "site_submission_verified",
        json!({"browser_id":"default","url":&echo_url}),
        "site_submission_verified",
    )
    .await;
    assert_eq!(
        sv["origin"],
        json!(base_url()),
        "submission-verified origin: {sv}"
    );
    assert!(
        !sv["verified_at"].is_null(),
        "the pump never recorded this origin as submission-verified: {sv}"
    );

    let r = locator(
        rt,
        "browser_session_name",
        json!({"browser_id":"default","name":"gap-session"}),
        "browser_session_name",
    )
    .await;
    assert_eq!(r["session_id"], json!(SESSION), "session name answer: {r}");
    assert_eq!(r["name"], json!("gap-session"), "session name answer: {r}");

    // The G1 visit must be in the native History DB…
    let mut hit = false;
    for _ in 0..40 {
        let r = locator(
            rt,
            "browser_history",
            json!({"browser_id":"default","queries":["arrived"],"limit":50}),
            "browser_history",
        )
        .await;
        if r["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .any(|e| {
                e["url"]
                    .as_str()
                    .unwrap_or_default()
                    .ends_with("/easy/arrived")
            })
        {
            hit = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(hit, "History DB never recorded the G1 /easy/arrived visit");
    // …and clearData(history) must empty it again.
    let r = locator(
        rt,
        "browser_clear_data",
        json!({"browser_id":"default","data_types":["history"]}),
        "browser_clear_data history",
    )
    .await;
    let cleared: Vec<String> = r["cleared"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    assert!(
        cleared.iter().any(|c| c == "history"),
        "clearData cleared list: {r}"
    );
    let mut emptied = false;
    for _ in 0..40 {
        let r = locator(
            rt,
            "browser_history",
            json!({"browser_id":"default","queries":["arrived"],"limit":50}),
            "browser_history after clear",
        )
        .await;
        if r["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .is_empty()
        {
            emptied = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        emptied,
        "History DB still carried rows after clearData(history)"
    );

    // ═══ G8: marks, handoffs, claims, and the honest refusal surface ══════
    // G8a: a real AGENT turn (g1) marks its tab handoff ⇒ survives its own
    // end_turn; the user side claims it (resetting ownership) and closes it.
    let g1 = new_tab(rt, "g1").await;
    let r = ok(
        cmd(
            rt,
            SESSION,
            "g1",
            json!({"commandType":"tab_mark_handoff","session_id":SESSION,"turn_id":"g1",
                   "payload":{"browser_id":"default","tab_id":g1}}),
        )
        .await,
        "mark_handoff (g1)",
    );
    assert_eq!(r["tab_id"], json!(g1), "mark_handoff answer: {r}");
    rt.end_turn(SESSION, "g1").await;
    let g = get_tab(rt, &g1).await;
    assert_eq!(
        g["tab_id"],
        json!(g1),
        "handoff-marked tab must survive end_turn"
    );
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_user_claim_tab","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":g1}}),
        )
        .await,
        "claim g1",
    );
    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"tab_close","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":g1}}),
        )
        .await,
        "close claimed handoff tab (g1)",
    );
    assert_eq!(r["closed"], json!(true), "close g1: {r}");

    // G8b: the manual handoff REQUEST parks the tab as user-owned
    // (taken_over), marks it handoff, and a claim is what re-opens it.
    let g2 = new_tab(rt, "g2").await;
    let r = ok(
        cmd(
            rt,
            SESSION,
            "g2",
            json!({"commandType":"tab_manual_handoff_request","session_id":SESSION,"turn_id":"g2",
                   "payload":{"browser_id":"default","tab_id":g2}}),
        )
        .await,
        "manual handoff request (g2)",
    );
    assert_eq!(r, json!({}), "manual handoff answer: {r}");
    let g = get_tab(rt, &g2).await;
    assert_eq!(
        g["taken_over"],
        json!(true),
        "manual handoff must set taken_over: {g}"
    );
    rt.end_turn(SESSION, "g2").await;
    let g = get_tab(rt, &g2).await;
    assert_eq!(
        g["tab_id"],
        json!(g2),
        "manual-handoff tab must survive end_turn"
    );
    ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"browser_user_claim_tab","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":g2}}),
        )
        .await,
        "claim g2",
    );
    let g = get_tab(rt, &g2).await;
    assert_eq!(
        g["taken_over"],
        json!(false),
        "a user claim must reset taken_over: {g}"
    );
    let r = ok(
        cmd(
            rt,
            SESSION,
            TURN,
            json!({"commandType":"tab_close","session_id":SESSION,"turn_id":TURN,
                   "payload":{"browser_id":"default","tab_id":g2}}),
        )
        .await,
        "close claimed manual-handoff tab (g2)",
    );
    assert_eq!(r["closed"], json!(true), "close g2: {r}");

    // G8c: the honest floor of the export/report/annotation surface on a
    // NON-Google, NON-YouTube fixture tab.
    let e = cmd(
        rt,
        SESSION,
        TURN,
        json!({"commandType":"tab_content_export_gsuite","session_id":SESSION,"turn_id":TURN,
               "payload":{"browser_id":"default","tab_id":tab,"type":"pdf"}}),
    )
    .await
    .expect_err("gsuite export on a non-Google tab must be a typed payload error");
    assert!(
        e.to_string().contains("gsuite"),
        "gsuite refusal message: {e}"
    );
    let r = locator(
        rt,
        "tab_content_export_youtube_transcript",
        json!({"browser_id":"default","tab_id":tab}),
        "youtube transcript floor",
    )
    .await;
    assert!(
        r["transcript"].is_null(),
        "a non-YouTube tab must answer an honest null transcript: {r}"
    );
    assert!(
        r["url"].is_string() && r["note"].is_string(),
        "transcript floor answer: {r}"
    );
    let r = locator(
        rt,
        "tab_bot_detection_report",
        json!({"browser_id":"default","tab_id":tab,"reason":"captcha_failed"}),
        "bot detection report",
    )
    .await;
    assert_eq!(r["status"], json!("reported"), "bot report answer: {r}");
    let r = locator(
        rt,
        "browser_annotation_capture",
        json!({"browser_id":"default","tab_id":tab}),
        "annotation capture (panel-only command)",
    )
    .await;
    assert!(
        r["page_url"]
            .as_str()
            .unwrap_or_default()
            .contains("/medium/echo"),
        "annotation capture page_url: {r}"
    );
    assert!(r.get("anchor").is_some(), "annotation capture anchor: {r}");

    // ═══ cleanup: end_turn sweeps the ui-owned battery tab; handoff tabs
    // were claimed+closed above; the startup (user) tab is never swept.
    rt.end_turn(SESSION, TURN).await;
    let after: Vec<String> = tab_ids(&list_tabs(rt).await);
    assert!(!after.contains(&tab), "gap battery tab survived end_turn");
    assert!(
        !after.contains(&g1) && !after.contains(&g2),
        "claimed handoff tabs lingered"
    );

    rt.shutdown().await;
    if let Some(mut child) = node {
        let _ = child.start_kill();
    }
}
