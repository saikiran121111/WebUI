/**
 * Standalone export targets for the Studio Viewer: a self-contained .html
 * page (embedded scene JSON + a compact three.js builder, three loaded from
 * CDN) and a React Three Fiber .tsx component generated straight from the
 * scene3d spec. Both are pure string generators — unit-testable in node.
 */
import type { Scene3DSpec, Scene3DNode } from "./sceneSchema";

function pascal(text: string): string {
  const words = text.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/);
  const name = words.map(w => w[0].toUpperCase() + w.slice(1)).join("");
  return name || "SceneModel";
}

/* ── standalone .html ─────────────────────────────────────────────────── */

const HTML_BUILDER_JS = [
  'import * as THREE from "three";',
  'import { OrbitControls } from "three/addons/controls/OrbitControls.js";',
  "const SPEC = ",
].join("\n");

const HTML_BUILDER_TAIL = `;

function buildGeometry(g) {
  switch (g.kind) {
    case "box": return new THREE.BoxGeometry(g.width, g.height, g.depth);
    case "sphere": return new THREE.SphereGeometry(g.radius, g.widthSegments ?? 24, g.heightSegments ?? 16);
    case "cylinder": return new THREE.CylinderGeometry(g.radiusTop, g.radiusBottom, g.height, g.radialSegments ?? 24, 1, g.openEnded ?? false);
    case "cone": return new THREE.ConeGeometry(g.radius, g.height, g.radialSegments ?? 24);
    case "torus": return new THREE.TorusGeometry(g.radius, g.tube, g.radialSegments ?? 16, g.tubularSegments ?? 32);
    case "capsule": return new THREE.CapsuleGeometry(g.radius, g.length, g.capSegments ?? 8, g.radialSegments ?? 16);
    case "lathe": return new THREE.LatheGeometry(g.points.map(p => new THREE.Vector2(p[0], p[1])), g.segments ?? 24);
    case "extrude": {
      const s = new THREE.Shape();
      s.moveTo(g.shape[0][0], g.shape[0][1]);
      for (let i = 1; i < g.shape.length; i++) s.lineTo(g.shape[i][0], g.shape[i][1]);
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, {
        depth: g.depth,
        bevelEnabled: g.bevelEnabled ?? true,
        bevelSize: g.bevelSize ?? 0.04,
        bevelThickness: g.bevelThickness ?? 0.04,
        bevelSegments: g.bevelSegments ?? 2,
        curveSegments: 8,
      });
      geo.translate(0, 0, -g.depth / 2);
      return geo;
    }
    case "tube": {
      const curve = new THREE.CatmullRomCurve3(g.path.map(p => new THREE.Vector3(p[0], p[1], p[2])), g.closed ?? false, "catmullrom", 0.5);
      return new THREE.TubeGeometry(curve, g.tubularSegments ?? 24, g.radius, g.radialSegments ?? 8, g.closed ?? false);
    }
    case "plane": return new THREE.PlaneGeometry(g.width, g.height);
    default: return null;
  }
}

function buildMaterial(m) {
  const mat = new THREE.MeshStandardMaterial({ color: (m && m.color) || "#8B95A5", roughness: m?.roughness ?? 0.55, metalness: m?.metalness ?? 0.25 });
  if (m?.emissive) { mat.emissive = new THREE.Color(m.emissive); mat.emissiveIntensity = m.emissiveIntensity ?? 1; }
  if (m?.flatShading) mat.flatShading = true;
  if (typeof m?.opacity === "number" && m.opacity < 1) { mat.transparent = true; mat.opacity = m.opacity ?? true; }
  if (m?.side === "double") mat.side = THREE.DoubleSide;
  else if (m?.side === "back") mat.side = THREE.BackSide;
  return mat;
}

function buildNode(n) {
  if (n.geometry.kind === "grid") {
    return new THREE.GridHelper(n.geometry.size, n.geometry.divisions, 0x4a5568, 0x2a3140);
  }
  if (n.geometry.kind === "arrow") {
    const g = new THREE.Group();
    const a = n.geometry;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(a.shaftRadius, a.shaftRadius, a.length - a.headLength, 12), buildMaterial(n.material));
    shaft.position.y = (a.length - a.headLength) / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(a.headRadius, a.headLength, 16), buildMaterial(n.material));
    head.position.y = a.length - a.headLength / 2;
    g.add(shaft, head);
    applyTransform(g, n);
    return g;
  }
  const mesh = new THREE.Mesh(buildGeometry(n.geometry), buildMaterial(n.material));
  mesh.name = n.id;
  applyTransform(mesh, n);
  for (const c of n.children ?? []) mesh.add(buildNode(c));
  return mesh;
}

function applyTransform(o, n) {
  if (n.position) o.position.fromArray(n.position);
  if (n.rotation) o.rotation.fromArray(n.rotation);
  if (n.scale) o.scale.fromArray(n.scale);
  if (n.visible === false) o.visible = false;
}

function buildClips(nodesById) {
  const clips = [];
  for (const a of SPEC.animations ?? []) {
    const node = nodesById.get(a.target);
    if (!node) continue;
    const times = [0, a.duration];
    const yoyo = a.yoyo ?? false;
    if (yoyo) times.push(a.duration * 2);
    if (a.channel === "rotation") {
      const axis = new THREE.Vector3(a.axis === "x" ? 1 : 0, a.axis === "y" ? 1 : 0, a.axis === "z" ? 1 : 0);
      const q0 = new THREE.Quaternion().setFromAxisAngle(axis, a.from);
      const q1 = new THREE.Quaternion().setFromAxisAngle(axis, a.to);
      const values = [...q0.toArray(), ...q1.toArray()];
      if (yoyo) values.push(...q0.toArray());
      clips.push(new THREE.AnimationClip(a.id, a.duration * (yoyo ? 2 : 1),
        [new THREE.QuaternionKeyframeTrack(a.target + ".quaternion", times, values)]));
    } else {
      const base = a.channel === "position" ? node.position.toArray() : node.scale.toArray();
      const idx = a.axis === "x" ? 0 : a.axis === "y" ? 1 : 2;
      const mid = base.slice(); mid[idx] = a.to;
      const values = [...base, ...mid];
      if (yoyo) values.push(...base);
      const prop = a.channel === "position" ? "position" : "scale";
      clips.push(new THREE.AnimationClip(a.id, a.duration * (yoyo ? 2 : 1),
        [new THREE.VectorKeyframeTrack(a.target + "." + prop, times, values)]));
    }
  }
  return clips;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0B0E14");
const camera = new THREE.PerspectiveCamera(SPEC.camera?.fov ?? 45, window.innerWidth / window.innerHeight, 0.01, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const ambient = new THREE.AmbientLight(0xffffff, SPEC.lighting?.ambientIntensity ?? 0.45);
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(5, 8, 6);
const fill = new THREE.DirectionalLight(0xbfd4ff, 0.8); fill.position.set(-6, 4, -3);
const rim = new THREE.DirectionalLight(0xffffff, 1.4); rim.position.set(0, 6, -9);
scene.add(ambient, key, fill, rim);
scene.add(new THREE.GridHelper(10, 10, 0x4a5568, 0x2a3140));

const root = new THREE.Group();
const nodesById = new Map();
(function index(nodes) {
  for (const n of nodes) { nodesById.set(n.id, null); index(n.children ?? []); }
})(SPEC.objects ?? []);
for (const n of SPEC.objects ?? []) {
  const obj = buildNode(n);
  nodesById.set(n.id, obj);
  root.add(obj);
}
scene.add(root);

const box = new THREE.Box3().setFromObject(root);
const center = box.getCenter(new THREE.Vector3());
const radius = Math.max(0.5, box.getBoundingSphere(new THREE.Sphere()).radius);
const dist = Math.max(radius / Math.sin(THREE.MathUtils.degToRad((SPEC.camera?.fov ?? 45) / 2)) * 1.35, 1.5);
camera.position.copy(center).add(new THREE.Vector3(0.55, 0.4, 0.75).normalize().multiplyScalar(dist));
controls.target.copy(center);

const mixer = new THREE.AnimationMixer(root);
for (const clip of buildClips(nodesById)) mixer.clipAction(clip).play();

document.getElementById("title").textContent = SPEC.title ?? "3D scene";
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  mixer.update(clock.getDelta());
  controls.update();
  renderer.render(scene, camera);
});
`;

/** Self-contained viewer page: embeds the spec, loads three.js from a CDN. */
export function buildStandaloneHtml(spec: Scene3DSpec): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(spec.title ?? "3D scene")}</title>`,
    "<style>",
    "html,body{margin:0;height:100%;background:#0B0E14;color:#e2e8f0;font-family:system-ui,sans-serif;overflow:hidden}",
    "#hud{position:fixed;top:10px;left:12px;font-size:12px;opacity:.85;pointer-events:none}",
    "#hint{position:fixed;bottom:10px;left:12px;font-size:11px;opacity:.5;pointer-events:none}",
    "</style>",
    "</head>",
    "<body>",
    '<div id="hud"></div>',
    '<div id="hint">drag to orbit · right-drag to pan · scroll to zoom — exported by the WebUI Studio Viewer (needs internet for the three.js CDN)</div>',
    '<script type="importmap">',
    '{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/"}}',
    "<\/script>",
    '<script type="module">',
    HTML_BUILDER_JS,
    JSON.stringify(spec),
    HTML_BUILDER_TAIL,
    "<\/script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── React Three Fiber .tsx component ─────────────────────────────────── */

const NUM = (n: number): string => String(Number(n.toFixed(4)));
const ARR = (a: number[]): string => `[${a.map(NUM).join(", ")}]`;

interface R3fAccumulator {
  consts: string[];
  body: string[];
}

function geometryJsx(node: Scene3DNode, acc: R3fAccumulator): string | null {
  const g = node.geometry as any;
  const id = node.id;
  switch (g.kind) {
    case "box": return `<boxGeometry args={[${NUM(g.width)}, ${NUM(g.height)}, ${NUM(g.depth)}]} />`;
    case "sphere": return `<sphereGeometry args={[${NUM(g.radius)}, ${g.widthSegments ?? 24}, ${g.heightSegments ?? 16}]} />`;
    case "cylinder": return `<cylinderGeometry args={[${NUM(g.radiusTop)}, ${NUM(g.radiusBottom)}, ${NUM(g.height)}, ${g.radialSegments ?? 24}, 1, ${g.openEnded ?? false}]} />`;
    case "cone": return `<coneGeometry args={[${NUM(g.radius)}, ${NUM(g.height)}, ${g.radialSegments ?? 24}]} />`;
    case "torus": return `<torusGeometry args={[${NUM(g.radius)}, ${NUM(g.tube)}, ${g.radialSegments ?? 16}, ${g.tubularSegments ?? 32}]} />`;
    case "capsule": return `<capsuleGeometry args={[${NUM(g.radius)}, ${NUM(g.length)}, ${g.capSegments ?? 8}, ${g.radialSegments ?? 16}]} />`;
    case "lathe":
      acc.consts.push(`const POINTS_${cssIdent(id)} = ${JSON.stringify(g.points)}.map(([x, y]) => new THREE.Vector2(x, y));`);
      return `<latheGeometry args={[POINTS_${cssIdent(id)}, ${g.segments ?? 24}]} />`;
    case "extrude":
      acc.consts.push(`const SHAPE_${cssIdent(id)} = new THREE.Shape(${JSON.stringify(g.shape)}.map(([x, y]) => new THREE.Vector2(x, y)));`);
      acc.consts.push(`const EXTRUDE_${cssIdent(id)} = { depth: ${NUM(g.depth)}, bevelEnabled: ${g.bevelEnabled ?? true}, bevelSize: ${g.bevelSize ?? 0.04}, bevelThickness: ${g.bevelThickness ?? 0.04}, bevelSegments: ${g.bevelSegments ?? 2}, curveSegments: 8 };`);
      return `<extrudeGeometry args={[SHAPE_${cssIdent(id)}, EXTRUDE_${cssIdent(id)}]} />`;
    case "tube":
      acc.consts.push(`const CURVE_${cssIdent(id)} = new THREE.CatmullRomCurve3(${JSON.stringify(g.path)}.map(([x, y, z]) => new THREE.Vector3(x, y, z)), ${g.closed ?? false}, "catmullrom", 0.5);`);
      return `<tubeGeometry args={[CURVE_${cssIdent(id)}, ${g.tubularSegments ?? 24}, ${NUM(g.radius)}, ${g.radialSegments ?? 8}, ${g.closed ?? false}]} />`;
    case "plane": return `<planeGeometry args={[${NUM(g.width)}, ${NUM(g.height)}]} />`;
    default: return null; // grid / arrow handled by the caller
  }
}

function cssIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function materialJsx(node: Scene3DNode): string {
  const m = (node.material ?? {}) as any;
  const props: string[] = [`color="${m.color ?? "#8B95A5"}"`, `roughness={${m.roughness ?? 0.55}}`, `metalness={${m.metalness ?? 0.25}}`];
  if (m.emissive) props.push(`emissive="${m.emissive}"`, `emissiveIntensity={${m.emissiveIntensity ?? 1}}`);
  if (m.flatShading) props.push("flatShading");
  if (typeof m.opacity === "number" && m.opacity < 1) props.push("transparent", `opacity={${m.opacity}}`);
  if (m.side === "double") props.push('side={THREE.DoubleSide}');
  else if (m.side === "back") props.push('side={THREE.BackSide}');
  return `<meshStandardMaterial ${props.join(" ")} />`;
}

function nodeToJsx(node: Scene3DNode, acc: R3fAccumulator, indent: string): string {
  const g = node.geometry as any;
  const transform: string[] = [];
  if (node.position) transform.push(`position={${ARR(node.position)}}`);
  if (node.rotation) transform.push(`rotation={${ARR(node.rotation)}}`);
  if (node.scale) transform.push(`scale={${ARR(node.scale)}}`);
  if (node.visible === false) transform.push("visible={false}");
  const attrs = `name="${node.id}"${node.label ? ` data-label="${node.label.replace(/"/g, "'")}"` : ""} ${transform.join(" ")}`.trimEnd();

  if (g.kind === "grid") {
    return `${indent}<gridHelper args={[${g.size}, ${g.divisions}, "#4A5568", "#2A3140"]} />`;
  }
  if (g.kind === "arrow") {
    const shaftH = g.length - g.headLength;
    return [
      `${indent}<group ${attrs}>`,
      `${indent}  <mesh position={[0, ${NUM(shaftH / 2)}, 0]}>`,
      `${indent}    <cylinderGeometry args={[${NUM(g.shaftRadius)}, ${NUM(g.shaftRadius)}, ${NUM(shaftH)}, 12]} />`,
      `${indent}    ${materialJsx(node)}`,
      `${indent}  </mesh>`,
      `${indent}  <mesh position={[0, ${NUM(g.length - g.headLength / 2)}, 0]}>`,
      `${indent}    <coneGeometry args={[${NUM(g.headRadius)}, ${NUM(g.headLength)}, 16]} />`,
      `${indent}    ${materialJsx(node)}`,
      `${indent}  </mesh>`,
      `${indent}</group>`,
    ].join("\n");
  }

  const geo = geometryJsx(node, acc) ?? `<boxGeometry args={[1, 1, 1]} />`;
  const children = (node.children ?? []).map(c => nodeToJsx(c, acc, indent + "  "));
  const hasChildren = children.length > 0;
  const tag = hasChildren ? "group" : "mesh";
  const lines = [`${indent}<${tag} ${attrs}>`];
  if (!hasChildren) {
    lines.push(`${indent}  ${geo}`);
    lines.push(`${indent}  ${materialJsx(node)}`);
  } else {
    lines.push(...children);
  }
  lines.push(`${indent}</${tag}>`);
  return lines.join("\n");
}

/**
 * Generates a dependency-light React Three Fiber component: real R3F JSX
 * primitives, named parts (Outliner-friendly), no drei. Animation clips are
 * listed as a comment so the consumer can wire useAnimations themselves.
 */
export function buildR3fComponent(spec: Scene3DSpec): string {
  const componentName = pascal(spec.title ?? spec.export?.filename ?? "SceneModel");
  const acc: R3fAccumulator = { consts: [], body: [] };
  for (const node of spec.objects ?? []) acc.body.push(nodeToJsx(node, acc, "      "));

  const clipNotes = (spec.animations ?? []).map(a =>
    `  // clip "${a.id}": ${a.channel} ${a.axis} ${a.from} → ${a.to} over ${a.duration}s${a.loop ? " (loop)" : ""}${a.yoyo ? " (yoyo)" : ""} on "${a.target}"`).join("\n");

  return [
    "// Generated by the WebUI Studio Viewer — React Three Fiber component.",
    "// Render with <Canvas> from @react-three/fiber. Parts keep their scene3d",
    "// ids as name= attributes so selection / explode tooling can find them.",
    "// Animation clips from the source scene (wire up with useAnimations or",
    "// useFrame if you need them):",
    clipNotes || "  // (none)",
    'import * as THREE from "three";',
    "",
    ...acc.consts,
    "",
    `export default function ${componentName}() {`,
    "  return (",
    "    <group name=\"scene\">",
    ...acc.body,
    "    </group>",
    "  );",
    "}",
    "",
  ].join("\n");
}
