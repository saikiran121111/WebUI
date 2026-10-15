"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ZoomIn, ZoomOut, Maximize2, Minimize2, Code, Eye, Download, Crosshair } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { copyText } from "../../lib/render/clipboard";

const STREAM_SETTLE_MS = 500;
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(m => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: '"Inter", system-ui, sans-serif',
        themeVariables: {
          background: "transparent",
          primaryColor: "#1b2430",
          primaryBorderColor: "#3d4c5e",
          primaryTextColor: "#cdd3de",
          lineColor: "#828791",
          secondaryColor: "#20262e",
          tertiaryColor: "#161a20",
          mainBkg: "#1b2430",
          nodeBorder: "#3d4c5e",
          clusterBkg: "rgba(255,255,255,0.02)",
          edgeLabelBackground: "#141416",
          titleColor: "#cdd3de",
          actorBkg: "#1b2430",
          actorBorder: "#3d4c5e",
          actorTextColor: "#cdd3de",
          signalColor: "#828791",
          signalTextColor: "#cdd3de",
          labelBoxBkgColor: "#1b2430",
          labelBoxBorderColor: "#3d4c5e",
          labelTextColor: "#cdd3de",
          loopTextColor: "#cdd3de",
          noteBkgColor: "#20262e",
          noteTextColor: "#cdd3de",
          noteBorderColor: "#3d4c5e",
          activationBkgColor: "#20262e",
          activationBorderColor: "#3d4c5e",
          sequenceNumberColor: "#cdd3de",
          classText: "#cdd3de",
          attributeBackgroundColorOdd: "#161a20",
          attributeBackgroundColorEven: "#1b2430",
        },
      });
      return m.default;
    }).catch(err => {
      mermaidPromise = null;
      throw err;
    });
  }
  return mermaidPromise;
}

const SVG_CACHE_CAP = 10;
const svgCache = new Map<string, string>();
let renderSeq = 0;

interface MermaidBlockProps {
  source: string;
  streaming?: boolean;
}

/**
 * First-class Mermaid rendering with pan/zoom/fit, node inspection with
 * connected-edge highlighting, source view, copy, SVG download, fullscreen.
 * Invalid diagrams never crash: the source is preserved in a code block.
 */
export default memo(function MermaidBlock({ source, streaming = false }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<{ label: string } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);

  const settledSource = useMemo(() => source.trim(), [source]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const cached = svgCache.get(settledSource);
    if (cached) { setSvg(cached); return; }
    const delay = streaming ? STREAM_SETTLE_MS : 0;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.render("mmd-" + (++renderSeq).toString(36), settledSource);
        if (cancelled) return;
        svgCache.set(settledSource, rendered);
        if (svgCache.size > SVG_CACHE_CAP) {
          const oldest = svgCache.keys().next().value;
          if (oldest !== undefined) svgCache.delete(oldest);
        }
        setSvg(rendered);
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : "diagram failed to render");
        }
      }
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settledSource, streaming]);

  // Wire node/edge interactivity after each SVG injection.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !svg) return;
    const cleanups: Array<() => void> = [];
    stage.querySelectorAll<SVGGElement>("g.node").forEach(node => {
      const label = node.querySelector(".nodeLabel")?.textContent?.trim()
        ?? node.querySelector("text")?.textContent?.trim() ?? "";
      node.style.cursor = "pointer";
      node.setAttribute("tabindex", "0");
      const activate = () => {
        setSelected({ label });
        highlightConnectedEdges(stage, node.id);
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
      });
      cleanups.push(() => node.removeEventListener("click", activate));
    });
    return () => cleanups.forEach(fn => fn());
  }, [svg]);

  // Non-passive wheel zoom (React onWheel is passive in some setups).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView(v => zoomAt(v, e.deltaY < 0 ? 1.15 : 0.87));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest("g.node")) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [view]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView(v => ({ ...v, x: drag.viewX + e.clientX - drag.startX, y: drag.viewY + e.clientY - drag.startY }));
  }, []);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = 40;
    if (e.key === "ArrowLeft") setView(v => ({ ...v, x: v.x + step }));
    else if (e.key === "ArrowRight") setView(v => ({ ...v, x: v.x - step }));
    else if (e.key === "ArrowUp") setView(v => ({ ...v, y: v.y + step }));
    else if (e.key === "ArrowDown") setView(v => ({ ...v, y: v.y - step }));
    else if (e.key === "+" || e.key === "=") setView(v => zoomAt(v, 1.2));
    else if (e.key === "-") setView(v => zoomAt(v, 0.83));
    else if (e.key === "0") setView({ x: 0, y: 0, k: 1 });
    else if (e.key === "Escape") setSelected(null);
    else return;
    e.preventDefault();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const handleCopySource = useCallback(async () => {
    setCopied(await copyText(source));
    setTimeout(() => setCopied(false), 2000);
  }, [source]);

  const handleDownloadSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.svg";
    a.click();
    URL.revokeObjectURL(url);
  }, [svg]);

  if (error) {
    return (
      <div className="diagram-block" data-testid="mermaid-error">
        <div className="diagram-error-note">
          Diagram source could not be rendered — showing the source instead.
        </div>
        <CodeBlock code={source} lang="mermaid" />
      </div>
    );
  }

  if (showSource || !svg) {
    return (
      <div className="diagram-block">
        {showSource && (
          <div className="code-block-header">
            <span className="code-block-lang">Diagram source</span>
            <div className="code-block-controls">
              <button className="code-block-ctl" onClick={() => setShowSource(false)}
                aria-label="Show rendered diagram" title="Diagram">
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        {svg === null && !streaming && !showSource && (
          <div className="diagram-pending-note" aria-hidden="true">Rendering diagram…</div>
        )}
        <CodeBlock code={source} lang="mermaid" streaming={streaming} />
      </div>
    );
  }

  return (
    <div className={"diagram-block" + (fullscreen ? " is-fullscreen" : "")} data-testid="mermaid-block">
      <div className="code-block-header">
        <span className="code-block-lang">Diagram</span>
        <div className="code-block-controls">
          <button className="code-block-ctl" onClick={() => setView(v => zoomAt(v, 1.2))} aria-label="Zoom in" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button className="code-block-ctl" onClick={() => setView(v => zoomAt(v, 0.83))} aria-label="Zoom out" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button className="code-block-ctl" onClick={() => { setView({ x: 0, y: 0, k: 1 }); setSelected(null); }}
            aria-label="Fit diagram" title="Fit / reset">
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          <button className={"code-block-ctl" + (showSource ? " is-active" : "")} onClick={() => setShowSource(true)}
            aria-label="Show diagram source" title="Source">
            <Code className="w-3.5 h-3.5" />
          </button>
          <button className="code-block-ctl" onClick={handleCopySource} aria-label="Copy diagram source" title="Copy source">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button className="code-block-ctl" onClick={handleDownloadSvg} aria-label="Download diagram as SVG" title="Download SVG">
            <Download className="w-3.5 h-3.5" />
          </button>
          <button className="code-block-ctl" onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="diagram-stage"
        tabIndex={0}
        role="group"
        aria-label="Interactive diagram: drag to pan, scroll to zoom, arrow keys to move, plus and minus to zoom, 0 to fit"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        data-testid="diagram-stage"
      >
        <div
          ref={stageRef}
          className="diagram-canvas"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      {selected && (
        <div className="diagram-inspect" data-testid="diagram-inspect">
          <span className="diagram-inspect-label">{selected.label || "Selected node"}</span>
          <button className="code-block-ctl" onClick={() => setSelected(null)} aria-label="Clear selection">
            <Eye className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
});

function zoomAt(v: { x: number; y: number; k: number }, factor: number) {
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.k * factor));
  const applied = k / v.k;
  // Keep the viewport center roughly fixed while zooming.
  return { k, x: v.x * applied, y: v.y * applied };
}

function highlightConnectedEdges(stage: HTMLElement, nodeId: string) {
  const rawId = nodeId.replace(/^flowchart-/, "").replace(/-\d+$/, "");
  if (!rawId) return;
  stage.querySelectorAll<SVGPathElement>("path[data-edge]").forEach(edge => {
    const pair = (edge.getAttribute("data-edge") ?? "").split(",");
    edge.classList.toggle("edge-active", pair.includes(rawId));
  });
}
