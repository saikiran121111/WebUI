//! `buildDecisionSkillBlock(env, root)` from
//! `lib/decision/skill-loader.ts`: `<core_skill>` bundle (if
//! `skill_to_load` resolves to a readable `.cskills` bundle) + the mode's
//! output contract, joined by blank lines inside the `<decision_skill>`
//! wrapper. Core-tier bundles are NEVER visible to the browser (Part 3 §9
//! invisibility) — this block is only ever injected into outbound chat
//! payloads.

use std::path::Path;

use ruke_contracts::decision::{DecisionEnvelope, RendererMode};
use ruke_skills::core_skill::load_core_skill_bundle;

use crate::contracts::mode_contract;

/// F02: a multi-deliverable turn stays in `standard_chat` (one mode validator
/// cannot own two fences), yet EVERY requested deliverable must be armed — the
/// list is the envelope's own typed `task_constraints` (provenance: the
/// scanner wrote it), never a re-parse of the prompt. Mirrors
/// `requestedDeliverables` in `lib/decision/skill-loader.ts`.
const DELIVERABLE_REQUEST_PREFIX: &str = "deliverable-request=";
/// Bounded injection: two extra contracts is already a large prompt.
pub const MAX_EXTRA_DELIVERABLE_CONTRACTS: usize = 2;

/// Byte-identical to the TS `MULTI_DELIVERABLE_NOTE` (byte-exact replay class).
pub const MULTI_DELIVERABLE_NOTE: &str = concat!(
    "MULTI-DELIVERABLE TURN: the request asks for more than one deliverable. ",
    "Emit one fenced block per contract above, in the order requested. ",
    "Do not merge them and do not drop one.",
);

/// Requested deliverable modes other than the active one, in request order.
pub fn requested_deliverables(env: &DecisionEnvelope) -> Vec<RendererMode> {
    let mut out: Vec<RendererMode> = Vec::new();
    for constraint in &env.task_constraints {
        let Some(value) = constraint.strip_prefix(DELIVERABLE_REQUEST_PREFIX) else {
            continue;
        };
        if value == "standard_chat" || value == env.active_mode.as_str() {
            continue;
        }
        let Some(mode) = RendererMode::parse(value) else {
            continue;
        };
        if out.contains(&mode) {
            continue;
        }
        out.push(mode);
        if out.len() >= MAX_EXTRA_DELIVERABLE_CONTRACTS {
            break;
        }
    }
    out
}

/// `buildDecisionSkillBlock`. No mode is contract-less anymore: artifact
/// modes carry their output contract, standard_chat the D-070 fence
/// catalogue, so a block exists for every envelope; `None` stays only as
/// the honest mirror of a MODE_CONTRACTS entry set back to `null`.
pub fn build_decision_skill_block(env: &DecisionEnvelope, root: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    if let Some(skill) = env.skill_to_load {
        if let Some(bundle) = load_core_skill_bundle(root, skill) {
            // JS `if (bundle)` guards falsy "" too — empty bundles skip.
            if !bundle.is_empty() {
                parts.push(format!(
                    "<core_skill name=\"{skill}\">\n{bundle}\n</core_skill>"
                ));
            }
        }
    }
    if let Some(contract) = mode_contract(env.active_mode) {
        parts.push(contract.to_string());
    }
    let mut extras: Vec<String> = requested_deliverables(env)
        .into_iter()
        .filter_map(|mode| mode_contract(mode).map(str::to_string))
        .collect();
    let extra_contracts = extras.len();
    // Same ORDER as the TS: every requested contract first, then the note —
    // and only when there really is more than one contract to keep apart.
    parts.append(&mut extras);
    if extra_contracts > 1 {
        parts.push(MULTI_DELIVERABLE_NOTE.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "<decision_skill mode=\"{}\" decided_by=\"{}\">\n{}\nFollow the skill and output contract above exactly for this request. Emit only the fence type named in the contract (if any); where none names one, emit a renderer fence only from the catalogue above and only when the request clearly calls for one.\n</decision_skill>",
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
    fn standard_chat_with_no_skill_still_carries_the_fence_catalogue() {
        // D-070: the catalogue rides every chat turn - knowledge, not a
        // keyword rule. A prose answer was invisible to fenceRepair because
        // nothing failed a validator; now the model is told which fences
        // exist even when the engine proposed no mode.
        let tmp = tempfile::TempDir::new().unwrap();
        let block = build_decision_skill_block(
            &envelope(RendererMode::StandardChat, "in-process-fallback"),
            tmp.path(),
        )
        .expect("standard_chat now carries the catalogue");
        assert!(block.starts_with("<decision_skill mode=\"standard_chat\" decided_by=\"in-process-fallback\">\n"));
        assert!(block.contains(crate::contracts_generated::CONTRACT_STANDARD_CHAT));
        assert!(!block.contains("<core_skill"));
        assert!(block.ends_with("\nFollow the skill and output contract above exactly for this request. Emit only the fence type named in the contract (if any); where none names one, emit a renderer fence only from the catalogue above and only when the request clearly calls for one.\n</decision_skill>"));
    }

    #[test]
    fn chart_mode_has_contract_but_no_core_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        let env = envelope(RendererMode::Chart, "in-process-deliverable-match");
        assert_eq!(env.skill_to_load, None); // MODE_SKILL[chart] = null
        let block = build_decision_skill_block(&env, tmp.path()).unwrap();
        assert!(block.starts_with(
            "<decision_skill mode=\"chart\" decided_by=\"in-process-deliverable-match\">\n"
        ));
        assert!(!block.contains("<core_skill"));
        assert!(block.contains(crate::contracts_generated::CONTRACT_CHART));
        assert!(block.ends_with("\nFollow the skill and output contract above exactly for this request. Emit only the fence type named in the contract (if any); where none names one, emit a renderer fence only from the catalogue above and only when the request clearly calls for one.\n</decision_skill>"));
    }

    #[test]
    fn excel_mode_includes_core_skill_then_contract_separated_by_blank_line() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join(".cskills/xlsx");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: xlsx\n---\nGuide body").unwrap();
        let block = build_decision_skill_block(
            &envelope(RendererMode::Excel, "repair-passthrough"),
            tmp.path(),
        )
        .unwrap();
        let contract = crate::contracts_generated::CONTRACT_EXCEL;
        assert!(block.contains("<core_skill name=\"xlsx\">\nGuide body\n</core_skill>\n\n"));
        assert!(block.contains(&format!("</core_skill>\n\n{contract}")));
        assert!(block
            .starts_with("<decision_skill mode=\"excel\" decided_by=\"repair-passthrough\">\n"));
    }

    #[test]
    fn missing_core_skill_dir_still_emits_contract_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let block =
            build_decision_skill_block(&envelope(RendererMode::Excel, "x"), tmp.path()).unwrap();
        assert!(!block.contains("<core_skill"));
        assert!(block.contains(crate::contracts_generated::CONTRACT_EXCEL));
    }

    #[test]
    fn envelope_round_trip_helper_shape() {
        // keep the helper honest against json! usage (no unused-import drift)
        let v = json!({ "role": "user" });
        assert_eq!(v["role"], "user");
    }

    /* ---- F02 multi-deliverable injection (mirrors the TS skill-loader) ---- */

    fn envelope_with_constraints(
        mode: RendererMode,
        constraints: &[&str],
    ) -> DecisionEnvelope {
        let mut env = envelope(mode, "in-process-deliverable-multiple");
        env.task_constraints = constraints.iter().map(|s| (*s).to_string()).collect();
        env
    }

    #[test]
    fn multi_deliverable_turn_arms_every_requested_contract() {
        let tmp = tempfile::TempDir::new().unwrap();
        let env = envelope_with_constraints(
            RendererMode::StandardChat,
            &["deliverable-request=pdf", "deliverable-request=excel"],
        );
        let block = build_decision_skill_block(&env, tmp.path()).expect("multi block");
        let pdf = crate::contracts_generated::CONTRACT_PDF;
        let xlsx = crate::contracts_generated::CONTRACT_EXCEL;
        assert!(block.starts_with(
            "<decision_skill mode=\"standard_chat\" decided_by=\"in-process-deliverable-multiple\">\n"
        ));
        assert!(block.contains(pdf), "the PDF contract was dropped");
        assert!(block.contains(xlsx), "the Excel contract was dropped");
        // request ORDER is preserved, then the note keeps them apart
        assert!(block.find(pdf).unwrap() < block.find(xlsx).unwrap());
        assert!(block.contains(MULTI_DELIVERABLE_NOTE));
        assert!(block.find(xlsx).unwrap() < block.find(MULTI_DELIVERABLE_NOTE).unwrap());
        assert!(block.ends_with("\n</decision_skill>"));
    }

    #[test]
    fn single_deliverable_turn_is_unchanged_and_gets_no_note() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut env = envelope(RendererMode::Excel, "in-process-deliverable-match");
        env.task_constraints = vec!["deliverable-request=excel".into()];
        let block = build_decision_skill_block(&env, tmp.path()).unwrap();
        assert!(!block.contains(MULTI_DELIVERABLE_NOTE));
        let contract = crate::contracts_generated::CONTRACT_EXCEL;
        assert_eq!(block.matches(contract).count(), 1, "contract injected twice");
    }

    #[test]
    fn constraint_injection_is_bounded_and_type_validated() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Garbage, unknown modes and the active mode never inject an EXTRA
        // contract. (D-070 changed the pre-condition: standard_chat is no
        // longer contract-less — the block it returns carries ONLY the
        // catalogue, no artifact contract and no multi note.)
        let env = envelope_with_constraints(
            RendererMode::StandardChat,
            &[
                "search-domain=alpha.com",
                "deliverable-request=not-a-mode",
                "deliverable-request=standard_chat",
            ],
        );
        let block = build_decision_skill_block(&env, tmp.path()).expect("catalogue block");
        assert!(block.contains(crate::contracts_generated::CONTRACT_STANDARD_CHAT));
        assert!(!block.contains(crate::contracts_generated::CONTRACT_PDF));
        assert!(!block.contains(crate::contracts_generated::CONTRACT_EXCEL));
        assert!(!block.contains(MULTI_DELIVERABLE_NOTE));
        assert!(!block.contains("<core_skill"));
        // three requests still inject at most MAX_EXTRA_DELIVERABLE_CONTRACTS
        let env = envelope_with_constraints(
            RendererMode::StandardChat,
            &[
                "deliverable-request=pdf",
                "deliverable-request=excel",
                "deliverable-request=ppt",
            ],
        );
        let block = build_decision_skill_block(&env, tmp.path()).unwrap();
        let third = crate::contracts_generated::CONTRACT_PPT;
        let included = [
            crate::contracts_generated::CONTRACT_PDF,
            crate::contracts_generated::CONTRACT_EXCEL,
            third,
        ]
        .iter()
        .filter(|c| block.contains(**c))
        .count();
        assert_eq!(included, MAX_EXTRA_DELIVERABLE_CONTRACTS, "injection bound");
    }

    #[test]
    fn note_text_is_byte_identical_to_the_ts_constant() {
        // The block is a byte-exact golden replay class, so the note must not
        // drift between engines. This constant is the only source of the text.
        assert_eq!(
            MULTI_DELIVERABLE_NOTE,
            "MULTI-DELIVERABLE TURN: the request asks for more than one deliverable. Emit one fenced block per contract above, in the order requested. Do not merge them and do not drop one."
        );
    }

}
