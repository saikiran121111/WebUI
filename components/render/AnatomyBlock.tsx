"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Download, Layers, Maximize2, Minimize2, Moon, Sun } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence } from "../../lib/render/schemas";
import { anatomySpecSchema, type AnatomySpec } from "../../lib/anatomy/anatomySchema";
import type { AnatomyFigure } from "../../lib/anatomy/anatomyBuilder";
import "../../lib/anatomy/kit/iso.css";

/**
 * Renders ```anatomy fences as crafted isometric technical illustrations:
 * validated JSON only (model output is never executed), projected into an SVG
 * plate by the deterministic kit builder, then made interactive by the
 * dependency-free live engine (sliders/needles/readouts share one state model).
 * Builder + engine load via dynamic import so the kit never touches the
 * initial bundle. This is an SVG illustration — never a 3D mesh.
 */
interface AnatomyBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

export default memo(function AnatomyBlock({ source, streaming = false, onSend }: AnatomyBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, anatomySpecSchema), [source]);

  if (!parsed.ok) {
    if (streaming) return null; // partial JSON mid-stream: render nothing yet
    return (
      <div className="anatomy-block" data-testid="anatomy-error">
        <div className="diagram-error-note">
          Anatomy illustration data did not validate ({parsed.error}) — showing the source instead.
          Ask the model to fix this exact error and re-emit the full fence.
        </div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return <AnatomyView spec={parsed.value} onSend={onSend} />;
});

interface AnatomyEngineHandle {
  setState(id: string, value: number): void;
  setExplode(on: boolean): void;
  destroy(): void;
}

function AnatomyView({ spec, onSend }: { spec: AnatomySpec; onSend?: (text: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<AnatomyEngineHandle | null>(null);
  // Keep the refine callback in a ref: its identity changes on every parent
  // render, and re-mounting the engine for that would duplicate its controls.
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const [figure, setFigure] = useState<AnatomyFigure | null>(null);
  const [buildFailed, setBuildFailed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [exploded, setExploded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [exportNote, setExportNote] = useState("");

  const filename = figure?.filename ?? slugify(spec.title);

  // Build the plate (kit projection) — dynamic import keeps iso-kit out of the base bundle.
  useEffect(() => {
    let disposed = false;
    setFigure(null);
    setBuildFailed(false);
    void (async () => {
      try {
        const { buildAnatomyFigure } = await import("../../lib/anatomy/anatomyBuilder");
        const built = buildAnatomyFigure(spec);
        if (!disposed) setFigure(built);
      } catch {
        if (!disposed) setBuildFailed(true);
      }
    })();
    return () => { disposed = true; };
  }, [spec]);

  // The plate slot is written imperatively: React must never re-set its
  // innerHTML, or a parent-driven re-render would wipe the live engine's
  // injected controls (dangerouslySetInnerHTML re-applies on every commit).
  const plateRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = plateRef.current;
    if (!slot) return;
    slot.innerHTML = figure ? figure.plate : "";
  }, [figure]);

  // Mount the live engine over the plate; part clicks send a focused refinement prompt.
  useEffect(() => {
    const root = rootRef.current;
    if (!figure || !root) return;
    let disposed = false;
    void (async () => {
      const { mountAnatomyLive } = await import("../../lib/anatomy/liveEngine.mjs");
      if (disposed || !rootRef.current) return;
      engineRef.current = mountAnatomyLive(rootRef.current, figure.liveSpec, {
        onPartClick: (id: string, label: string, note: string) => {
          const name = label || id;
          onSendRef.current?.(`Refine the "${name}" part of this anatomy illustration${note ? ` (${note})` : ""} — keep every other part and the current control values unchanged.`);
        },
      });
    })();
    return () => {
      disposed = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [figure]);

  // Explode state lives in React so re-mounts restore it.
  useEffect(() => { engineRef.current?.setExplode(exploded); }, [exploded, figure]);

  // Fullscreen where the browser supports it; the engine's zoom/pan/reset keep
  // the figure usable at any size inside the fullscreen element.
  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    const element = rootRef.current;
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (!element.requestFullscreen) {
      setExportNote("Fullscreen is not available in this browser.");
      return;
    }
    element.requestFullscreen().catch(() => setExportNote("Fullscreen was blocked by the browser."));
  }

  async function standaloneSvgMarkup(): Promise<string | null> {
    const svg = rootRef.current?.querySelector("svg.anatomy-svg");
    if (!svg) return null;
    const { ISO_CSS } = await import("../../lib/anatomy/kit/iso-kit");
    const clone = svg.cloneNode(true) as SVGElement;
    clone.classList.add("iso");
    clone.setAttribute("data-theme", theme);
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = ISO_CSS;
    const paper = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    paper.setAttribute("width", "100%");
    paper.setAttribute("height", "100%");
    paper.setAttribute("fill", "var(--anatomy-paper)");
    clone.insertBefore(paper, clone.firstChild);
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  async function downloadSvg() {
    const markup = await standaloneSvgMarkup();
    if (!markup) return;
    downloadBlob(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml" }), `${filename}.svg`);
  }

  async function downloadPng() {
    const markup = await standaloneSvgMarkup();
    if (!markup) return;
    const image = new Image();
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("svg rasterize failed"));
        image.src = url;
      });
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = spec.width * scale;
      canvas.height = spec.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = theme === "dark" ? "#131313" : "#fbfbfa";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) downloadBlob(blob, `${filename}.png`);
    } catch {
      setExportNote("PNG capture failed for this figure.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function requestExport(kind: "html" | "tsx") {
    try {
      const res = await fetch("/api/anatomy/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, theme, kind }),
      });
      if (!res.ok) { setExportNote(`${kind.toUpperCase()} export failed on the server.`); return; }
      downloadBlob(await res.blob(), `${filename}.${kind}`);
    } catch {
      setExportNote(`${kind.toUpperCase()} export failed.`);
    }
  }

  return (
    <div ref={rootRef} className="iso anatomy-block" data-theme={theme} data-testid="anatomy-block">
      <div className="anatomy-toolbar">
        <span className="anatomy-badge" data-testid="anatomy-badge">SVG vector illustration — not a 3D mesh</span>
        <div className="anatomy-tools">
          {spec.explode && (
            <button
              type="button"
              className={`viz-play-btn${exploded ? " is-active" : ""}`}
              onClick={() => setExploded((on) => !on)}
              aria-pressed={exploded}
              data-testid="anatomy-explode"
              title="Explode the assembly apart"
            >
              <Layers size={13} /> {spec.explode.label ?? "Explode"}
            </button>
          )}
          <button
            type="button"
            className="viz-play-btn"
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            data-testid="anatomy-fullscreen"
            title="Fullscreen the illustration"
          >
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />} Fullscreen
          </button>
          <button
            type="button"
            className="viz-play-btn"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            data-testid="anatomy-theme"
            title="Switch illustration theme"
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />} Theme
          </button>
          <button type="button" className="viz-play-btn" onClick={downloadSvg} disabled={!figure} data-testid="anatomy-download-svg" title="Download the figure as a standalone SVG">
            <Download size={13} /> SVG
          </button>
          <button type="button" className="viz-play-btn" onClick={downloadPng} disabled={!figure} data-testid="anatomy-download-png" title="Download a 2x PNG of the figure">
            <Download size={13} /> PNG
          </button>
          <button type="button" className="viz-play-btn" onClick={() => requestExport("html")} disabled={!figure} data-testid="anatomy-download-html" title="Download a standalone interactive HTML page">
            <Download size={13} /> HTML
          </button>
          <button type="button" className="viz-play-btn" onClick={() => requestExport("tsx")} disabled={!figure} data-testid="anatomy-download-tsx" title="Download a reusable React component">
            <Download size={13} /> TSX
          </button>
        </div>
      </div>

      {buildFailed ? (
        <div className="diagram-error-note" data-testid="anatomy-build-error">The illustration could not be drawn — showing the source instead.</div>
      ) : (
        <>
          {!figure && <div className="anatomy-loading">Drawing the illustration…</div>}
          <div className="anatomy-plate-slot" data-testid="anatomy-plate" ref={plateRef} />
        </>
      )}

      {figure && figure.warnings.length > 0 && (
        <div className="anatomy-warnings" data-testid="anatomy-warnings">{figure.warnings.join(" ")}</div>
      )}
      {exportNote && <div className="anatomy-warnings">{exportNote}</div>}
    </div>
  );
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 49) || "anatomy-figure";
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
