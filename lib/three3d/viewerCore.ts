import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { applyLighting, buildEnvironment, type LightingPreset, type LightingRig } from "./lighting";
import { frameObject } from "./camera";
import { computeStats, disposeObject3D, type SceneStats } from "./sceneBuilder";

export interface ViewerConfig {
  background?: string;
  preset?: LightingPreset;
  shadows?: boolean;
  ambientIntensity?: number;
  fov?: number;
}

/**
 * Browser-only imperative viewer shared by scene3d and asset3d blocks:
 * renderer + orbit/pan/zoom controls + studio lighting + IBL + grid/axes/
 * wireframe toggles + animation mixer + rAF parked while off-screen +
 * full GPU dispose on unmount. Components own the React shell; this owns
 * the WebGL lifecycle so cleanup can never be half-done.
 */
export class ViewerCore {
  readonly three: any;
  readonly renderer: any;
  readonly scene: any;
  readonly camera: any;
  readonly controls: OrbitControls;

  private container: HTMLElement;
  private content: any = null;
  private grid: any;
  private axes: any;
  private rig: LightingRig;
  private env: { pmrem: any; texture: any };
  private mixer: any = null;
  private clock: any;
  private raycaster: any;
  private ndc: any;
  private raf = 0;
  private onScreen = true;
  private playing = true;
  private wireframeOn = false;
  private disposed = false;
  private home = { position: [0, 0, 0] as number[], target: [0, 0, 0] as number[] };
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private frameHandlers = new Set<(dt: number) => void>();

  constructor(three: any, container: HTMLElement, config: ViewerConfig = {}) {
    this.three = three;
    this.container = container;

    this.renderer = new three.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = three.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    if (config.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = three.PCFSoftShadowMap;
    }
    container.appendChild(this.renderer.domElement);

    this.scene = new three.Scene();
    this.scene.background = new three.Color(config.background ?? "#0B0E14");

    const fov = config.fov ?? 45;
    this.camera = new three.PerspectiveCamera(fov, 1, 0.01, 2000);
    this.camera.position.set(6, 4, 8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.rig = applyLighting(three, this.scene, {
      preset: config.preset,
      shadows: config.shadows,
      ambientIntensity: config.ambientIntensity,
    });
    this.env = buildEnvironment(three, this.renderer);
    this.scene.environment = this.env.texture;
    this.scene.environmentIntensity = this.rig.envIntensity;

    this.grid = new three.GridHelper(10, 10, 0x4A5568, 0x2A3140);
    this.axes = new three.AxesHelper(3);
    this.grid.visible = true;
    this.axes.visible = false;
    this.scene.add(this.grid, this.axes);

    this.clock = new three.Clock();
    this.raycaster = new three.Raycaster();
    this.ndc = new three.Vector2();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.intersectionObserver = new IntersectionObserver(
      entries => { this.onScreen = entries[0]?.isIntersecting ?? true; },
      { threshold: 0.01 },
    );
    this.intersectionObserver.observe(container);

    this.resize();
    this.start();
  }

  /* ── content ─────────────────────────────────────────────────────────── */

  setContent(root: any, clips: any[] = [], opts: { loop?: boolean } = {}): void {
    this.clearContent();
    this.content = root;
    this.scene.add(root);

    if (this.renderer.shadowMap.enabled) {
      root.traverse((obj: any) => {
        if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
      });
    }

    const view = frameObject(this.three, root, this.camera.fov);
    this.camera.position.copy(view.position);
    this.controls.target.copy(view.center);
    this.controls.update();
    this.home = { position: view.position.toArray(), target: view.center.toArray() };

    if (clips.length) {
      this.mixer = new this.three.AnimationMixer(root);
      for (const clip of clips) {
        const action = this.mixer.clipAction(clip);
        action.setLoop(opts.loop === false ? this.three.LoopOnce : this.three.LoopRepeat, Infinity);
        action.clampWhenFinished = opts.loop === false;
        action.play();
      }
    }
  }

  getContent(): any { return this.content; }

  getStats(): SceneStats {
    return this.content ? computeStats(this.content) : { meshes: 0, vertices: 0, triangles: 0 };
  }

  /* ── toggles & camera ────────────────────────────────────────────────── */

  setGrid(on: boolean): void { this.grid.visible = on; }
  setAxes(on: boolean): void { this.axes.visible = on; }

  setWireframe(on: boolean): void {
    this.wireframeOn = on;
    this.content?.traverse((obj: any) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m: any) => { if (m && "wireframe" in m) m.wireframe = on; });
    });
  }
  isWireframe(): boolean { return this.wireframeOn; }

  setPlaying(on: boolean): void { this.playing = on; }
  isPlaying(): boolean { return this.playing; }

  resetView(): void {
    this.camera.position.fromArray(this.home.position);
    this.controls.target.fromArray(this.home.target);
    this.controls.update();
  }

  enterFullscreen(): void {
    if (!document.fullscreenElement) void this.container.requestFullscreen?.();
    else void document.exitFullscreen?.();
  }

  /* ── picking & projection (for HTML overlays) ────────────────────────── */

  pick(clientX: number, clientY: number, pickables: any[]): any | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(pickables, false)[0] ?? null;
  }

  projectToScreen(worldPos: any): { x: number; y: number; behind: boolean } {
    const v = worldPos.clone().project(this.camera);
    const w = this.renderer.domElement.clientWidth || 1;
    const h = this.renderer.domElement.clientHeight || 1;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, behind: v.z > 1 };
  }

  addFrameHandler(fn: (dt: number) => void): void { this.frameHandlers.add(fn); }
  removeFrameHandler(fn: (dt: number) => void): void { this.frameHandlers.delete(fn); }

  /* ── loop & lifecycle ────────────────────────────────────────────────── */

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      if (!this.onScreen) return; // rAF parked while scrolled away
      const dt = this.clock.getDelta();
      if (this.mixer && this.playing) this.mixer.update(dt);
      for (const fn of this.frameHandlers) fn(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private clearContent(): void {
    if (!this.content) return;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.scene.remove(this.content);
    disposeObject3D(this.content);
    this.content = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.frameHandlers.clear();
    this.controls.dispose();
    this.clearContent();
    for (const light of this.rig.lights) {
      this.scene.remove(light);
      light.dispose?.();
    }
    this.scene.remove(this.grid, this.axes);
    disposeObject3D(this.grid);
    disposeObject3D(this.axes);
    this.env.pmrem.dispose();
    this.env.texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
