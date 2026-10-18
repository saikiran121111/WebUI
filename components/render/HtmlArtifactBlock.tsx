"use client";
/**
 * Interactive HTML artifact viewer (PHASE 2). Minimal auto-sizing dark box —
 * ZERO chrome inside the frame (no toolbar, no icons, no code toggle): just
 * a 1px rgba(255,255,255,0.12) border, 16px radius, #000000 canvas around a
 * sandboxed iframe. The iframe injects a ResizeObserver that posts
 * {type:"HTML_VIEWER_RESIZE",width,height}; the parent validates the message
 * source, clamps the height, and animates the fit smoothly. All pointer and
 * keyboard input passes straight through to the artifact at 60fps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBrokenHtmlFence } from "../../lib/documents/schemas";
import { downloadDocument, FenceBroken, FencePending, saveBlob } from "./DocumentCard";
import { useBuildProgress } from "../ui/RobotProgress";

const MIN_H = 120;
const MAX_H = 2400;

/** Runs INSIDE the sandboxed iframe: reports content size to the parent. */
const RESIZE_SCRIPT =
  "<script>(function(){var post=function(){try{var d=document.documentElement;var b=document.body;" +
  "parent.postMessage({type:'HTML_VIEWER_RESIZE'," +
  "width:Math.max(d.scrollWidth,b?b.scrollWidth:0)," +
  "height:Math.max(d.scrollHeight,b?b.scrollHeight:0)},'*')}catch(e){}};" +
  "if(window.ResizeObserver){new ResizeObserver(post).observe(document.documentElement);}" +
  "window.addEventListener('load',post);window.addEventListener('resize',post);setTimeout(post,50);post();})();</script>";

function buildSrcDoc(source: string): string {
  const isFullDoc = /<html[\s>]/i.test(source);
  const doc = isFullDoc
    ? source
    : '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>html,body{margin:0;background:#000000;color:#FFFFFF;font-family:system-ui,sans-serif}</style></head><body>' +
      source + "</body></html>";
  return doc.includes("</body>") ? doc.replace(/<\/body>/i, RESIZE_SCRIPT + "</body>") : doc + RESIZE_SCRIPT;
}

export default function HtmlArtifactBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const [height, setHeight] = useState(420);
  const [clamped, setClamped] = useState(false);
  const [invert, setInvert] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nativeFsRef = useRef(false);

  const broken = !streaming && isBrokenHtmlFence(source);
  const srcDoc = useMemo(() => (streaming || broken ? null : buildSrcDoc(source)), [source, streaming, broken]);

  // Light-background artifacts (white reports/charts with black ink) get an
  // invert+hue-rotate filter so the viewer matches the app's dark chrome —
  // the Download HTML / Export PDF paths are untouched (still white paper).
  const probeLuma = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      const bg = getComputedStyle(doc.body).backgroundColor;
      const m = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(bg);
      if (!m) return;
      const luma = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      setInvert(luma > 0.5);
    } catch { /* sandboxed cross-origin — leave colors as authored */ }
  }, []);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return; // reject lookalike posts
      const d = ev.data as { type?: string; height?: number } | null;
      if (!d || d.type !== "HTML_VIEWER_RESIZE" || typeof d.height !== "number" || !isFinite(d.height)) return;
      setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.round(d.height))));
      // Content taller than the clamp: the frame must scroll internally, or
      // the tail of long split-page PDF previews is unreachable.
      setClamped(d.height > MAX_H);
      probeLuma();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [probeLuma]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) { void document.exitFullscreen(); return; }
    if (document.fullscreenElement) return;
    // Native FS hides the browser chrome; the fixed-inset CSS class remains
    // as the fallback when the API is unavailable or the grant fails.
    el.requestFullscreen?.()
      .then(() => { nativeFsRef.current = true; })
      .catch(() => { nativeFsRef.current = false; });
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && nativeFsRef.current) {
        nativeFsRef.current = false;
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !nativeFsRef.current) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Robot toast for the slow PDF export (headless Chromium render + screenshot).
  const { start, succeed, fail, toast: pdfToast } = useBuildProgress("Exporting PDF");

  if (streaming) return <FencePending label="HTML artifact" chars={source.length} />;
  if (broken) return <FenceBroken label="html" />;

  const onExportPdf = async () => {
    setBusy(true);
    setError(null);
    start();
    try {
      await downloadDocument("/api/documents/pdf", source, "artifact.pdf");
      succeed();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      fail(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={"html-artifact" + (fullscreen ? " html-artifact--fullscreen" : "")}
      data-testid="html-artifact-block"
    >
      {pdfToast}
      <div className="html-artifact-frame" style={{ height }}>
        <iframe
          ref={frameRef}
          title="Interactive HTML artifact"
          className={"html-artifact-iframe" + (invert ? " html-artifact-iframe--invert" : "")}
          sandbox="allow-scripts allow-same-origin"
          srcDoc={srcDoc ?? ""}
          scrolling={clamped || fullscreen ? "yes" : "no"}
          onLoad={probeLuma}
        />
      </div>
      <div className="html-artifact-actions">
        {error && <span className="doc-card-error" role="alert">{error}</span>}
        <button
          type="button"
          className="doc-card-btn"
          onClick={() => saveBlob(new Blob([source], { type: "text/html" }), "artifact.html")}
          aria-label="Download HTML file"
        >
          Download HTML
        </button>
        <button type="button" className="doc-card-btn" onClick={onExportPdf} disabled={busy} aria-label="Export as PDF">
          {busy ? "Rendering…" : "Export PDF"}
        </button>
        <button
          type="button"
          className="doc-card-btn"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
      </div>
      {fullscreen && <div className="doc-card-esc-hint">Press Esc to exit</div>}
    </div>
  );
}
