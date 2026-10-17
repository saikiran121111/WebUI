"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Axis3d, Box, ChevronDown, ChevronRight, Download, Eye, EyeOff,
  Grid3x3, Maximize2, MessageSquarePlus, Minimize2, Move, Pause, Play, RotateCcw,
  RotateCw, Scale3d, Target,
} from "lucide-react";
import type { Scene3DSpec } from "../../lib/three3d/sceneSchema";
import type { MeshExportFormat } from "../../lib/three3d/exporters";
import type {
  BackgroundSpec, LightState, MaterialInfo, OutlinerNode,
  ShadingMode, StudioStats, TransformMode,
} from "../../lib/three3d/studioEngine";
import { fenceFixRequest } from "../../lib/render/fenceRepair";

/**
 * ThreeStudioViewer — the Blender/Maya-grade studio front-end for ```scene3d
 * fences. All three.js code (engine + builders + exporters) loads via
 * dynamic import on mount, so the base bundle never pays for three.
 *
 * Layout: top toolbar (shading / projection / FOV / views / transform /
 * overlays), stage with floating docks — left Outliner (tree, hide, solo),
 * right material + environment + lighting + post-FX, bottom timeline +
 * explode — plus a stats HUD and a ViewCube gizmo in the top-right corner.
 */

export type StudioExportFormat =
  | "glb" | "gltf" | "obj" | "stl" | "ply" | "usdz" | "html" | "tsx" | "png";

const EXPORT_FORMATS: Array<{ value: StudioExportFormat; label: string }> = [
  { value: "glb", label: "GLB" },
  { value: "gltf", label: "GLTF" },
  { value: "obj", label: "OBJ" },
  { value: "stl", label: "STL" },
  { value: "ply", label: "PLY" },
  { value: "usdz", label: "USDZ" },
  { value: "html", label: "HTML (standalone)" },
  { value: "tsx", label: "TSX (R3F)" },
  { value: "png", label: "PNG 4K" },
];

const SHADING_OPTIONS: Array<{ value: ShadingMode; label: string }> = [
  { value: "rendered", label: "Rendered" },
  { value: "solid", label: "Solid (MatCap)" },
  { value: "wireframe", label: "Wireframe" },
  { value: "wireframeShaded", label: "Wire on Shaded" },
  { value: "normals", label: "Normals" },
  { value: "uv", label: "UV Checker" },
  { value: "unlit", label: "Unlit" },
  { value: "xray", label: "X-Ray" },
];

const ENV_OPTIONS = ["studio-soft", "cyberpunk-neon", "sunset-gold", "showroom-white", "deep-space", "night"];

/** Code-mode viewers have no spec: a stable empty spec keeps effect deps constant. */
const EMPTY_SPEC = { title: "Three.js model", objects: [] } as unknown as Scene3DSpec;

interface ThreeStudioViewerProps {
  /** Normalized ```scene3d contract. */
  spec?: Scene3DSpec;
  /** Executable ```threejs fence body — runs in this live scene instead of spec. */
  code?: string;
  onSend?: (text: string) => void;
  /** Reports a code-level failure (syntax/runtime/empty scene) for auto-repair. */
  onRuntimeError?: (info: { error: string }) => void;
}

interface SelectedPart { id: string; label: string }

export default function ThreeStudioViewer({ spec: specIn, code, onSend, onRuntimeError }: ThreeStudioViewerProps) {
  const spec = useMemo(() => specIn ?? EMPTY_SPEC, [specIn]);
  const onRuntimeErrorRef = useRef(onRuntimeError);
  onRuntimeErrorRef.current = onRuntimeError;
  const stageRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const threeRef = useRef<any>(null);
  const clipsRef = useRef<any[]>([]);
  const sliderValuesRef = useRef<Record<string, number>>({});
  const scrubRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);
  const lastHoverIdRef = useRef<string | null>(null);

  const [glError, setGlError] = useState(false);
  const [stats, setStats] = useState<StudioStats | null>(null);
  const [selected, setSelected] = useState<SelectedPart | null>(null);
  const [matForm, setMatForm] = useState<MaterialInfo | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const [outliner, setOutliner] = useState<OutlinerNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [soloId, setSoloId] = useState<string | null>(null);

  const [shading, setShading] = useState<ShadingMode>("rendered");
  const [projection, setProjection] = useState("perspective");
  const [fov, setFov] = useState(spec.camera?.fov ?? 45);
  const [autoRotate, setAutoRotate] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [axesOn, setAxesOn] = useState(false);
  const [bboxOn, setBboxOn] = useState(false);
  const [cageOn, setCageOn] = useState(false);
  const [helpersOn, setHelpersOn] = useState(false);
  const [transformMode, setTransformMode] = useState<TransformMode | null>(null);
  const [transformSpace, setTransformSpace] = useState<"local" | "world">("local");

  const [envPreset, setEnvPreset] = useState(spec.lighting?.preset === "space" ? "deep-space" : "studio-soft");
  const [bgMode, setBgMode] = useState<BackgroundSpec["mode"]>("dark");
  const [bgColor, setBgColor] = useState("#0B0E14");
  const [toneMapping, setToneMapping] = useState("ACESFilmic");
  const [bloomOn, setBloomOn] = useState(false);
  const [ssaoOn, setSsaoOn] = useState(false);
  const [vignetteOn, setVignetteOn] = useState(false);

  const [lights, setLights] = useState<LightState | null>(null);
  const [playing, setPlaying] = useState(true);
  const [duration, setDuration] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [clipId, setClipId] = useState("all");
  const [clipIds, setClipIds] = useState<string[]>([]);
  const [explode, setExplode] = useState(0);

  const [sliderValues, setSliderValues] = useState<Record<string, number>>({});
  const [exportFmt, setExportFmt] = useState<StudioExportFormat>("glb");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNote, setExportNote] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeUpdateRef = useRef<((delta: number, elapsed: number) => void) | null>(null);
  const elapsedRef = useRef(0);

  // Fullscreen takes the whole .scene3d-block (toolbar stays usable); the
  // stage flexes to fill the rest via the :fullscreen rules in globals.css.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => {
      const el = document.fullscreenElement;
      const stage = stageRef.current;
      setIsFullscreen(!!el && !!stage && (el === stage || el.contains(stage)));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  function toggleStageFullscreen() {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    const stage = stageRef.current;
    const target = stage?.closest(".scene3d-block") ?? stage;
    void target?.requestFullscreen?.();
  }

  const hasAnimations = (spec.animations?.length ?? 0) > 0;
  const exportFilename = useMemo(() => {
    if (spec.export?.filename) return spec.export.filename;
    const slug = (spec.title ?? "scene").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "scene";
  }, [spec]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let disposed = false;
    let frameHandler: ((dt: number) => void) | null = null;
    const cleanups: Array<() => void> = [];
    const interactions = spec.interactions ?? {};

    void (async () => {
      const three = await import("three");
      if (disposed) return;
      const [{ StudioViewer }, { buildScene, buildAnimationClips }] = await Promise.all([
        import("../../lib/three3d/studioEngine"),
        import("../../lib/three3d/sceneBuilder"),
      ]);
      if (disposed || !stageRef.current) return;

      let viewer: any;
      try {
        viewer = new StudioViewer(three, stage, {
          fov: spec.camera?.fov ?? 45,
          lightingPreset: spec.lighting?.preset ?? "studio",
          envPreset: spec.lighting?.preset === "space" ? "deep-space" : "studio-soft",
          onStats: (s: StudioStats) => setStats(s),
        });
      } catch {
        setGlError(true);
        return;
      }
      threeRef.current = three;
      viewerRef.current = viewer;
      // Live engine handle for the visible Playwright suite: assertions read the
      // real scene graph (mesh.visible, gizmo attach, explode offsets) not React state.
      (window as any).__studioViewer = viewer;
      cleanups.push(() => { if ((window as any).__studioViewer === viewer) delete (window as any).__studioViewer; });
      if (interactions.orbit === false) viewer.controls.enableRotate = false;
      if (interactions.pan === false) viewer.controls.enablePan = false;
      viewer.setLight({ shadows: spec.lighting?.shadows ?? false, ambientIntensity: spec.lighting?.ambientIntensity ?? viewer.getLights().ambientIntensity });
      setLights(viewer.getLights());

      // Two content modes: executable ```threejs fence, or normalized scene3d spec.
      let nodesById: Map<string, any>;
      if (code) {
        const { runThreeCode } = await import("../../lib/three3d/codeRunner");
        const run = runThreeCode(three, code);
        if (!run.ok) {
          setCodeError(run.error);
          onRuntimeErrorRef.current?.({ error: run.error });
          nodesById = new Map();
          viewer.setContent(new three.Group(), []);
        } else {
          nodesById = new Map();
          run.root.traverse((obj: any) => { if (obj.name) nodesById.set(obj.name, obj); });
          codeUpdateRef.current = run.onUpdate;
          elapsedRef.current = 0;
          viewer.setContent(run.root, []);
        }
      } else {
        const built = buildScene(three, spec);
        const clips = buildAnimationClips(three, spec, built.nodesById);
        clipsRef.current = clips;
        nodesById = built.nodesById;
        viewer.setContent(built.root, clips);
      }
      setOutliner(viewer.getOutliner());
      setClipIds(viewer.getClipIds());
      setDuration(viewer.getDuration());

      if (spec.camera?.position) {
        viewer.activeCamera.position.fromArray(spec.camera.position);
        viewer.controls.target.fromArray(spec.camera.target ?? [0, 0, 0]);
        viewer.controls.update();
      }

      // One frame handler rides the engine's rAF after the mixer + explode:
      // spec sliders override their channel, label tags follow their node,
      // and the timeline scrubber tracks playback without React churn.
      frameHandler = (dt: number) => {
        if (codeUpdateRef.current) {
          elapsedRef.current += dt;
          try { codeUpdateRef.current(dt, elapsedRef.current); } catch { /* a broken onUpdate must not kill the render loop */ }
        }
        for (const sl of spec.sliders ?? []) {
          const node = nodesById.get(sl.target);
          if (!node) continue;
          const v = Number.isFinite(sliderValuesRef.current[sl.id]) ? sliderValuesRef.current[sl.id]! : sl.defaultValue;
          const axisIdx = sl.axis === "x" ? 0 : sl.axis === "y" ? 1 : 2;
          if (sl.binding === "rotation") node.rotation[sl.axis] = v;
          else if (sl.binding === "scale") node.scale.setComponent(axisIdx, v);
          else if (sl.binding.startsWith("material.")) {
            const mat = node.material;
            if (!mat) continue;
            if (sl.binding === "material.emissiveIntensity") mat.emissiveIntensity = v;
            else if (sl.binding === "material.roughness") mat.roughness = v;
            else if (sl.binding === "material.metalness") mat.metalness = v;
            else if (sl.binding === "material.opacity") { mat.opacity = v; mat.transparent = v < 1; }
          }
          else node.position.setComponent(axisIdx, v);
        }
        const layer = labelLayerRef.current;
        if (layer && spec.labels?.length) {
          for (const label of spec.labels) {
            const node = nodesById.get(label.target);
            if (!node) continue;
            let tag = layer.querySelector<HTMLElement>(`[data-label-target="${label.target}"]`);
            if (!tag) {
              tag = document.createElement("span");
              tag.className = "scene3d-label-tag";
              tag.dataset.labelTarget = label.target;
              tag.textContent = label.text;
              layer.appendChild(tag);
            }
            const world = node.getWorldPosition(new three.Vector3());
            if (label.offset) world.add(new three.Vector3(label.offset[0], label.offset[1], label.offset[2]));
            const p = viewer.projectToScreen(world);
            tag.style.display = p.behind ? "none" : "";
            tag.style.left = `${p.x}px`;
            tag.style.top = `${p.y}px`;
          }
        }
        if (scrubRef.current && !scrubbingRef.current) {
          scrubRef.current.value = String(viewer.getTime());
          if (timeRef.current) timeRef.current.textContent = `${viewer.getTime().toFixed(1)}s`;
        }
      };
      viewer.addFrameHandler(frameHandler);

      let downX = 0;
      let downY = 0;
      const canvasEl: HTMLCanvasElement = viewer.renderer.domElement;
      const onPointerDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
      const onPointerUp = (e: PointerEvent) => {
        if (interactions.select === false) return;
        if (e.target !== canvasEl) return; // dock/HUD clicks bubble here — they must never pick or clear the selection
        if (viewer.handleGizmoClick(e.clientX, e.clientY)) return; // ViewCube handled it
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) return; // orbit drag, not a pick
        const id = viewer.pick(e.clientX, e.clientY);
        if (!id) { setSelected(null); viewer.select(null); setMatForm(null); return; }
        const node = nodesById.get(id);
        setSelected({ id, label: node?.userData?.label ?? id });
        viewer.select(id);
        setMatForm(viewer.getMaterial(id));
      };
      let hoverQueued = false;
      const onPointerMove = (e: PointerEvent) => {
        if (interactions.hover === false || hoverQueued) return;
        if (e.target !== canvasEl) return; // no hover-picking through the dock chrome
        hoverQueued = true;
        requestAnimationFrame(() => {
          hoverQueued = false;
          const id = viewer.pick(e.clientX, e.clientY);
          if (!id) { lastHoverIdRef.current = null; setHover(null); return; }
          if (id === lastHoverIdRef.current) return;
          lastHoverIdRef.current = id;
          const rect = stage.getBoundingClientRect();
          setHover({ label: nodesById.get(id)?.userData?.label ?? id, x: e.clientX - rect.left, y: e.clientY - rect.top });
        });
      };
      stage.addEventListener("pointerdown", onPointerDown);
      stage.addEventListener("pointerup", onPointerUp);
      stage.addEventListener("pointermove", onPointerMove);
      cleanups.push(() => {
        stage.removeEventListener("pointerdown", onPointerDown);
        stage.removeEventListener("pointerup", onPointerUp);
        stage.removeEventListener("pointermove", onPointerMove);
      });
    })();

    return () => {
      disposed = true;
      viewerRef.current?.removeFrameHandler(frameHandler);
      cleanups.forEach(fn => fn());
      viewerRef.current?.dispose();
      viewerRef.current = null;
      threeRef.current = null;
      clipsRef.current = [];
      labelLayerRef.current?.replaceChildren();
      setSelected(null);
      setMatForm(null);
      setHover(null);
      setStats(null);
      codeUpdateRef.current = null;
      elapsedRef.current = 0;
      setCodeError(null);
    };
  }, [spec, code]);

  /* ── dock handlers (all cheap engine calls, no remount) ─────────────── */

  const patchLight = (patch: Partial<LightState>) => {
    viewerRef.current?.setLight(patch);
    setLights(viewerRef.current?.getLights() ?? null);
  };
  const patchMaterial = (patch: Partial<MaterialInfo>) => {
    if (!selected) return;
    viewerRef.current?.setMaterial(selected.id, patch);
    setMatForm(prev => (prev ? { ...prev, ...patch } : prev));
  };
  const togglePlay = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const on = !viewer.isPlaying();
    viewer.setPlaying(on);
    setPlaying(on);
  };
  const applyTransformMode = (mode: TransformMode) => {
    const next = transformMode === mode ? null : mode; // clicking the active mode detaches the gizmo
    setTransformMode(next);
    viewerRef.current?.setTransformMode(next);
  };
  const applyTransformSpace = (space: "local" | "world") => {
    setTransformSpace(space);
    viewerRef.current?.setTransformSpace(space);
  };
  const toggleSolo = (id: string) => {
    const next = soloId === id ? null : id;
    setSoloId(next);
    viewerRef.current?.setSolo(next);
  };
  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectFromOutliner = (node: OutlinerNode) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.select(node.id);
    setSelected({ id: node.id, label: node.label });
    setMatForm(viewer.getMaterial(node.id));
  };
  const setSlider = (id: string, value: number) => {
    sliderValuesRef.current[id] = value;
    setSliderValues(prev => ({ ...prev, [id]: value }));
  };

  const onStageKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "q": applyTransformMode("translate"); break;
      case "g": applyTransformMode("rotate"); break;
      case "r": applyTransformMode("scale"); break;
      case "s": applyTransformSpace(transformSpace === "local" ? "world" : "local"); break;
      case "f": viewerRef.current?.frameSelected(); break;
      case " ": e.preventDefault(); togglePlay(); break;
      default: return;
    }
  };

  async function runExport() {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three || exportBusy) return;
    setExportBusy(true);
    setExportNote("");
    try {
      const root = viewer.getContent();
      if (exportFmt === "glb" || exportFmt === "gltf") {
        const { exportScene, downloadBlob, validateGlb, reimportGlb } = await import("../../lib/three3d/exporters");
        const blob = await exportScene(three, root, clipsRef.current, exportFmt, exportFilename);
        if (exportFmt === "glb") {
          const bytes = await blob.arrayBuffer();
          validateGlb(bytes);
          const { meshes } = await reimportGlb(three, bytes);
          setExportNote(`GLB exported — re-import verified: ${meshes} mesh${meshes === 1 ? "" : "es"} loaded back.`);
        } else {
          setExportNote("GLTF exported — JSON with embedded base64 buffers.");
        }
        downloadBlob(blob, `${exportFilename}.${exportFmt}`);
      } else if (exportFmt === "obj" || exportFmt === "stl" || exportFmt === "ply" || exportFmt === "usdz") {
        const { exportMesh, downloadBlob } = await import("../../lib/three3d/exporters");
        const blob = await exportMesh(root, exportFmt as MeshExportFormat);
        const notes: Record<string, string> = {
          obj: "OBJ exported — geometry + materials (.obj only, no textures).",
          stl: "STL exported — binary mesh, 3D-print ready.",
          ply: "PLY exported — ASCII point/mesh cloud.",
          usdz: "USDZ exported — AR-ready (open on iOS).",
        };
        setExportNote(notes[exportFmt]);
        downloadBlob(blob, `${exportFilename}.${exportFmt}`);
      } else if ((exportFmt === "html" || exportFmt === "tsx") && !code) {
        const { buildStandaloneHtml, buildR3fComponent } = await import("../../lib/three3d/standaloneExport");
        if (exportFmt === "html") {
          const blob = new Blob([buildStandaloneHtml(spec)], { type: "text/html" });
          setExportNote("Standalone .html saved — opens the model in any browser (loads three.js from CDN).");
          (await import("../../lib/three3d/exporters")).downloadBlob(blob, `${exportFilename}.html`);
        } else {
          const blob = new Blob([buildR3fComponent(spec)], { type: "text/plain" });
          setExportNote("React Three Fiber component saved (.tsx).");
          (await import("../../lib/three3d/exporters")).downloadBlob(blob, `${pascalName(spec.title ?? "scene")}.tsx`);
        }
      } else if (exportFmt === "png") {
        const blob = await viewer.capturePng(3840, 2160, bgMode === "transparent");
        setExportNote("4K PNG rendered (3840×2160).");
        (await import("../../lib/three3d/exporters")).downloadBlob(blob, `${exportFilename}.png`);
      }
    } catch (err: unknown) {
      setExportNote(`Export failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setExportBusy(false);
    }
  }

  const renderOutlinerRows = (nodes: OutlinerNode[], depth: number) =>
    nodes.map(node => (
      <div key={node.id}>
        <div
          className={`studio-outliner-row${selected?.id === node.id ? " is-selected" : ""}`}
          data-testid={`scene3d-outliner-${node.id}`}
          style={{ paddingLeft: `${0.25 + depth * 0.7}rem` }}
        >
          {node.children.length > 0 ? (
            <button type="button" className="studio-outliner-btn" aria-label={`Expand ${node.label}`}
              onClick={() => toggleExpand(node.id)}>
              {expanded.has(node.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : <span style={{ width: 12 }} />}
          <button type="button" className="studio-outliner-name" onClick={() => selectFromOutliner(node)}>
            {node.label}
          </button>
          <button type="button"
            className={`studio-outliner-btn${node.visible ? "" : " is-off"}`}
            data-testid={`scene3d-hide-${node.id}`}
            aria-label={`${node.visible ? "Hide" : "Show"} ${node.label}`}
            onClick={() => {
              viewerRef.current?.setNodeVisible(node.id, !node.visible);
              setOutliner(viewerRef.current?.getOutliner() ?? []);
            }}>
            {node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button type="button" className={`studio-outliner-btn${soloId === node.id ? " is-active" : ""}`}
            data-testid="scene3d-solo" aria-label={`Solo ${node.label}`} onClick={() => toggleSolo(node.id)}>
            <Target size={12} />
          </button>
        </div>
        {expanded.has(node.id) && renderOutlinerRows(node.children, depth + 1)}
      </div>
    ));

  return (
    <>
      <div className="scene3d-toolbar">
        <select className="scene3d-format" data-testid="scene3d-shading" value={shading} aria-label="Shading mode"
          onChange={e => { setShading(e.target.value as ShadingMode); viewerRef.current?.setShading(e.target.value as ShadingMode); }}>
          {SHADING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="scene3d-format" data-testid="scene3d-projection" value={projection} aria-label="Camera projection"
          onChange={e => { setProjection(e.target.value); viewerRef.current?.setProjection(e.target.value); }}>
          <option value="perspective">Perspective</option>
          <option value="orthographic">Orthographic</option>
        </select>
        <label className="studio-field-row" style={{ margin: 0, flex: "0 1 140px" }}>
          <span className="studio-field-label">FOV</span>
          <input type="range" min={20} max={110} step={1} value={fov} data-testid="scene3d-fov"
            onChange={e => { setFov(Number(e.target.value)); viewerRef.current?.setFov(Number(e.target.value)); }} />
          <span className="studio-field-val">{fov}°</span>
        </label>
        {(["front", "back", "left", "right", "top", "bottom", "iso"] as const).map(v => (
          <button key={v} type="button" className="scene3d-tool-btn" data-testid={`scene3d-view-${v}`}
            onClick={() => viewerRef.current?.setView(v)}>
            {v === "iso" ? "Iso" : v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-view-frame" onClick={() => viewerRef.current?.frameSelected()}>
          <Target size={13} /> Frame (F)
        </button>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-view-reset" onClick={() => viewerRef.current?.setView("reset")}>
          <RotateCcw size={13} /> Reset
        </button>
        <button type="button" className={`scene3d-tool-btn${transformMode === "translate" ? " is-active" : ""}`}
          data-testid="scene3d-transform-translate" aria-pressed={transformMode === "translate"}
          onClick={() => applyTransformMode("translate")}><Move size={13} /> Move</button>
        <button type="button" className={`scene3d-tool-btn${transformMode === "rotate" ? " is-active" : ""}`}
          data-testid="scene3d-transform-rotate" aria-pressed={transformMode === "rotate"}
          onClick={() => applyTransformMode("rotate")}><RotateCw size={13} /> Rotate</button>
        <button type="button" className={`scene3d-tool-btn${transformMode === "scale" ? " is-active" : ""}`}
          data-testid="scene3d-transform-scale" aria-pressed={transformMode === "scale"}
          onClick={() => applyTransformMode("scale")}><Scale3d size={13} /> Scale</button>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-transform-space"
          onClick={() => applyTransformSpace(transformSpace === "local" ? "world" : "local")}>
          {transformSpace === "local" ? "Local" : "World"}
        </button>
        <button type="button" className={`scene3d-tool-btn${autoRotate ? " is-active" : ""}`} data-testid="scene3d-autorotate"
          aria-pressed={autoRotate} onClick={() => { const on = !autoRotate; setAutoRotate(on); viewerRef.current?.setAutoRotate(on); }}>
          Turntable
        </button>
        <button type="button" className={`scene3d-tool-btn${gridOn ? " is-active" : ""}`} data-testid="scene3d-tool-grid"
          aria-pressed={gridOn} onClick={() => { const on = !gridOn; setGridOn(on); viewerRef.current?.setGrid(on); }}>
          <Grid3x3 size={13} /> Grid
        </button>
        <button type="button" className={`scene3d-tool-btn${axesOn ? " is-active" : ""}`} data-testid="scene3d-tool-axes"
          aria-pressed={axesOn} onClick={() => { const on = !axesOn; setAxesOn(on); viewerRef.current?.setAxes(on); }}>
          <Axis3d size={13} /> Axes
        </button>
        <button type="button" className={`scene3d-tool-btn${bboxOn ? " is-active" : ""}`} data-testid="scene3d-tool-bbox"
          aria-pressed={bboxOn} onClick={() => { const on = !bboxOn; setBboxOn(on); viewerRef.current?.setBbox(on); }}>
          Bounding box
        </button>
        <button type="button" className={`scene3d-tool-btn${cageOn ? " is-active" : ""}`} data-testid="scene3d-tool-cage"
          aria-pressed={cageOn} onClick={() => { const on = !cageOn; setCageOn(on); viewerRef.current?.setCage(on); }}>
          <Box size={13} /> Cage
        </button>
        <button type="button" className={`scene3d-tool-btn${helpersOn ? " is-active" : ""}`} data-testid="scene3d-tool-lights"
          aria-pressed={helpersOn} onClick={() => { const on = !helpersOn; setHelpersOn(on); viewerRef.current?.setLightHelpers(on); }}>
          Light rig
        </button>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-fullscreen"
          aria-pressed={isFullscreen} onClick={toggleStageFullscreen}>
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <select className="scene3d-format" data-testid="scene3d-export-format" value={exportFmt}
          aria-label="Export format" onChange={e => setExportFmt(e.target.value as StudioExportFormat)}>
          {EXPORT_FORMATS.filter(f => !code || (f.value !== "html" && f.value !== "tsx")).map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-export" onClick={runExport} disabled={exportBusy}>
          <Download size={13} /> {exportBusy ? "Exporting…" : "Export"}
        </button>
      </div>

      <div ref={stageRef} className="scene3d-stage" data-testid="scene3d-stage" tabIndex={0} onKeyDown={onStageKey}
        role="img" aria-label={`3D studio: ${spec.title ?? "interactive model"}`}>
        {glError && <div className="diagram-error-note">WebGL is unavailable in this browser.</div>}
        {codeError && (
          <div className="scene3d-code-error" data-testid="threejs-code-error">
            <span>⚠️ 3D code failed: {codeError}</span>
            <button type="button" className="scene3d-tool-btn" onClick={() => onSend?.(fenceFixRequest("threejs", codeError))}>
              🔧 Fix with AI
            </button>
          </div>
        )}
        <div ref={labelLayerRef} className="scene3d-label-layer" aria-hidden="true" />
        {hover && <span className="scene3d-hover-tip" style={{ left: hover.x, top: hover.y }}>{hover.label}</span>}
        {stats && (
          <div className="studio-hud" data-testid="scene3d-stats">
            {stats.fps} FPS · {stats.meshes} meshes · {stats.vertices.toLocaleString()} verts · {stats.triangles.toLocaleString()} tris · {stats.drawCalls} calls · {stats.bbox.w.toFixed(1)}×{stats.bbox.h.toFixed(1)}×{stats.bbox.d.toFixed(1)}
          </div>
        )}

        <div className="studio-left-dock" data-testid="scene3d-outliner">
          <div className="studio-dock-section">
            <div className="studio-dock-title">Outliner</div>
            {renderOutlinerRows(outliner, 0)}
          </div>
        </div>

        <div className="studio-right-dock">
          {selected && matForm && (
            <div className="studio-dock-section">
              <div className="studio-dock-title">Material — {selected.label}</div>
              <div className="studio-field-row">
                <span className="studio-field-label">Color</span>
                <input type="color" value={matForm.color} data-testid="scene3d-material-color"
                  onChange={e => patchMaterial({ color: e.target.value })} />
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Metal</span>
                <input type="range" min={0} max={1} step={0.01} value={matForm.metalness} data-testid="scene3d-material-metalness"
                  onChange={e => patchMaterial({ metalness: Number(e.target.value) })} />
                <span className="studio-field-val">{matForm.metalness.toFixed(2)}</span>
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Rough</span>
                <input type="range" min={0} max={1} step={0.01} value={matForm.roughness} data-testid="scene3d-material-roughness"
                  onChange={e => patchMaterial({ roughness: Number(e.target.value) })} />
                <span className="studio-field-val">{matForm.roughness.toFixed(2)}</span>
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Emissive</span>
                <input type="color" value={matForm.emissive} data-testid="scene3d-material-emissive"
                  onChange={e => patchMaterial({ emissive: e.target.value })} />
                <input type="range" min={0} max={5} step={0.1} value={matForm.emissiveIntensity} data-testid="scene3d-material-emissiveIntensity"
                  onChange={e => patchMaterial({ emissiveIntensity: Number(e.target.value) })} />
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Opacity</span>
                <input type="range" min={0} max={1} step={0.01} value={matForm.opacity} data-testid="scene3d-material-opacity"
                  onChange={e => patchMaterial({ opacity: Number(e.target.value) })} />
                <span className="studio-field-val">{matForm.opacity.toFixed(2)}</span>
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Flat</span>
                <input type="checkbox" checked={matForm.flatShading} data-testid="scene3d-material-flatShading"
                  onChange={e => patchMaterial({ flatShading: e.target.checked })} />
                <span className="studio-field-label">Wire</span>
                <input type="checkbox" checked={matForm.wireframe} data-testid="scene3d-material-wireframe"
                  onChange={e => patchMaterial({ wireframe: e.target.checked })} />
              </div>
            </div>
          )}
          <div className="studio-dock-section">
            <div className="studio-dock-title">Environment</div>
            <div className="studio-field-row">
              <span className="studio-field-label">Preset</span>
              <select value={envPreset} data-testid="scene3d-env" aria-label="Environment preset"
                onChange={e => { setEnvPreset(e.target.value); viewerRef.current?.setEnvPreset(e.target.value); }}>
                {ENV_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="studio-field-row">
              <span className="studio-field-label">BG</span>
              <select value={bgMode} data-testid="scene3d-bg" aria-label="Background"
                onChange={e => {
                  const mode = e.target.value as BackgroundSpec["mode"];
                  setBgMode(mode);
                  viewerRef.current?.setBackground({ mode, color: bgColor });
                }}>
                <option value="dark">Dark</option>
                <option value="custom">Custom</option>
                <option value="transparent">Transparent</option>
              </select>
              {bgMode === "custom" && (
                <input type="color" value={bgColor} aria-label="Background color"
                  onChange={e => { setBgColor(e.target.value); viewerRef.current?.setBackground({ mode: "custom", color: e.target.value }); }} />
              )}
            </div>
            <div className="studio-field-row">
              <span className="studio-field-label">Tone</span>
              <select value={toneMapping} data-testid="scene3d-tonemap" aria-label="Tone mapping"
                onChange={e => { setToneMapping(e.target.value); viewerRef.current?.setToneMapping(e.target.value); }}>
                <option value="ACESFilmic">ACES Filmic</option>
                <option value="Neutral">Neutral</option>
                <option value="Reinhard">Reinhard</option>
                <option value="Linear">Linear</option>
              </select>
            </div>
            <div className="studio-field-row">
              <span className="studio-field-label">Bloom</span>
              <input type="checkbox" checked={bloomOn} data-testid="scene3d-bloom"
                onChange={e => { setBloomOn(e.target.checked); viewerRef.current?.setBloom(e.target.checked); }} />
              <span className="studio-field-label">SSAO</span>
              <input type="checkbox" checked={ssaoOn} data-testid="scene3d-ssao"
                onChange={e => { setSsaoOn(e.target.checked); viewerRef.current?.setSSAO(e.target.checked); }} />
              <span className="studio-field-label">Vig</span>
              <input type="checkbox" checked={vignetteOn} data-testid="scene3d-vignette"
                onChange={e => { setVignetteOn(e.target.checked); viewerRef.current?.setVignette(e.target.checked); }} />
            </div>
          </div>
          {lights && (
            <div className="studio-dock-section">
              <div className="studio-dock-title">Lighting</div>
              {([
                ["key", "Key", lights.keyIntensity, lights.keyColor, lights.keyAzimuth],
                ["fill", "Fill", lights.fillIntensity, lights.fillColor, lights.fillAzimuth],
                ["rim", "Rim", lights.rimIntensity, lights.rimColor, lights.rimAzimuth],
              ] as const).map(([lightKey, label, intensity, color, azimuth]) => (
                <div key={lightKey}>
                  <div className="studio-field-row">
                    <span className="studio-field-label">{label}</span>
                    <input type="range" min={0} max={5} step={0.05} value={intensity}
                      data-testid={`scene3d-light-${lightKey}`} aria-label={`${label} intensity`}
                      onChange={e => patchLight({ [`${lightKey}Intensity`]: Number(e.target.value) } as Partial<LightState>)} />
                    <span className="studio-field-val">{intensity.toFixed(1)}</span>
                    <input type="color" value={color} data-testid={`scene3d-light-${lightKey}-color`} aria-label={`${label} color`}
                      onChange={e => patchLight({ [`${lightKey}Color`]: e.target.value } as Partial<LightState>)} />
                  </div>
                  <div className="studio-field-row">
                    <span className="studio-field-label">{label}°</span>
                    <input type="range" min={0} max={360} step={1} value={azimuth}
                      data-testid={`scene3d-light-${lightKey}-azimuth`} aria-label={`${label} rotation`}
                      onChange={e => patchLight({ [`${lightKey}Azimuth`]: Number(e.target.value) } as Partial<LightState>)} />
                    <span className="studio-field-val">{Math.round(azimuth)}°</span>
                  </div>
                </div>
              ))}
              <div className="studio-field-row">
                <span className="studio-field-label">Ambient</span>
                <input type="range" min={0} max={3} step={0.05} value={lights.ambientIntensity} data-testid="scene3d-light-ambient"
                  onChange={e => patchLight({ ambientIntensity: Number(e.target.value) })} />
                <span className="studio-field-val">{lights.ambientIntensity.toFixed(2)}</span>
              </div>
              <div className="studio-field-row">
                <span className="studio-field-label">Shadows</span>
                <input type="checkbox" checked={lights.shadows} data-testid="scene3d-shadows"
                  onChange={e => patchLight({ shadows: e.target.checked })} />
                <span className="studio-field-label">Contact</span>
                <input type="checkbox" checked={lights.contactShadows} data-testid="scene3d-contact"
                  onChange={e => patchLight({ contactShadows: e.target.checked })} />
              </div>
            </div>
          )}
        </div>

        <div className="studio-bottom-dock">
          {hasAnimations && (
            <>
              <button type="button" className="scene3d-tool-btn" data-testid="scene3d-play" onClick={togglePlay} aria-pressed={playing}>
                {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : "Play"}
              </button>
              <button type="button" className="scene3d-tool-btn" data-testid="scene3d-restart" onClick={() => viewerRef.current?.restart()}>
                <RotateCcw size={13} />
              </button>
              <input ref={scrubRef} type="range" min={0} max={duration} step={0.01} defaultValue={0}
                data-testid="scene3d-scrub" aria-label="Timeline scrub" style={{ flex: "1 1 120px", minWidth: 80 }}
                onPointerDown={() => { scrubbingRef.current = true; }}
                onPointerUp={() => { scrubbingRef.current = false; }}
                onChange={e => viewerRef.current?.seek(Number(e.target.value))} />
              <span ref={timeRef} className="studio-field-val" style={{ flex: "0 0 auto" }}>0.0s</span>
              <select className="scene3d-format" data-testid="scene3d-speed" value={speed} aria-label="Playback speed"
                onChange={e => { setSpeed(Number(e.target.value)); viewerRef.current?.setSpeed(Number(e.target.value)); }}>
                <option value="0.25">0.25×</option>
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
              </select>
              {clipIds.length > 1 && (
                <select className="scene3d-format" data-testid="scene3d-clip" value={clipId} aria-label="Animation clip"
                  onChange={e => { setClipId(e.target.value); viewerRef.current?.setClip(e.target.value as string); }}>
                  <option value="all">All clips</option>
                  {clipIds.map(id => <option key={id} value={id}>{id}</option>)}
                </select>
              )}
            </>
          )}
          <label className="studio-field-row" style={{ margin: 0, flex: "1 1 160px", minWidth: 140 }}>
            <span className="studio-field-label">Explode</span>
            <input type="range" min={0} max={100} step={1} value={explode} data-testid="scene3d-explode"
              onChange={e => { setExplode(Number(e.target.value)); viewerRef.current?.setExplode(Number(e.target.value)); }} />
            <span className="studio-field-val">{explode}%</span>
          </label>
        </div>
      </div>

      {exportNote && <div className="scene3d-export-note" data-testid="scene3d-export-note">{exportNote}</div>}

      {spec.sliders && spec.sliders.length > 0 && (
        <div className="chart-sliders" data-testid="scene3d-sliders">
          {spec.sliders.map(sl => {
            const v = Number.isFinite(sliderValues[sl.id]) ? sliderValues[sl.id]! : sl.defaultValue;
            return (
              <label key={sl.id} className="chart-slider-row">
                <span className="chart-slider-label">{sl.label}</span>
                <input type="range" min={sl.min} max={sl.max} step={sl.step} value={v}
                  data-testid={`scene3d-slider-${sl.id}`} aria-label={sl.label}
                  onChange={e => setSlider(sl.id, Number(e.target.value))} />
                <span className="chart-slider-value">{trimZero(v)}</span>
              </label>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="scene3d-inspect" data-testid="scene3d-inspect">
          <span className="scene3d-inspect-label">{selected.label}</span>
          {onSend && (
            <button type="button" className="viz-ask-btn"
              onClick={() => onSend(
                `In the 3D scene "${spec.title ?? "untitled"}": the part "${selected.label}" (node id "${selected.id}"). ` +
                `What is it doing and why does it matter?`,
              )}>
              <MessageSquarePlus className="w-3 h-3" /> Ask AI about this 3D part
            </button>
          )}
        </div>
      )}
    </>
  );
}

function trimZero(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function pascalName(text: string): string {
  const pascal = text.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
  return pascal ? pascal[0].toUpperCase() + pascal.slice(1) : "Scene";
}
