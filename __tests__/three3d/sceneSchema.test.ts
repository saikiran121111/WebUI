import { describe, it, expect } from "vitest";
import { scene3dSpecSchema, asset3dSpecSchema } from "../../lib/three3d/sceneSchema";
import { DEMO_SHOWCASE_MARKDOWN } from "../../lib/render/demoShowcase";

const validScene = {
  title: "Probe",
  objects: [
    {
      id: "bus", label: "Bus",
      geometry: { kind: "lathe", points: [[0, -1], [0.6, -1], [0.6, 0.8], [0, 1]], segments: 24 },
      material: { color: "#A78BFA", metalness: 0.5, roughness: 0.35 },
      children: [
        { id: "nozzle", geometry: { kind: "cylinder", radiusTop: 0.2, radiusBottom: 0.5, height: 0.6 }, position: [0, -1.2, 0] },
      ],
    },
  ],
  labels: [{ target: "bus", text: "Main bus" }],
  animations: [{ id: "spin", target: "nozzle", channel: "rotation", axis: "y", from: 0, to: 6.28, duration: 4, loop: true }],
  sliders: [{ id: "pitch", label: "Pitch", min: -1, max: 1, step: 0.01, defaultValue: 0, target: "bus", binding: "rotation", axis: "x" }],
  export: { filename: "probe" },
};

describe("scene3dSpecSchema (v2 contract)", () => {
  it("accepts a rich scene with lathe/cylinder, labels, animation, slider, export", () => {
    const parsed = scene3dSpecSchema.safeParse(validScene);
    expect(parsed.success).toBe(true);
  });

  it("accepts extrude and tube geometry", () => {
    const parsed = scene3dSpecSchema.safeParse({
      objects: [
        { id: "panel", geometry: { kind: "extrude", shape: [[-1, -1], [1, -1], [1, 1], [-1, 1]], depth: 0.1 } },
        { id: "boom", geometry: { kind: "tube", path: [[0, 0, 0], [1, 1, 1]], radius: 0.05 } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys (strict geometry)", () => {
    const parsed = scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "box", width: 1, height: 1, depth: 1, radius: 5 } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    const parsed = scene3dSpecSchema.safeParse({
      objects: [
        { id: "dup", geometry: { kind: "box", width: 1, height: 1, depth: 1 } },
        { id: "dup", geometry: { kind: "sphere", radius: 1 } },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects labels, animations and sliders that target missing nodes", () => {
    const base = { objects: [{ id: "a", geometry: { kind: "box", width: 1, height: 1, depth: 1 } }] };
    expect(scene3dSpecSchema.safeParse({ ...base, labels: [{ target: "ghost", text: "x" }] }).success).toBe(false);
    expect(scene3dSpecSchema.safeParse({
      ...base,
      animations: [{ id: "s", target: "ghost", channel: "rotation", axis: "y", from: 0, to: 1, duration: 2 }],
    }).success).toBe(false);
    expect(scene3dSpecSchema.safeParse({
      ...base,
      sliders: [{ id: "p", label: "P", min: -1, max: 1, step: 0.1, defaultValue: 0, target: "ghost", binding: "rotation", axis: "x" }],
    }).success).toBe(false);
  });

  it("enforces the node budget", () => {
    const objects = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      geometry: { kind: "box" as const, width: 1, height: 1, depth: 1 },
      children: Array.from({ length: 3 }, (_, k) => ({
        id: `n${i}c${k}`, geometry: { kind: "box" as const, width: 1, height: 1, depth: 1 },
      })),
    })); // 160 nodes > 120 budget
    expect(scene3dSpecSchema.safeParse({ objects }).success).toBe(false);
  });

  it("rejects bad colors, zero scale and non-finite numbers", () => {
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "box", width: 1, height: 1, depth: 1 }, material: { color: "#gg0000" } }],
    }).success).toBe(false);
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "box", width: 1, height: 1, depth: 1 }, scale: [0, 1, 1] }],
    }).success).toBe(false);
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "box", width: Number.NaN, height: 1, depth: 1 } }],
    }).success).toBe(false);
  });

  it("rejects degenerate lathe/extrude/tube inputs", () => {
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "lathe", points: [[-0.5, 0], [0.5, 1]] } }],
    }).success).toBe(false); // negative radius profile
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "extrude", shape: [[0, 0], [1, 1]], depth: 1 } }],
    }).success).toBe(false); // fewer than 3 shape points
    expect(scene3dSpecSchema.safeParse({
      objects: [{ id: "a", geometry: { kind: "tube", path: [[0, 0, 0]], radius: 0.1 } }],
    }).success).toBe(false); // fewer than 2 path points
  });

  it("the demo showcase scene3d fence parses against the live schema", () => {
    const fence = /```scene3d\n([\s\S]*?)\n```/.exec(DEMO_SHOWCASE_MARKDOWN);
    expect(fence, "demo showcase must contain a scene3d fence").not.toBeNull();
    const parsed = scene3dSpecSchema.safeParse(JSON.parse(fence![1]));
    expect(parsed.success, JSON.stringify((parsed as any).error?.issues ?? [])).toBe(true);
  });
});

describe("asset3dSpecSchema", () => {
  it("accepts a provider generation request", () => {
    const parsed = asset3dSpecSchema.safeParse({
      title: "Retro rocket", prompt: "a stylized retro rocket", formats: ["glb", "obj"], quality: "standard",
    });
    expect(parsed.success).toBe(true);
  });
  it("rejects empty prompts and unknown formats", () => {
    expect(asset3dSpecSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(asset3dSpecSchema.safeParse({ prompt: "x", formats: ["xyz"] }).success).toBe(false);
  });
});
