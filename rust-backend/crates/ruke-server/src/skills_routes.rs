//! Part 7: `app/api/skills/route.ts` (GET) and
//! `app/api/skills/[skillName]/route.ts` (DELETE) +
//! `app/api/skills/[skillName]/scenario/route.ts` (PATCH) — mounted under
//! the Rust-only `/api/ruke/skills*` namespace (Part 8 cuts the plain
//! paths over). The registry semantics themselves live in
//! `ruke_skills::registry` (ported & gated earlier in this Part).
//!
//! The status/shape table mirrors the TS verbatim:
//!
//! | GET    | 200 `{skills:[...]}` — sync first, then one record per installed name: `{...scenario, skillName, installed:true, description}` |
//! | DELETE | unsafe name → 400 `{error:"Invalid skill name"}`; not removed → 404 `{error:"Skill not found"}`; else 200 `{ok:true, deleted:<name>}` |
//! | PATCH  | unsafe name → 400 `{error:"Invalid skill name"}`; bad JSON → 400 `{error:"Invalid JSON body"}`; empty-or-foreign keys → 400 `{error:"Allowed fields: enabled, autoUse, whenToUse, triggerKeywords"}`; scenario gone → 404 `{error:"Skill scenario not found"}`; else 200 `{skill:<updated>}` |
//!
//! Parity notes:
//! - GET runs `syncInstalledSkills` INLINE (the TS awaits it before
//!   responding; its throw is uncaught there → generic Next 500 — Rust
//!   replies 500 `{error}` instead, recorded). The TS `startSkillWatcher`
//!   chokidar loop is NOT ported (RECORDED OMISSION: skills added while
//!   the server runs appear on the next GET anyway — the watcher only
//!   pushed invalidations to the browser store, which the Rust side has
//!   no consumer for yet).
//! - read_scenario merges the file over the default keys, so every record
//!   carries the full six-key shape; `skillName` is then re-pinned to the
//!   directory name and `installed`/`description` appended (spread order
//!   preserved by serde preserve_order: existing-key inserts keep the
//!   original slot, new keys append).
//! - PATCH's `Object.keys(patch ?? {})` over a NON-object body: null /
//!   numbers / booleans give `[]` (empty → same 400), arrays and strings
//!   give index keys (foreign → same 400). All non-object bodies therefore
//!   collapse into the one allowed-fields 400 — the equivalence class the
//!   Rust `_` arm implements.
//! - PATCH's allow-list gate inspects KEY NAMES only; value types are
//!   filtered later by update_scenario's per-field `typeof` gates (wrong
//!   type = silently ignored, TS parity).
//! - RECORDED MICRO-DIVERGENCE: the TS routes resolve root via
//!   `projectRoot()` = `WEBUI_SKILLS_ROOT ?? cwd`. Rust uses the injected
//!   `state.root` (config::project_root() = `RUKE_PROJECT_ROOT` → walk-up
//!   discovery → cwd). Same directory in every supported launch mode, and
//!   injecting it keeps route handlers free of process-env reads (a race
//!   hazard under cargo's parallel test harness).

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Map, Value};

use ruke_skills::registry;

use crate::AppState;

/// The TS GET: sync, then decorate every installed skill.
pub async fn skills_get(State(state): State<AppState>) -> Response {
    let root = &state.root;
    let _synced = match registry::sync_installed_skills(root) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let mut records = Vec::new();
    for name in registry::list_installed_skill_names(root) {
        // TS: `(await readScenario(root, name)) ?? defaultScenario(name)`
        // — read_scenario in BOTH implementations returns only objects or
        // None, and its default-overlay merge already fills missing keys.
        // defaultScenario(name) defaults sourceRepo to "" — mirrored.
        let mut rec = match registry::read_scenario(root, &name) {
            Some(Value::Object(m)) => m,
            _ => registry::default_scenario(&name, ""),
        };
        rec.insert("skillName".into(), Value::String(name.clone()));
        rec.insert("installed".into(), Value::Bool(true));
        rec.insert("description".into(), Value::String(registry::skill_description(root, &name)));
        records.push(Value::Object(rec));
    }
    json_response(StatusCode::OK, json!({ "skills": records }))
}

/// `app/api/skills/[skillName]/route.ts` DELETE.
pub async fn skill_delete(State(state): State<AppState>, Path(skill_name): Path<String>) -> Response {
    if !registry::is_safe_skill_name(&skill_name) {
        return err(StatusCode::BAD_REQUEST, "Invalid skill name");
    }
    match registry::delete_skill(&state.root, &skill_name) {
        Ok(false) => err(StatusCode::NOT_FOUND, "Skill not found"),
        // NOTE: the response carries the NAME, not a boolean (TS
        // `{ ok: true, deleted: skillName }`).
        Ok(true) => json_response(StatusCode::OK, json!({ "ok": true, "deleted": skill_name })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

const ALLOWED_FIELDS: [&str; 4] = ["enabled", "autoUse", "whenToUse", "triggerKeywords"];

/// `app/api/skills/[skillName]/scenario/route.ts` PATCH.
pub async fn scenario_patch(State(state): State<AppState>, Path(skill_name): Path<String>, req: Request) -> Response {
    if !registry::is_safe_skill_name(&skill_name) {
        return err(StatusCode::BAD_REQUEST, "Invalid skill name");
    }
    // `try { patch = await req.json() } catch { 400 }` — the catch fires on
    // both parse failure and body-read failure.
    let bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };
    let patch: Map<String, Value> = match body {
        Value::Object(m) => m,
        // See header: every non-object body lands in the same allowed-
        // fields 400 as an empty object does.
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                "Allowed fields: enabled, autoUse, whenToUse, triggerKeywords",
            )
        }
    };
    // `keys.length === 0 || keys.some(k => !ALLOWED.includes(k))`
    if patch.is_empty() || patch.keys().any(|k| !ALLOWED_FIELDS.contains(&k.as_str())) {
        return err(
            StatusCode::BAD_REQUEST,
            "Allowed fields: enabled, autoUse, whenToUse, triggerKeywords",
        );
    }
    match registry::update_scenario(&state.root, &skill_name, &patch) {
        Ok(Some(updated)) => json_response(StatusCode::OK, json!({ "skill": updated })),
        Ok(None) => err(StatusCode::NOT_FOUND, "Skill scenario not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
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
    use std::path::Path;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use ruke_attach::UnavailableEmbedder;
    use ruke_core::{settings::SettingsStore, slot::InferenceSlot, turn::TurnCounter};
    use tower::ServiceExt; // oneshot

    use crate::persistence::ConversationStore;
    use crate::titles::{generate::UnconfiguredTitleModel, queue::TitleQueue};

    /// A state rooted at a temp dir pre-seeded with a skills tree.
    fn seeded_state(seed: impl FnOnce(&Path)) -> (crate::AppState, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        seed(tmp.path());
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
        };
        (state, tmp)
    }

    fn seed_skill(root: &Path, name: &str, skill_md: &str, scenario: Option<&str>) {
        let dir = root.join("skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), skill_md).unwrap();
        if let Some(s) = scenario {
            let sc = root.join("skill-scenarios");
            std::fs::create_dir_all(&sc).unwrap();
            std::fs::write(sc.join(format!("{name}.json")), s).unwrap();
        }
    }

    async fn call(
        state: &crate::AppState,
        method: &str,
        uri: &str,
        body: Body,
    ) -> (StatusCode, Value) {
        let req = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap();
        let resp = crate::build_router(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 256_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn find_skill<'a>(body: &'a Value, name: &str) -> &'a Value {
        body["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["skillName"] == json!(name))
            .unwrap_or_else(|| panic!("no record for {name} in {body}"))
    }

    #[tokio::test]
    async fn get_lists_installed_with_default_scenario_shape() {
        let (s, _t) = seeded_state(|root| seed_skill(root, "alpha", "# Alpha Skill", None));
        let (status, body) = call(&s, "GET", "/api/ruke/skills", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        let rec = find_skill(&body, "alpha");
        // Default scenario keys (sync auto-created the file too).
        assert_eq!(rec["sourceRepo"], json!(""));
        assert_eq!(rec["enabled"], json!(true));
        assert_eq!(rec["autoUse"], json!(false));
        assert_eq!(rec["whenToUse"], json!(""));
        assert_eq!(rec["triggerKeywords"], json!([]));
        assert_eq!(rec["blockedReason"], json!(null));
        // Decorations.
        assert_eq!(rec["skillName"], json!("alpha"));
        assert_eq!(rec["installed"], json!(true));
        assert_eq!(rec["description"], json!("Alpha Skill")); // first heading
        assert!(s.root.join("skill-scenarios").join("alpha.json").exists());
    }

    #[tokio::test]
    async fn get_preserves_existing_scenario_and_frontmatter_description() {
        let (s, _t) = seeded_state(|root| {
            seed_skill(
                root,
                "beta",
                "---\nname: beta\ndescription: Beta does things.\n---\n# heading\n",
                Some(r#"{"skillName":"beta","sourceRepo":"acme/beta","enabled":false,"autoUse":true,"whenToUse":"use it","triggerKeywords":["b"],"blockedReason":null}"#),
            );
        });
        let (_status, body) = call(&s, "GET", "/api/ruke/skills", Body::empty()).await;
        let rec = find_skill(&body, "beta");
        assert_eq!(rec["sourceRepo"], json!("acme/beta"));
        assert_eq!(rec["enabled"], json!(false)); // file value WINS over default
        assert_eq!(rec["autoUse"], json!(true));
        assert_eq!(rec["whenToUse"], json!("use it"));
        assert_eq!(rec["triggerKeywords"], json!(["b"]));
        assert_eq!(rec["description"], json!("Beta does things.")); // frontmatter wins
    }

    #[tokio::test]
    async fn patch_gates_keys_then_updates() {
        let scenario = r#"{"skillName":"gamma","sourceRepo":"","enabled":false,"autoUse":false,"whenToUse":"","triggerKeywords":[],"blockedReason":null}"#;
        let (s, _t) = seeded_state(|root| seed_skill(root, "gamma", "# Gamma", Some(scenario)));

        // Foreign key ⇒ allowed-fields 400 (value never even inspected).
        let (status, body) = call(
            &s,
            "PATCH",
            "/api/ruke/skills/gamma/scenario",
            Body::from(r#"{"enabled":true,"bogus":1}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Allowed fields: enabled, autoUse, whenToUse, triggerKeywords"));

        // Empty object ⇒ same 400 (keys.length === 0).
        let (status, _) =
            call(&s, "PATCH", "/api/ruke/skills/gamma/scenario", Body::from("{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Non-object bodies ⇒ same 400 class (Object.keys ⇒ []/index keys).
        let (status, _) =
            call(&s, "PATCH", "/api/ruke/skills/gamma/scenario", Body::from("null")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Bad JSON ⇒ distinct 400.
        let (status, body) =
            call(&s, "PATCH", "/api/ruke/skills/gamma/scenario", Body::from("{oops")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Invalid JSON body"));

        // Unsafe name short-circuits BEFORE the body is even read.
        let (status, body) = call(
            &s,
            "PATCH",
            "/api/ruke/skills/..%2Fescape/scenario",
            Body::from(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Invalid skill name"));

        // Valid patch: enabled flips; a wrong-typed allowed field is silently
        // ignored (TS typeof gate) — but the KEY is still allowed, so it is
        // not a 400.
        let (status, body) = call(
            &s,
            "PATCH",
            "/api/ruke/skills/gamma/scenario",
            Body::from(r#"{"enabled":true,"whenToUse":99}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["skill"]["enabled"], json!(true));
        assert_eq!(body["skill"]["whenToUse"], json!("")); // 99 ignored, file value kept

        // Missing scenario (skill dir absent) ⇒ 404.
        let (status, body) = call(
            &s,
            "PATCH",
            "/api/ruke/skills/nothere/scenario",
            Body::from(r#"{"enabled":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], json!("Skill scenario not found"));
    }

    #[tokio::test]
    async fn delete_removes_skill_and_scenario() {
        let (s, tmp) = seeded_state(|root| {
            seed_skill(root, "delta", "# Delta", Some(r#"{"skillName":"delta"}"#));
        });
        let (status, body) = call(&s, "DELETE", "/api/ruke/skills/delta", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        // The name rides along — NOT `deleted: true`.
        assert_eq!(body, json!({ "ok": true, "deleted": "delta" }));
        assert!(!tmp.path().join("skills").join("delta").exists());
        assert!(!tmp.path().join("skill-scenarios").join("delta.json").exists());

        // Second delete ⇒ not removed ⇒ 404.
        let (status, body) = call(&s, "DELETE", "/api/ruke/skills/delta", Body::empty()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], json!("Skill not found"));

        // Unsafe names are rejected at the route gate.
        let (status, body) = call(&s, "DELETE", "/api/ruke/skills/Bad%20Name", Body::empty()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], json!("Invalid skill name"));
    }
}
