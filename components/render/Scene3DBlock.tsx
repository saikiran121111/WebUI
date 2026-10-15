"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence, scene3dSpecSchema, type Scene3DSpec, type Scene3DObject } from "../../lib/render/schemas";
import { OBSIDIAN_SERIES_COLORS } from "../../lib/render/themes";

/**
 * Renders ```scene3d fences as procedural three.js scenes: validated JSON
 * only (never arbitrary code), lazy `await import("three")` so the initial
 * bundle stays 0 KB for this feature, orbit drag + wheel zoom on the
 * Obsidian-black canvas, live sliders bound to rotation/scale/position,
 * click raycasting with an "Ask AI about this 3D part" hand-off, and an
 * IntersectionObserver that parks requestAnimationFrame at 0% GPU when the
 * canvas scrolls off-screen.
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

interface SelectedPart { id: string; label: string; kind: string }

function Scene3DView({ spec, onSend }: { spec: Scene3DSpec; onSend?: (text: string) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const meshesRef = useRef<Map<string, any>>(new Map());
  const rendererRef = useRef<any>(null);
  const orbitRef = useRef({ theta: 0.65, phi: 1.15, radius: 7 });
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<SelectedPart | null>(null);
  const [glError, setGlError] = useState(false);

  const sliderValue = useCallback((id: string, def: number) => (
    Number.isFinite(sliderValues[id]) ? sliderValues[id]! : def
  ), [sliderValues]);

  // Bind slider values onto the live meshes (base transform + axis override).
  const applySliders = useCallback(() => {
    for (const sl of spec.sliders ?? []) {
      const obj = meshesRef.current.get(sl.target);
      if (!obj) continue;
      const v = Number.isFinite(sliderValues[sl.id]) ? sliderValues[sl.id]! : sl.defaultValue;
      const axisIdx = sl.axis === "x" ? 0 : sl.axis === "y" ? 1 : 2;
      if (sl.binding === "rotation") obj.rotation[sl.axis] = v;
      else if (sl.binding === "scale") obj.scale.setComponent(axisIdx, v);
      else obj.position.setComponent(axisIdx, v);
    }
  }, [spec, sliderValues]);

  const applySlidersRef = useRef(applySliders);
  applySlidersRef.current = applySliders;

  useEffect(() => { applySliders(); }, [applySliders]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let disposed = false;
    let raf = 0;
    const cleanups: Array<() => void> = [];

    void (async () => {
      const three = await import("three");
      if (disposed || !stageRef.current) return;

      let renderer: any;
      try {
        renderer = new three.WebGLRenderer({ antialias: true });
      } catch {
        setGlError(true);
        return;
      }
      rendererRef.current = renderer;
      renderer.setClearColor(0x050507, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      stage.appendChild(renderer.domElement);

      const scene = new three.Scene();
      const camera = new three.PerspectiveCamera(50, 1, 0.1, 200);

      scene.add(new three.HemisphereLight(0xbfd4ff, 0x0d0d12, 1.1));
      const keyLight = new three.DirectionalLight(0x38bdf8, 1.4);
      keyLight.position.set(4, 6, 3);
      scene.add(keyLight);
      const rimLight = new three.DirectionalLight(0xa78bfa, 0.6);
      rimLight.position.set(-5, -2, -4);
      scene.add(rimLight);

      const meshes = new Map<string, any>();
      spec.objects.forEach((obj, i) => {
        const node = buildNode(three, obj, OBSIDIAN_SERIES_COLORS[i % OBSIDIAN_SERIES_COLORS.length]);
        const pos = obj.position ?? [0, 0, 0];
        const rot = obj.rotation ?? [0, 0, 0];
        const scale = obj.scale ?? [1, 1, 1];
        node.position.set(...pos);
        node.rotation.set(...rot);
        node.scale.set(...scale);
        node.userData = { id: obj.id, label: obj.label ?? obj.id, kind: obj.kind, pickable: obj.kind !== "grid" };
        scene.add(node);
        meshes.set(obj.id, node);
      });
      meshesRef.current = meshes;
      applySlidersRef.current();

      const orbit = orbitRef.current;
      const placeCamera = () => {
        const phi = Math.min(Math.PI - 0.15, Math.max(0.15, orbit.phi));
        const r = orbit.radius;
        camera.position.set(
          r * Math.sin(phi) * Math.sin(orbit.theta),
          r * Math.cos(phi),
          r * Math.sin(phi) * Math.cos(orbit.theta),
        );
        camera.lookAt(0, 0, 0);
      };

      const resize = () => {
        const w = stage.clientWidth || 1;
        const h = stage.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(stage);
      cleanups.push(() => ro.disconnect());

      // IntersectionObserver gate: an off-screen canvas renders zero frames.
      let visible = true;
      const io = new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting ?? true;
      });
      io.observe(stage);
      cleanups.push(() => io.disconnect());

      const loop = () => {
        raf = requestAnimationFrame(loop);
        if (!visible) return;
        placeCamera();
        renderer.render(scene, camera);
      };
      loop();

      let dragging = false;
      let moved = 0;
      let lastX = 0;
      let lastY = 0;
      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        moved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        stage.classList.add("is-dragging");
        stage.setPointerCapture?.(e.pointerId);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = e.clientX;
        lastY = e.clientY;
        orbit.theta -= dx * 0.008;
        orbit.phi -= dy * 0.008;
      };
      const onPointerUp = (e: PointerEvent) => {
        dragging = false;
        stage.classList.remove("is-dragging");
        if (moved > 5) return; // an orbit drag, not a part click
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new three.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        const ray = new three.Raycaster();
        ray.setFromCamera(ndc, camera);
        const targets = [...meshes.values()].filter(m => m.userData?.pickable);
        const hit = ray.intersectObjects(targets, true)[0];
        if (!hit) { setSelected(null); return; }
        let node: any = hit.object;
        while (node && !node.userData?.id) node = node.parent;
        if (node?.userData?.id) {
          setSelected({ id: node.userData.id, label: node.userData.label, kind: node.userData.kind });
        }
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        orbit.radius = Math.min(40, Math.max(2.5, orbit.radius * (e.deltaY < 0 ? 0.9 : 1.1)));
      };
      stage.addEventListener("pointerdown", onPointerDown);
      stage.addEventListener("pointermove", onPointerMove);
      stage.addEventListener("pointerup", onPointerUp);
      stage.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => {
        stage.removeEventListener("pointerdown", onPointerDown);
        stage.removeEventListener("pointermove", onPointerMove);
        stage.removeEventListener("pointerup", onPointerUp);
        stage.removeEventListener("wheel", onWheel);
      });
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanups.forEach(fn => fn());
      for (const node of meshesRef.current.values()) {
        node.traverse?.((child: any) => {
          child.geometry?.dispose();
          if (Array.isArray(child.material)) child.material.forEach((mat: any) => mat.dispose());
          else child.material?.dispose();
        });
      }
      meshesRef.current.clear();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      stage.querySelector("canvas")?.remove();
    };
  }, [spec]);

  return (
    <div className="scene3d-block" data-testid="scene3d-block" data-scene-title={spec.title ?? ""}>
      <div className="code-block-header">
        <span className="code-block-lang">{spec.title ?? "3D scene"}</span>
      </div>
      <div ref={stageRef} className="scene3d-stage" data-testid="scene3d-stage"
        role="img" aria-label={`3D scene: ${spec.title ?? "interactive model"}`}>
        {glError && <div className="diagram-error-note">WebGL is unavailable in this browser.</div>}
        <span className="scene3d-hint">drag to orbit · scroll to zoom · click a part</span>
      </div>

      {spec.sliders && spec.sliders.length > 0 && (
        <div className="chart-sliders" data-testid="scene3d-sliders">
          {spec.sliders.map(sl => {
            const v = sliderValue(sl.id, sl.defaultValue);
            return (
              <label key={sl.id} className="chart-slider-row">
                <span className="chart-slider-label">{sl.label}</span>
                <input type="range" min={sl.min} max={sl.max} step={sl.step} value={v}
                  data-testid={`scene3d-slider-${sl.id}`} aria-label={sl.label}
                  onChange={e => setSliderValues(prev => ({ ...prev, [sl.id]: Number(e.target.value) }))} />
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
                `In the 3D scene "${spec.title ?? "untitled"}": the part "${selected.label}" (${selected.kind}). ` +
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

function buildNode(three: any, obj: Scene3DObject, paletteColor: string): any {
  const color = obj.color ?? paletteColor;
  if (obj.kind === "grid") return new three.GridHelper(8, 16, 0x38bdf8, 0x1e293b);
  if (obj.kind === "arrow") {
    const mat = new three.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 });
    const group = new three.Group();
    const shaft = new three.Mesh(new three.CylinderGeometry(0.06, 0.06, 1, 16), mat);
    const head = new three.Mesh(new three.ConeGeometry(0.18, 0.4, 16), mat);
    head.position.y = 0.7;
    group.add(shaft, head);
    return group;
  }
  let geometry;
  switch (obj.kind) {
    case "box": geometry = new three.BoxGeometry(1, 1, 1); break;
    case "sphere": geometry = new three.SphereGeometry(0.6, 32, 24); break;
    case "cylinder": geometry = new three.CylinderGeometry(0.5, 0.5, 1.4, 32); break;
    case "cone": geometry = new three.ConeGeometry(0.6, 1.4, 32); break;
    case "torus": geometry = new three.TorusGeometry(0.7, 0.22, 24, 48); break;
    default: geometry = new three.BoxGeometry(1, 1, 1);
  }
  return new three.Mesh(geometry, new three.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 }));
}
