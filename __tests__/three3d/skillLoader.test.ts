import { describe, it, expect } from "vitest";
import { selectSkillIds, loadSkillInstructions, loadAnatomyInstructions, getSkillCatalog } from "../../lib/skills/loader";

describe("WebUI skill registry (skills/ directory, not Claude Code)", () => {
  it("manifest lists the 3D pack plus the anatomy pack", async () => {
    const catalog = await getSkillCatalog();
    expect(catalog).toHaveLength(11);
    const ids = catalog.map(s => s.id);
    expect(ids).toContain("3d");
    for (const id of ["3d/scene-design", "3d/geometry-and-topology", "3d/materials-and-lighting",
      "3d/interaction-and-animation", "3d/asset-generation", "3d/export-and-interoperability",
      "3d/performance-and-quality-assurance"]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
    for (const id of ["anatomy", "anatomy/drawing-craft", "anatomy/mechanism-explainers"]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it("domain skill always loads; intent skills only when requested", async () => {
    expect(await selectSkillIds([])).toEqual(["3d"]);

    const withExport = await selectSkillIds(["export"]);
    expect(withExport).toContain("3d");
    expect(withExport).toContain("3d/export-and-interoperability");
    expect(withExport).not.toContain("3d/geometry-and-topology");
    // Dependency closure: the domain skill is emitted before its dependents.
    expect(withExport.indexOf("3d")).toBeLessThan(withExport.indexOf("3d/export-and-interoperability"));
  });

  it("instruction blocks carry skill markers and real content", async () => {
    const text = await loadSkillInstructions(["materials", "export"]);
    expect(text).toContain("<!-- skill: 3d -->");
    expect(text).toContain("<!-- skill: 3d/materials-and-lighting -->");
    expect(text).toContain("<!-- skill: 3d/export-and-interoperability -->");
    expect(text.length).toBeGreaterThan(500);
  });

  it("every manifest skill file loads (no dead references)", async () => {
    const catalog = await getSkillCatalog();
    const all3d = await loadSkillInstructions(
      ["scene", "geometry", "materials", "interaction", "assetGen", "export", "performance"],
    );
    for (const meta of catalog.filter(s => (s.domain ?? "3d") === "3d")) {
      expect(all3d, `skill body missing: ${meta.id}`).toContain(`<!-- skill: ${meta.id} -->`);
    }
    const allAnatomy = await loadAnatomyInstructions(["craft", "mechanism"]);
    for (const meta of catalog.filter(s => s.domain === "anatomy")) {
      expect(allAnatomy, `skill body missing: ${meta.id}`).toContain(`<!-- skill: ${meta.id} -->`);
    }
  });
});
