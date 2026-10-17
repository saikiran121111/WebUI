/**
 * StudioViewer — the Blender/Maya-grade engine behind ThreeStudioViewer.
 * Browser-only (imports three addons directly); the React component passes in
 * the dynamically-imported `three` namespace so nothing here is bundled into
 * the server build. ViewerCore stays untouched for Asset3DBlock.
 *
 * Feature surface: shading modes, perspective/orthographic cameras + view
 * presets + ViewCube gizmo, 3-point lighting rig, env presets, post-FX
 * (bloom / SSAO / vignette), outliner + selection + TransformControls,
 * timeline scrubbing and a universal explode slider.
 */
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { computeStats, disposeObject3D } from "./sceneBuilder";
import { buildStudioEnvironment, type EnvPreset } from "./studioEnv";

export type ShadingMode =
  | "rendered" | "solid" | "wireframe" | "wireframeShaded"
  | "normals" | "uv" | "unlit" | "xray";

export const SHADING_MODES: ShadingMode[] = [
  "rendered", "solid", "wireframe", "wireframeShaded", "normals", "uv", "unlit", "xray",
];

export type ProjectionMode = "perspective" | "orthographic";
export type ToneMappingName = "ACESFilmic" | "Neutral" | "Reinhard" | "Linear";
export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso" | "reset";
export type TransformMode = "translate" | "rotate" | "scale";

export interface BackgroundSpec {
  mode: "dark" | "custom" | "transparent";
  color?: string;
}

export interface StudioStats {
  fps: number;
  meshes: number;
  vertices: number;
  triangles: number;
  drawCalls: number;
  bbox: { w: number; h: number; d: number };
}

export interface OutlinerNode {
  id: string;
  label: string;
  visible: boolean;
  children: OutlinerNode[];
}

export interface MaterialInfo {
  color: string;
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  flatShading: boolean;
  wireframe: boolean;
}

export interface LightState {
  keyIntensity: number;
  fillIntensity: number;
  rimIntensity: number;
  ambientIntensity: number;
  keyColor: string;
  fillColor: string;
  rimColor: string;
  keyAzimuth: number;
  fillAzimuth: number;
  rimAzimuth: number;
  shadows: boolean;
  contactShadows: boolean;
  helpers: boolean;
}

export interface StudioOptions {
  fov?: number;
  lightingPreset?: "studio" | "dramatic" | "blueprint" | "space";
  envPreset?: EnvPreset;
  background?: BackgroundSpec;
  onStats?: (stats: StudioStats) => void;
}

const LIGHT_PRESETS: Record<string, { key: number; fill: number; rim: number; ambient: number }> = {
  studio: { key: 2.2, fill: 0.8, rim: 1.4, ambient: 0.45 },
  dramatic: { key: 3.0, fill: 0.3, rim: 2.0, ambient: 0.2 },
  blueprint: { key: 1.6, fill: 1.2, rim: 1.0, ambient: 0.8 },
  space: { key: 1.2, fill: 0.5, rim: 1.8, ambient: 0.25 },
};

const VIEW_DIRS: Record<Exclude<ViewName, "reset">, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: [0.55, 0.4, 0.75],
};

const GIZMO_AXIS_TO_VIEW: Record<string, Exclude<ViewName, "reset">> = {
  x: "right", xneg: "left", y: "top", yneg: "bottom", z: "front", zneg: "back",
};

const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    darkness: { value: 0.55 },
  },
  vertexShader: [
    "varying vec2 vUv;",
    "void main() { vUv = uv; gl_FragColor = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  ].join("\n"),
  fragmentShader: [
    "uniform sampler2D tDiffuse;",
    "uniform float darkness;",
    "varying vec2 vUv;",
    "void main() {",
    "  vec4 color = texture2D(tDiffuse, vUv);",
    "  vec2 p = vUv - 0.5;",
    "  float vig = 1.0 - smoothstep(0.35, 1.0, length(p) * 1.35);",
    "  color.rgb *= mix(1.0, vig, darkness);",
    "  gl_FragColor = color;",
    "}",
  ].join("\n"),
};

interface ExplodeEntry {
  node: any;
  base: any;      // Vector3 original local position
  dirLocal: any;  // Vector3 unit radial direction in parent space
  maxDist: number;
}

export class StudioViewer {
  private three: any;
  private container: HTMLElement;
  private renderer: any;
  private scene: any;
  private perspCamera: any;
  private orthoCamera: any = null;
  private activeCamera: any;
  controls: OrbitControls;
  private viewHelper: ViewHelper;
  private transformControls: TransformControls;
  private transformHelper: any;

  private root: any = null;
  private nodesById = new Map<string, any>();
  private pickables: any[] = [];
  private mixer: any = null;
  private clips: any[] = [];
  private actions: any[] = [];
  private timeScale = 1;
  private playing = true;
  private duration = 1;

  private ambient: any;
  private keyLight: any;
  private fillLight: any;
  private rimLight: any;
  private lightHelpers: any;
  private contactPlane: any = null;
  private lightState: LightState;

  private envTexture: any = null;
  private grid: any;
  private axes: any;
  private bboxHelper: any;
  private cageHelper: any;
  private selectionBox: any;
  private selectedId: string | null = null;
  private soloId: string | null = null;

  private shadingMode: ShadingMode = "rendered";
  private matcapTexture: any = null;
  private checkerTexture: any = null;
  private edgeOverlays: any[] = [];

  private composer: EffectComposer | null = null;
  private bloomOn = false;
  private bloomStrength = 0.7;
  private ssaoOn = false;
  private vignetteOn = false;

  private explodePct = 0;
  private explodeCache: ExplodeEntry[] = [];

  private frameHandlers = new Set<(dt: number) => void>();
  private raf = 0;
  private clock: any;
  private parked = false;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private size = { w: 1, h: 1 };
  private homePosition: any = null;
  private homeTarget: any = null;
  private cachedStats = { meshes: 0, vertices: 0, triangles: 0 };
  private bboxDims = { w: 0, h: 0, d: 0 };
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private onStats?: (stats: StudioStats) => void;

  constructor(three: any, container: HTMLElement, opts: StudioOptions = {}) {
    this.three = three;
    this.container = container;
    this.onStats = opts.onStats;

    this.renderer = new three.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = three.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = three.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = three.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new three.Scene();
    this.scene.background = new three.Color("#0B0E14");

    const fov = opts.fov ?? 45;
    this.perspCamera = new three.PerspectiveCamera(fov, 1, 0.01, 2000);
    this.perspCamera.position.set(6, 4, 8);
    this.activeCamera = this.perspCamera;

    this.controls = new OrbitControls(this.perspCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.viewHelper = new ViewHelper(this.activeCamera, this.scene);
    if (typeof (this.viewHelper as any).setSize === "function") (this.viewHelper as any).setSize(96);

    this.transformControls = new TransformControls(this.activeCamera, this.renderer.domElement);
    this.transformHelper = this.transformControls.getHelper();
    this.scene.add(this.transformHelper);
    this.transformControls.addEventListener("dragging-changed", (event: any) => {
      this.controls.enabled = !event.value;
    });
    this.transformControls.addEventListener("mouseUp", () => {
      this.refreshExplodeBase();
      this.refreshBboxHelpers();
    });

    // 3-point rig + ambient, driven by the right dock.
    const preset = LIGHT_PRESETS[opts.lightingPreset ?? "studio"] ?? LIGHT_PRESETS.studio;
    this.ambient = new three.AmbientLight(0xffffff, preset.ambient);
    this.keyLight = new three.DirectionalLight(0xffffff, preset.key);
    this.fillLight = new three.DirectionalLight(0xbfd4ff, preset.fill);
    this.rimLight = new three.DirectionalLight(0xffffff, preset.rim);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.ambient, this.keyLight, this.fillLight, this.rimLight);
    this.lightHelpers = new three.Group();
    for (const light of [this.keyLight, this.fillLight, this.rimLight]) {
      this.lightHelpers.add(new three.DirectionalLightHelper(light, 1, 0x38bdf8));
    }
    this.lightHelpers.visible = false;
    this.scene.add(this.lightHelpers);
    this.lightState = {
      keyIntensity: preset.key, fillIntensity: preset.fill, rimIntensity: preset.rim,
      ambientIntensity: preset.ambient,
      keyColor: "#ffffff", fillColor: "#bfd4ff", rimColor: "#ffffff",
      keyAzimuth: 39, fillAzimuth: 210, rimAzimuth: 300,
      shadows: true, contactShadows: false, helpers: false,
    };

    this.grid = new three.GridHelper(10, 10, 0x4a5568, 0x2a3140);
    this.axes = new three.AxesHelper(3);
    this.bboxHelper = new three.Box3Helper(new three.Box3(), 0x38bdf8);
    this.cageHelper = new three.Box3Helper(new three.Box3(), 0x64748b);
    this.selectionBox = new three.Box3Helper(new three.Box3(), 0xfbbf24);
    this.bboxHelper.visible = false;
    this.cageHelper.visible = false;
    this.selectionBox.visible = false;
    this.scene.add(this.grid, this.axes, this.bboxHelper, this.cageHelper, this.selectionBox);

    this.clock = new three.Clock();

    this.setEnvPreset(opts.envPreset ?? "studio-soft");
    this.setBackground(opts.background ?? { mode: "dark" });
    this.positionLights();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.intersectionObserver = new IntersectionObserver(
      (entries) => { this.parked = !entries[0]?.isIntersecting; },
      { threshold: 0.01 },
    );
    this.intersectionObserver.observe(container);

    this.handleResize();
    this.raf = requestAnimationFrame(this.tick);
  }

  /* ── content ───────────────────────────────────────────────────────── */

  setContent(root: any, clips: any[] = []): void {
    if (this.root) {
      this.scene.remove(this.root);
      disposeObject3D(this.root);
    }
    this.root = root;
    this.clips = clips;
    this.nodesById.clear();
    this.pickables = [];
    root.traverse((obj: any) => {
      const nodeId = obj.userData?.nodeId;
      if (nodeId && !this.nodesById.has(nodeId)) this.nodesById.set(nodeId, obj);
      if (obj.isMesh) this.pickables.push(obj);
    });
    this.scene.add(root);

    this.mixer = new this.three.AnimationMixer(root);
    this.actions = [];
    for (const clip of clips) this.actions.push(this.mixer.clipAction(clip));
    this.duration = Math.max(1, ...clips.map((c: any) => c.duration));
    this.playing = true;
    for (const action of this.actions) action.play();

    this.selectedId = null;
    this.soloId = null;
    this.transformControls.detach();
    this.selectionBox.visible = false;
    this.shadingMode = "rendered";
    this.edgeOverlays = [];
    this.explodePct = 0;
    this.refreshExplodeCache();
    this.cachedStats = computeStats(root);
    this.refreshBboxHelpers();

    const frame = this.frameFor(this.root);
    this.homePosition = frame.position;
    this.homeTarget = frame.center;
    this.activeCamera.position.copy(frame.position);
    this.controls.target.copy(frame.center);
    this.positionLights();
  }

  getContent(): any {
    return this.root;
  }

  getClips(): any[] {
    return this.clips;
  }

  getClipIds(): string[] {
    return this.clips.map((c: any) => c.name);
  }

  private frameFor(object: any): { center: any; position: any } {
    const three = this.three;
    const box = new three.Box3().setFromObject(object);
    const center = box.getCenter(new three.Vector3());
    if (!Number.isFinite(center.x)) center.set(0, 0, 0);
    const sphere = box.getBoundingSphere(new three.Sphere());
    let radius = sphere.radius;
    if (!Number.isFinite(radius) || radius < 0.5) radius = 5;
    const fovRad = three.MathUtils.degToRad(this.perspCamera.fov);
    const distance = Math.max(radius / Math.sin(fovRad / 2) * 1.35, 1.5);
    const dir = new three.Vector3(0.55, 0.4, 0.75).normalize();
    return { center, position: center.clone().add(dir.multiplyScalar(distance)) };
  }

  private currentBox(): any {
    const box = new this.three.Box3();
    if (this.root) box.setFromObject(this.root);
    return box;
  }

  private refreshBboxHelpers(): void {
    if (!this.root) return;
    this.root.updateWorldMatrix(true, true);
    const box = this.currentBox();
    if (box.isEmpty()) return;
    this.cageHelper.box = box.clone();
    if (this.selectedId) {
      const node = this.nodesById.get(this.selectedId);
      if (node) {
        const selBox = new this.three.Box3().setFromObject(node);
        if (!selBox.isEmpty()) {
          this.selectionBox.box = selBox;
          this.bboxHelper.box = selBox.clone();
        }
      }
    } else {
      this.bboxHelper.box = box.clone();
    }
    const size = box.getSize(new this.three.Vector3());
    this.bboxDims = { w: size.x, h: size.y, d: size.z };
    if (this.contactPlane) this.contactPlane.position.y = box.min.y - 0.01;
  }

  /* ── outliner / selection / visibility ─────────────────────────────── */

  getOutliner(): OutlinerNode[] {
    if (!this.root) return [];
    const toNode = (obj: any): OutlinerNode | null => {
      const id = obj.userData?.nodeId;
      if (!id) return null;
      const children: OutlinerNode[] = [];
      for (const child of obj.children) {
        const c = toNode(child);
        if (c) children.push(c);
      }
      return { id, label: obj.userData?.label ?? id, visible: obj.visible, children };
    };
    const top: OutlinerNode[] = [];
    for (const child of this.root.children) {
      const n = toNode(child);
      if (n) top.push(n);
    }
    return top;
  }

  setNodeVisible(id: string, visible: boolean): void {
    const node = this.nodesById.get(id);
    if (!node) return;
    node.visible = visible;
  }

  setSolo(id: string | null): void {
    this.soloId = id;
    if (!id) {
      for (const node of this.nodesById.values()) node.visible = true;
      return;
    }
    const keep = new Set<string>();
    let cursor = this.nodesById.get(id);
    while (cursor) {
      const nid = cursor.userData?.nodeId;
      if (nid) keep.add(nid);
      cursor = this.nodesById.has(cursor.parent?.userData?.nodeId ?? "") ? cursor.parent : null;
    }
    const markSubtree = (obj: any) => {
      const nid = obj.userData?.nodeId;
      if (nid) keep.add(nid);
      for (const child of obj.children) markSubtree(child);
    };
    markSubtree(this.nodesById.get(id));
    for (const [nid, node] of this.nodesById) node.visible = keep.has(nid);
  }

  select(id: string | null): void {
    this.selectedId = id;
    if (id) {
      const node = this.nodesById.get(id);
      if (node) {
        this.transformControls.attach(node);
        this.selectionBox.visible = true;
        this.refreshBboxHelpers();
        return;
      }
    }
    this.transformControls.detach();
    this.selectionBox.visible = false;
  }

  getSelected(): string | null {
    return this.selectedId;
  }

  setTransformMode(mode: TransformMode): void {
    this.transformControls.mode = mode;
  }

  setTransformSpace(space: "local" | "world"): void {
    this.transformControls.space = space;
  }

  /* ── shading ───────────────────────────────────────────────────────── */

  setShading(mode: ShadingMode): void {
    this.shadingMode = mode;
    if (!this.root) return;
    this.clearEdgeOverlays();
    const three = this.three;
    this.root.traverse((obj: any) => {
      if (!obj.isMesh || obj.userData?.edgeOverlay) return;
      if (!obj.userData.origMaterial) obj.userData.origMaterial = obj.material;
      const orig = obj.userData.origMaterial;
      switch (mode) {
        case "rendered":
          obj.material = orig;
          break;
        case "solid":
          obj.material = new three.MeshMatcapMaterial({ matcap: this.getMatcap(), color: orig.color ?? 0xd8dde6 });
          break;
        case "wireframe":
          obj.material = new three.MeshBasicMaterial({ color: orig.color ?? 0x94a3b8, wireframe: true });
          break;
        case "wireframeShaded":
          obj.material = orig;
          this.addEdgeOverlay(obj, 0x94a3b8);
          break;
        case "normals":
          obj.material = new three.MeshNormalMaterial();
          break;
        case "uv":
          obj.material = new three.MeshStandardMaterial({ map: this.getChecker(), roughness: 0.8, metalness: 0 });
          break;
        case "unlit":
          obj.material = new three.MeshBasicMaterial({ color: orig.color ?? 0x8b95a5 });
          break;
        case "xray": {
          obj.material = new three.MeshBasicMaterial({
            color: 0x7dd3fc, transparent: true, opacity: 0.18,
            blending: three.AdditiveBlending, depthWrite: false, side: three.DoubleSide,
          });
          this.addEdgeOverlay(obj, 0x38bdf8);
          break;
        }
      }
    });
  }

  getShading(): ShadingMode {
    return this.shadingMode;
  }

  private addEdgeOverlay(mesh: any, color: number): void {
    if (!mesh.geometry) return;
    const edges = new this.three.LineSegments(
      new this.three.EdgesGeometry(mesh.geometry, 30),
      new this.three.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }),
    );
    edges.userData.edgeOverlay = true;
    mesh.add(edges);
    this.edgeOverlays.push(edges);
  }

  private clearEdgeOverlays(): void {
    for (const edge of this.edgeOverlays) {
      edge.parent?.remove(edge);
      edge.geometry.dispose();
      edge.material.dispose();
    }
    this.edgeOverlays = [];
  }

  private getMatcap(): any {
    if (this.matcapTexture) return this.matcapTexture;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(110, 96, 12, 128, 128, 150);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.35, "#d9dee6");
    grad.addColorStop(0.75, "#8b95a5");
    grad.addColorStop(1, "#39404d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    this.matcapTexture = new this.three.CanvasTexture(canvas);
    this.matcapTexture.colorSpace = this.three.SRGBColorSpace;
    return this.matcapTexture;
  }

  private getChecker(): any {
    if (this.checkerTexture) return this.checkerTexture;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const cells = 8;
    const cell = canvas.width / cells;
    for (let y = 0; y < cells; y += 1) {
      for (let x = 0; x < cells; x += 1) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#e2e8f0" : "#475569";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    this.checkerTexture = new this.three.CanvasTexture(canvas);
    this.checkerTexture.colorSpace = this.three.SRGBColorSpace;
    this.checkerTexture.wrapS = this.three.RepeatWrapping;
    this.checkerTexture.wrapT = this.three.RepeatWrapping;
    return this.checkerTexture;
  }

  /* ── material editor ───────────────────────────────────────────────── */

  getMaterial(id: string): MaterialInfo | null {
    const node = this.nodesById.get(id);
    const orig = node?.userData?.origMaterial ?? node?.material;
    if (!orig || !orig.color) return null;
    return {
      color: `#${orig.color.getHexString()}`,
      metalness: orig.metalness ?? 0,
      roughness: orig.roughness ?? 1,
      emissive: orig.emissive ? `#${orig.emissive.getHexString()}` : "#000000",
      emissiveIntensity: orig.emissiveIntensity ?? 1,
      opacity: orig.opacity ?? 1,
      flatShading: !!orig.flatShading,
      wireframe: !!orig.wireframe,
    };
  }

  setMaterial(id: string, patch: Partial<MaterialInfo>): void {
    const node = this.nodesById.get(id);
    const orig = node?.userData?.origMaterial ?? node?.material;
    if (!orig) return;
    if (patch.color !== undefined) orig.color.set(patch.color);
    if (patch.metalness !== undefined && "metalness" in orig) orig.metalness = patch.metalness;
    if (patch.roughness !== undefined && "roughness" in orig) orig.roughness = patch.roughness;
    if (patch.emissive !== undefined && orig.emissive) orig.emissive.set(patch.emissive);
    if (patch.emissiveIntensity !== undefined && orig.emissive) orig.emissiveIntensity = patch.emissiveIntensity;
    if (patch.opacity !== undefined) {
      orig.opacity = patch.opacity;
      orig.transparent = patch.opacity < 1;
    }
    if (patch.flatShading !== undefined) {
      orig.flatShading = patch.flatShading;
      orig.needsUpdate = true;
    }
    if (patch.wireframe !== undefined) orig.wireframe = patch.wireframe;
  }

  /* ── environment / background / lighting ───────────────────────────── */

  setEnvPreset(preset: EnvPreset): void {
    const { texture, intensity } = buildStudioEnvironment(this.three, this.renderer, preset);
    if (this.envTexture) this.envTexture.dispose();
    this.envTexture = texture;
    this.scene.environment = texture;
    this.scene.environmentIntensity = intensity;
  }

  setBackground(spec: BackgroundSpec): void {
    if (spec.mode === "transparent") {
      this.scene.background = null;
      this.renderer.setClearAlpha(0);
    } else {
      const color = spec.mode === "custom" ? spec.color ?? "#0B0E14" : "#0B0E14";
      this.scene.background = new this.three.Color(color);
      this.renderer.setClearAlpha(1);
    }
  }

  getLights(): LightState {
    return { ...this.lightState };
  }

  setLight(patch: Partial<LightState>): void {
    Object.assign(this.lightState, patch);
    this.ambient.intensity = this.lightState.ambientIntensity;
    this.keyLight.intensity = this.lightState.keyIntensity;
    this.fillLight.intensity = this.lightState.fillIntensity;
    this.rimLight.intensity = this.lightState.rimIntensity;
    this.keyLight.color.set(this.lightState.keyColor);
    this.fillLight.color.set(this.lightState.fillColor);
    this.rimLight.color.set(this.lightState.rimColor);
    const shadowsOn = this.lightState.shadows || this.lightState.contactShadows;
    this.renderer.shadowMap.enabled = shadowsOn;
    this.keyLight.castShadow = shadowsOn;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 120;
    const extent = Math.max(15, (this.bboxDims.w + this.bboxDims.d) * 1.5);
    this.keyLight.shadow.camera.left = -extent;
    this.keyLight.shadow.camera.right = extent;
    this.keyLight.shadow.camera.top = extent;
    this.keyLight.shadow.camera.bottom = -extent;
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.lightHelpers.visible = this.lightState.helpers;
    this.ensureContactPlane();
    if (this.contactPlane) this.contactPlane.visible = this.lightState.contactShadows;
    this.positionLights();
  }

  private ensureContactPlane(): void {
    if (this.contactPlane || !this.root) return;
    const plane = new this.three.Mesh(
      new this.three.PlaneGeometry(60, 60),
      new this.three.ShadowMaterial({ opacity: 0.35 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.visible = false;
    this.contactPlane = plane;
    this.scene.add(plane);
    this.refreshBboxHelpers();
  }

  private positionLights(): void {
    const three = this.three;
    const target = this.controls?.target ?? new three.Vector3();
    const dist = Math.max(10, Math.max(this.bboxDims.w, this.bboxDims.h, this.bboxDims.d) * 2.5);
    const place = (light: any, azimuthDeg: number, elevationDeg: number) => {
      const az = three.MathUtils.degToRad(azimuthDeg);
      const el = three.MathUtils.degToRad(elevationDeg);
      light.position.set(
        target.x + dist * Math.cos(el) * Math.sin(az),
        target.y + dist * Math.sin(el),
        target.z + dist * Math.cos(el) * Math.cos(az),
      );
      light.target.position.copy(target);
      light.target.updateMatrixWorld();
    };
    place(this.keyLight, this.lightState.keyAzimuth, 55);
    place(this.fillLight, this.lightState.fillAzimuth, 18);
    place(this.rimLight, this.lightState.rimAzimuth, 35);
    for (const helper of this.lightHelpers.children) (helper as any).update?.();
  }

  /* ── camera: projection, presets, gizmo, fov, autorotate ───────────── */

  setProjection(mode: ProjectionMode): void {
    if (mode === "orthographic" && !this.orthoCamera) {
      const frame = this.frameFor(this.root ?? new this.three.Object3D());
      const radius = Math.max(1, frame.center.distanceTo(frame.position) * 0.35);
      const aspect = this.size.w / Math.max(1, this.size.h);
      this.orthoCamera = new this.three.OrthographicCamera(
        -radius * aspect, radius * aspect, radius, -radius, -1000, 1000,
      );
    }
    const next = mode === "orthographic" ? this.orthoCamera : this.perspCamera;
    if (!next || next === this.activeCamera) return;
    next.position.copy(this.activeCamera.position);
    next.quaternion.copy(this.activeCamera.quaternion);
    if (mode === "orthographic") {
      const frame = this.frameFor(this.root ?? new this.three.Object3D());
      const radius = Math.max(2, Math.max(this.bboxDims.w, this.bboxDims.h, this.bboxDims.d) * 0.8);
      const aspect = this.size.w / Math.max(1, this.size.h);
      this.orthoCamera.left = -radius * aspect;
      this.orthoCamera.right = radius * aspect;
      this.orthoCamera.top = radius;
      this.orthoCamera.bottom = -radius;
      this.orthoCamera.near = -radius * 20;
      this.orthoCamera.far = radius * 20;
      this.orthoCamera.updateProjectionMatrix();
    }
    this.activeCamera = next;
    (this.controls as any).object = next;
    this.transformControls.camera = next;
    this.viewHelper = new ViewHelper(next, this.scene);
    if (typeof (this.viewHelper as any).setSize === "function") (this.viewHelper as any).setSize(96);
    this.controls.update();
    if (this.composer) this.rebuildComposer();
  }

  setFov(deg: number): void {
    this.perspCamera.fov = Math.min(110, Math.max(20, deg));
    this.perspCamera.updateProjectionMatrix();
  }

  setView(name: ViewName): void {
    if (!this.root) return;
    if (name === "reset") {
      if (this.homePosition) {
        this.activeCamera.position.copy(this.homePosition);
        this.controls.target.copy(this.homeTarget);
      }
      this.controls.update();
      return;
    }
    const box = this.currentBox();
    const center = box.getCenter(new this.three.Vector3());
    const size = box.getSize(new this.three.Vector3());
    const radius = Math.max(0.5, size.length() / 2);
    const fovRad = this.activeCamera.isOrthographicCamera
      ? this.three.MathUtils.degToRad(this.perspCamera.fov)
      : this.three.MathUtils.degToRad(this.activeCamera.fov);
    const distance = Math.max(radius / Math.sin(fovRad / 2) * 1.35, 1.5);
    const dir = new this.three.Vector3(...VIEW_DIRS[name]).normalize();
    this.activeCamera.position.copy(center).add(dir.multiplyScalar(distance));
    if (name === "top") this.activeCamera.up.set(0, 0, -1);
    else if (name === "bottom") this.activeCamera.up.set(0, 0, 1);
    else this.activeCamera.up.set(0, 1, 0);
    this.controls.target.copy(center);
    this.controls.update();
  }

  frameSelected(): void {
    if (!this.root) return;
    const target = this.selectedId ? this.nodesById.get(this.selectedId) : this.root;
    const box = new this.three.Box3().setFromObject(target ?? this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new this.three.Vector3());
    const size = box.getSize(new this.three.Vector3());
    const radius = Math.max(0.5, size.length() / 2);
    const fovRad = this.three.MathUtils.degToRad(this.perspCamera.fov);
    const distance = Math.max(radius / Math.sin(fovRad / 2) * 1.6, 1.2);
    const dir = this.activeCamera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.set(0.55, 0.4, 0.75).normalize();
    this.activeCamera.position.copy(center).add(dir.multiplyScalar(distance));
    this.controls.target.copy(center);
    this.controls.update();
  }

  /** ViewCube click: returns true when the gizmo handled the pointer. */
  handleGizmoClick(clientX: number, clientY: number): boolean {
    try {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new this.three.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const hit = (this.viewHelper as any).intersect?.(ndc); // @types/three lags the r186 runtime API
      if (!hit) return false;
      const axis = hit.userData?.axis ?? hit.parent?.userData?.axis;
      const view = GIZMO_AXIS_TO_VIEW[axis];
      if (!view) return true;
      this.setView(view);
      return true;
    } catch {
      return false;
    }
  }

  setAutoRotate(on: boolean, speed = 2): void {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = speed;
  }

  setGrid(on: boolean): void { this.grid.visible = on; }
  setAxes(on: boolean): void { this.axes.visible = on; }
  setBbox(on: boolean): void { this.refreshBboxHelpers(); this.bboxHelper.visible = on; }
  setCage(on: boolean): void { this.refreshBboxHelpers(); this.cageHelper.visible = on; }
  setLightHelpers(on: boolean): void { this.setLight({ helpers: on }); }

  enterFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.container.requestFullscreen?.();
  }

  /* ── post-processing ───────────────────────────────────────────────── */

  setBloom(enabled: boolean, strength = this.bloomStrength): void {
    this.bloomOn = enabled;
    this.bloomStrength = strength;
    this.rebuildComposer();
  }

  setSSAO(enabled: boolean): void {
    this.ssaoOn = enabled;
    this.rebuildComposer();
  }

  setVignette(enabled: boolean): void {
    this.vignetteOn = enabled;
    this.rebuildComposer();
  }

  setToneMapping(name: ToneMappingName): void {
    const three = this.three;
    const map: Record<ToneMappingName, any> = {
      ACESFilmic: three.ACESFilmicToneMapping,
      Neutral: three.NeutralToneMapping ?? three.ACESFilmicToneMapping,
      Reinhard: three.ReinhardToneMapping,
      Linear: three.LinearToneMapping,
    };
    this.renderer.toneMapping = map[name] ?? three.ACESFilmicToneMapping;
  }

  private rebuildComposer(): void {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    if (!this.bloomOn && !this.ssaoOn && !this.vignetteOn) return;
    const three = this.three;
    const composer = new EffectComposer(this.renderer);
    if (this.ssaoOn) {
      const ssao = new SSAOPass(this.scene, this.activeCamera, this.size.w, this.size.h);
      ssao.kernelRadius = 8;
      ssao.minDistance = 0.003;
      ssao.maxDistance = 0.12;
      composer.addPass(ssao);
    } else {
      composer.addPass(new RenderPass(this.scene, this.activeCamera));
    }
    if (this.bloomOn) {
      composer.addPass(new UnrealBloomPass(new three.Vector2(this.size.w, this.size.h), this.bloomStrength, 0.4, 0.85));
    }
    if (this.vignetteOn) {
      composer.addPass(new ShaderPass(VIGNETTE_SHADER as any));
    }
    composer.addPass(new OutputPass());
    composer.setSize(this.size.w, this.size.h);
    this.composer = composer;
  }

  /* ── timeline ──────────────────────────────────────────────────────── */

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (this.mixer) {
      for (const action of this.actions) {
        if (playing) action.play();
        else action.paused = true;
      }
      if (playing) for (const action of this.actions) action.paused = false;
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  restart(): void {
    if (!this.mixer) return;
    for (const action of this.actions) {
      action.stop();
      action.reset();
      action.play();
    }
    this.mixer.setTime(0);
    this.playing = true;
  }

  seek(time: number): void {
    if (!this.mixer) return;
    this.mixer.setTime(Math.min(this.duration, Math.max(0, time)));
    if (!this.playing) this.mixer.update(0);
  }

  getTime(): number {
    return this.mixer?.time ?? 0;
  }

  getDuration(): number {
    return this.duration;
  }

  setSpeed(scale: number): void {
    this.timeScale = Math.min(2, Math.max(0.25, scale));
  }

  getSpeed(): number {
    return this.timeScale;
  }

  setClip(clipId: string | "all"): void {
    if (!this.mixer) return;
    for (const action of this.actions) {
      const name = action.getClip().name;
      if (clipId === "all" || name === clipId) {
        action.reset();
        action.play();
      } else {
        action.stop();
      }
    }
  }

  /* ── explode ───────────────────────────────────────────────────────── */

  private refreshExplodeCache(): void {
    this.explodeCache = [];
    if (!this.root) return;
    this.root.updateWorldMatrix(true, true);
    const box = this.currentBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new this.three.Vector3());
    const size = box.getSize(new this.three.Vector3());
    const maxDist = Math.max(size.x, size.y, size.z) * 0.9;
    const tmpWorld = new this.three.Vector3();
    const tmpInverse = new this.three.Matrix4();
    for (const node of this.nodesById.values()) {
      node.getWorldPosition(tmpWorld);
      const dirWorld = tmpWorld.clone().sub(center);
      if (dirWorld.lengthSq() < 1e-8) dirWorld.set(0, 1, 0);
      dirWorld.normalize();
      let dirLocal = dirWorld;
      if (node.parent) {
        tmpInverse.copy(node.parent.matrixWorld).invert();
        dirLocal = dirWorld.clone().transformDirection(tmpInverse);
      }
      this.explodeCache.push({
        node,
        base: node.position.clone(),
        dirLocal,
        maxDist,
      });
    }
  }

  private refreshExplodeBase(): void {
    for (const entry of this.explodeCache) entry.base.copy(entry.node.position);
  }

  setExplode(percent: number): void {
    this.explodePct = Math.min(100, Math.max(0, percent));
  }

  getExplode(): number {
    return this.explodePct;
  }

  private applyExplode(): void {
    if (this.explodePct <= 0) return;
    const t = (this.explodePct / 100);
    for (const entry of this.explodeCache) {
      entry.node.position.copy(entry.base).addScaledVector(entry.dirLocal, t * entry.maxDist);
    }
  }

  /* ── picking / projection / capture ────────────────────────────────── */

  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new this.three.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new this.three.Raycaster();
    raycaster.setFromCamera(ndc, this.activeCamera);
    const hits = raycaster.intersectObjects(this.pickables, false);
    for (const hit of hits) {
      if (!hit.object.visible) continue;
      let cursor: any = hit.object;
      while (cursor && !cursor.userData?.nodeId) cursor = cursor.parent;
      if (cursor?.userData?.nodeId) return cursor.userData.nodeId;
    }
    return null;
  }

  projectToScreen(worldPos: any): { x: number; y: number; behind: boolean } {
    const v = worldPos.clone().project(this.activeCamera);
    return {
      x: (v.x * 0.5 + 0.5) * this.size.w,
      y: (-v.y * 0.5 + 0.5) * this.size.h,
      behind: v.z > 1,
    };
  }

  /** High-res offscreen PNG (4K by default). Returns a Blob. */
  async capturePng(width = 3840, height = 2160, transparent = false): Promise<Blob> {
    const prevW = this.size.w;
    const prevH = this.size.h;
    const prevBg = this.scene.background;
    const prevAspect = this.perspCamera.aspect;
    this.renderer.setSize(width, height, false);
    this.perspCamera.aspect = width / height;
    this.perspCamera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(width, height);
    if (transparent) this.scene.background = null;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.activeCamera);
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    this.scene.background = prevBg;
    this.renderer.setSize(prevW, prevH, false);
    this.perspCamera.aspect = prevAspect;
    this.perspCamera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(prevW, prevH);
    return await (await fetch(dataUrl)).blob();
  }

  addFrameHandler(handler: (dt: number) => void): void {
    this.frameHandlers.add(handler);
  }

  removeFrameHandler(handler: (dt: number) => void): void {
    this.frameHandlers.delete(handler);
  }

  /* ── loop / resize / dispose ───────────────────────────────────────── */

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    if (this.orthoCamera) {
      const radius = (this.orthoCamera.top);
      this.orthoCamera.left = -radius * (w / h);
      this.orthoCamera.right = radius * (w / h);
      this.orthoCamera.updateProjectionMatrix();
    }
    if (this.composer) this.composer.setSize(w, h);
  }

  private renderGizmo(): void {
    try {
      const size = typeof (this.viewHelper as any).getSize === "function"
        ? (this.viewHelper as any).getSize()
        : 96;
      const renderer = this.renderer;
      const origViewport = renderer.setViewport.bind(renderer);
      const origScissor = renderer.setScissor.bind(renderer);
      const dw = renderer.domElement.width;
      const dh = renderer.domElement.height;
      renderer.setViewport = (x: number, y: number, w?: number, h?: number) =>
        origViewport(dw - (w ?? size), dh - (h ?? size), w, h);
      renderer.setScissor = (x: number, y: number, w?: number, h?: number) =>
        origScissor(dw - (w ?? size), dh - (h ?? size), w, h);
      try {
        this.viewHelper.render(renderer);
      } finally {
        renderer.setViewport = origViewport;
        renderer.setScissor = origScissor;
      }
    } catch {
      // ViewHelper API drift must never break the render loop.
    }
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.parked) return;
    const dt = this.clock.getDelta();
    if (this.mixer && this.playing) this.mixer.update(dt * this.timeScale);
    this.applyExplode();
    for (const handler of this.frameHandlers) handler(dt);
    if (this.selectedId) this.refreshBboxHelpers();
    this.controls.update();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.activeCamera);
    this.renderGizmo();
    this.trackStats(dt);
  };

  private trackStats(dt: number): void {
    this.fpsFrames += 1;
    this.fpsElapsed += dt;
    if (this.fpsElapsed < 0.5 || !this.onStats) return;
    const fps = Math.round(this.fpsFrames / this.fpsElapsed);
    this.fpsFrames = 0;
    this.fpsElapsed = 0;
    this.onStats({
      fps,
      meshes: this.cachedStats.meshes,
      vertices: this.cachedStats.vertices,
      triangles: this.cachedStats.triangles,
      drawCalls: this.renderer.info.render.calls,
      bbox: this.bboxDims,
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.frameHandlers.clear();
    this.clearEdgeOverlays();
    this.transformControls.detach();
    this.transformControls.dispose();
    this.controls.dispose();
    this.composer?.dispose();
    this.envTexture?.dispose();
    this.matcapTexture?.dispose();
    this.checkerTexture?.dispose();
    if (this.root) {
      this.scene.remove(this.root);
      disposeObject3D(this.root);
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
