import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildScene, buildAnimationClips, computeStats, disposeObject3D } from "../../lib/three3d/sceneBuilder";
import { scene3dSpecSchema, type Scene3DSpec } from "../../lib/three3d/sceneSchema";

const spec: Scene3DSpec = scene3dSpecSchema.parse({
  title: "Builder probe",
  objects: [
    { id: "grid", geometry: { kind: "grid", size: 10, divisions: 10 } },
    {
      id: "bus", label: "Main bus",
      geometry: { kind: "lathe", points: [[0, -1], [0.6, -1], [0.6, 0.8], [0, 1]], segments: 24 },
      material: { color: "#A78BFA" },
      children: [
        { id: "nozzle", geometry: { kind: "cylinder", radiusTop: 0.2, radiusBottom: 0.5, height: 0.6 }, position: [0, -1.2, 0] },
        { id: "thruster", geometry: { kind: "arrow", length: 1, shaftRadius: 0.05, headRadius: 0.15, headLength: 0.4 }, material: { color: "#FB7185" } },
      ],
    },
  ],
  animations: [
    { id: "spin", target: "nozzle", channel: "rotation", axis: "y", from: 0, to: 3.14, duration: 2, loop: true, yoyo: true },
    { id: "bob", target: "bus", channel: "position", axis: "y", from: 0, to: 0.5, duration: 1 },
  ],
});

describe("buildScene (deterministic, data-only)", () => {
  const built = buildScene(THREE as any, spec);

  it("indexes every node by id, including nested children", () => {
    for (const id of ["grid", "bus", "nozzle", "thruster"]) {
      expect(built.nodesById.has(id), `missing node ${id}`).toBe(true);
    }
    expect(built.nodesById.get("nozzle")!.parent).toBe(built.nodesById.get("bus"));
  });

  it("names nodes with spec ids and stores labels for picking", () => {
    expect(built.nodesById.get("bus")!.name).toBe("bus");
    expect(built.nodesById.get("bus")!.userData.label).toBe("Main bus");
  });

  it("pickables are solid meshes only — grid helper excluded, arrow parts tagged", () => {
    for (const p of built.pickables) expect(p.isMesh).toBe(true);
    const ids = new Set(built.pickables.map(p => p.userData.nodeId));
    expect(ids.has("grid")).toBe(false);
    expect(ids.has("bus")).toBe(true);
    expect(ids.has("thruster")).toBe(true); // arrow group children carry the node id
  });

  it("produces real geometry with non-trivial triangle counts", () => {
    expect(built.stats.meshes).toBeGreaterThanOrEqual(4); // bus, nozzle, arrow shaft+head
    expect(built.stats.triangles).toBeGreaterThan(100);
    expect(computeStats(built.root).triangles).toBe(built.stats.triangles);
  });

  it("builds one clip per animation with id-targeted tracks; yoyo bakes 3 keyframes", () => {
    expect(built.clips).toHaveLength(2);
    const spin = THREE.AnimationClip.findByName(built.clips, "spin")!;
    expect(spin).toBeTruthy();
    expect(spin.tracks[0].name).toBe("nozzle.quaternion");
    expect(spin.tracks[0].times).toHaveLength(3); // yoyo: there and back
    const bob = THREE.AnimationClip.findByName(built.clips, "bob")!;
    expect(bob.tracks[0].name).toBe("bus.position");
    expect(bob.tracks[0].times).toHaveLength(2);
  });

  it("buildAnimationClips skips targets that do not exist (defensive)", () => {
    const ghost = { ...spec, animations: [{ id: "x", target: "ghost", channel: "rotation" as const, axis: "y" as const, from: 0, to: 1, duration: 1 }] };
    expect(buildAnimationClips(THREE as any, ghost as Scene3DSpec, built.nodesById)).toHaveLength(0);
  });

  it("disposeObject3D releases geometry and materials without throwing", () => {
    const fresh = buildScene(THREE as any, spec);
    expect(() => disposeObject3D(fresh.root)).not.toThrow();
    const bus = fresh.nodesById.get("bus")!;
    expect(bus.geometry.attributes.position).toBeTruthy(); // geometry object survives; GPU buffers released
  });
});
