"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, Copy, ZoomIn, ZoomOut, Maximize2, Minimize2, Code, Eye, Download, Crosshair,
  Play, Pause, ChevronLeft, ChevronRight, RotateCcw, MessageSquarePlus,
} from "lucide-react";
import CodeBlock from "./CodeBlock";
import { copyText } from "../../lib/render/clipboard";
import { OBSIDIAN_MERMAID_THEME } from "../../lib/render/themes";

const STREAM_SETTLE_MS = 500;
const STEP_ADVANCE_MS = 1800;
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(m => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Without this, mermaid injects its "Syntax error in text" SVG into
        // document.body on parse failure and throws before cleaning it up,
        // leaving orphaned error boxes at the bottom of the page. We render
        // our own fallback (see the error state below), so suppress theirs.
        suppressErrorRendering: true,
        theme: "base",
        fontFamily: '"Inter", system-ui, sans-serif',
        themeVariables: OBSIDIAN_MERMAID_THEME,
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
  onSend?: (text: string) => void;
}

interface DiagramStep {
  id: string;
  title: string;
  explanation: string;
}

/**
 * First-class Mermaid rendering with pan/zoom/fit, node inspection with
 * connected-edge highlighting, source view, copy, SVG download, fullscreen.
 * `%%step: NodeID | Title | Explanation` comments drive a synced step
 * playback bar (Play/Pause/Prev/Next/Reset) that spotlights the active
 * node and its edges while dimming the rest; without step comments the
 * steps are derived from the rendered DOM (g.node / .messageText).
 * Invalid diagrams never crash: the source is preserved in a code block.
 */
export default memo(function MermaidBlock({ source, streaming = false, onSend }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<{ label: string } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [derivedSteps, setDerivedSteps] = useState<DiagramStep[]>([]);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);

  const settledSource = useMemo(() => source.trim(), [source]);
  const parsedSteps = useMemo(() => parseStepComments(settledSource), [settledSource]);
  const steps = parsedSteps.length > 0 ? parsedSteps : derivedSteps;
  const activeStep = stepIndex != null ? steps[stepIndex] ?? null : null;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setStepIndex(null);
    setPlaying(false);
    setDerivedSteps([]);
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

  // Inject the SVG imperatively — React must not own this subtree, because
  // it re-sets dangerouslySetInnerHTML on every re-render, which would wipe
  // the highlight classes and node listeners applied below. Then wire
  // node/edge interactivity and derive DOM-based playback steps.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !svg) return;
    stage.innerHTML = svg;
    const cleanups: Array<() => void> = [];
    const derived: DiagramStep[] = [];
    stage.querySelectorAll<SVGGElement>("g.node").forEach(node => {
      const label = nodeLabelOf(node);
      const rawId = normalizeNodeId(node.id);
      if (rawId || label) derived.push({ id: rawId, title: label || rawId, explanation: "" });
      node.style.cursor = "pointer";
      node.setAttribute("tabindex", "0");
      const activate = () => {
        setSelected({ label });
        highlightConnectedEdges(stage, node.id);
        const stepAt = parsedSteps.findIndex(s => (s.id && s.id === rawId) || s.title === label);
        if (stepAt >= 0) setStepIndex(stepAt);
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
      });
      cleanups.push(() => node.removeEventListener("click", activate));
    });
    if (derived.length === 0) {
      // Sequence diagrams have no g.node — fall back to message labels.
      stage.querySelectorAll<SVGTextElement>(".messageText").forEach(text => {
        const label = text.textContent?.trim() ?? "";
        if (label) derived.push({ id: "", title: label, explanation: "" });
      });
    }
    setDerivedSteps(derived);
    return () => cleanups.forEach(fn => fn());
  }, [svg, parsedSteps, showSource]);

  // Synced step highlight: active node glows, its edges flow, the rest dims.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !svg) return;
    const nodeIds = new Set<string>();
    stage.querySelectorAll<SVGGElement>("g.node").forEach(node => {
      const rawId = normalizeNodeId(node.id);
      nodeIds.add(rawId);
      const label = nodeLabelOf(node);
      const isActive = !!activeStep &&
        ((activeStep.id !== "" && activeStep.id === rawId) || activeStep.title === label);
      node.classList.toggle("viz-active-node", isActive);
      node.classList.toggle("viz-dimmed-node", !!activeStep && activeStep.id !== "" && !isActive);
    });
    stage.querySelectorAll<SVGPathElement>("path[data-edge]").forEach(edge => {
      const ends = edgeEndpoints(edge.id, nodeIds);
      edge.classList.toggle("viz-active-edge", !!activeStep && activeStep.id !== "" && ends.includes(activeStep.id));
    });
  }, [svg, activeStep, showSource]);

  // Auto-advance while playing; stop at the last step.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setStepIndex(i => {
        if (i == null) return 0;
        if (i + 1 >= steps.length) { setPlaying(false); return i; }
        return i + 1;
      });
    }, STEP_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [playing, steps.length]);

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
    else if (e.key === "Escape") { setSelected(null); setStepIndex(null); setPlaying(false); }
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

  const askAboutStep = useCallback((step: DiagramStep) => {
    onSend?.(
      `Explain this diagram step: "${step.title}"` +
      `${step.explanation ? ` — ${step.explanation}` : ""}. What is happening here and why?`,
    );
  }, [onSend]);

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
            {copied ? <Check className="w-3.5 h-3.5 text-white/80" /> : <Copy className="w-3.5 h-3.5" />}
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
        />
      </div>

      {steps.length > 0 && (
        <div className="viz-playbar" data-testid="mermaid-playbar">
          <button type="button" className="viz-play-btn" aria-label="Reset playback" title="Reset"
            onClick={() => { setStepIndex(null); setPlaying(false); }}>
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button type="button" className="viz-play-btn" aria-label="Previous step" title="Previous step"
            disabled={stepIndex == null || stepIndex <= 0}
            onClick={() => { setPlaying(false); setStepIndex(i => (i == null ? 0 : Math.max(0, i - 1))); }}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button type="button" className={"viz-play-btn" + (playing ? " is-active" : "")}
            aria-label={playing ? "Pause playback" : "Play steps"} title={playing ? "Pause" : "Play"}
            onClick={() => {
              if (!playing && stepIndex == null) setStepIndex(0);
              setPlaying(p => !p);
            }}>
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button type="button" className="viz-play-btn" aria-label="Next step" title="Next step"
            disabled={stepIndex != null && stepIndex >= steps.length - 1}
            onClick={() => { setPlaying(false); setStepIndex(i => (i == null ? 0 : Math.min(steps.length - 1, i + 1))); }}>
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="viz-step-count" data-testid="mermaid-step-count">
            Step {stepIndex == null ? 0 : stepIndex + 1}/{steps.length}
          </span>
        </div>
      )}

      {activeStep && (
        <div className="viz-callout" data-testid="mermaid-callout">
          <div className="min-w-0 flex-1">
            <span className="viz-callout-title">{activeStep.title}</span>
            {activeStep.explanation}
          </div>
          {onSend && (
            <button type="button" className="viz-ask-btn" onClick={() => askAboutStep(activeStep)}>
              <MessageSquarePlus className="w-3 h-3" /> Explain this step
            </button>
          )}
        </div>
      )}

      {selected && (
        <div className="diagram-inspect" data-testid="diagram-inspect">
          <span className="diagram-inspect-label">{selected.label || "Selected node"}</span>
          {onSend && (
            <button type="button" className="viz-ask-btn"
              onClick={() => onSend(`Explain the node "${selected.label}" in this diagram and how it connects to the rest.`)}>
              <MessageSquarePlus className="w-3 h-3" /> Explain this step
            </button>
          )}
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

function normalizeNodeId(id: string): string {
  // Mermaid 12 nests the diagram id inside the DOM id, e.g.
  // "mmd-1-flowchart-intake-0" -> "intake".
  const marker = id.lastIndexOf("flowchart-");
  const bare = marker >= 0 ? id.slice(marker + "flowchart-".length) : id;
  return bare.replace(/-\d+$/, "");
}

function nodeLabelOf(node: Element): string {
  return node.querySelector(".nodeLabel")?.textContent?.trim()
    ?? node.querySelector("text")?.textContent?.trim() ?? "";
}

function highlightConnectedEdges(stage: HTMLElement, nodeId: string) {
  const rawId = normalizeNodeId(nodeId);
  if (!rawId) return;
  const nodeIds = new Set<string>();
  stage.querySelectorAll<SVGGElement>("g.node").forEach(node => nodeIds.add(normalizeNodeId(node.id)));
  stage.querySelectorAll<SVGPathElement>("path[data-edge]").forEach(edge => {
    edge.classList.toggle("edge-active", edgeEndpoints(edge.id, nodeIds).includes(rawId));
  });
}

/** Mermaid 12 edge path ids look like "mmd-1-L_intake_plan_0"; node ids may
 *  contain underscores, so split against the known node id set. */
function edgeEndpoints(edgeId: string, nodeIds: Set<string>): string[] {
  const match = /-L_(.+)_\d+$/.exec(edgeId);
  if (!match) return [];
  const joined = match[1];
  for (const source of nodeIds) {
    if (!joined.startsWith(source + "_")) continue;
    const target = joined.slice(source.length + 1);
    if (nodeIds.has(target)) return [source, target];
  }
  return [];
}

/** `%%step: NodeID | Title | Explanation` — one playback step per line. */
function parseStepComments(source: string): DiagramStep[] {
  const steps: DiagramStep[] = [];
  for (const line of source.split("\n")) {
    const match = /^%%\s*step:\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/.exec(line.trim());
    if (match) steps.push({ id: match[1], title: match[2], explanation: match[3] });
  }
  return steps;
}
