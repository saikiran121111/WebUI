import { describe, it, expect } from "vitest";
import type { Logger } from "pino";
import type { DecisionEnvelope } from "../../lib/decision/types";
import { logDecisionTable, MODE_COMPONENT } from "../../lib/server/decision-log";

function envelope(over: Partial<DecisionEnvelope> = {}): DecisionEnvelope {
  return {
    active_mode: "3d_asset",
    confidence: 0.88,
    decided_by: "needle3+lfm2.5",
    stripped_prompt: "3D heart model with labeled chambers",
    skill_to_load: "threejs-skills",
    allowed_code_fence: "scene3d",
    disable_validators: ["excel", "docs", "pdf", "ppt", "cad_blueprint", "chart", "html_render", "standard_chat"],
    enable_validator: "3d_asset",
    task_constraints: ["labeled chambers"],
    extracted_entities: ["heart"],
    needle_latency_ms: 12,
    lfm_latency_ms: 340,
    needle_prior: { modes: ["3d_asset"], confidence: 0.91 },
    lfm_input: "Create a 3D heart model with labeled chambers\n---\nPRIOR candidates=[\"3d_asset\"]",
    lfm_raw: '{"active_mode":"3d_asset","confidence":0.88,"stripped_prompt":"3D heart model with labeled chambers"}',
    ...over,
  };
}

function table(o: Parameters<typeof logDecisionTable>[1]): string {
  const msgs: string[] = [];
  const fake = { info: (m: string) => msgs.push(m) } as unknown as Logger;
  logDecisionTable(fake, o);
  return msgs[0];
}

describe("logDecisionTable", () => {
  it("renders the full Needle + LFM input/output story for a decided turn", () => {
    const t = table({ input: "Create a 3D heart model with labeled chambers", env: envelope(), usedSkill: null, skillBlockBytes: 8192, model: "default" });
    expect(t).toContain("NEEDLE 3 · stage-1 prior · 12ms");
    expect(t).toContain("candidates: 3d_asset · conf 0.91");
    expect(t).toContain("LFM2.5-1.2B · stage-2 gate + noise-strip · 340ms");
    expect(t).toContain('OUT     {"active_mode":"3d_asset"');
    expect(t).toContain("MODE        3d_asset · conf 0.88 · by needle3+lfm2.5");
    expect(t).toContain(MODE_COMPONENT["3d_asset"]);
    expect(t).toContain("core:threejs-skills · user:— · 8192B block injected");
    expect(t).toContain('LLM PROMPT  "3D heart model with labeled chambers"');
    expect(t).toContain("CONSTRAINTS labeled chambers");
    expect(t).toContain("ENTITIES    heart");
    expect(t).toContain("3d_asset ON · 8 others OFF · fence `scene3d`");
    expect(t).toContain('MAIN LLM    model "default"');
  });

  it("shows the user-tier slash skill when one was used", () => {
    const t = table({ input: "/xlsx make a sheet", env: envelope({ skill_to_load: null }), usedSkill: "xlsx", skillBlockBytes: 0 });
    expect(t).toContain("core:— · user:xlsx");
  });

  it("marks an engine-unavailable fallback honestly (no fake model rows)", () => {
    const t = table({
      input: "hi",
      env: envelope({
        active_mode: "standard_chat", decided_by: "fallback", confidence: 0,
        skill_to_load: null, allowed_code_fence: null, enable_validator: "standard_chat",
        needle_latency_ms: 0, lfm_latency_ms: 0, needle_prior: null, lfm_input: null, lfm_raw: null,
      }),
    });
    expect(t).toContain("not called — engine unavailable (fallback envelope)");
    expect(t).toContain("LFM2.5-1.2B · stage-2 gate + noise-strip · 0ms");
    expect(t).toContain("IN/OUT  not called");
    expect(t).toContain(MODE_COMPONENT.standard_chat);
  });

  it("marks fence-repair passthrough rounds as skipped", () => {
    const t = table({
      input: "repair the broken scene3d fence",
      env: envelope({ decided_by: "repair-passthrough", needle_latency_ms: 0, lfm_latency_ms: 0, needle_prior: null }),
    });
    expect(t).toContain("skipped — fence-repair round, mode pinned by the client");
    expect(t).toContain("IN/OUT  not called");
  });

  it("collapses newlines and caps long values so rows stay single-line", () => {
    const t = table({ input: "line1\nline2", env: envelope({ lfm_raw: "a".repeat(500) }) });
    const out = t.split("\n").filter((l) => l.includes("   OUT ")).pop();
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThan(340);
    expect(out).toContain("…");
    expect(t).toContain('USER      "line1 ⏎ line2"');
  });
});
