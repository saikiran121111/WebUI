/**
 * F02 (2026-11-16): a turn that requests SEVERAL deliverables must arm EVERY
 * requested output contract. The list is read from the envelope's OWN typed
 * task_constraints (provenance: the scanner wrote it) - the injection layer
 * never re-parses or re-classifies the prompt, and never invents a winner.
 *
 * The Rust twin is ruke-decision/src/skill_block.rs (same cap, same note text,
 * same ordering rules); its four unit tests pin the byte-identical note.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_EXTRA_DELIVERABLE_CONTRACTS,
  MULTI_DELIVERABLE_NOTE,
  buildDecisionSkillBlock,
  requestedDeliverables,
} from "@/lib/decision/skill-loader";
import { MODE_CONTRACTS } from "@/lib/decision/contracts";
import { getDecisionSync } from "@/lib/decision/client";
import { RENDERER_MODES, type DecisionEnvelope, type RendererMode } from "@/lib/decision/types";
import { projectRoot } from "@/lib/skills/registry";

function env(
  active_mode: RendererMode,
  task_constraints: string[],
  decided_by = "in-process-deliverable-multiple",
): DecisionEnvelope {
  return {
    active_mode,
    confidence: 0.5,
    decided_by,
    stripped_prompt: "stub",
    skill_to_load: null,
    allowed_code_fence: null,
    disable_validators: RENDERER_MODES.filter((m) => m !== active_mode),
    enable_validator: active_mode,
    task_constraints,
    extracted_entities: [],
    lfm_latency_ms: 0,
  };
}

describe("F02 - requestedDeliverables reads the typed record, not the prompt", () => {
  it("keeps request order and drops the active mode / standard_chat / duplicates", () => {
    expect(
      requestedDeliverables(
        env("excel", [
          "deliverable-request=pdf",
          "deliverable-request=standard_chat",
          "deliverable-request=excel",
          "deliverable-request=pdf",
          "deliverable-request=docs",
        ]),
      ),
    ).toEqual(["pdf", "docs"]);
  });

  it("ignores unrelated or malformed constraints (no invented contracts)", () => {
    expect(
      requestedDeliverables(
        env("standard_chat", [
          "no-search",
          "deliverable-request=",
          "deliverable-request=not_a_mode",
          "deliverable-request=3d_asset",
          "",
        ]),
      ),
    ).toEqual([]);
  });

  it("caps the extras at MAX_EXTRA_DELIVERABLE_CONTRACTS (bounded prompt)", () => {
    const all = requestedDeliverables(
      env("standard_chat", RENDERER_MODES.filter((m) => m !== "standard_chat").map((m) => `deliverable-request=${m}`)),
    );
    expect(all).toHaveLength(MAX_EXTRA_DELIVERABLE_CONTRACTS);
  });

  it("tolerates a missing/undefined constraint list", () => {
    const bare = env("standard_chat", []);
    delete (bare as { task_constraints?: string[] }).task_constraints;
    expect(requestedDeliverables(bare)).toEqual([]);
  });
});

describe("F02 - buildDecisionSkillBlock arms every requested contract", () => {
  it("two deliverables: both contracts + the multi-deliverable note", async () => {
    const real = getDecisionSync("Create a PDF and an XLSX of these numbers", []);
    expect(real.decided_by).toBe("in-process-deliverable-multiple");
    const block = (await buildDecisionSkillBlock(real, projectRoot()))!;
    expect(block).toContain(MODE_CONTRACTS.pdf!);
    expect(block).toContain(MODE_CONTRACTS.excel!);
    expect(block).toContain(MULTI_DELIVERABLE_NOTE);
    expect(block).toContain('mode="standard_chat"');
    expect(block).toContain('decided_by="in-process-deliverable-multiple"');
    // Request order is preserved: the first requested contract precedes the second.
    expect(block.indexOf(MODE_CONTRACTS.pdf!)).toBeLessThan(block.indexOf(MODE_CONTRACTS.excel!));
  });

  it("one extra contract: it is armed, but the multi note is NOT emitted", async () => {
    const block = (await buildDecisionSkillBlock(env("excel", ["deliverable-request=excel", "deliverable-request=chart"]), projectRoot()))!;
    expect(block).toContain(MODE_CONTRACTS.chart!);
    expect(block).not.toContain(MULTI_DELIVERABLE_NOTE);
  });

  it("standard_chat with no recorded deliverable injects NOTHING", async () => {
    expect(await buildDecisionSkillBlock(env("standard_chat", [], "in-process-deliverable-none"), projectRoot())).toBeNull();
  });

  it("the cap also bounds the emitted block", async () => {
    const block = (await buildDecisionSkillBlock(
      env("standard_chat", ["pdf", "excel", "docs", "ppt"].map((m) => `deliverable-request=${m}`)),
      projectRoot(),
    ))!;
    let armed = 0;
    for (const mode of ["pdf", "excel", "docs", "ppt"] as RendererMode[]) {
      if (block.includes(MODE_CONTRACTS[mode]!)) armed += 1;
    }
    expect(armed).toBe(MAX_EXTRA_DELIVERABLE_CONTRACTS);
    expect(block).toContain(MULTI_DELIVERABLE_NOTE);
  });

  it("the note is exact, byte-stable text (Rust parity constant)", () => {
    expect(MULTI_DELIVERABLE_NOTE).toBe(
      "MULTI-DELIVERABLE TURN: the request asks for more than one deliverable. " +
        "Emit one fenced block per contract above, in the order requested. " +
        "Do not merge them and do not drop one.",
    );
  });
});
