import type { Scene3DGeometry } from "./sceneSchema";

/**
 * Translates a validated geometry spec into real three.js BufferGeometry.
 * `three` is the lazily-imported three module namespace, so this module never
 * pulls three into the initial bundle.
 *
 * Returns null for composite kinds (grid, arrow) — the scene builder handles
 * those via buildGridHelper / buildArrowGroup below.
 */
export function buildGeometry(three: any, spec: Scene3DGeometry): any | null {
  switch (spec.kind) {
    case "box":
      return new three.BoxGeometry(spec.width, spec.height, spec.depth);
    case "sphere":
      return new three.SphereGeometry(spec.radius, spec.widthSegments ?? 24, spec.heightSegments ?? 16);
    case "cylinder":
      return new three.CylinderGeometry(
        spec.radiusTop, spec.radiusBottom, spec.height,
        spec.radialSegments ?? 24, 1, spec.openEnded ?? false,
      );
    case "cone":
      return new three.ConeGeometry(spec.radius, spec.height, spec.radialSegments ?? 24);
    case "torus":
      return new three.TorusGeometry(spec.radius, spec.tube, spec.radialSegments ?? 16, spec.tubularSegments ?? 32);
    case "capsule":
      return new three.CapsuleGeometry(spec.radius, spec.length, spec.capSegments ?? 8, spec.radialSegments ?? 16);
    case "lathe":
      return new three.LatheGeometry(
        spec.points.map(([x, y]) => new three.Vector2(x, y)),
        spec.segments ?? 24,
      );
    case "extrude": {
      const shape = new three.Shape();
      spec.shape.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
      shape.closePath();
      const geo = new three.ExtrudeGeometry(shape, {
        depth: spec.depth,
        bevelEnabled: spec.bevelEnabled ?? true,
        bevelSize: spec.bevelSize ?? 0.04,
        bevelThickness: spec.bevelThickness ?? 0.04,
        bevelSegments: spec.bevelSegments ?? 2,
        curveSegments: 8,
      });
      geo.translate(0, 0, -spec.depth / 2); // pivot at mid-depth
      return geo;
    }
    case "tube": {
      const curve = new three.CatmullRomCurve3(
        spec.path.map(([x, y, z]) => new three.Vector3(x, y, z)),
        spec.closed ?? false, "catmullrom", 0.5,
      );
      return new three.TubeGeometry(curve, spec.tubularSegments ?? 24, spec.radius, spec.radialSegments ?? 8, spec.closed ?? false);
    }
    case "plane":
      return new three.PlaneGeometry(spec.width, spec.height);
    default:
      return null; // grid | arrow are composites
  }
}

export function buildGridHelper(three: any, spec: { size: number; divisions: number }): any {
  return new three.GridHelper(spec.size, spec.divisions, 0x4A5568, 0x2A3140);
}

/** Directional indicator: shaft cylinder + head cone, pointing +Y from origin. */
export function buildArrowGroup(three: any, spec: { length: number; shaftRadius: number; headRadius: number; headLength: number }): any {
  const headLen = Math.min(spec.headLength, spec.length * 0.5);
  const shaftLen = spec.length - headLen;
  const group = new three.Group();

  const shaft = new three.Mesh(new three.CylinderGeometry(spec.shaftRadius, spec.shaftRadius, shaftLen, 16));
  shaft.position.y = shaftLen / 2;
  const head = new three.Mesh(new three.ConeGeometry(spec.headRadius, headLen, 16));
  head.position.y = shaftLen + headLen / 2;
  group.add(shaft, head);
  return group;
}
