import { describe, it, expect } from "vitest";
import {
  MAX_FENCE_REPAIRS,
  applyFenceRepair,
  extractFenceBody,
  findBrokenRenderFences,
  fenceRepairRequest,
} from "../../lib/render/fenceRepair";
import type { RendererMode } from "../../lib/decision/types";

// Anatomy note: the anatomy scanner retired with the anatomy mode on
// 2026-11-07 (user directive). The repair API stays for the document-modality
// fences; these tests pin the still-live chart half plus the zero-collision
// rule (a mode never touches another mode's fences).

// Known-valid chart spec (same schema the scan and the viewer share).
const VALID_BODY =
  '{"type":"bar","title":"Test","categories":["a","b"],"series":[{"name":"s","data":[1,2]}]}';

describe("findBrokenRenderFences", () => {
  it("accepts a valid fence", () => {
    expect(findBrokenRenderFences("intro\n\n```chart\n" + VALID_BODY + "\n```\n\noutro", "chart")).toEqual([]);
  });

  it("reports the exact JSON syntax error for a malformed fence", () => {
    const brokenBody = VALID_BODY.replace('"title":"Test"', '"title" "Test"'); // dropped colon
    const found = findBrokenRenderFences("```chart\n" + brokenBody + "\n```", "chart");
    expect(found).toHaveLength(1);
    expect(found[0].error).toContain("invalid JSON");
    expect(found[0].closed).toBe(true);
    expect(found[0].lang).toBe("chart");
  });

  it("reports the exact contract violation for a schema failure", () => {
    // Series length must match categories (chartSpecSchema superRefine).
    const ragged = '{"type":"bar","categories":["a","b"],"series":[{"name":"s","data":[1]}]}';
    const found = findBrokenRenderFences("```chart\n" + ragged + "\n```", "chart");
    expect(found).toHaveLength(1);
    expect(found[0].error).toContain('series "s" length does not match categories');
  });

  it("treats a stream-truncated fence as broken and unclosed", () => {
    const content = '```chart\n{"type":"bar"';
    const found = findBrokenRenderFences(content, "chart");
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(false);
    expect(found[0].bodyEnd).toBe(content.length);
  });

  it("only reports the broken fence when several are present", () => {
    const content = "```chart\n" + VALID_BODY + "\n```\n\nmid\n\n```chart\n{ nope\n```";
    const found = findBrokenRenderFences(content, "chart");
    expect(found).toHaveLength(1);
    expect(found[0].bodyStart).toBeGreaterThan(content.indexOf(VALID_BODY));
  });

  it("a mode never scans another mode's fences (zero-collision rule)", () => {
    // The excel turn ignores the broken chart fence sitting in its stream.
    expect(findBrokenRenderFences("```chart\n{ nope\n```", "excel")).toEqual([]);
    // standard_chat triggers NO validator/auto-repair at all (PART 3).
    expect(findBrokenRenderFences("```chart\n{ nope\n```", "standard_chat")).toEqual([]);
    expect(findBrokenRenderFences("```chart\n{ nope\n```", null)).toEqual([]);
  });

  it("retired anatomy fences are never repaired — the compat card owns them", () => {
    // anatomy retired 2026-11-07: NO active mode lists anatomy in its scan
    // langs, so even a syntactically-dead anatomy fence earns no repair round.
    const modes: (RendererMode | null)[] =
      ["excel", "docs", "pdf", "ppt", "chart", "html_render", "standard_chat", null];
    for (const mode of modes) {
      expect(findBrokenRenderFences("```anatomy\n{ nope\n```", mode), String(mode)).toEqual([]);
    }
  });

  it("caps silent repair rounds", () => {
    expect(MAX_FENCE_REPAIRS).toBe(2);
  });
});

describe("fence repair round-trip", () => {
  it("replaces only the broken fence body, keeping the rest of the message", () => {
    const content = "before\n\n```chart\n{ bad\n```\n\nafter";
    const [broken] = findBrokenRenderFences(content, "chart");
    expect(applyFenceRepair(content, broken, VALID_BODY))
      .toBe("before\n\n```chart\n" + VALID_BODY + "\n```\n\nafter");
  });

  it("closes a fence that was cut off mid-stream", () => {
    const content = '```chart\n{"type":"bar"';
    const [broken] = findBrokenRenderFences(content, "chart");
    expect(applyFenceRepair(content, broken, VALID_BODY)).toBe("```chart\n" + VALID_BODY + "\n```");
  });

  it("extracts the corrected fence from a repair reply, ignoring prose", () => {
    const reply = "Fixing it:\n\n```chart\n" + VALID_BODY + "\n```\n\nDone.";
    expect(extractFenceBody(reply, "chart")).toBe(VALID_BODY);
  });

  it("returns null when the model answers without a fence", () => {
    expect(extractFenceBody("I added the missing bracket.", "chart")).toBeNull();
    expect(extractFenceBody("```chart\n\n```", "chart")).toBeNull();
  });

  it("the repair request names the exact error and the fence contract", () => {
    const [broken] = findBrokenRenderFences("```chart\n{ bad\n```", "chart");
    const prompt = fenceRepairRequest(broken);
    expect(prompt).toContain(broken.error);
    // Naming the contract is what makes the model re-emit a valid fence.
    expect(prompt).toContain("```chart");
  });
});
