"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Axis3d, Box, Download, Grid3x3, Maximize2, MessageSquarePlus, Pause, Play, RotateCcw } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence } from "../../lib/render/schemas";
import { scene3dSpecSchema, type Scene3DSpec } from "../../lib/three3d/sceneSchema";
import type { SceneExportFormat } from "../../lib/three3d/exporters"; // type-only: keeps three out of the bundle

/**
 * Renders ```scene3d fences as procedural three.js scenes (v2 contract):
 * validated JSON only — model output is never executed as code — built into
 * real geometry by the deterministic builder in lib/three3d. three.js and
 * the viewer load via dynamic import so the initial bundle stays free of
 * three. The viewer offers orbit/pan/zoom, grid/axes/wireframe toggles,
 * animation playback, reset, fullscreen, live stats and GLB/GLTF export
 * (the GLB path re-imports the bytes to prove the file is valid).
 */
interface Scene3DBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

export default memo(function Scene3DBlock({ source, streaming = false, onSend }: Scene3DBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, scene3dSpecSchema), [source]);

  if (!parsed.ok) {
    if (streaming) return null; // partial JSON mid-stream: render nothing yet
    return (
      <div className="scene3d-block" data-testid="scene3d-error">
        <div className="diagram-error-note">3D scene data did not validate — showing the source instead.</div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return <Scene3DView spec={parsed.value} onSend={onSend} />;
});

interface SelectedPart { id: string; label: string }

function Scene3DView({ spec, onSend }: { spec: Scene3DSpec; onSend?: (text: string) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const threeRef = useRef<any>(null);
  const clipsRef = useRef<any[]>([]);
  const pickablesRef = useRef<any[]>([]);
  const sliderValuesRef = useRef<Record<string, number>>({});
  const lastHoverIdRef = useRef<string | null>(null);

  const [sliderValues, setSliderValues] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<SelectedPart | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const [glError, setGlError] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [axesOn, setAxesOn] = useState(false);
  const [wireOn, setWireOn] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [stats, setStats] = useState<{ meshes: number; vertices: number; triangles: number } | null>(null);
  const [exportFmt, setExportFmt] = useState<SceneExportFormat>("glb");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNote, setExportNote] = useState("");

  const hasAnimations = (spec.animations?.length ?? 0) > 0;
  const exportFilename = spec.export?.filename ?? slugify(spec.title ?? "scene");

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
      const [{ ViewerCore }, { buildScene, buildAnimationClips }] = await Promise.all([
        import("../../lib/three3d/viewerCore"),
        import("../../lib/three3d/sceneBuilder"),
      ]);
      if (disposed || !stageRef.current) return;

      let viewer: any;
      try {
        viewer = new ViewerCore(three, stage, {
          preset: spec.lighting?.preset ?? "studio",
          shadows: spec.lighting?.shadows ?? false,
          ambientIntensity: spec.lighting?.ambientIntensity,
          fov: spec.camera?.fov ?? 45,
        });
      } catch {
        setGlError(true);
        return;
      }
      threeRef.current = three;
      viewerRef.current = viewer;
      if (interactions.orbit === false) viewer.controls.enableRotate = false;
      if (interactions.pan === false) viewer.controls.enablePan = false;

      const built = buildScene(three, spec);
      const clips = buildAnimationClips(three, spec, built.nodesById);
      clipsRef.current = clips;
      pickablesRef.current = built.pickables;
      viewer.setContent(built.root, clips, { loop: true });
      setStats(viewer.getStats());

      if (spec.camera?.position) {
        viewer.camera.position.fromArray(spec.camera.position);
        viewer.controls.target.fromArray(spec.camera.target ?? [0, 0, 0]);
        viewer.controls.update();
      }

      // One frame handler rides the viewer's rAF after the mixer: sliders
      // override the animated channel, and HTML label tags follow their node.
      frameHandler = () => {
        for (const sl of spec.sliders ?? []) {
          const node = built.nodesById.get(sl.target);
          if (!node) continue;
          const v = Number.isFinite(sliderValuesRef.current[sl.id]) ? sliderValuesRef.current[sl.id]! : sl.defaultValue;
          const axisIdx = sl.axis === "x" ? 0 : sl.axis === "y" ? 1 : 2;
          // Euler has no setComponent (that's a Vector API) — assign the axis directly.
          if (sl.binding === "rotation") node.rotation[sl.axis] = v;
          else if (sl.binding === "scale") node.scale.setComponent(axisIdx, v);
          else node.position.setComponent(axisIdx, v);
        }
        const layer = labelLayerRef.current;
        if (layer && spec.labels?.length) {
          for (const label of spec.labels) {
            const node = built.nodesById.get(label.target);
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
      };
      viewer.addFrameHandler(frameHandler);

      let downX = 0;
      let downY = 0;
      const nodeOfHit = (hit: any): any => {
        let node = hit?.object ?? null;
        while (node && !node.userData?.nodeId) node = node.parent;
        return node;
      };
      const onPointerDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
      const onPointerUp = (e: PointerEvent) => {
        if (interactions.select === false) return;
        if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) return; // orbit drag, not a part click
        const node = nodeOfHit(viewer.pick(e.clientX, e.clientY, pickablesRef.current));
        if (!node?.userData?.nodeId) { setSelected(null); return; }
        setSelected({ id: node.userData.nodeId, label: node.userData.label ?? node.userData.nodeId });
      };
      let hoverQueued = false;
      const onPointerMove = (e: PointerEvent) => {
        if (interactions.hover === false || hoverQueued) return;
        hoverQueued = true;
        requestAnimationFrame(() => {
          hoverQueued = false;
          const node = nodeOfHit(viewer.pick(e.clientX, e.clientY, pickablesRef.current));
          const nodeId = node?.userData?.nodeId ?? null;
          if (!nodeId) { lastHoverIdRef.current = null; setHover(null); return; }
          if (nodeId === lastHoverIdRef.current) return; // tip follows on hover change only (no 60fps re-render)
          lastHoverIdRef.current = nodeId;
          const rect = stage.getBoundingClientRect();
          setHover({ label: node.userData.label ?? nodeId, x: e.clientX - rect.left, y: e.clientY - rect.top });
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
      pickablesRef.current = [];
      clipsRef.current = [];
      labelLayerRef.current?.replaceChildren();
      setSelected(null);
      setHover(null);
      setStats(null);
    };
  }, [spec]);

  const setSlider = (id: string, value: number) => {
    sliderValuesRef.current[id] = value;
    setSliderValues(prev => ({ ...prev, [id]: value }));
  };

  const toggleGrid = () => { const on = !gridOn; setGridOn(on); viewerRef.current?.setGrid(on); };
  const toggleAxes = () => { const on = !axesOn; setAxesOn(on); viewerRef.current?.setAxes(on); };
  const toggleWire = () => { const on = !wireOn; setWireOn(on); viewerRef.current?.setWireframe(on); };
  const togglePlay = () => { const on = !playing; setPlaying(on); viewerRef.current?.setPlaying(on); };

  async function runExport() {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three || exportBusy) return;
    setExportBusy(true);
    setExportNote("");
    try {
      const { exportScene, downloadBlob, validateGlb, reimportGlb } = await import("../../lib/three3d/exporters");
      const blob = await exportScene(three, viewer.getContent(), clipsRef.current, exportFmt, exportFilename);
      if (exportFmt === "glb") {
        // Prove the file we just wrote is a real glTF 2.0 binary by parsing
        // its chunks and re-importing it through GLTFLoader.
        const bytes = await blob.arrayBuffer();
        validateGlb(bytes);
        const { meshes } = await reimportGlb(three, bytes);
        setExportNote(`GLB exported — re-import verified: ${meshes} mesh${meshes === 1 ? "" : "es"} loaded back.`);
      } else {
        setExportNote("GLTF exported — JSON with embedded base64 buffers.");
      }
      downloadBlob(blob, `${exportFilename}.${exportFmt}`);
    } catch (err: unknown) {
      setExportNote(`Export failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="scene3d-block" data-testid="scene3d-block" data-scene-title={spec.title ?? ""}>
      <div className="code-block-header">
        <span className="code-block-lang">{spec.title ?? "3D scene"}</span>
      </div>
      <div ref={stageRef} className="scene3d-stage" data-testid="scene3d-stage"
        role="img" aria-label={`3D scene: ${spec.title ?? "interactive model"}`}>
        {glError && <div className="diagram-error-note">WebGL is unavailable in this browser.</div>}
        <div ref={labelLayerRef} className="scene3d-label-layer" aria-hidden="true" />
        {hover && <span className="scene3d-hover-tip" style={{ left: hover.x, top: hover.y }}>{hover.label}</span>}
        <span className="scene3d-hint">drag to orbit · right-drag to pan · scroll to zoom · click a part</span>
      </div>

      <div className="scene3d-toolbar">
        <button type="button" className={`scene3d-tool-btn${gridOn ? " is-active" : ""}`} data-testid="scene3d-tool-grid" onClick={toggleGrid} aria-pressed={gridOn}>
          <Grid3x3 size={13} /> Grid
        </button>
        <button type="button" className={`scene3d-tool-btn${axesOn ? " is-active" : ""}`} data-testid="scene3d-tool-axes" onClick={toggleAxes} aria-pressed={axesOn}>
          <Axis3d size={13} /> Axes
        </button>
        <button type="button" className={`scene3d-tool-btn${wireOn ? " is-active" : ""}`} data-testid="scene3d-tool-wireframe" onClick={toggleWire} aria-pressed={wireOn}>
          <Box size={13} /> Wireframe
        </button>
        {hasAnimations && (
          <button type="button" className="scene3d-tool-btn" data-testid="scene3d-tool-play" onClick={togglePlay} aria-pressed={playing}>
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : "Play"}
          </button>
        )}
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-tool-reset" onClick={() => viewerRef.current?.resetView()}>
          <RotateCcw size={13} /> Reset view
        </button>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-tool-fullscreen" onClick={() => viewerRef.current?.enterFullscreen()}>
          <Maximize2 size={13} /> Fullscreen
        </button>
        <select className="scene3d-format" data-testid="scene3d-export-format" value={exportFmt}
          aria-label="Export format" onChange={e => setExportFmt(e.target.value as SceneExportFormat)}>
          <option value="glb">GLB</option>
          <option value="gltf">GLTF</option>
        </select>
        <button type="button" className="scene3d-tool-btn" data-testid="scene3d-export" onClick={runExport} disabled={exportBusy}>
          <Download size={13} /> {exportBusy ? "Exporting…" : "Export"}
        </button>
        {stats && (
          <span className="scene3d-stats" data-testid="scene3d-stats">
            {stats.meshes} meshes · {stats.vertices.toLocaleString()} verts · {stats.triangles.toLocaleString()} tris
          </span>
        )}
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
    </div>
  );
}

function trimZero(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scene";
}
