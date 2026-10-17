"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Triangle,
  CircleDot,
  Compass,
  Download,
  Expand,
  Shrink,
  Eye,
  EyeOff,
  Grid,
  Layers,
  Lock,
  Maximize2,
  Ruler,
  Sun,
  Target,
  Hexagon,
  Unlock,
  X,
} from "lucide-react";
import type { CadHotspot, CadSpec } from "../../lib/cad/cadSchema";
import {
  angleAtDeg,
  distance,
  formatAngle,
  formatArea,
  formatLength,
  formatScaleLabel,
  isoProject,
  niceRoundStep,
  polylineLength,
  shoelaceArea,
  specBBox,
  sunPosition,
  thermalColor,
  trimZero,
  type BBox2,
  type Point2,
} from "../../lib/cad/cad2d";
import { cadToDxf } from "../../lib/cad/svgToDxf";
import { cadToPdf } from "../../lib/cad/pdfExport";
import { buildCadStandaloneHtml } from "../../lib/cad/cadStandalone";
import type { CadBimViewer } from "../../lib/cad/cadEngine";

type ViewMode = "2d" | "iso" | "3d" | "split";
type CadTool = "measure" | "area" | "protractor" | null;
type ExportFormat = "dxf" | "svg" | "pdf" | "png" | "html" | "glb" | "obj";

interface CadTheme {
  key: string;
  label: string;
  bg: string;
  grid: string;
  gridStrong: string;
  text: string;
  crosshair: string;
}

const CAD_THEMES: CadTheme[] = [
  { key: "autocad-dark", label: "AutoCAD Dark", bg: "#090d16", grid: "#141d31", gridStrong: "#1d2b47", text: "#e2e8f0", crosshair: "#38BDF8" },
  { key: "cyanotype", label: "Cyanotype", bg: "#0a2540", grid: "#123354", gridStrong: "#1a4470", text: "#bfe3ff", crosshair: "#7dd3fc" },
  { key: "white-plot", label: "White Plot Sheet", bg: "#ffffff", grid: "#e6ebf2", gridStrong: "#cfd9e6", text: "#0f172a", crosshair: "#0284c7" },
  { key: "thermal", label: "Thermal / Energy", bg: "#101018", grid: "#1c2230", gridStrong: "#273044", text: "#f1f5f9", crosshair: "#fbbf24" },
];

const EXPORT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "dxf", label: "DXF (R2000)" },
  { value: "svg", label: "SVG (layered)" },
  { value: "pdf", label: "PDF (A3 title block)" },
  { value: "png", label: "PNG (4K)" },
  { value: "html", label: "HTML (standalone)" },
  { value: "glb", label: "GLB (BIM model)" },
  { value: "obj", label: "OBJ (BIM model)" },
];

interface ViewState {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayerState {
  visible: boolean;
  opacity: number;
  locked: boolean;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cad-drawing";
}

function fitView(bbox: BBox2): ViewState {
  const padX = (bbox.maxX - bbox.minX) * 0.06 + 0.4;
  const padY = (bbox.maxY - bbox.minY) * 0.06 + 0.4;
  return {
    x: bbox.minX - padX,
    y: -(bbox.maxY + padY),
    w: bbox.maxX - bbox.minX + 2 * padX,
    h: bbox.maxY - bbox.minY + 2 * padY,
  };
}

function ArchitectureCadViewer({ spec, onSend }: { spec: CadSpec; onSend?: (text: string) => void }) {
  const bbox = useMemo(() => specBBox(spec), [spec]);
  const fit = useMemo(() => fitView(bbox), [bbox]);

  const [viewMode, setViewMode] = useState<ViewMode>(spec.defaultView);
  const [theme, setTheme] = useState(CAD_THEMES[0]);
  const [view, setView] = useState<ViewState>(fit);
  const [tool, setTool] = useState<CadTool>(null);
  const [pending, setPending] = useState<Point2[]>([]);
  const [measures, setMeasures] = useState<{ a: Point2; b: Point2 }[]>([]);
  const [areaResult, setAreaResult] = useState<{ points: Point2[]; area: number; perimeter: number } | null>(null);
  const [protractorResult, setProtractorResult] = useState<Point2[] | null>(null);
  const [snapGrid, setSnapGrid] = useState(true);
  const [snapVertex, setSnapVertex] = useState(false);
  const [cursor, setCursor] = useState<Point2 | null>(null);
  const [soloLayer, setSoloLayer] = useState<string | null>(null);
  const [layerState, setLayerState] = useState<Record<string, LayerState>>(() =>
    Object.fromEntries(
      spec.layers.map((l) => [l.id, { visible: l.visible, opacity: l.opacity, locked: l.locked }]),
    ),
  );
  const [flowsOn, setFlowsOn] = useState(spec.flows.length > 0);
  const [explode, setExplode] = useState(0);
  const [sectionOn, setSectionOn] = useState({ x: false, y: false, z: false });
  const [sectionVal, setSectionVal] = useState({
    x: (bbox.minX + bbox.maxX) / 2,
    y: (bbox.minY + bbox.maxY) / 2,
    z: Math.max(...spec.walls.map((w) => w.z + w.height), 1) * 0.6,
  });
  const [sunTime, setSunTime] = useState(spec.sun?.time ?? 13);
  const [hotspotSel, setHotspotSel] = useState<CadHotspot | null>(null);
  const [exportFmt, setExportFmt] = useState<ExportFormat>("dxf");
  const [exportNote, setExportNote] = useState("");
  const [bimStats, setBimStats] = useState<{ meshes: number; vertices: number; triangles: number } | null>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fullscreen the whole sheet (toolbar + docks + status bar stay live); the
  // stage ResizeObserver re-renders the SVG at the new size automatically.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onFsChange = () => {
      const el = document.fullscreenElement;
      const root = rootRef.current;
      setIsFullscreen(!!el && !!root && (el === root || el.contains(root)));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  function toggleSheetFullscreen() {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    void rootRef.current?.requestFullscreen?.();
  }

  const svg2dRef = useRef<SVGSVGElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const bimContainerRef = useRef<HTMLDivElement | null>(null);
  const bimRef = useRef<CadBimViewer | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const gridStep = useMemo(() => niceRoundStep(Math.max(view.w, view.h), 12), [view]);
  const zoomPct = Math.round((fit.w / view.w) * 100);
  const scaleRatio = spec.scale?.ratio ?? 100;
  const filename = spec.export?.filename ?? slugify(spec.title);

  const layerColor = useCallback(
    (layerId: string) => {
      const index = spec.layers.findIndex((l) => l.id === layerId);
      const layer = spec.layers[index];
      if (theme.key === "thermal") return thermalColor(index / Math.max(1, spec.layers.length - 1));
      return layer?.color ?? "#94a3b8";
    },
    [spec.layers, theme.key],
  );

  const isLayerVisible = useCallback(
    (layerId: string) => {
      const state = layerState[layerId];
      if (!state?.visible) return false;
      if (soloLayer !== null) return soloLayer === layerId;
      return true;
    },
    [layerState, soloLayer],
  );

  const entitiesByLayer = useMemo(() => {
    const map = new Map<string, typeof spec.entities>();
    for (const entity of spec.entities) {
      const list = map.get(entity.layer) ?? [];
      list.push(entity);
      map.set(entity.layer, list);
    }
    return map;
  }, [spec.entities]);

  const vertexPool = useMemo<Point2[]>(() => {
    const pool: Point2[] = [];
    for (const entity of spec.entities) {
      if (entity.kind === "line") pool.push(entity.from, entity.to);
      else if (entity.kind === "polyline" || entity.kind === "polygon") pool.push(...entity.points);
      else if (entity.kind === "rect")
        pool.push([entity.x, entity.y], [entity.x + entity.w, entity.y + entity.h]);
    }
    for (const wall of spec.walls) pool.push(...wall.path);
    for (const slab of spec.slabs) pool.push(...slab.outline);
    return pool;
  }, [spec]);

  // ── 2D pointer plumbing ─────────────────────────────────────────────────
  const toModel = useCallback((clientX: number, clientY: number): Point2 => {
    const svg = svg2dRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    const mx = view.x + ((clientX - rect.left) / rect.width) * view.w;
    const my = -(view.y + ((clientY - rect.top) / rect.height) * view.h);
    return [mx, my];
  }, [view]);

  const snapPoint = useCallback(
    (p: Point2): Point2 => {
      let [mx, my] = p;
      if (snapGrid) {
        mx = Math.round(mx / gridStep) * gridStep;
        my = Math.round(my / gridStep) * gridStep;
      }
      if (snapVertex) {
        const threshold = view.w * 0.012;
        let best: Point2 | null = null;
        let bestDist = threshold;
        for (const v of vertexPool) {
          const d = distance(v, [mx, my]);
          if (d < bestDist) {
            bestDist = d;
            best = v;
          }
        }
        if (best) [mx, my] = best;
      }
      return [mx, my];
    },
    [snapGrid, snapVertex, gridStep, vertexPool, view.w],
  );

  const handleClick = useCallback(
    (raw: Point2) => {
      if (!tool) return;
      const p = snapPoint(raw);
      if (tool === "measure") {
        const next = [...pending, p];
        if (next.length === 2) {
          setMeasures((prev) => [...prev, { a: next[0], b: next[1] }]);
          setPending([]);
        } else setPending(next);
        return;
      }
      if (tool === "protractor") {
        const next = [...pending, p];
        if (next.length === 3) {
          setProtractorResult(next);
          setPending([]);
        } else setPending(next);
        return;
      }
      setPending((prev) => [...prev, p]);
    },
    [tool, pending, snapPoint],
  );

  const finishArea = useCallback(() => {
    if (pending.length < 3) return;
    setAreaResult({
      points: pending,
      area: shoelaceArea(pending),
      perimeter: polylineLength(pending, true),
    });
    setPending([]);
  }, [pending]);

  const clearTools = useCallback(() => {
    setPending([]);
    setMeasures([]);
    setAreaResult(null);
    setProtractorResult(null);
  }, []);

  useEffect(() => {
    const svg = svg2dRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = event.deltaY > 0 ? 1 / 1.15 : 1.15;
      setView((v) => {
        const cx = v.x + ((event.clientX - rect.left) / rect.width) * v.w;
        const cy = v.y + ((event.clientY - rect.top) / rect.height) * v.h;
        const f = 1 / factor;
        return { x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f, w: v.w * f, h: v.h * f };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [viewMode]);

  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() =>
      setStageSize({ w: wrap.clientWidth, h: wrap.clientHeight }),
    );
    observer.observe(wrap);
    setStageSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    return () => observer.disconnect();
  }, [viewMode]);

  const setZoomPct = useCallback(
    (pct: number) => {
      if (pct === 100) {
        setView(fit);
        return;
      }
      const targetW = fit.w / (pct / 100);
      setView((v) => {
        const f = targetW / v.w;
        return { x: v.x + (v.w * (1 - f)) / 2, y: v.y + (v.h * (1 - f)) / 2, w: v.w * f, h: v.h * f };
      });
    },
    [fit],
  );

  // ── 3D BIM engine lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    if (viewMode !== "3d" && viewMode !== "split") return;
    const container = bimContainerRef.current;
    if (!container) return;
    let cancelled = false;
    let viewer: CadBimViewer | null = null;
    (async () => {
      const three = await import("three");
      const { CadBimViewer: Engine } = await import("../../lib/cad/cadEngine");
      if (cancelled) return;
      viewer = new Engine(three, container, { background: theme.bg, onStats: setBimStats });
      viewer.setSpec(spec);
      viewer.setSun(sunTime);
      viewer.setExplode(explode);
      for (const layer of spec.layers) viewer.setLayerVisible(layer.id, isLayerVisible(layer.id));
      if (sectionOn.x) viewer.setSection("x", sectionVal.x);
      if (sectionOn.y) viewer.setSection("y", sectionVal.y);
      if (sectionOn.z) viewer.setSection("z", sectionVal.z);
      bimRef.current = viewer;
    })();
    return () => {
      cancelled = true;
      bimRef.current = null;
      viewer?.dispose();
    };
    // Engine is re-created only when the view mode or spec changes; live
    // control changes are pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, spec]);

  useEffect(() => { bimRef.current?.setExplode(explode); }, [explode, viewMode]);
  useEffect(() => { bimRef.current?.setSun(sunTime); }, [sunTime, viewMode]);
  useEffect(() => {
    const bim = bimRef.current;
    if (!bim) return;
    for (const layer of spec.layers) bim.setLayerVisible(layer.id, isLayerVisible(layer.id));
  }, [layerState, soloLayer, viewMode, spec.layers, isLayerVisible]);
  useEffect(() => {
    const bim = bimRef.current;
    if (!bim) return;
    bim.setSection("x", sectionOn.x ? sectionVal.x : null);
    bim.setSection("y", sectionOn.y ? sectionVal.y : null);
    bim.setSection("z", sectionOn.z ? sectionVal.z : null);
  }, [sectionOn, sectionVal, viewMode]);

  // ── exports ─────────────────────────────────────────────────────────────
  const rasterize2d = useCallback(async (): Promise<Blob | null> => {
    const svg = svg2dRef.current;
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const vb = svg.viewBox.baseVal;
    const width = 3840;
    const height = 2160;
    clone.setAttribute("width", String(vb.width));
    clone.setAttribute("height", String(vb.height));
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", String(vb.x));
    bgRect.setAttribute("y", String(vb.y));
    bgRect.setAttribute("width", String(vb.width));
    bgRect.setAttribute("height", String(vb.height));
    bgRect.setAttribute("fill", theme.bg);
    clone.insertBefore(bgRect, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg rasterization failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
      const scale = Math.min(width / vb.width, height / vb.height);
      ctx.drawImage(
        img,
        (width - vb.width * scale) / 2,
        (height - vb.height * scale) / 2,
        vb.width * scale,
        vb.height * scale,
      );
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [theme.bg]);

  const withBim = useCallback(
    async <T,>(fn: (bim: CadBimViewer) => Promise<T>): Promise<T> => {
      if (bimRef.current) return fn(bimRef.current);
      const three = await import("three");
      const { CadBimViewer: Engine } = await import("../../lib/cad/cadEngine");
      const host = document.createElement("div");
      const viewer = new Engine(three, host, {});
      viewer.setSpec(spec);
      try {
        return await fn(viewer);
      } finally {
        viewer.dispose();
      }
    },
    [spec],
  );

  const runExport = useCallback(async () => {
    setExportNote("");
    const { downloadBlob } = await import("../../lib/three3d/exporters");
    try {
      switch (exportFmt) {
        case "dxf": {
          const dxf = cadToDxf(spec, { version: "R2000" });
          downloadBlob(new Blob([dxf], { type: "application/dxf" }), `${filename}.dxf`);
          setExportNote("DXF (R2000) saved — LINE / LWPOLYLINE / CIRCLE / ARC / TEXT entities on L-* CAD layers.");
          return;
        }
        case "svg": {
          const svg = svg2dRef.current;
          if (!svg) throw new Error("2D stage not visible");
          const clone = svg.cloneNode(true) as SVGSVGElement;
          clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          downloadBlob(
            new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }),
            `${filename}.svg`,
          );
          setExportNote("Layered SVG saved — one <g data-layer> group per CAD layer.");
          return;
        }
        case "pdf": {
          downloadBlob(cadToPdf(spec), `${filename}.pdf`);
          setExportNote("ISO/ANSI title-block PDF saved (A3 landscape, layer legend, north arrow).");
          return;
        }
        case "png": {
          const blob = viewMode === "3d" && bimRef.current
            ? await bimRef.current.capturePng(3840, 2160)
            : await rasterize2d();
          if (!blob) throw new Error("PNG capture failed");
          downloadBlob(blob, `${filename}.png`);
          setExportNote("4K PNG (3840×2160) saved.");
          return;
        }
        case "html": {
          downloadBlob(new Blob([buildCadStandaloneHtml(spec)], { type: "text/html" }), `${filename}.html`);
          setExportNote("Standalone interactive HTML saved — layers, explode, measure, offline-ready.");
          return;
        }
        case "glb":
        case "obj": {
          const three = await import("three");
          const { exportScene, exportMesh } = await import("../../lib/three3d/exporters");
          const blob = await withBim(async (bim) =>
            exportFmt === "glb"
              ? exportScene(three, bim.getRoot(), [], "glb", filename)
              : exportMesh(bim.getRoot(), "obj"),
          );
          downloadBlob(blob, `${filename}.${exportFmt}`);
          setExportNote(
            exportFmt === "glb"
              ? "GLB saved — extruded BIM walls & slabs as real glTF nodes."
              : "OBJ saved — extruded BIM walls & slabs as wavefront geometry.",
          );
          return;
        }
      }
    } catch (error) {
      setExportNote(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [exportFmt, spec, filename, viewMode, rasterize2d, withBim]);

  // ── 2D render pieces ────────────────────────────────────────────────────
  const gridLines = useMemo(() => {
    const lines: ReactNode[] = [];
    const gs = gridStep;
    const xStart = Math.floor(view.x / gs) * gs;
    for (let x = xStart, i = 0; x <= view.x + view.w && i < 240; x += gs, i++) {
      const strong = Math.abs(x % (gs * 5)) < gs * 1e-6;
      lines.push(
        <line key={`vx${x}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h} stroke={strong ? theme.gridStrong : theme.grid} strokeWidth={strong ? 1 : 0.6} vectorEffect="non-scaling-stroke" />,
      );
    }
    const modelBottom = -(view.y + view.h);
    const modelTop = -view.y;
    for (let my = Math.ceil(modelBottom / gs) * gs, i = 0; my <= modelTop && i < 240; my += gs, i++) {
      const strong = Math.abs(my % (gs * 5)) < gs * 1e-6;
      lines.push(
        <line key={`hy${my}`} x1={view.x} y1={-my} x2={view.x + view.w} y2={-my} stroke={strong ? theme.gridStrong : theme.grid} strokeWidth={strong ? 1 : 0.6} vectorEffect="non-scaling-stroke" />,
      );
    }
    return lines;
  }, [view, gridStep, theme]);

  const dashFor = useCallback(
    (layerId: string) => {
      const layer = spec.layers.find((l) => l.id === layerId);
      if (layer?.lineType === "dashed") return `${gridStep * 0.4} ${gridStep * 0.25}`;
      if (layer?.lineType === "dotted") return `${gridStep * 0.06} ${gridStep * 0.12}`;
      return undefined;
    },
    [spec.layers, gridStep],
  );

  const renderEntity = useCallback(
    (entity: (typeof spec.entities)[number], key: number) => {
      const color = layerColor(entity.layer);
      const dash = dashFor(entity.layer);
      const common = { stroke: color, strokeWidth: 1.2, fill: "none" as const, vectorEffect: "non-scaling-stroke" as const, strokeDasharray: dash };
      switch (entity.kind) {
        case "line":
          return <line key={key} x1={entity.from[0]} y1={-entity.from[1]} x2={entity.to[0]} y2={-entity.to[1]} {...common} />;
        case "rect":
          return (
            <rect key={key} x={entity.x} y={-(entity.y + entity.h)} width={entity.w} height={entity.h}
              {...common} fill={entity.filled ? color : "none"} fillOpacity={entity.filled ? 0.18 : undefined} />
          );
        case "polyline": {
          const pts = entity.points.map((p) => `${p[0]},${-p[1]}`).join(" ");
          return entity.closed
            ? <polygon key={key} points={pts} {...common} />
            : <polyline key={key} points={pts} {...common} />;
        }
        case "polygon":
          return <polygon key={key} points={entity.points.map((p) => `${p[0]},${-p[1]}`).join(" ")} {...common} />;
        case "circle":
          return <circle key={key} cx={entity.cx} cy={-entity.cy} r={entity.r} {...common} fill={entity.filled ? color : "none"} fillOpacity={entity.filled ? 0.18 : undefined} />;
        case "arc": {
          const a0 = (entity.startDeg * Math.PI) / 180;
          const a1 = (entity.endDeg * Math.PI) / 180;
          let delta = (entity.endDeg - entity.startDeg) % 360;
          if (delta < 0) delta += 360;
          const x0 = entity.cx + entity.r * Math.cos(a0);
          const y0 = -(entity.cy + entity.r * Math.sin(a0));
          const x1 = entity.cx + entity.r * Math.cos(a1);
          const y1 = -(entity.cy + entity.r * Math.sin(a1));
          return <path key={key} d={`M ${x0} ${y0} A ${entity.r} ${entity.r} 0 ${delta > 180 ? 1 : 0} 0 ${x1} ${y1}`} {...common} />;
        }
        case "text":
          return (
            <text key={key} x={entity.x} y={-entity.y} fill={color} fontSize={entity.height}
              textAnchor={entity.anchor === "middle" ? "middle" : entity.anchor === "end" ? "end" : "start"}
              transform={entity.rotation ? `rotate(${-entity.rotation} ${entity.x} ${-entity.y})` : undefined}>
              {entity.content}
            </text>
          );
      }
    },
    [layerColor, dashFor, spec.entities],
  );

  const hotspotR = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.008;

  // ── isometric render ────────────────────────────────────────────────────
  const isoFaces = useMemo(() => {
    if (viewMode !== "iso") return null;
    const faces: { points: Point2[]; color: string; opacity: number; stroke: string }[] = [];
    const ez = (z: number) => z * (1 + explode / 100);
    const proj = (x: number, y: number, z: number): Point2 => {
      const [ix, iy] = isoProject(x, y, z);
      return [ix, -iy];
    };
    for (const wall of spec.walls) {
      if (!isLayerVisible(wall.layer)) continue;
      const color = layerColor(wall.layer);
      const z0 = ez(wall.z);
      const z1 = ez(wall.z) + wall.height;
      const segments = wall.closed ? wall.path.length : wall.path.length - 1;
      for (let i = 0; i < segments; i++) {
        const a = wall.path[i];
        const b = wall.path[(i + 1) % wall.path.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const nx = (-dy / len) * (wall.thickness / 2);
        const ny = (dx / len) * (wall.thickness / 2);
        const corners: Point2[] = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
        faces.push({ points: corners.map((c) => proj(c[0], c[1], z1)), color, opacity: 0.85, stroke: color });
        faces.push({ points: [proj(corners[0][0], corners[0][1], z0), proj(corners[1][0], corners[1][1], z0), proj(corners[1][0], corners[1][1], z1), proj(corners[0][0], corners[0][1], z1)], color, opacity: 0.5, stroke: color });
        faces.push({ points: [proj(corners[3][0], corners[3][1], z0), proj(corners[2][0], corners[2][1], z0), proj(corners[2][0], corners[2][1], z1), proj(corners[3][0], corners[3][1], z1)], color, opacity: 0.65, stroke: color });
      }
    }
    for (const slab of spec.slabs) {
      if (!isLayerVisible(slab.layer)) continue;
      const color = layerColor(slab.layer);
      const z = ez(slab.z);
      faces.push({ points: slab.outline.map((p) => proj(p[0], p[1], z + slab.thickness)), color, opacity: 0.4, stroke: color });
    }
    faces.sort((a, b) => {
      const da = a.points.reduce((s, p) => s + p[0], 0) / a.points.length;
      const db = b.points.reduce((s, p) => s + p[0], 0) / b.points.length;
      return da - db;
    });
    return faces;
  }, [viewMode, spec.walls, spec.slabs, explode, isLayerVisible, layerColor]);

  const isoViewBox = useMemo(() => {
    if (!isoFaces) return "0 0 10 10";
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const face of isoFaces) {
      for (const [x, y] of face.points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 0.5;
    return `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;
  }, [isoFaces]);

  const sun = sunPosition(sunTime);
  const sunClock = `${String(Math.floor(sunTime)).padStart(2, "0")}:${String(Math.round((sunTime % 1) * 60)).padStart(2, "0")}`;

  const pxPerModel = stageSize.w > 0 ? stageSize.w / view.w : 1;
  const barModel = niceRoundStep(140 / pxPerModel, 1);
  const barPx = Math.round(barModel * pxPerModel);

  const toolHint =
    tool === "measure" ? "Click two points to measure"
    : tool === "area" ? "Click polygon points, then Finish (needs 3+)"
    : tool === "protractor" ? "Click three points — angle at the second"
    : "Drag to pan · scroll to zoom";

  return (
    <div ref={rootRef} className="cad-viewer" data-testid="cad-viewer" style={{ background: theme.bg, color: theme.text }}>
      <div className="cad-toolbar">
        <div className="cad-seg" role="group" aria-label="View mode">
          {(["2d", "iso", "3d", "split"] as ViewMode[]).map((mode) => (
            <button key={mode} type="button" data-testid={`cad-view-${mode}`} aria-pressed={viewMode === mode}
              className={viewMode === mode ? "is-active" : ""} onClick={() => setViewMode(mode)}>
              {mode === "2d" ? "2D CAD" : mode === "iso" ? "Iso Cutaway" : mode === "3d" ? "3D BIM" : "Split"}
            </button>
          ))}
        </div>
        <select className="cad-theme-select" data-testid="cad-theme" value={theme.key}
          onChange={(e) => setTheme(CAD_THEMES.find((t) => t.key === e.target.value) ?? CAD_THEMES[0])}
          aria-label="Sheet theme">
          {CAD_THEMES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <div className="cad-seg">
          <button type="button" data-testid="cad-zoom-fit" onClick={() => setZoomPct(100)} title="Zoom fit"><Maximize2 size={14} /></button>
          {[100, 200, 400].map((pct) => (
            <button key={pct} type="button" data-testid={`cad-zoom-${pct}`} onClick={() => setZoomPct(pct)}>{pct}%</button>
          ))}
        </div>
        <div className="cad-seg">
          <button type="button" data-testid="cad-tool-measure" aria-pressed={tool === "measure"} title="Point-to-point measure"
            className={tool === "measure" ? "is-active" : ""} onClick={() => { setTool(tool === "measure" ? null : "measure"); setPending([]); }}>
            <Ruler size={14} />
          </button>
          <button type="button" data-testid="cad-tool-area" aria-pressed={tool === "area"} title="Polygon area"
            className={tool === "area" ? "is-active" : ""} onClick={() => { setTool(tool === "area" ? null : "area"); setPending([]); }}>
            <Hexagon size={14} />
          </button>
          <button type="button" data-testid="cad-tool-protractor" aria-pressed={tool === "protractor"} title="3-point protractor"
            className={tool === "protractor" ? "is-active" : ""} onClick={() => { setTool(tool === "protractor" ? null : "protractor"); setPending([]); }}>
            <Triangle size={14} />
          </button>
          <button type="button" data-testid="cad-tool-snap-grid" aria-pressed={snapGrid} title="Snap to grid"
            className={snapGrid ? "is-active" : ""} onClick={() => setSnapGrid(!snapGrid)}><Grid size={14} /></button>
          <button type="button" data-testid="cad-tool-snap-vertex" aria-pressed={snapVertex} title="Snap to vertex"
            className={snapVertex ? "is-active" : ""} onClick={() => setSnapVertex(!snapVertex)}><CircleDot size={14} /></button>
          {(tool || measures.length || areaResult || protractorResult) && (
            <button type="button" data-testid="cad-tool-clear" onClick={clearTools} title="Clear measurements"><X size={14} /></button>
          )}
          {tool === "area" && pending.length >= 3 && (
            <button type="button" data-testid="cad-area-finish" onClick={finishArea}>Finish</button>
          )}
        </div>
        <div className="cad-seg">
          <button type="button" data-testid="cad-fullscreen" aria-pressed={isFullscreen}
            title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen the sheet"}
            onClick={toggleSheetFullscreen}>
            {isFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
          </button>
        </div>
        <div className="cad-export-group">
          <select data-testid="cad-export-format" value={exportFmt} onChange={(e) => setExportFmt(e.target.value as ExportFormat)} aria-label="Export format">
            {EXPORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" data-testid="cad-export" className="cad-export-btn" onClick={runExport}>
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      <div className="cad-body">
        <aside className="cad-dock cad-dock-left" aria-label="Layer manager">
          <div className="cad-dock-title"><Layers size={13} /> LAYERS {soloLayer && (
            <button type="button" data-testid="cad-solo-clear" className="cad-solo-clear" onClick={() => setSoloLayer(null)}>solo: {soloLayer} ✕</button>
          )}</div>
          {spec.layers.map((layer) => {
            const state = layerState[layer.id];
            return (
              <div key={layer.id} className={`cad-layer-row${soloLayer && soloLayer !== layer.id ? " is-dimmed" : ""}`} data-testid={`cad-layer-${layer.id}`}>
                <button type="button" data-testid={`cad-hide-${layer.id}`} aria-pressed={state.visible} title="Toggle visibility"
                  className="cad-icon-btn" onClick={() => setLayerState((prev) => ({ ...prev, [layer.id]: { ...prev[layer.id], visible: !prev[layer.id].visible } }))}>
                  {state.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
                <button type="button" data-testid={`cad-lock-${layer.id}`} aria-pressed={state.locked} title="Lock layer"
                  className={`cad-icon-btn${state.locked ? " is-active" : ""}`}
                  onClick={() => setLayerState((prev) => ({ ...prev, [layer.id]: { ...prev[layer.id], locked: !prev[layer.id].locked } }))}>
                  {state.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
                <span className="cad-swatch" style={{ background: layerColor(layer.id) }} />
                <span className="cad-layer-name" title={layer.group ? `${layer.group} / ${layer.name ?? layer.id}` : layer.name ?? layer.id}>
                  {layer.name ?? layer.id}
                </span>
                <input type="range" min={5} max={100} value={Math.round(state.opacity * 100)} disabled={state.locked}
                  data-testid={`cad-opacity-${layer.id}`} aria-label={`${layer.name ?? layer.id} opacity`}
                  onChange={(e) => setLayerState((prev) => ({ ...prev, [layer.id]: { ...prev[layer.id], opacity: Number(e.target.value) / 100 } }))} />
                <button type="button" data-testid={`cad-solo-${layer.id}`} title="Solo layer"
                  className={`cad-icon-btn${soloLayer === layer.id ? " is-active" : ""}`}
                  onClick={() => setSoloLayer(soloLayer === layer.id ? null : layer.id)}>
                  <Target size={13} />
                </button>
              </div>
            );
          })}
          {spec.flows.length > 0 && (
            <button type="button" data-testid="cad-toggle-flows" aria-pressed={flowsOn} className="cad-flows-toggle" onClick={() => setFlowsOn(!flowsOn)}>
              {flowsOn ? <Eye size={13} /> : <EyeOff size={13} />} Flow paths ({spec.flows.length})
            </button>
          )}
        </aside>

        <div className="cad-stage-wrap" ref={stageWrapRef}>
          {(viewMode === "2d" || viewMode === "split") && (
            <div className="cad-pane cad-pane-2d">
              <svg
                ref={svg2dRef}
                className="cad-stage-svg"
                data-testid="cad-stage"
                viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                onPointerDown={(e) => { dragRef.current = { x: e.clientX, y: e.clientY, moved: false }; }}
                onPointerMove={(e) => {
                  setCursor(toModel(e.clientX, e.clientY));
                  const drag = dragRef.current;
                  if (!drag) return;
                  const dx = e.clientX - drag.x;
                  const dy = e.clientY - drag.y;
                  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
                  if (drag.moved && !tool) {
                    const svg = svg2dRef.current;
                    if (!svg) return;
                    const rect = svg.getBoundingClientRect();
                    setView((v) => ({ ...v, x: v.x - (dx / rect.width) * v.w, y: v.y - (dy / rect.height) * v.h }));
                    dragRef.current = { x: e.clientX, y: e.clientY, moved: true };
                  }
                }}
                onPointerUp={(e) => {
                  const drag = dragRef.current;
                  dragRef.current = null;
                  if (drag && !drag.moved) handleClick(toModel(e.clientX, e.clientY));
                }}
                onPointerLeave={() => setCursor(null)}
                onDoubleClick={() => { if (tool === "area") finishArea(); }}
              >
                <g className="cad-grid">{gridLines}</g>
                {spec.layers.map((layer) => {
                  if (!isLayerVisible(layer.id)) return null;
                  const state = layerState[layer.id];
                  return (
                    <g key={layer.id} data-layer={layer.id} opacity={state.opacity}>
                      {(entitiesByLayer.get(layer.id) ?? []).map((entity, i) => renderEntity(entity, i))}
                      {spec.walls.filter((w) => w.layer === layer.id).map((wall) => (
                        <polyline key={wall.id} data-testid={`cad-wall-${wall.id}`}
                          points={(wall.closed ? [...wall.path, wall.path[0]] : wall.path).map((p) => `${p[0]},${-p[1]}`).join(" ")}
                          fill="none" stroke={layerColor(layer.id)} strokeWidth={Math.max(wall.thickness, gridStep * 0.04)}
                          strokeLinejoin="round" strokeDasharray={dashFor(layer.id)} />
                      ))}
                    </g>
                  );
                })}
                {flowsOn && spec.flows.map((flow) => (
                  <polyline key={flow.id} data-testid={`cad-flow-${flow.id}`} className="cad-flow-dash"
                    points={flow.points.map((p) => `${p[0]},${-p[1]}`).join(" ")}
                    fill="none" stroke={flow.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                ))}
                {spec.hotspots.map((hotspot) => (
                  <g key={hotspot.id}>
                    <circle data-testid={`cad-hotspot-${hotspot.id}`} cx={hotspot.x} cy={-hotspot.y} r={hotspotR}
                      fill={hotspotSel?.id === hotspot.id ? "#38BDF8" : "transparent"} stroke="#38BDF8" strokeWidth={1.4}
                      vectorEffect="non-scaling-stroke" className="cad-hotspot-dot"
                      onClick={() => setHotspotSel(hotspotSel?.id === hotspot.id ? null : hotspot)} />
                  </g>
                ))}
                {measures.map((m, i) => (
                  <g key={`m${i}`} className="cad-measure">
                    <line x1={m.a[0]} y1={-m.a[1]} x2={m.b[0]} y2={-m.b[1]} stroke="#FBBF24" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                    <text x={(m.a[0] + m.b[0]) / 2} y={-(m.a[1] + m.b[1]) / 2 - view.h * 0.015} fill="#FBBF24"
                      fontSize={view.h * 0.03} textAnchor="middle">{formatLength(distance(m.a, m.b), spec.units)}</text>
                  </g>
                ))}
                {pending.length > 0 && tool && (
                  <g className="cad-pending">
                    {pending.map((p, i) => <circle key={i} cx={p[0]} cy={-p[1]} r={view.w * 0.004} fill="#FBBF24" />)}
                    {pending.length > 1 && (
                      <polyline points={pending.map((p) => `${p[0]},${-p[1]}`).join(" ")} fill="none" stroke="#FBBF24" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    )}
                  </g>
                )}
                {areaResult && (
                  <g className="cad-area">
                    <polygon points={areaResult.points.map((p) => `${p[0]},${-p[1]}`).join(" ")} fill="#34D399" fillOpacity={0.15} stroke="#34D399" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                    <text x={areaResult.points.reduce((s, p) => s + p[0], 0) / areaResult.points.length}
                      y={-areaResult.points.reduce((s, p) => s + p[1], 0) / areaResult.points.length}
                      fill="#34D399" fontSize={view.h * 0.032} textAnchor="middle">
                      {formatArea(areaResult.area, spec.units)} · P {formatLength(areaResult.perimeter, spec.units)}
                    </text>
                  </g>
                )}
                {protractorResult && (
                  <g className="cad-protractor">
                    <polyline points={protractorResult.map((p) => `${p[0]},${-p[1]}`).join(" ")} fill="none" stroke="#F472B6" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                    <text x={protractorResult[1][0]} y={-protractorResult[1][1] - view.h * 0.02} fill="#F472B6" fontSize={view.h * 0.03} textAnchor="middle">
                      {formatAngle(angleAtDeg(protractorResult[0], protractorResult[1], protractorResult[2]))}
                    </text>
                  </g>
                )}
                {cursor && (
                  <g className="cad-crosshair" pointerEvents="none">
                    <line x1={cursor[0]} y1={view.y} x2={cursor[0]} y2={view.y + view.h} stroke={theme.crosshair} strokeWidth={0.6} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                    <line x1={view.x} y1={-cursor[1]} x2={view.x + view.w} y2={-cursor[1]} stroke={theme.crosshair} strokeWidth={0.6} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                  </g>
                )}
              </svg>
              <div className="cad-north" aria-hidden="true">
                <svg width="26" height="30" viewBox="0 0 26 30">
                  <path d="M13 2 L18 22 L13 17 L8 22 Z" fill={theme.text} opacity="0.85" />
                  <text x="13" y="29" textAnchor="middle" fontSize="9" fill={theme.text}>N</text>
                </svg>
              </div>
              <div className="cad-scalebar" aria-hidden="true">
                <div className="cad-scalebar-line" style={{ width: `${barPx}px` }} />
                <span>{formatLength(barModel, spec.units)}</span>
              </div>
            </div>
          )}

          {viewMode === "iso" && (
            <div className="cad-pane cad-pane-iso">
              <svg className="cad-iso-svg" data-testid="cad-iso-stage" viewBox={isoViewBox}>
                {isoFaces?.map((face, i) => (
                  <polygon key={i} points={face.points.map((p) => `${p[0]},${p[1]}`).join(" ")}
                    fill={face.color} fillOpacity={face.opacity} stroke={face.stroke} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
                ))}
                {flowsOn && spec.flows.map((flow) => {
                  const z = flow.z * (1 + explode / 100) + 0.4;
                  return (
                    <polyline key={flow.id} className="cad-flow-dash"
                      points={flow.points.map((p) => { const [ix, iy] = isoProject(p[0], p[1], z); return `${ix},${-iy}`; }).join(" ")}
                      fill="none" stroke={flow.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  );
                })}
              </svg>
            </div>
          )}

          {(viewMode === "3d" || viewMode === "split") && (
            <div className="cad-pane cad-pane-3d" ref={bimContainerRef} data-testid="cad-3d" />
          )}
        </div>

        <aside className="cad-dock cad-dock-right" aria-label="Drawing controls">
          <div className="cad-dock-title">VIEW CONTROLS</div>
          <label className="cad-control-row">
            <span>Explode</span>
            <input type="range" min={0} max={100} value={explode} data-testid="cad-explode" disabled={viewMode === "2d"}
              onChange={(e) => setExplode(Number(e.target.value))} />
            <b className="cad-control-value">{explode}%</b>
          </label>
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis} className="cad-control-row">
              <span>
                <input type="checkbox" data-testid={`cad-section-${axis}`} checked={sectionOn[axis]} disabled={viewMode === "2d"}
                  onChange={(e) => setSectionOn((prev) => ({ ...prev, [axis]: e.target.checked }))} /> Section {axis.toUpperCase()}
              </span>
              <input type="range" min={axis === "z" ? 0 : (axis === "x" ? bbox.minX : bbox.minY)}
                max={axis === "z" ? Math.max(...spec.walls.map((w) => w.z + w.height), 1) : (axis === "x" ? bbox.maxX : bbox.maxY)}
                step={0.01} value={sectionVal[axis]} disabled={viewMode === "2d" || !sectionOn[axis]}
                data-testid={`cad-section-val-${axis}`}
                onChange={(e) => setSectionVal((prev) => ({ ...prev, [axis]: Number(e.target.value) }))} />
            </label>
          ))}
          <label className="cad-control-row">
            <span><Sun size={12} /> Sun {sunClock}</span>
            <input type="range" min={6} max={20} step={0.25} value={sunTime} data-testid="cad-sun" disabled={viewMode === "2d"}
              onChange={(e) => setSunTime(Number(e.target.value))} />
            <span className="cad-compass" title={`azimuth ${Math.round(sun.azimuthDeg)}°, altitude ${Math.round(sun.altitudeDeg)}°`}>
              <Compass size={14} style={{ transform: `rotate(${sun.azimuthDeg}deg)` }} />
            </span>
          </label>
          {bimStats && (viewMode === "3d" || viewMode === "split") && (
            <div className="cad-bim-stats" data-testid="cad-stats">
              {bimStats.meshes} meshes · {bimStats.vertices.toLocaleString()} verts · {bimStats.triangles.toLocaleString()} tris
            </div>
          )}
          {hotspotSel && (
            <div className="cad-inspector" data-testid="cad-inspect">
              <div className="cad-inspector-head">
                <b>{hotspotSel.title}</b>
                <button type="button" onClick={() => setHotspotSel(null)} aria-label="Close inspector"><X size={12} /></button>
              </div>
              {hotspotSel.role && <p><i>Role</i> {hotspotSel.role}</p>}
              {hotspotSel.material && <p><i>Material</i> {hotspotSel.material}</p>}
              {hotspotSel.dims && <p><i>Dimensions</i> {hotspotSel.dims}</p>}
              {hotspotSel.note && <p>{hotspotSel.note}</p>}
              {onSend && (
                <button type="button" data-testid="cad-ask-ai" onClick={() =>
                  onSend(`Tell me more about "${hotspotSel.title}"${hotspotSel.role ? ` (${hotspotSel.role})` : ""} in the drawing "${spec.title}".`)}>
                  Ask the AI about this
                </button>
              )}
            </div>
          )}
        </aside>
      </div>

      <div className="cad-status-bar" data-testid="cad-status">
        <span data-testid="cad-status-xy" className="cad-status-coords">
          {cursor ? `X: ${trimZero(cursor[0], 2)}  Y: ${trimZero(cursor[1], 2)}` : `X: —  Y: —`}
        </span>
        <span>{zoomPct}% · {formatScaleLabel(scaleRatio)} · units {spec.units}</span>
        <span className="cad-status-hint">{toolHint}</span>
        {exportNote && <span className="cad-export-note" data-testid="cad-export-note">{exportNote}</span>}
      </div>
    </div>
  );
}

export default memo(ArchitectureCadViewer);
