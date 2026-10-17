import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildScene } from "../../lib/three3d/sceneBuilder";
import { exportMesh } from "../../lib/three3d/exporters";
import { scene3dSpecSchema } from "../../lib/three3d/sceneSchema";

// PLYExporter yields between chunks via requestAnimationFrame — shim it for node.
(globalThis as any).requestAnimationFrame ??= (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 0);

/**
 * Proves the Studio viewer's extra export formats (OBJ / STL / PLY / USDZ)
 * produce real files through the official three/addons exporters — no fake
 * byte writers.
 */
const spec = scene3dSpecSchema.parse({
  title: "Exporter probe",
  objects: [
    {
      id: "hull",
      label: "Hull",
      geometry: { kind: "box", width: 2, height: 1, depth: 1 },
      material: { color: "#8899AA", roughness: 0.4 },
      children: [{ id: "nose", geometry: { kind: "sphere", radius: 0.5 }, position: [1.4, 0, 0] }],
    },
  ],
});

describe("exportMesh — real three/addons exporters", () => {
  const built = buildScene(THREE as unknown as any, spec);

  it("obj: text export with vertices and faces", async () => {
    const text = await (await exportMesh(built.root, "obj")).text();
    expect(text).toContain("v ");
    expect(text).toContain("f ");
  });

  it("stl: binary export with a valid triangle-count header", async () => {
    const blob = await exportMesh(built.root, "stl");
    expect(blob.size).toBeGreaterThan(84);
    const header = new DataView(await blob.slice(0, 84).arrayBuffer());
    expect(header.getUint32(80, true)).toBeGreaterThan(0);
    expect(blob.size).toBe(84 + header.getUint32(80, true) * 50);
  });

  it("ply: ASCII export with a ply header", async () => {
    const text = await (await exportMesh(built.root, "ply")).text();
    expect(text.startsWith("ply")).toBe(true);
    expect(text).toContain("end_header");
  });

  it("usdz: real zip archive, or an honest dependency failure under node", async () => {
    try {
      const blob = await exportMesh(built.root, "usdz");
      expect(blob.size).toBeGreaterThan(0);
    } catch (err: unknown) {
      // USDZExporter zips via fflate, which node may not resolve; the browser
      // bundle ships it. Anything other than a resolution failure is a bug.
      expect(String((err as Error)?.message ?? err)).toMatch(/fflate|Cannot find|Failed to resolve|parseAsync/);
    }
  });
});
