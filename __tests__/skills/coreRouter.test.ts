import { describe, expect, it } from "vitest";
import { applyCoreSkillRouting, selectCoreSkills } from "../../lib/skills/coreRouter";
import type { SkillScenario } from "../../lib/skills/types";

function scenario(skillName: string, triggerKeywords: string[]): SkillScenario {
  return {
    skillName,
    sourceRepo: "test/repo",
    enabled: true,
    autoUse: true,
    whenToUse: "test scenario for " + skillName,
    triggerKeywords,
    blockedReason: null,
  };
}

const SCENARIOS: SkillScenario[] = [
  scenario("threejs-fundamentals", ["3d", "three.js", "webgl", "3d model"]),
  scenario("threejs-geometry", ["geometry", "low-poly", "procedural model"]),
  scenario("threejs-materials", ["material", "pbr", "chrome"]),
  scenario("threejs-lighting", ["lighting", "shadow", "hdr"]),
  scenario("threejs-animation", ["animation", "orbit", "rotating", "floating"]),
  scenario("threejs-shaders", ["shader", "glow", "arc reactor", "hologram", "aura"]),
  scenario("threejs-postprocessing", ["bloom", "postprocessing", "glow", "neon"]),
  scenario("threejs-interaction", ["clickable", "hover", "raycast"]),
  scenario("threejs-blender-glb-pipeline", ["blender", "image to 3d", "reconstruct from image"]),
  scenario("threejs-skills", ["3d", "three.js", "webgl"]),
  scenario("r3f-fundamentals", ["react three fiber", "r3f", "drei"]),
  scenario("r3f-animation", ["r3f animation", "useframe"]),
  scenario("archify", ["floor plan", "3bhk", "autocad", "blueprint", "villa"]),
  scenario("anatomy", ["anatomy of", "exploded isometric", "cutaway", "reactor"]),
  scenario("architecture-diagram", ["system architecture", "microservices", "network topology"]),
  scenario("diagram-design", ["schematic", "wiring diagram"]),
];

const ALL_INSTALLED = new Set(SCENARIOS.map((s) => s.skillName));

describe("selectCoreSkills (pure sub-skill selection)", () => {
  it("fires the three.js base bundle on a plain 3D request, nothing else", () => {
    const sel = selectCoreSkills("make me a 3d model of a shoe", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.categories).toEqual(["3d"]);
    expect(sel.skillNames).toEqual(["threejs-fundamentals", "threejs-geometry", "threejs-materials", "threejs-lighting"]);
  });

  it("adds shaders + postprocessing for glow / arc reactor cues", () => {
    const sel = selectCoreSkills("iron man helmet with a glowing arc reactor", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.skillNames).toContain("threejs-shaders");
    expect(sel.skillNames).toContain("threejs-postprocessing");
    expect(sel.skillNames).not.toContain("threejs-interaction");
  });

  it("adds animation for orbital motion", () => {
    const sel = selectCoreSkills("saturn orbiting the sun in 3d", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.skillNames).toContain("threejs-animation");
  });

  it("fires the blender pipeline when an image is attached (image-to-3D)", () => {
    const sel = selectCoreSkills("turn this into a 3d model", true, SCENARIOS, ALL_INSTALLED);
    expect(sel.skillNames).toContain("threejs-blender-glb-pipeline");
  });

  it("uses the umbrella fallback when the base four are not all installed", () => {
    const partial = new Set(["threejs-skills", "threejs-fundamentals"]);
    const sel = selectCoreSkills("a webgl 3d scene", false, SCENARIOS, partial);
    expect(sel.skillNames).toEqual(["threejs-skills"]);
  });

  it("swaps to the R3F bundle for react three fiber requests", () => {
    const sel = selectCoreSkills("build this 3d robot with react three fiber and useframe motion", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.skillNames).toContain("r3f-fundamentals");
    expect(sel.skillNames).toContain("r3f-animation");
  });

  it("routes floor plans to archify and cutaways to anatomy", () => {
    expect(selectCoreSkills("design a 3bhk floor plan", false, SCENARIOS, ALL_INSTALLED).skillNames).toEqual(["archify"]);
    const cutaway = selectCoreSkills("exploded isometric anatomy of a fusion reactor", false, SCENARIOS, ALL_INSTALLED);
    expect(cutaway.categories).toContain("architecture");
    expect(cutaway.skillNames).toContain("anatomy");
  });

  it("routes system architecture to architecture-diagram, not to 3D", () => {
    const sel = selectCoreSkills("draw the system architecture of my microservices", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.categories).toEqual(["architecture"]);
    expect(sel.skillNames).toEqual(["architecture-diagram"]);
  });

  it("fires nothing for a plain chat message", () => {
    const sel = selectCoreSkills("hello, explain recursion", false, SCENARIOS, ALL_INSTALLED);
    expect(sel.skillNames).toEqual([]);
    expect(sel.categories).toEqual([]);
  });
});

describe("applyCoreSkillRouting (real ./.cskills tier, lazy injection)", () => {
  it("injects matched core skill bundles + the 3D output contract as one system block", async () => {
    const payload = {
      messages: [
        { role: "system", content: "visual router prompt" },
        { role: "user", content: "create a 3d saturn with rings orbiting in space" },
      ],
    };
    const result = await applyCoreSkillRouting(payload);
    expect(result.usedSkills).toContain("threejs-fundamentals");
    expect(result.usedSkills).toContain("threejs-animation");
    const injected = payload.messages[1];
    expect(injected.role).toBe("system");
    expect(injected.content).toContain("<core_skill_routing");
    expect(injected.content).toContain('<core_skill name="threejs-fundamentals">');
    expect(injected.content).toContain("<output_contract_3d>");
    expect(injected.content.length).toBeLessThan(60_000);
  });

  it("injects the architecture contract for floor plan requests", async () => {
    const payload = { messages: [{ role: "user", content: "2bhk floor plan with room dimensions" }] };
    const result = await applyCoreSkillRouting(payload);
    expect(result.usedSkills).toContain("archify");
    expect(payload.messages[0].content).toContain("<output_contract_architecture>");
    expect(payload.messages[0].content).toContain("layer-structural");
  });

  it("costs zero tokens when nothing matches", async () => {
    const payload = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "what is 2+2?" }] };
    const result = await applyCoreSkillRouting(payload);
    expect(result.usedSkills).toEqual([]);
    expect(payload.messages.length).toBe(2);
  });

  it("never routes a user-tier skill through the core engine", async () => {
    const payload = { messages: [{ role: "user", content: "3d robot action figure" }] };
    const result = await applyCoreSkillRouting(payload);
    expect(result.usedSkills.length).toBeGreaterThan(0);
    for (const name of result.usedSkills) {
      expect(name).not.toBe("humanizer");
    }
  });
});
