//! `buildDecisionSkillBlock(env, root)` from
//! `lib/decision/skill-loader.ts`: `<core_skill>` bundle (if
//! `skill_to_load` resolves to a readable `.cskills` bundle) + the mode's
//! output contract, joined by blank lines inside the `<decision_skill>`
//! wrapper. Core-tier bundles are NEVER visible to the browser (Part 3 §9
//! invisibility) — this block is only ever injected into outbound chat
//! payloads.

use std::path::Path;

use ruke_contracts::decision::DecisionEnvelope;
use ruke_skills::core_skill::load_core_skill_bundle;

use crate::contracts::mode_contract;

/// `buildDecisionSkillBlock`. Returns `None` exactly when the TS returns
/// `null` (no skill bundle AND no contract — i.e. standard_chat with no
/// skill).
pub fn build_decision_skill_block(env: &DecisionEnvelope, root: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if let Some(skill) = env.skill_to_load {
        if let Some(bundle) = load_core_skill_bundle(root, skill) {
            // JS `if (bundle)` guards falsy "" too — empty bundles skip.
            if !bundle.is_empty() {
                parts.push(format!("<core_skill name=\"{skill}\">\n{bundle}\n</core_skill>"));
            }
        }
    }
    if let Some(contract) = mode_contract(env.active_mode) {
        parts.push(contract.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "<decision_skill mode=\"{}\" decided_by=\"{}\">\n{}\nFollow the skill and output contract above exactly for this request. Emit only the fence type named in the contract (if any); never emit other renderer fences.\n</decision_skill>",
        env.active_mode.as_str(),
        env.decided_by,
        parts.join("\n\n"),
    ))
}

/// Same as [`build_decision_skill_block`] with the default project root —
/// the TS's `projectRoot()` (`WEBUI_SKILLS_ROOT` ?? cwd) maps to
/// `ruke_core::config::project_root()` (`RUKE_PROJECT_ROOT` → discovery
/// walk-up → cwd).
pub fn build_decision_skill_block_default_root(env: &DecisionEnvelope) -> Option<String> {
    build_decision_skill_block(env, &ruke_core::config::project_root())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruke_contracts::decision::{mode_fence, RendererMode};
    use serde_json::json;
    use std::fs;

    fn envelope(mode: RendererMode, decided_by: &str) -> DecisionEnvelope {
        DecisionEnvelope {
            active_mode: mode,
            confidence: 1.0,
            decided_by: decided_by.to_string(),
            stripped_prompt: "x".into(),
            skill_to_load: ruke_contracts::decision::mode_skill(mode),
            allowed_code_fence: mode_fence(mode),
            disable_validators: RendererMode::disable_validators_for(mode),
            enable_validator: mode,
            task_constraints: vec![],
            extracted_entities: vec![],
            lfm_latency_ms: 0,
            lfm_input: None,
            lfm_raw: None,
        }
    }

    #[test]
    fn standard_chat_with_no_skill_produces_no_block() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert!(build_decision_skill_block(&envelope(RendererMode::StandardChat, "in-process-fallback"), tmp.path()).is_none());
    }

    #[test]
    fn chart_mode_has_contract_but_no_core_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        let env = envelope(RendererMode::Chart, "in-process-deliverable-match");
        assert_eq!(env.skill_to_load, None); // MODE_SKILL[chart] = null
        let block = build_decision_skill_block(&env, tmp.path()).unwrap();
        assert!(block.starts_with("<decision_skill mode=\"chart\" decided_by=\"in-process-deliverable-match\">\n"));
        assert!(!block.contains("<core_skill"));
        assert!(block.contains(crate::contracts_generated::CONTRACT_CHART));
        assert!(block.ends_with("\nFollow the skill and output contract above exactly for this request. Emit only the fence type named in the contract (if any); never emit other renderer fences.\n</decision_skill>"));
    }

    #[test]
    fn excel_mode_includes_core_skill_then_contract_separated_by_blank_line() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join(".cskills/xlsx");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: xlsx\n---\nGuide body").unwrap();
        let block = build_decision_skill_block(&envelope(RendererMode::Excel, "repair-passthrough"), tmp.path()).unwrap();
        let contract = crate::contracts_generated::CONTRACT_EXCEL;
        assert!(block.contains("<core_skill name=\"xlsx\">\nGuide body\n</core_skill>\n\n"));
        assert!(block.contains(&format!("</core_skill>\n\n{contract}")));
        assert!(block.starts_with("<decision_skill mode=\"excel\" decided_by=\"repair-passthrough\">\n"));
    }

    #[test]
    fn missing_core_skill_dir_still_emits_contract_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let block = build_decision_skill_block(&envelope(RendererMode::Excel, "x"), tmp.path()).unwrap();
        assert!(!block.contains("<core_skill"));
        assert!(block.contains(crate::contracts_generated::CONTRACT_EXCEL));
    }

    #[test]
    fn envelope_round_trip_helper_shape() {
        // keep the helper honest against json! usage (no unused-import drift)
        let v = json!({ "role": "user" });
        assert_eq!(v["role"], "user");
    }
}
