import { describe, it, expect } from "vitest";
import { detectThreeIntent, extractUserText } from "../../lib/skills/intent";

describe("detectThreeIntent", () => {
  it("never fires on AI-model / language-model / endpoint phrases", () => {
    for (const text of [
      "tell me about the AI model",
      "which language model are you",
      "the model endpoint is down",
      "configure the model temperature",
      "deploy a model server",
      "model",
    ]) {
      expect(detectThreeIntent(text).wants3D, `should not trigger: "${text}"`).toBe(false);
    }
  });

  it("fires on explicit 3D tokens", () => {
    expect(detectThreeIntent("build a 3D model of the solar system").wants3D).toBe(true);
    expect(detectThreeIntent("make a scene3d fence").wants3D).toBe(true);
    expect(detectThreeIntent("export the mesh as GLB").wants3D).toBe(true);
    expect(detectThreeIntent("render this in three.js").wants3D).toBe(true);
  });

  it("fires on spatial subject phrases without the token 3d", () => {
    expect(detectThreeIntent("animate the solar system").wants3D).toBe(true);
    expect(detectThreeIntent("add pitch, roll and yaw controls").wants3D).toBe(true);
  });

  it("maps sub-intents to the right skills", () => {
    const r = detectThreeIntent("create a 3D scene with shiny metal materials and export it as GLB");
    expect(r.subIntents).toContain("scene");
    expect(r.subIntents).toContain("materials");
    expect(r.subIntents).toContain("export");

    const g = detectThreeIntent("generate a 3D model of a sneaker");
    expect(g.subIntents).toContain("assetGen");

    const p = detectThreeIntent("this 3D scene is slow on mobile, optimize it");
    expect(p.subIntents).toContain("performance");
  });

  it("returns no sub-intents when 3D is not requested", () => {
    expect(detectThreeIntent("write a haiku").subIntents).toEqual([]);
  });
});

describe("extractUserText", () => {
  it("passes strings through", () => {
    expect(extractUserText("hello")).toBe("hello");
  });
  it("joins text parts of multimodal content", () => {
    expect(extractUserText([
      { type: "text", text: "build" },
      { type: "image_url", image_url: { url: "x" } },
      { type: "text", text: "a 3D scene" },
    ])).toBe("build\na 3D scene");
  });
  it("returns empty string for anything else", () => {
    expect(extractUserText(null)).toBe("");
    expect(extractUserText(undefined)).toBe("");
    expect(extractUserText(42)).toBe("");
  });
});
