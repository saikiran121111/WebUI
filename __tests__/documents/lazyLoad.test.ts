/**
 * Decision Engine skill-loader exclusivity: against the REAL ./.cskills/ tree
 * in this repo, each mode loads its ONE core skill + ONE output contract and
 * zero tokens from any other modality's skill. standard_chat loads nothing.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildDecisionSkillBlock, loadCoreSkillBundle } from "@/lib/decision/skill-loader";
import {
  MODE_FENCE,
  MODE_SKILL,
  RENDERER_MODES,
  type DecisionEnvelope,
  type RendererMode,
} from "@/lib/decision/types";

const ROOT = path.resolve(__dirname, "../..");

function envelope(mode: RendererMode): DecisionEnvelope {
  return {
    active_mode: mode,
    confidence: 0.97,
    decided_by: "test",
    stripped_prompt: "task",
    skill_to_load: MODE_SKILL[mode],
    allowed_code_fence: MODE_FENCE[mode],
    disable_validators: RENDERER_MODES.filter((m) => m !== mode),
    enable_validator: mode,
    task_constraints: [],
    extracted_entities: [],
    lfm_latency_ms: 1,
  };
}

const MODALITY_SKILLS = ["pdf", "docx", "xlsx", "pptx", "html-viewer", "threejs-skills", "archify"];

const MODE_SKILL_TESTS: [RendererMode, string][] = [
  ["excel", "xlsx"],
  ["docs", "docx"],
  ["pdf", "pdf"],
  ["ppt", "pptx"],
  ["3d_asset", "threejs-skills"],
  ["cad_blueprint", "archify"],
  ["html_render", "html-viewer"],
];

describe("decision skill loader — one skill per mode, zero cross-modality contamination", () => {
  for (const [mode, skill] of MODE_SKILL_TESTS) {
    it(`${mode} loads ONLY the ${skill} skill + its contract`, async () => {
      const block = await buildDecisionSkillBlock(envelope(mode), ROOT);
      expect(block).not.toBeNull();
      expect(block).toContain(`<core_skill name="${skill}"`);
      expect(block).toContain(`<decision_skill mode="${mode}"`);
      const others = MODALITY_SKILLS.filter((s) => s !== skill);
      for (const other of others) {
        expect(block).not.toContain(`<core_skill name="${other}"`);
      }
    });
  }

  it("chart injects only the chart contract (no core skill)", async () => {
    const block = await buildDecisionSkillBlock(envelope("chart"), ROOT);
    expect(block).not.toBeNull();
    expect(block).toContain("<output_contract_chart>");
    expect(block).not.toContain("<core_skill");
  });

  it("standard_chat injects nothing at all", async () => {
    const block = await buildDecisionSkillBlock(envelope("standard_chat"), ROOT);
    expect(block).toBeNull();
  });

  it("bundle reader refuses path-unsafe names and missing skills", async () => {
    expect(await loadCoreSkillBundle(ROOT, "../evil")).toBeNull();
    expect(await loadCoreSkillBundle(ROOT, "no-such-skill-xyz")).toBeNull();
  });
});
