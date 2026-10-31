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
