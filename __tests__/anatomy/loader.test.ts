import { describe, it, expect } from "vitest";
import { selectAnatomySkillIds, loadAnatomyInstructions, selectSkillIds } from "../../lib/skills/loader";

describe("Anatomy pack loading is domain-gated (no cross-pack leakage)", () => {
  it("anatomy selection never pulls 3D skills", async () => {
    const ids = await selectAnatomySkillIds(["craft", "mechanism"]);
    expect(ids).toContain("anatomy");
    expect(ids).toContain("anatomy/drawing-craft");
    expect(ids).toContain("anatomy/mechanism-explainers");
    expect(ids.filter(id => id.startsWith("3d"))).toEqual([]);
    expect(ids.indexOf("anatomy")).toBeLessThan(ids.indexOf("anatomy/drawing-craft"));
  });

  it("3D selection never pulls anatomy skills", async () => {
    const ids = await selectSkillIds(["scene", "geometry", "materials", "interaction", "assetGen", "export", "performance"]);
    expect(ids.filter(id => id.startsWith("anatomy"))).toEqual([]);
  });

  it("anatomy instruction block carries markers and the fence contract", async () => {
    const text = await loadAnatomyInstructions(["craft"]);
    expect(text).toContain("<!-- skill: anatomy -->");
    expect(text).toContain("<!-- skill: anatomy/drawing-craft -->");
    expect(text).not.toContain("<!-- skill: 3d -->");
    expect(text).toContain("```anatomy");
    expect(text).toContain("never claim an SVG is a mesh");
  });

  it("unrequested anatomy sub-skills stay unloaded", async () => {
    const ids = await selectAnatomySkillIds([]);
    expect(ids).toEqual(["anatomy"]);
  });
});
