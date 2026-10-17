import type { Scene3DNode, Scene3DSpec } from "./sceneSchema";
import { buildArrowGroup, buildGeometry, buildGridHelper } from "./geometryKit";
import { buildMaterial } from "./materials";

export interface SceneStats {
  meshes: number;
  vertices: number;
  triangles: number;
}

export interface BuiltScene {
  root: any; // THREE.Group
  nodesById: Map<string, any>;
  pickables: any[]; // raycast targets (solid meshes only)
  clips: any[]; // THREE.AnimationClip, one per spec animation
  stats: SceneStats;
}

/**
 * Deterministically turns a validated Scene3DSpec into a three.js node tree.
 * The model never supplies code — only this data — so the render is safe and
 * reproducible. Node names carry the spec ids, which makes animation tracks
 * and glTF export names resolve by id.
 */
export function buildScene(three: any, spec: Scene3DSpec): BuiltScene {
  const root = new three.Group();
  root.name = spec.title ?? "scene3d";
  const nodesById = new Map<string, any>();
  const pickables: any[] = [];

  const buildNode = (node: Scene3DNode, parent: any): void => {
    let object: any;

    if (!node.geometry || node.geometry.kind === "group") {
      // Container node: children only, never a raycast target.
      object = new three.Group();
    } else if (node.geometry.kind === "grid") {
      object = buildGridHelper(three, node.geometry);
    } else if (node.geometry.kind === "arrow") {
      object = buildArrowGroup(three, node.geometry);
      const mat = buildMaterial(three, node.material);
      object.traverse((child: any) => {
        if (child.isMesh) {
          child.material = mat;
          child.userData.nodeId = node.id;
          pickables.push(child);
        }
      });
    } else {
      const geometry = buildGeometry(three, node.geometry);
      object = new three.Mesh(geometry, buildMaterial(three, node.material));
      object.userData.nodeId = node.id;
      pickables.push(object);
    }

    object.name = node.id;
    object.userData.label = node.label ?? node.id;
    if (node.position) object.position.set(...node.position);
    if (node.rotation) object.rotation.set(...node.rotation);
    if (node.scale) object.scale.set(...node.scale);
    if (node.visible === false) object.visible = false;

    parent.add(object);
    nodesById.set(node.id, object);
    node.children?.forEach(child => buildNode(child, object));
  };

  spec.objects.forEach(node => buildNode(node, root));

  const clips = buildAnimationClips(three, spec, nodesById);
  return { root, nodesById, pickables, clips, stats: computeStats(root) };
}

/**
 * Bakes spec animations into one-shot AnimationClips. Rotation tracks use
 * quaternions about the declared axis; position/scale tracks vary only the
 * declared axis around the node's authored base value. yoyo is baked into
 * the clip (there and back), so loop playback is a plain repeat.
 */
export function buildAnimationClips(three: any, spec: Scene3DSpec, nodesById: Map<string, any>): any[] {
  const clips: any[] = [];
  for (const a of spec.animations ?? []) {
    const target = nodesById.get(a.target);
    if (!target) continue;

    if (a.channel === "rotation") {
      const axis = new three.Vector3(a.axis === "x" ? 1 : 0, a.axis === "y" ? 1 : 0, a.axis === "z" ? 1 : 0);
      const q0 = new three.Quaternion().setFromAxisAngle(axis, a.from);
      const q1 = new three.Quaternion().setFromAxisAngle(axis, a.to);
      const times = [0, a.duration];
      const values = [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w];
      if (a.yoyo) {
        times.push(a.duration * 2);
        values.push(q0.x, q0.y, q0.z, q0.w);
      }
      const track = new three.QuaternionKeyframeTrack(`${a.target}.quaternion`, times, values);
      clips.push(new three.AnimationClip(a.id, times[times.length - 1], [track]));
    } else {
      const base = a.channel === "position" ? target.position : target.scale;
      const baseVec = [base.x, base.y, base.z];
      const axisIdx = a.axis === "x" ? 0 : a.axis === "y" ? 1 : 2;
      const at = (v: number) => {
        const out = [...baseVec];
        out[axisIdx] = v;
        return out;
      };
      const times = [0, a.duration];
      const values = [...at(a.from), ...at(a.to)];
      if (a.yoyo) {
        times.push(a.duration * 2);
        values.push(...at(a.from));
      }
      const prop = a.channel === "position" ? "position" : "scale";
      const track = new three.VectorKeyframeTrack(`${a.target}.${prop}`, times, values);
      clips.push(new three.AnimationClip(a.id, times[times.length - 1], [track]));
    }
  }
  return clips;
}

export function computeStats(root: any): SceneStats {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((obj: any) => {
    if (!obj.isMesh || !obj.geometry) return;
    meshes += 1;
    const pos = obj.geometry.getAttribute?.("position");
    if (!pos) return;
    vertices += pos.count;
    triangles += (obj.geometry.index ? obj.geometry.index.count : pos.count) / 3;
  });
  return { meshes, vertices, triangles: Math.round(triangles) };
}

/** Releases GPU resources for a subtree (geometry, materials, any maps). */
export function disposeObject3D(root: any): void {
  root.traverse((obj: any) => {
    obj.geometry?.dispose?.();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) {
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
        mat[key]?.dispose?.();
      }
      mat.dispose?.();
    }
  });
}
