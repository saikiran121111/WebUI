import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CadSpec, CadDoor, CadWindow, CadFurniture } from "./cadSchema";
import { specBBox, sunPosition } from "./cad2d";
import { deg2rad } from "./cadBlocks";

/**
 * Browser-only BIM cutaway engine behind the cad viewer's 3D / split views:
 * extrudes the 2D plan into real three.js geometry — walls with REAL door and
 * window openings (jambs, headers, glazing, mullions, ajar panels), procedural
 * 3D furniture, glowing circulation tubes — and puts the signature
 * EdgesGeometry outline on every hard-surface mesh for the Revit/BIM look.
 * `three` is injected (same pattern as StudioViewer) so the app keeps a single
 * three instance.
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
  baseH: number;
  bottom: number; // piece bottom offset from the wall base (walls only)
  kind: "wall" | "slab";
}

interface Cut {
  t0: number;
  t1: number;
  bottom: number;
  top: number;
}

export type BimViewDir = "top" | "front" | "right" | "iso-ne" | "iso-sw";

const DOOR_TOP = 2.1;

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
  private ground: import("three").Mesh | null = null;
  private groundMat: import("three").MeshStandardMaterial | null = null;
  private selectionBox: import("three").BoxHelper | null = null;

  private spec: CadSpec | null = null;
  private materials: import("three").MeshStandardMaterial[] = [];
  private edgeMat: import("three").LineBasicMaterial | null = null;
  private wallMeshes: WallMesh[] = [];
  private clippingPlanes: import("three").Plane[] = [];
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private wallHeightOverride: number | null = null;

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
    this.setBackground(this.options.background ?? "#060a12");

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

  /* ── shared materials ─────────────────────────────────────────────────── */

  private edgeMaterial(): import("three").LineBasicMaterial {
    if (!this.edgeMat) {
      this.edgeMat = new this.three.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
        clippingPlanes: this.clippingPlanes,
      });
    }
    return this.edgeMat;
  }

  /** Signature BIM edge shader: cyan silhouette + crease lines on every mesh. */
  private addEdges(mesh: import("three").Mesh): void {
    const lines = new this.three.LineSegments(
      new this.three.EdgesGeometry(mesh.geometry, 15),
      this.edgeMaterial(),
    );
    lines.userData = { cadEdge: true };
    mesh.add(lines);
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

    const matchedDoors = new Set<string>();
    const matchedWindows = new Set<string>();

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
        const angle = Math.atan2(dy, dx);

        // Collect door/window openings that fall on this segment.
        const cuts: Cut[] = [];
        for (const door of spec.doors) {
          if (matchedDoors.has(door.id)) continue;
          const span = this.projectOpening(a, dx, dy, len, [door.hinge], door.width);
          if (!span) continue;
          matchedDoors.add(door.id);
          cuts.push({ t0: span.t0, t1: span.t1, bottom: 0, top: Math.min(DOOR_TOP, wall.height) });
          this.addDoor3D(wall, angle, door, a, dx, dy, len, span);
        }
        for (const win of spec.windows) {
          if (matchedWindows.has(win.id)) continue;
          const span = this.projectOpening(a, dx, dy, len, [win.from, win.to], 0);
          if (!span) continue;
          matchedWindows.add(win.id);
          cuts.push({
            t0: span.t0,
            t1: span.t1,
            bottom: Math.min(win.sillHeight, wall.height),
            top: Math.min(win.headHeight, wall.height),
          });
          this.addWindow3D(wall, angle, win, a, dx, dy, len, span);
        }

        this.addWallPieces(wall, material, a, dx, dy, len, angle, cuts);
      }
    }

    // Openings that matched no wall still get drawn standalone from their own data.
    for (const door of spec.doors) {
      if (matchedDoors.has(door.id)) continue;
      const fake = { id: door.id, layer: door.layer, path: [[door.hinge[0], door.hinge[1]], [door.hinge[0] + Math.cos(deg2rad(door.angleDeg)) * door.width, door.hinge[1] + Math.sin(deg2rad(door.angleDeg)) * door.width]] as [number, number][], height: DOOR_TOP, thickness: 0.2, z: 0, closed: false };
      this.addDoor3D(fake as CadSpec["walls"][number], deg2rad(door.angleDeg), door, fake.path[0], fake.path[1][0] - fake.path[0][0], fake.path[1][1] - fake.path[0][1], door.width, { t0: 0, t1: 1 });
    }
    for (const win of spec.windows) {
      if (matchedWindows.has(win.id)) continue;
      const dx = win.to[0] - win.from[0];
      const dy = win.to[1] - win.from[1];
      const len = Math.hypot(dx, dy) || 1;
      const fake = { id: win.id, layer: win.layer, path: [win.from, win.to] as [number, number][], height: win.headHeight, thickness: 0.15, z: 0, closed: false };
      this.addWindow3D(fake as CadSpec["walls"][number], Math.atan2(dy, dx), win, win.from, dx, dy, len, { t0: 0, t1: 1 });
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
      this.addEdges(mesh);
      this.root.add(mesh);
      this.wallMeshes.push({ mesh, baseZ: slab.z, baseH: slab.thickness, bottom: 0, kind: "slab" });
    }

    for (const f of spec.furniture) this.addFurniture3D(f, materialFor);

    this.addFlowTubes(spec);
    this.buildGround(bbox, spec);
    this.applyExplode(this.explodePct);
    this.rebuildGrid(bbox);
    this.frame();
    this.emitStats();
  }

  /* ── wall extrusion with real openings ────────────────────────────────── */

  /** Project opening endpoints onto a wall segment; null when it misses. */
  private projectOpening(
    a: [number, number],
    dx: number,
    dy: number,
    len: number,
    pts: [number, number][],
    halfWidth: number,
  ): { t0: number; t1: number } | null {
    const ux = dx / len;
    const uy = dy / len;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const p of pts) {
      const px = p[0] - a[0];
      const py = p[1] - a[1];
      const t = (px * ux + py * uy) / len;
      const perp = Math.abs(px * uy - py * ux);
      if (perp > Math.max(0.35, 0.2) + 0.25) return null;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    if (halfWidth > 0) {
      const mid = (t0 + t1) / 2;
      const half = halfWidth / 2 / len;
      t0 = mid - half;
      t1 = mid + half;
    }
    if (t1 <= 0.005 || t0 >= 0.995) return null;
    return { t0: Math.max(0, t0), t1: Math.min(1, t1) };
  }

  private addWallPieces(
    wall: CadSpec["walls"][number],
    material: import("three").MeshStandardMaterial,
    a: [number, number],
    dx: number,
    dy: number,
    len: number,
    angle: number,
    cuts: Cut[],
  ): void {
    const piece = (t0: number, t1: number, bottom: number, top: number): void => {
      const pieceLen = (t1 - t0) * len;
      const pieceH = top - bottom;
      if (pieceLen < 0.02 || pieceH < 0.02) return;
      const midT = (t0 + t1) / 2;
      const geometry = new this.three.BoxGeometry(pieceLen, pieceH, wall.thickness);
      const mesh = new this.three.Mesh(geometry, material);
      mesh.position.set(a[0] + dx * midT, wall.z + bottom + pieceH / 2, -(a[1] + dy * midT));
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { id: wall.id, label: wall.label ?? wall.id, layer: wall.layer, kind: "wall" };
      this.addEdges(mesh);
      this.root.add(mesh);
      this.wallMeshes.push({ mesh, baseZ: wall.z, baseH: pieceH, bottom, kind: "wall" });
    };

    if (!cuts.length) {
      piece(0, 1, 0, wall.height);
      return;
    }
    cuts.sort((p, q) => p.t0 - q.t0);
    let cursor = 0;
    for (const cut of cuts) {
      const c0 = Math.max(0, cut.t0);
      const c1 = Math.min(1, cut.t1);
      if (c1 <= cursor + 0.005) continue;
      if (c0 > cursor) piece(cursor, c0, 0, wall.height);
      if (cut.bottom > 0.02) piece(c0, c1, 0, Math.min(cut.bottom, wall.height));
      if (cut.top < wall.height - 0.02) piece(c0, c1, Math.min(cut.top, wall.height), wall.height);
      cursor = Math.max(cursor, c1);
    }
    if (cursor < 0.995) piece(cursor, 1, 0, wall.height);
  }

  private addDoor3D(
    wall: CadSpec["walls"][number],
    angle: number,
    door: CadDoor,
    a: [number, number],
    dx: number,
    dy: number,
    len: number,
    span: { t0: number; t1: number },
  ): void {
    const three = this.three;
    const material = this.materials.find(m => m.color) ?? null;
    const frameMat = new three.MeshStandardMaterial({
      color: new three.Color("#475569"),
      roughness: 0.6,
      metalness: 0.25,
      clippingPlanes: this.clippingPlanes,
    });
    this.materials.push(frameMat);
    const cutTop = Math.min(DOOR_TOP, wall.height);

    // Jambs at both ends of the opening.
    for (const t of [span.t0, span.t1]) {
      const geometry = new three.BoxGeometry(0.06, cutTop, wall.thickness + 0.02);
      const mesh = new three.Mesh(geometry, frameMat);
      mesh.position.set(a[0] + dx * t, wall.z + cutTop / 2, -(a[1] + dy * t));
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.userData = { id: door.id, label: door.id, layer: door.layer, kind: "door" };
      this.addEdges(mesh);
      this.root.add(mesh);
    }

    // Leaf, slightly ajar, hinged at the hinge point.
    const panelH = Math.max(0.4, cutTop - 0.06);
    const panelMat = new three.MeshStandardMaterial({
      color: new three.Color("#64748b"),
      roughness: 0.5,
      metalness: 0.3,
      clippingPlanes: this.clippingPlanes,
    });
    this.materials.push(panelMat);
    const geometry = new three.BoxGeometry(door.width, panelH, 0.05);
    geometry.translate(door.width / 2, 0, 0);
    const panel = new three.Mesh(geometry, panelMat);
    panel.position.set(door.hinge[0], wall.z + 0.03 + panelH / 2, -door.hinge[1]);
    panel.rotation.y = deg2rad(door.angleDeg + door.swingDeg * 0.25);
    panel.castShadow = true;
    panel.userData = { id: door.id, label: door.id, layer: door.layer, kind: "door" };
    this.addEdges(panel);
    this.root.add(panel);
    void material;
  }

  private addWindow3D(
    wall: CadSpec["walls"][number],
    angle: number,
    win: CadWindow,
    a: [number, number],
    dx: number,
    dy: number,
    len: number,
    span: { t0: number; t1: number },
  ): void {
    const three = this.three;
    const midT = (span.t0 + span.t1) / 2;
    const cx = a[0] + dx * midT;
    const cz = -(a[1] + dy * midT);
    const openLen = (span.t1 - span.t0) * len;
    const sill = Math.min(win.sillHeight, wall.height);
    const head = Math.min(Math.max(win.headHeight, sill + 0.1), wall.height);
    const glassH = head - sill;

    const glassMat = new three.MeshPhysicalMaterial({
      color: new three.Color("#9db8d8"),
      transparent: true,
      opacity: 0.35,
      roughness: 0.15,
      metalness: 0.1,
      clippingPlanes: this.clippingPlanes,
      side: three.DoubleSide,
    });
    this.materials.push(glassMat as unknown as import("three").MeshStandardMaterial);

    const glass = new three.Mesh(new three.BoxGeometry(openLen, glassH, 0.03), glassMat);
    glass.position.set(cx, wall.z + sill + glassH / 2, cz);
    glass.rotation.y = angle;
    glass.userData = { id: win.id, label: win.id, layer: win.layer, kind: "window" };
    this.root.add(glass);

    const mullionMat = new three.MeshStandardMaterial({
      color: new three.Color("#94a3b8"),
      roughness: 0.35,
      metalness: 0.7,
      clippingPlanes: this.clippingPlanes,
    });
    this.materials.push(mullionMat);
    for (let i = 1; i <= win.mullions; i++) {
      const t = span.t0 + (span.t1 - span.t0) * (i / (win.mullions + 1));
      const mesh = new three.Mesh(new three.BoxGeometry(0.05, glassH, 0.08), mullionMat);
      mesh.position.set(a[0] + dx * t, wall.z + sill + glassH / 2, -(a[1] + dy * t));
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.userData = { id: win.id, label: win.id, layer: win.layer, kind: "window" };
      this.addEdges(mesh);
      this.root.add(mesh);
    }

    const sillMesh = new three.Mesh(
      new three.BoxGeometry(openLen + 0.08, 0.06, wall.thickness + 0.1),
      mullionMat,
    );
    sillMesh.position.set(cx, wall.z + sill - 0.03, cz);
    sillMesh.rotation.y = angle;
    sillMesh.castShadow = true;
    sillMesh.userData = { id: win.id, label: win.id, layer: win.layer, kind: "window" };
    this.addEdges(sillMesh);
    this.root.add(sillMesh);
  }

  /* ── procedural 3D furniture ──────────────────────────────────────────── */

  private addFurniture3D(f: CadFurniture, materialFor: (layerId: string) => import("three").MeshStandardMaterial): void {
    const three = this.three;
    const group = new three.Group();
    group.position.set(f.x, 0, -f.y);
    group.rotation.y = deg2rad(f.rotation);
    group.userData = { id: f.id, label: f.label ?? f.id, layer: f.layer, kind: "furniture" };
    const material = materialFor(f.layer);
    const meta = { id: f.id, label: f.label ?? f.id, layer: f.layer, kind: "furniture" };

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat = material): void => {
      const mesh = new three.Mesh(new three.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = meta;
      this.addEdges(mesh);
      group.add(mesh);
    };
    const cyl = (r: number, h: number, x: number, y: number, z: number, mat = material): void => {
      const mesh = new three.Mesh(new three.CylinderGeometry(r, r, h, 12), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.userData = meta;
      this.addEdges(mesh);
      group.add(mesh);
    };
    // model-local (lx, ly) y-up → three (lx, ·, -ly)
    const legs = (w: number, h: number, top: number): void => {
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        cyl(0.04, top, sx * (w / 2 - 0.08), top / 2, -sy * (h / 2 - 0.08));
      }
    };

    switch (f.category) {
      case "sofa":
        box(f.w, 0.42, f.h, 0, 0.21, 0);
        box(f.w, 0.75, 0.18, 0, 0.375, -(f.h / 2 - 0.09));
        box(0.18, 0.6, f.h, -(f.w / 2 - 0.09), 0.3, 0);
        box(0.18, 0.6, f.h, f.w / 2 - 0.09, 0.3, 0);
        break;
      case "table":
      case "dining_table":
      case "coffee_table":
      case "desk": {
        const top = f.category === "coffee_table" ? 0.42 : f.category === "desk" ? 0.74 : 0.72;
        box(f.w, 0.05, f.h, 0, top - 0.025, 0);
        legs(f.w, f.h, top - 0.05);
        if (f.category === "desk") box(Math.min(0.5, f.w * 0.4), 0.3, 0.04, 0, top + 0.15, -(f.h / 2 - 0.12));
        break;
      }
      case "counter":
        box(f.w, 0.9, f.h, 0, 0.45, 0);
        break;
      case "sink":
        box(f.w, 0.85, f.h, 0, 0.425, 0);
        cyl(Math.min(f.w, f.h) * 0.3, 0.06, 0, 0.86, 0);
        break;
      case "bed":
        box(f.w, 0.3, f.h, 0, 0.15, 0);
        box(f.w - 0.06, 0.2, f.h - 0.06, 0, 0.4, 0);
        box(f.w * 0.4, 0.1, f.h * 0.22, -f.w * 0.24, 0.55, -f.h * 0.36);
        box(f.w * 0.4, 0.1, f.h * 0.22, f.w * 0.24, 0.55, -f.h * 0.36);
        break;
      case "wardrobe":
        box(f.w, 2.1, f.h, 0, 1.05, 0);
        break;
      case "toilet":
        box(Math.min(0.65, f.w), 0.42, 0.22, 0, 0.21, -(f.h / 2 - 0.11));
        cyl(0.2, 0.4, 0, 0.2, f.h * 0.1);
        break;
      case "shower": {
        box(f.w, 0.1, f.h, 0, 0.05, 0);
        const glassMat = new three.MeshPhysicalMaterial({
          color: new three.Color("#9db8d8"),
          transparent: true,
          opacity: 0.3,
          roughness: 0.15,
          clippingPlanes: this.clippingPlanes,
          side: three.DoubleSide,
        });
        this.materials.push(glassMat as unknown as import("three").MeshStandardMaterial);
        const p1 = new three.Mesh(new three.BoxGeometry(f.w, 1.9, 0.02), glassMat);
        p1.position.set(0, 1.05, -f.h / 2);
        p1.userData = meta;
        group.add(p1);
        const p2 = new three.Mesh(new three.BoxGeometry(0.02, 1.9, f.h), glassMat);
        p2.position.set(-f.w / 2, 1.05, 0);
        p2.userData = meta;
        group.add(p2);
        break;
      }
      case "chair":
        box(f.w, 0.05, f.h, 0, 0.45, 0);
        box(f.w, 0.4, 0.05, 0, 0.68, -(f.h / 2 - 0.025));
        legs(f.w, f.h, 0.45);
        break;
      case "shelving":
        box(f.w, 1.8, f.h, 0, 0.9, 0);
        for (let i = 1; i <= 3; i++) box(f.w + 0.02, 0.03, f.h + 0.02, 0, (i / 4) * 1.8, 0);
        break;
      case "stairs": {
        const n = Math.max(3, Math.round(f.h / 0.28));
        const rise = Math.min(0.2, 2.6 / n);
        for (let i = 0; i < n; i++) {
          box(f.w, 0.05, f.h / n, 0, (i + 0.5) * rise, -((i + 0.5) / n) * f.h + f.h / 2 - f.h / 2 + (i + 0.5) * (f.h / n) - f.h / 2);
        }
        // handrail
        const rail = new three.Mesh(new three.CylinderGeometry(0.03, 0.03, Math.hypot(f.h, n * rise), 8), material);
        rail.rotation.x = Math.atan2(n * rise, f.h);
        rail.position.set(f.w / 2 - 0.05, n * rise * 0.55 + 0.5, 0);
        rail.userData = meta;
        group.add(rail);
        break;
      }
      case "plant":
        cyl(Math.min(f.w, f.h) * 0.28, 0.35, 0, 0.175, 0);
        {
          const foliage = new three.Mesh(
            new three.SphereGeometry(Math.min(f.w, f.h) * 0.45, 12, 10),
            new three.MeshStandardMaterial({ color: new three.Color("#4d7c5f"), roughness: 0.9, clippingPlanes: this.clippingPlanes }),
          );
          foliage.position.set(0, 0.85, 0);
          foliage.castShadow = true;
          foliage.userData = meta;
          group.add(foliage);
        }
        break;
      case "server_rack": {
        box(f.w, 2, f.h, 0, 1, 0);
        const ledMat = new three.MeshStandardMaterial({
          color: new three.Color("#0f172a"),
          emissive: new three.Color("#38bdf8"),
          emissiveIntensity: 1.6,
          clippingPlanes: this.clippingPlanes,
        });
        this.materials.push(ledMat);
        for (let i = 1; i <= 3; i++) box(f.w * 0.8, 0.04, 0.02, 0, (i / 4) * 2, f.h / 2 + 0.005, ledMat);
        break;
      }
      case "appliance":
        box(f.w, 0.9, f.h, 0, 0.45, 0);
        break;
      default:
        box(f.w, 0.75, f.h, 0, 0.375, 0);
    }

    this.root.add(group);
  }

  /* ── glowing circulation tubes ────────────────────────────────────────── */

  private addFlowTubes(spec: CadSpec): void {
    const three = this.three;
    for (const flow of spec.flows) {
      if (flow.points.length < 2) continue;
      const curve = new three.CatmullRomCurve3(
        flow.points.map(([x, y]) => new three.Vector3(x, flow.z + 0.35, -y)),
        false,
        "catmullrom",
        0.2,
      );
      const mesh = new three.Mesh(
        new three.TubeGeometry(curve, Math.min(64, flow.points.length * 8), 0.05, 8, false),
        new three.MeshBasicMaterial({ color: new three.Color(flow.color), toneMapped: false }),
      );
      mesh.userData = { id: flow.id, label: flow.label ?? flow.id, layer: "layer-flow", kind: "flow" };
      this.root.add(mesh);
    }
  }

  /* ── ground plane ─────────────────────────────────────────────────────── */

  private buildGround(bbox: ReturnType<typeof specBBox>, spec: CadSpec): void {
    const three = this.three;
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      this.groundMat?.dispose();
      this.ground = null;
    }
    const minY = Math.min(0, ...spec.slabs.map((s) => s.z));
    const size = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 3 + 8;
    this.groundMat = new three.MeshStandardMaterial({ color: new three.Color("#0b101b"), roughness: 0.95, metalness: 0 });
    const mesh = new three.Mesh(new three.PlaneGeometry(size, size), this.groundMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((bbox.minX + bbox.maxX) / 2, minY - 0.05, -(bbox.minY + bbox.maxY) / 2);
    mesh.receiveShadow = true;
    this.ground = mesh;
    this.scene.add(mesh);
  }

  /* ── layer visibility / explode / section ─────────────────────────────── */

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

  /** Cutaway slider: cap every wall piece at this height (null = full height). */
  setWallHeight(h: number | null): void {
    this.wallHeightOverride = h;
    this.applyExplode(this.explodePct);
  }

  private applyExplode(pct: number): void {
    const factor = pct / 100;
    for (const entry of this.wallMeshes) {
      const lift = entry.baseZ * (1 + factor * 1.5);
      if (entry.kind === "wall") {
        const cap = this.wallHeightOverride;
        if (cap != null && entry.bottom >= cap) {
          entry.mesh.scale.y = 0.0001;
          entry.mesh.position.y = lift + entry.bottom;
          continue;
        }
        const h = cap != null ? Math.min(entry.baseH, cap - entry.bottom) : entry.baseH;
        entry.mesh.scale.y = h / entry.baseH;
        entry.mesh.position.y = lift + entry.bottom + h / 2;
      } else {
        entry.mesh.position.y = lift + entry.baseH / 2;
      }
    }
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
    if (this.edgeMat) this.edgeMat.clippingPlanes = list;
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

  /** ViewCube presets: model→three mapping keeps the plan centered. */
  setView(dir: BimViewDir): void {
    const box = new this.three.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new this.three.Vector3());
    const size = box.getSize(new this.three.Vector3());
    const d = Math.max(Math.max(size.x, size.y, size.z), 1) * 1.6;
    this.camera.up.set(0, 1, 0);
    if (dir === "top") {
      this.camera.position.set(center.x, center.y + d, center.z + 0.001);
    } else if (dir === "front") {
      this.camera.position.set(center.x, center.y + d * 0.15, center.z + d);
    } else if (dir === "right") {
      this.camera.position.set(center.x + d, center.y + d * 0.15, center.z);
    } else {
      const sign = dir === "iso-ne" ? 1 : -1;
      const k = d / Math.hypot(0.62, 0.5, 0.62);
      this.camera.position.set(
        center.x + 0.62 * k * sign,
        center.y + 0.5 * k,
        center.z - 0.62 * k * sign,
      );
    }
    this.controls.target.copy(center);
    this.controls.update();
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
    const hits = raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      let obj: import("three").Object3D | null = hit.object;
      while (obj) {
        if (obj.userData?.id && !obj.userData?.cadEdge) return obj.userData.id as string;
        obj = obj.parent;
      }
    }
    return null;
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
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
    }
    this.groundMat?.dispose();
    this.edgeMat?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearRoot(): void {
    this.root.traverse((obj) => {
      const mesh = obj as import("three").Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
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
    const minY = this.spec ? Math.min(0, ...this.spec.slabs.map((s) => s.z)) : 0;
    this.grid.position.set((bbox.minX + bbox.maxX) / 2, minY - 0.04, -(bbox.minY + bbox.maxY) / 2);
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
