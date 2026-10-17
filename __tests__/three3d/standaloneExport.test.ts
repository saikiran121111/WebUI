import { describe, it, expect } from "vitest";
import { buildStandaloneHtml, buildR3fComponent } from "../../lib/three3d/standaloneExport";
import { scene3dSpecSchema } from "../../lib/three3d/sceneSchema";

/**
 * The standalone export targets are pure string generators — verified here
 * in node, no browser needed.
 */
const spec = scene3dSpecSchema.parse({
  title: "Deep-space probe",
  objects: [
    { id: "bus", label: "Main bus", geometry: { kind: "lathe", points: [[0, 0], [1, 0.5], [0, 1]] } },
    { id: "wing", geometry: { kind: "extrude", shape: [[0, 0], [2, 0], [2, 0.2], [0, 0.2]], depth: 0.1 }, position: [-1.5, 0, 0] },
    { id: "pipe", geometry: { kind: "tube", path: [[0, 0, 0], [1, 1, 0], [2, 1, 1]], radius: 0.05 } },
    { id: "deck", geometry: { kind: "grid", size: 4, divisions: 4 } },
  ],
  animations: [{ id: "spin", target: "bus", channel: "rotation", axis: "y", from: 0, to: 6.28, duration: 8, loop: true }],
});

describe("buildStandaloneHtml", () => {
  const html = buildStandaloneHtml(spec);

  it("is a complete page with a three@0.186.0 CDN importmap", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('type="importmap"');
    expect(html).toContain("three@0.186.0/build/three.module.js");
    expect(html).toContain("OrbitControls");
    expect(html).toContain("</html>");
  });

  it("embeds the full scene spec", () => {
    expect(html).toContain(JSON.stringify(spec));
    expect(html).toContain('"Deep-space probe"');
  });

  it("has exactly two script blocks (no premature </script> inside the builder)", () => {
    expect(html.split("</script>").length - 1).toBe(2);
  });
});

describe("buildR3fComponent", () => {
  const tsx = buildR3fComponent(spec);

  it("exports a PascalCase component named after the title", () => {
    expect(tsx).toContain("export default function DeepSpaceProbe()");
    expect(tsx).toContain('import * as THREE from "three";');
  });

  it("emits real R3F JSX with named parts and per-kind geometry constants", () => {
    expect(tsx).toContain("<mesh");
    expect(tsx).toContain("<meshStandardMaterial");
    expect(tsx).toContain('name="bus"');
    expect(tsx).toContain("POINTS_bus");
    expect(tsx).toContain("SHAPE_wing");
    expect(tsx).toContain("EXTRUDE_wing");
    expect(tsx).toContain("CURVE_pipe");
    expect(tsx).toContain("<gridHelper");
  });

  it("documents animation clips for the consumer", () => {
    expect(tsx).toContain('clip "spin"');
  });
});
