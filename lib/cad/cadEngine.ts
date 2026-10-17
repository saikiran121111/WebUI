import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CadSpec } from "./cadSchema";
import { specBBox, sunPosition } from "./cad2d";

/**
 * Browser-only BIM massing engine behind the cad viewer's 3D / split views:
 * extrudes the 2D plan's walls and slabs into real three.js meshes, with
 * per-layer visibility, vertical Explode, X/Y/Z section clipping planes, and
 * a time-of-day sun. `three` is injected (same pattern as StudioViewer) so
 * the app keeps a single three instance.
 */

export interface CadBimStats {
  meshes: number;
  vertices: number;
  triangles: number;
}

export interface CadBimOptions {
  background?: string;
  onStats?: (stats: CadBimStats) => void;
}

interface WallMesh {
  mesh: import("three").Mesh;
  baseZ: number;
}

export class CadBimViewer {
  private three: typeof import("three");
  private renderer: import("three").WebGLRenderer;
  private scene: import("three").Scene;
  private camera: import("three").PerspectiveCamera;
  private controls: OrbitControls;
  private root: import("three").Group;
  private sun: import("three").DirectionalLight;
  private ambient: import("three").AmbientLight;
  private grid: import("three").GridHelper | null = null;
  private selectionBox: import("three").BoxHelper | null = null;

  private spec: CadSpec | null = null;
  private materials: import("three").MeshStandardMaterial[] = [];
  private wallMeshes: WallMesh[] = [];
  private clippingPlanes: import("three").Plane[] = [];
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(
    three: typeof import("three"),
    private container: HTMLElement,
    private options: CadBimOptions = {},
  ) {
    this.three = three;
    this.renderer = new three.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = three.PCFSoftShadowMap;
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";
    container.appendChild(this.renderer.domElement);

    this.scene = new three.Scene();
    this.setBackground(this.options.background ?? "#090d16");

    this.camera = new three.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(14, 12, 14);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.ambient = new three.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambient);
    const hemi = new three.HemisphereLight(0xbfd8ff, 0x2b2b33, 0.45);
    this.scene.add(hemi);
    this.sun = new three.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.sun);

    this.root = new three.Group();
    this.scene.add(this.root);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const animate = () => {
      if (this.disposed) return;
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(animate);
  }

  setBackground(color: string): void {
    this.scene.background = new this.three.Color(color);
  }

  setSpec(spec: CadSpec): void {
    this.spec = spec;
    this.clearRoot();
    const bbox = specBBox(spec);
    const layerColor = new Map(spec.layers.map((l) => [l.id, l.color]));

    const materialFor = (layerId: string): import("three").MeshStandardMaterial => {
      const color = layerColor.get(layerId) ?? "#94a3b8";
      const material = new this.three.MeshStandardMaterial({
        color: new this.three.Color(color),
        roughness: 0.85,
        metalness: 0.05,
        clippingPlanes: this.clippingPlanes,
        side: this.three.DoubleSide,
      });
      this.materials.push(material);
      return material;
    };

    for (const wall of spec.walls) {
      const material = materialFor(wall.layer);
      const points = wall.path;
      const segments = wall.closed ? points.length : points.length - 1;
      for (let i = 0; i < segments; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const geometry = new this.three.BoxGeometry(len + wall.thickness, wall.height, wall.thickness);
        const mesh = new this.three.Mesh(geometry, material);
        mesh.position.set(
          (a[0] + b[0]) / 2,
          wall.z + wall.height / 2,
          -(a[1] + b[1]) / 2,
        );
        mesh.rotation.y = Math.atan2(dy, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { id: wall.id, label: wall.label ?? wall.id, layer: wall.layer, kind: "wall" };
        this.root.add(mesh);
        this.wallMeshes.push({ mesh, baseZ: wall.z });
      }
    }

    for (const slab of spec.slabs) {
      const material = materialFor(slab.layer);
      const shape = new this.three.Shape(
        slab.outline.map(([x, y]) => new this.three.Vector2(x, y)),
      );
      const geometry = new this.three.ExtrudeGeometry(shape, {
        depth: slab.thickness,
        bevelEnabled: false,
      });
      geometry.rotateX(-Math.PI / 2);
      const mesh = new this.three.Mesh(geometry, material);
      mesh.position.y = slab.z;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { id: slab.id, label: slab.label ?? slab.id, layer: slab.layer, kind: "slab" };
      this.root.add(mesh);
      this.wallMeshes.push({ mesh, baseZ: slab.z });
    }

    this.applyExplode(this.explodePct);
    this.rebuildGrid(bbox);
    this.frame();
    this.emitStats();
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    for (const child of this.root.children) {
      if (child.userData.layer === layerId) child.visible = visible;
    }
  }

  setSolo(layerId: string | null): void {
    if (!this.spec) return;
    for (const layer of this.spec.layers) {
      this.setLayerVisible(layer.id, layerId === null || layer.id === layerId);
    }
  }

  private explodePct = 0;

  setExplode(pct: number): void {
    this.explodePct = pct;
    this.applyExplode(pct);
  }

  private applyExplode(pct: number): void {
    const factor = pct / 100;
    for (const entry of this.wallMeshes) {
      entry.mesh.position.y = entry.baseZ * (1 + factor * 1.5) + this.meshHalfHeight(entry.mesh);
    }
  }

  private meshHalfHeight(mesh: import("three").Mesh): number {
    if (mesh.userData.kind !== "wall") return 0;
    const geometry = mesh.geometry as import("three").BoxGeometry;
    return (geometry.parameters?.height ?? 0) / 2;
  }

  /** Model-space section cut on the given axis (keeps x/y/z <= value); null disables. */
  setSection(axis: "x" | "y" | "z", value: number | null): void {
    this.sectionValues[axis] = value;
    const list: import("three").Plane[] = [];
    if (this.sectionValues.x !== null) {
      list.push(new this.three.Plane(new this.three.Vector3(-1, 0, 0), this.sectionValues.x));
    }
    if (this.sectionValues.y !== null) {
      list.push(new this.three.Plane(new this.three.Vector3(0, 0, 1), this.sectionValues.y));
    }
    if (this.sectionValues.z !== null) {
      list.push(new this.three.Plane(new this.three.Vector3(0, -1, 0), this.sectionValues.z));
    }
    this.clippingPlanes = list;
    for (const material of this.materials) material.clippingPlanes = list;
  }

  private sectionValues: { x: number | null; y: number | null; z: number | null } = {
    x: null,
    y: null,
    z: null,
  };

  setSun(time: number): void {
    const { altitudeDeg, azimuthDeg } = sunPosition(time);
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (altitudeDeg * Math.PI) / 180;
    const center = this.controls.target;
    const radius = 40;
    this.sun.position.set(
      center.x + Math.sin(az) * Math.cos(el) * radius,
      Math.max(0.5, Math.sin(el) * radius),
      center.z + Math.cos(az) * Math.cos(el) * radius,
    );
    const day = Math.max(0, Math.sin(el));
    this.sun.intensity = 0.25 + day * 1.8;
    this.ambient.intensity = 0.25 + day * 0.4;
    this.sun.color.setHex(day > 0.25 ? 0xfff4e0 : 0x9db4d8);
  }

  setGrid(on: boolean): void {
    if (this.grid) {
      this.grid.visible = on;
      return;
    }
    if (on && this.spec) this.rebuildGrid(specBBox(this.spec));
  }

  frame(): void {
    const box = new this.three.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new this.three.Vector3());
    const size = box.getSize(new this.three.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    this.controls.target.copy(center);
    this.camera.position.set(
      center.x + maxDim * 1.1,
      center.y + maxDim * 0.9,
      center.z + maxDim * 1.1,
    );
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 20;
    this.camera.updateProjectionMatrix();
    this.sun.shadow.camera.left = -maxDim;
    this.sun.shadow.camera.right = maxDim;
    this.sun.shadow.camera.top = maxDim;
    this.sun.shadow.camera.bottom = -maxDim;
    this.sun.shadow.camera.far = maxDim * 6;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  select(id: string | null): void {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as import("three").Material).dispose();
      this.selectionBox = null;
    }
    if (!id) return;
    const mesh = this.root.children.find((child) => child.userData.id === id);
    if (!mesh) return;
    this.selectionBox = new this.three.BoxHelper(mesh, 0x38bdf8);
    this.scene.add(this.selectionBox);
  }

  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new this.three.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new this.three.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const hits = raycaster.intersectObjects(this.root.children, false);
    return hits[0]?.object.userData.id ?? null;
  }

  getRoot(): import("three").Object3D {
    return this.root;
  }

  capturePng(width: number, height: number): Promise<Blob | null> {
    const prev = new this.three.Vector2();
    this.renderer.getSize(prev);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => {
      this.renderer.domElement.toBlob((blob) => {
        this.renderer.setSize(prev.x, prev.y, false);
        this.camera.aspect = prev.x / Math.max(1, prev.y);
        this.camera.updateProjectionMatrix();
        resolve(blob);
      }, "image/png");
    });
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearRoot();
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as import("three").Material).dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearRoot(): void {
    for (const child of this.root.children) {
      const mesh = child as import("three").Mesh;
      mesh.geometry?.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.materials = [];
    this.wallMeshes = [];
    this.root.clear();
  }

  private rebuildGrid(bbox: ReturnType<typeof specBBox>): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as import("three").Material).dispose();
    }
    const size = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 1.6;
    this.grid = new this.three.GridHelper(Math.ceil(size), Math.max(4, Math.round(size)), 0x334155, 0x1e293b);
    this.grid.position.set((bbox.minX + bbox.maxX) / 2, 0, -(bbox.minY + bbox.maxY) / 2);
    this.scene.add(this.grid);
  }

  private resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private emitStats(): void {
    if (!this.options.onStats) return;
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;
    this.root.traverse((child) => {
      const mesh = child as import("three").Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      meshes += 1;
      const position = mesh.geometry.getAttribute("position");
      vertices += position?.count ?? 0;
      triangles += (mesh.geometry.index?.count ?? position?.count ?? 0) / 3;
    });
    this.options.onStats({ meshes, vertices, triangles: Math.round(triangles) });
  }
}
