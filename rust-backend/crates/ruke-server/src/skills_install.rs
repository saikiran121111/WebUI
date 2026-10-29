//! Part 7: `app/api/skills/install/route.ts` (POST) — mounted under the
//! Rust-only `/api/ruke/skills/install` namespace — plus the `installSkill`
//! service from `lib/skills/install.ts`. Registry parsing lives in
//! `ruke_skills::registry::parse_install_request` (ported & gated earlier
//! in this Part).
//!
//! The status/shape table mirrors the TS verbatim:
//!
//! | POST | unparseable body → 400 `{error:"Invalid JSON body"}`; missing/blank `repoOrCommand` → 400 `{error:"repoOrCommand is required"}`; anything containing `.cskills` → 400 core-tier message; install failure → 400 when the message matches `/\Wempty|must be|No repository|Unsafe|Unsupported/i`-style client errors else 500, always `{error:<message>}`; success → 200 `{ok:true, installedSkillNames, commandOutput:<last 4000 chars>}` |
//!
//! Parity notes:
//! - The `.cskills` guard runs on the RAW (untrimmed) string against the
//!   substring ".cskills" — a whitespace-padded but valid input still
//!   reaches `parseInstallRequest` with its original text (TS passes
//!   `request.repoOrCommand` through untouched; parse trims internally).
//! - `installedSkillNames` is `targets.filter(Boolean)` — it INCLUDES names
//!   whose post-install `skillExists` check failed (the TS quirk: the list
//!   is derived from the target set, not from what was actually installed).
//! - `commandOutput` is `output.slice(-4000)` — UTF-16 units, via jsstr.
//! - The child spawn mirrors `runInstall`: on Windows it runs
//!   `cmd.exe /d /s /c npx …` with CREATE_NO_WINDOW (⇔ `windowsHide:true`)
//!   and `shell:false` semantics (args array, no re-parsing); 300 s timer →
//!   kill + "Skill install timed out after 300s"; non-zero exit →
//!   "Skill install failed (exit <code>): " + output.slice(-500); a signal
//!   kill gives code `null` on both sides.
//! - Output accumulation mirrors `if (output.length < 200_000) output +=
//!   chunk.toString()` — the cap test runs on the STORED length (UTF-16
//!   units, tracked separately since Rust Strings count bytes), chunks
//!   past the cap are dropped, and each chunk is lossily decoded on its
//!   own (chunk-buffer boundaries can split a code point on BOTH sides —
//!   recorded micro-divergence: replacement chars may land at different
//!   offsets than Buffer.concat-based decoding never happens in either
//!   implementation).
//! - `await syncInstalledSkills(root)` result is DISCARDED by the TS
//!   service (the fresh list is re-read via listInstalledSkillNames) —
//!   mirrored, including propagating its Err (TS has no catch inside
//!   installSkill; the route catch classifies the message).
//!
//! RECORDED TEST LIMITATION: the success path shells out to real `npx`
//! (network + npm registry). Per the overnight brief's no-new-deps/no-
//! network posture, only the pre-spawn short-circuit arms are exercised
//! here; the child-process plumbing is the same pattern chat.rs already
//! ships and is verified by the Part 8 manual regression checkpoint.

use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use regex::{Regex, RegexBuilder};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};

use ruke_skills::{jsstr, registry};

use crate::AppState;

/// `/api/ruke/skills/install` POST.
pub async fn skills_install_post(State(state): State<AppState>, req: Request) -> Response {
    // `try { body = await req.json() } catch { 400 "Invalid JSON body" }`
    let bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    // `typeof body?.repoOrCommand !== "string" || !body.repoOrCommand.trim()`
    let repo_or_command = match body.get("repoOrCommand") {
        Some(Value::String(s)) if !jsstr::js_trim(s).is_empty() => s.clone(),
        _ => return err(StatusCode::BAD_REQUEST, "repoOrCommand is required"),
    };
    // The developer-only tier gate (string includes — RAW, untrimmed).
    if repo_or_command.contains(".cskills") {
        return err(
            StatusCode::BAD_REQUEST,
            "The core skill tier (./.cskills/) is developer-only and cannot be modified from the browser",
        );
    }

    match install_skill(&body, &state.root).await {
        Ok(out) => {
            let names: Vec<Value> =
                out.installed_skill_names.into_iter().map(Value::String).collect();
            json_response(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "installedSkillNames": names,
                    // `output.slice(-4000)`
                    "commandOutput": jsstr::js_slice_tail(&out.command_output, 4000),
                }),
            )
        }
        Err(message) => {
            // `const isClientError = /empty|must be|No repository|Unsafe|Unsupported/i.test(message)`
            // — a falsy err.message falls to the "Skill install failed"
            // default; every Rust error here is a non-empty String.
            let status = if CLIENT_ERR_RE.is_match(&message) {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            err(status, &message)
        }
    }
}

static CLIENT_ERR_RE: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"empty|must be|no repository|unsafe|unsupported")
        .case_insensitive(true)
        .build()
        .expect("client-err regex")
});

/// `installSkill(request, root)` fused: parse → spawn npx → sync →
/// scenario hygiene per target.
pub(crate) struct InstallOutcome {
    pub installed_skill_names: Vec<String>,
    pub command_output: String,
}

async fn install_skill(body: &Value, root: &Path) -> Result<InstallOutcome, String> {
    let input = body.get("repoOrCommand").and_then(Value::as_str).unwrap_or("");
    let parsed = registry::parse_install_request(input)?;

    let mut npx_args: Vec<String> =
        vec!["-y".into(), "skills".into(), "add".into(), parsed.repo.clone()];
    if let Some(skill) = &parsed.skill_name {
        npx_args.push("--skill".into());
        npx_args.push(skill.clone());
    }
    npx_args.push("-y".into());

    let command_output = run_install(&npx_args, root).await?;

    // TS awaits this but never uses the array — re-listed below.
    registry::sync_installed_skills(root)?;

    // `skillName ? [skillName] : listInstalledSkillNames(root)`
    let targets: Vec<String> = match &parsed.skill_name {
        Some(s) => vec![s.clone()],
        None => registry::list_installed_skill_names(root),
    };
    for name in &targets {
        // `if (!(await skillExists(root, name))) continue;`
        if !registry::skill_exists(root, name) {
            continue;
        }
        registry::ensure_scenario(root, name, &parsed.repo)?;
        let mut patch = Map::new();
        patch.insert("sourceRepo".into(), Value::String(parsed.repo.clone()));
        // `request.autoUse !== undefined ? { autoUse: … } : {}` — an
        // explicit null IS defined in JS; body.get() carries it through
        // (update_scenario's typeof gates then ignore it, TS parity).
        for key in ["autoUse", "whenToUse", "triggerKeywords"] {
            if let Some(v) = body.get(key) {
                patch.insert(key.to_string(), v.clone());
            }
        }
        registry::update_scenario(root, name, &patch)?;
    }

    // `targets.filter((n) => n)` — NOT "what was installed": names that
    // failed the skillExists gate are still reported (TS quirk, kept).
    let installed_skill_names = targets.into_iter().filter(|n| !n.is_empty()).collect();
    Ok(InstallOutcome { installed_skill_names, command_output })
}

/// `runInstall(args, cwd)` ⇔ spawn cmd.exe/npx with piped stdio, the
/// 200 000-char output accumulator, and the 300 s kill timer.
async fn run_install(npx_args: &[String], root: &Path) -> Result<String, String> {
    #[cfg(windows)]
    let mut std_cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd.exe");
        c.args(["/d", "/s", "/c", "npx"]);
        // CREATE_NO_WINDOW ⇔ windowsHide:true (shell:false ⇔ the args array).
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut std_cmd = std::process::Command::new("npx");
    for a in npx_args {
        std_cmd.arg(a);
    }
    std_cmd
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = tokio::process::Command::from(std_cmd)
        .spawn()
        // child.on("error") ⇒ reject(err) — the spawn error's message.
        .map_err(|e| e.to_string())?;

    // (stored output, stored UTF-16 length) shared with both reader pumps.
    // (stdout/stderr are distinct types, so each pump is its own spawn of
    // the generic pump_output below — the TS side pumps both identically.)
    let acc = Arc::new(tokio::sync::Mutex::new((String::new(), 0usize)));
    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        pumps.push(tokio::spawn(pump_output(out, acc.clone())));
    }
    if let Some(e) = child.stderr.take() {
        pumps.push(tokio::spawn(pump_output(e, acc.clone())));
    }

    // `setTimeout(…, 300_000)` ⇒ kill + reject "Skill install timed out".
    match tokio::time::timeout(Duration::from_secs(300), child.wait()).await {
        Err(_) => {
            let _ = child.start_kill();
            for p in pumps {
                p.abort();
            }
            Err("Skill install timed out after 300s".to_string())
        }
        // `child.on("error")` after spawn (wait failure): the message rides
        // through the route classifier like any other install error.
        Ok(Err(e)) => {
            for p in pumps {
                p.abort();
            }
            Err(e.to_string())
        }
        Ok(Ok(status)) => {
            // 'close' fires after the stdio streams end — drain the pumps.
            for p in pumps {
                let _ = p.await;
            }
            let output = Arc::try_unwrap(acc).map(|m| m.into_inner().0).unwrap_or_default();
            if status.success() {
                // `code === 0`
                return Ok(output);
            }
            // `code` is null when the process died from a signal — TS
            // string-concatenates it as "null".
            let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".to_string());
            Err(format!(
                "Skill install failed (exit {code}): {}",
                jsstr::js_slice_tail(&output, 500)
            ))
        }
    }
}

/// Drains one child pipe into the shared accumulator, mirroring the TS
/// `on("data")` pump: `if (output.length < 200_000) output += chunk…` —
/// the cap test runs on the STORED length; once exceeded, chunks are
/// dropped (the running total keeps ticking, which only ever makes the
/// test false — identical decision sequence). `chunk.toString()` ⇔
/// per-chunk lossy UTF-8 decode.
async fn pump_output<R>(mut reader: R, acc: Arc<tokio::sync::Mutex<(String, usize)>>)
where
    R: tokio::io::AsyncReadExt + Unpin + Send,
{
    let mut buf = [0u8; 8192];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            // Decoding/stream errors: TS only rejects on the child
            // 'error' event; a pipe read error here is silent.
            Err(_) => break,
        };
        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
        let units = jsstr::js_len(&chunk);
        let mut g = acc.lock().await;
        if g.1 < 200_000 {
            g.0.push_str(&chunk);
        }
        g.1 += units;
    }
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn err(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use ruke_attach::UnavailableEmbedder;
    use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
    use tower::ServiceExt; // oneshot

    use crate::persistence::ConversationStore;
    use crate::titles::{generate::UnconfiguredTitleModel, queue::TitleQueue};

    fn state() -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let slot = Arc::new(InferenceSlot::new());
        let store = Arc::new(ConversationStore::new(tmp.path().join("conversations")));
        let state = crate::AppState {
            settings: Arc::new(SettingsStore::new(tmp.path().join("settings.json"))),
            slot: slot.clone(),
            turns: Arc::new(TurnCounter::new()),
            root: tmp.path().to_path_buf(),
            http: reqwest::Client::new(),
            attach_embedder: Arc::new(UnavailableEmbedder),
            conversations: store.clone(),
            titles: Arc::new(TitleQueue::new(store, slot, Arc::new(UnconfiguredTitleModel))),
            web: Arc::new(crate::WebRuntime {
                net: ruke_websearch::net::RealNet,
                cache: Arc::new(ruke_websearch::cache::SqliteSearchCache::new(tmp.path())),
                verticals: ruke_websearch::platform_api::RealVerticals,
                bridge: Arc::new(ruke_websearch::browser_bridge::NoBrowserBridge),
            }),
            browser: Arc::new(ruke_browser::engine::BrowserRuntime::new(
                tmp.path().to_path_buf(),
            )),
        };
        (state, tmp)
    }

    async fn post_body(state: &crate::AppState, body: Body) -> (StatusCode, Value) {
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/api/ruke/skills/install")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let resp = crate::build_router(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// Every arm asserted here short-circuits BEFORE the child spawn, so
    /// no real npx ever runs (success path deferred to the manual
    /// regression checkpoint — see the module header).
    #[tokio::test]
    async fn short_circuits_before_spawn() {
        let (s, _t) = state();

        // Bad JSON ⇒ the parse-catch 400.
        let (status, body) = post_body(&s, Body::from("{oops")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({ "error": "Invalid JSON body" }));

        // Missing / non-string / whitespace-only repoOrCommand.
        for text in ["{}", r#"{"repoOrCommand":5}"#, r#"{"repoOrCommand":"   "}"#] {
            let (status, body) = post_body(&s, Body::from(text)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{text} ⇒ {body}");
            assert_eq!(body["error"], json!("repoOrCommand is required"));
        }

        // Core-tier guard runs on the RAW string, even mid-token.
        let (status, body) =
            post_body(&s, Body::from(r#"{"repoOrCommand":"npx skills add me/./.cskills/x"}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            json!("The core skill tier (./.cskills/) is developer-only and cannot be modified from the browser")
        );

        // Parse errors route through the classifier: "No repository" and
        // "Unsupported" and "must be" all match the client-error regex ⇒
        // 400 (not 500), with the EXACT registry message.
        let (status, body) = post_body(&s, Body::from(r#"{"repoOrCommand":"-y"}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("No repository given in install input"));

        let (status, body) =
            post_body(&s, Body::from(r#"{"repoOrCommand":"--frobnicate x/y"}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Unsupported install flag: --frobnicate"));

        let (status, body) = post_body(&s, Body::from(r#"{"repoOrCommand":"."}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Repository must be an owner/repo slug or a github URL"));
    }
}
