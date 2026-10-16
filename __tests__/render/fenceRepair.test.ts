import { describe, it, expect } from "vitest";
import {
  MAX_FENCE_REPAIRS,
  applyFenceRepair,
  extractAnatomyFenceBody,
  fenceRepairRequest,
  findBrokenAnatomyFences,
} from "../../lib/render/fenceRepair";

// Known-valid mini spec (mirrors the SKILL.md worked example).
const VALID_BODY =
  '{"title":"Test head","label":"Test figure","width":560,"height":420,"parts":[{"id":"deck","tone":"base","kind":"slab","plan":{"x":-40,"y":-30,"w":80,"d":60,"r":6},"z":0,"height":14}]}';

describe("findBrokenAnatomyFences", () => {
  it("accepts a valid fence", () => {
    expect(findBrokenAnatomyFences("intro\n\n```anatomy\n" + VALID_BODY + "\n```\n\noutro")).toEqual([]);
  });

  it("reports the exact JSON syntax error for a malformed fence", () => {
    const brokenBody = VALID_BODY.replace('"r":6', '"r" 6'); // dropped colon
    const found = findBrokenAnatomyFences("```anatomy\n" + brokenBody + "\n```");
    expect(found).toHaveLength(1);
    expect(found[0].error).toContain("invalid JSON");
    expect(found[0].closed).toBe(true);
  });

  it("reports the exact schema path for a contract violation", () => {
    const noR = '{"title":"T","label":"T","parts":[{"id":"col","tone":"structure","kind":"rod","path":[[0,0,0],[0,0,120]]}]}';
    const found = findBrokenAnatomyFences("```anatomy\n" + noR + "\n```");
    expect(found).toHaveLength(1);
    expect(found[0].error).toContain("parts.0.r: Required");
  });

  it("treats a stream-truncated fence as broken and unclosed", () => {
    const found = findBrokenAnatomyFences('```anatomy\n{"title":"T","parts":[{"id":"a"');
    expect(found).toHaveLength(1);
    expect(found[0].closed).toBe(false);
    expect(found[0].bodyEnd).toBe('```anatomy\n{"title":"T","parts":[{"id":"a"'.length);
  });

  it("only reports the broken fence when several are present", () => {
    const content = "```anatomy\n" + VALID_BODY + "\n```\n\nmid\n\n```anatomy\n{ nope\n```";
    const found = findBrokenAnatomyFences(content);
    expect(found).toHaveLength(1);
    expect(found[0].bodyStart).toBeGreaterThan(content.indexOf(VALID_BODY));
  });

  it("caps silent repair rounds", () => {
    expect(MAX_FENCE_REPAIRS).toBe(2);
  });
});

describe("fence repair round-trip", () => {
  it("replaces only the broken fence body, keeping the rest of the message", () => {
    const content = "before\n\n```anatomy\n{ bad\n```\n\nafter";
    const [broken] = findBrokenAnatomyFences(content);
    expect(applyFenceRepair(content, broken, VALID_BODY))
      .toBe("before\n\n```anatomy\n" + VALID_BODY + "\n```\n\nafter");
  });

  it("closes a fence that was cut off mid-stream", () => {
    const content = '```anatomy\n{"title":"T","parts":[{"id":"a"';
    const [broken] = findBrokenAnatomyFences(content);
    expect(applyFenceRepair(content, broken, VALID_BODY)).toBe("```anatomy\n" + VALID_BODY + "\n```");
  });

  it("extracts the corrected fence from a repair reply, ignoring prose", () => {
    const reply = "Fixing it:\n\n```anatomy\n" + VALID_BODY + "\n```\n\nDone.";
    expect(extractAnatomyFenceBody(reply)).toBe(VALID_BODY);
  });

  it("returns null when the model answers without a fence", () => {
    expect(extractAnatomyFenceBody("I added the missing r field.")).toBeNull();
    expect(extractAnatomyFenceBody("```anatomy\n\n```")).toBeNull();
  });

  it("the repair request names the exact error and keeps the anatomy contract wording", () => {
    const [broken] = findBrokenAnatomyFences("```anatomy\n{ bad\n```");
    const prompt = fenceRepairRequest(broken);
    expect(prompt).toContain(broken.error);
    // The repair prompt must keep naming the anatomy illustration contract —
    // that wording is what makes the model re-emit a valid fence.
    expect(prompt.toLowerCase()).toContain("anatomy illustration");
  });
});
