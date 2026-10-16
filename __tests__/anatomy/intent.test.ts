import { describe, it, expect } from "vitest";
import { detectAnatomyIntent } from "../../lib/skills/anatomyIntent";
import { detectThreeIntent } from "../../lib/skills/intent";

describe("Anatomy routing intent (modes A-D)", () => {
  it("A: isometric exploded machine request activates Anatomy", () => {
    const r = detectAnatomyIntent("Draw an isometric exploded view of a four-stroke engine with interactive moving parts");
    expect(r.wantsAnatomy).toBe(true);
    expect(r.subIntents).toContain("craft");
    expect(r.subIntents).toContain("mechanism");
  });

  it("A: how-it-works instrument explainer activates Anatomy", () => {
    const r = detectAnatomyIntent("how does a dial indicator work? make me an interactive explainer");
    expect(r.wantsAnatomy).toBe(true);
  });

  it("B: spatial 3D scene request stays on the scene3d path, not Anatomy", () => {
    const text = "Build a 3D solar system scene with orbit controls";
    expect(detectAnatomyIntent(text).wantsAnatomy).toBe(false);
    expect(detectThreeIntent(text).wants3D).toBe(true);
  });

  it("C: genuine mesh/file request routes to the 3D pack, never Anatomy", () => {
    const r = detectAnatomyIntent("Generate a downloadable GLB sneaker model");
    expect(r.wantsMesh).toBe(true);
    expect(r.wantsAnatomy).toBe(false);

    const printed = detectAnatomyIntent("I want a 3D printed engine model as an STL file");
    expect(printed.wantsMesh).toBe(true);
    expect(printed.wantsAnatomy).toBe(false);
  });

  it("D: architecture/C4/schema/chart/wireframe requests get neither pack", () => {
    for (const text of [
      "Create a C4 architecture diagram of our microservices",
      "Draw a bar chart of quarterly revenue",
      "Design a database schema diagram for an ERP",
      "Wireframe the settings page of the app",
    ]) {
      const anatomy = detectAnatomyIntent(text);
      expect(anatomy.wantsAnatomy, text).toBe(false);
      expect(anatomy.wantsMesh, text).toBe(false);
    }
  });

  it("explicit 'Anatomy skill' invocation overrides the mode-D subject exclusion", () => {
    const r = detectAnatomyIntent(
      "Use the **Anatomy skill** for this request: an isometric cutaway of a vertical city building.",
    );
    expect(r.wantsAnatomy).toBe(true);
    expect(r.wantsMesh).toBe(false);
  });

  it("explicit invocation survives 'not a genuine 3D mesh' disclaimer wording", () => {
    const r = detectAnatomyIntent(
      "Use the Anatomy skill for this building cutaway. An SVG illustration is not a genuine downloadable 3D mesh.",
    );
    expect(r.wantsAnatomy).toBe(true);
    expect(r.wantsMesh).toBe(false);
  });

  it("a named mesh format still wins over an explicit Anatomy invocation", () => {
    const r = detectAnatomyIntent("Use the Anatomy skill, but export a GLB of the engine as well.");
    expect(r.wantsMesh).toBe(true);
    expect(r.wantsAnatomy).toBe(false);
  });

  it("bare 'model' and empty input never trigger Anatomy", () => {
    expect(detectAnatomyIntent("What is the best model of car?").wantsAnatomy).toBe(false);
    expect(detectAnatomyIntent("").wantsAnatomy).toBe(false);
  });
});
