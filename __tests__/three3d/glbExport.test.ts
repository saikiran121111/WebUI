import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { validateGlb, exportScene, reimportGlb } from "../../lib/three3d/exporters";
import { buildScene } from "../../lib/three3d/sceneBuilder";
import { scene3dSpecSchema } from "../../lib/three3d/sceneSchema";

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const rem = bytes.length % 4;
  if (!rem) return bytes;
  const out = new Uint8Array(bytes.length + (4 - rem));
  out.set(bytes);
  out.fill(fill, bytes.length);
  return out;
}

/** Hand-builds a spec-conformant GLB: 12-byte header + JSON chunk + optional BIN chunk. */
function makeGlb(json: unknown, bin: Uint8Array | null, opts: { magic?: string; version?: number; totalDelta?: number } = {}): ArrayBuffer {
  const jsonBytes = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binBytes = bin ? pad4(bin, 0x00) : null;
  const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode(opts.magic ?? "glTF"), 0);
  view.setUint32(4, opts.version ?? 2, true);
  view.setUint32(8, total + (opts.totalDelta ?? 0), true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);
  if (binBytes) {
    const off = 20 + jsonBytes.length;
    view.setUint32(off, binBytes.length, true);
    view.setUint32(off + 4, 0x004e4942, true); // "BIN\0"
    bytes.set(binBytes, off + 8);
  }
  return buf;
}

describe("validateGlb (GLB header/chunk parser)", () => {
  it("accepts a well-formed GLB and returns its JSON chunk + BIN size", () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const bytes = makeGlb({ asset: { version: "2.0" }, meshes: [{ name: "a" }] }, bin);
    const { json, binByteLength } = validateGlb(bytes);
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes).toHaveLength(1);
    expect(binByteLength).toBe(8);
  });

  it("accepts a GLB with no BIN chunk", () => {
    const { binByteLength } = validateGlb(makeGlb({ asset: { version: "2.0" } }, null));
    expect(binByteLength).toBe(0);
  });

  it("rejects bad magic, wrong version, length mismatch and missing JSON chunk", () => {
    expect(() => validateGlb(makeGlb({ asset: { version: "2.0" } }, null, { magic: "glTX" })))
      .toThrow(/missing glTF magic/);
    expect(() => validateGlb(makeGlb({ asset: { version: "1.0" } }, null, { version: 1 })))
      .toThrow(/unsupported glTF version 1/);
    expect(() => validateGlb(makeGlb({ asset: { version: "2.0" } }, null, { totalDelta: 4 })))
      .toThrow(/length header mismatch/);
    const noJson = makeGlb({ asset: { version: "2.0" } }, null);
    new DataView(noJson).setUint32(16, 0x004e4942, true); // flip JSON chunk type to BIN
    expect(() => validateGlb(noJson)).toThrow(/no JSON chunk/);
  });
});

describe("GLTFExporter round-trip (official three.js exporter)", () => {
  // The exporter's binary path uses FileReader.readAsArrayBuffer, which node
  // lacks; the browser (Playwright suite) has the real API. This shim only
  // bridges the platform gap — the exporter's own GLB framing is exercised.
  class NodeFileReader {
    result: unknown = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend?.(); });
    }
  }

  it("exports a built scene to GLB, validates it, and re-imports it with GLTFLoader", async () => {
    (globalThis as any).FileReader = NodeFileReader;
    const spec = scene3dSpecSchema.parse({
      title: "Round trip",
      objects: [
        { id: "bus", geometry: { kind: "lathe", points: [[0, -1], [0.6, -1], [0.6, 0.8], [0, 1]], segments: 16 }, material: { color: "#A78BFA" } },
        { id: "panel", geometry: { kind: "extrude", shape: [[-1, -1], [1, -1], [1, 1]], depth: 0.1 } },
      ],
      animations: [{ id: "spin", target: "bus", channel: "rotation", axis: "y", from: 0, to: 3.14, duration: 2 }],
    });
    const built = buildScene(THREE as any, spec);
    const blob = await exportScene(THREE as any, built.root, built.clips, "glb", "round-trip");
    const bytes = await blob.arrayBuffer();

    const { json, binByteLength } = validateGlb(bytes);
    expect(json.asset.version).toBe("2.0");
    expect(binByteLength).toBeGreaterThan(0);
    expect(json.meshes?.length).toBeGreaterThanOrEqual(2);

    const { meshes } = await reimportGlb(THREE as any, bytes);
    expect(meshes).toBeGreaterThanOrEqual(2);
  });
});
