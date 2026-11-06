"use client";
/**
 * Interactive HTML artifact viewer (PHASE 2). Minimal auto-sizing dark box —
 * ZERO chrome inside the frame (no toolbar, no icons, no code toggle): just
 * a 1px rgba(255,255,255,0.12) border, 16px radius, #000000 canvas around a
 * sandboxed iframe. The iframe injects a ResizeObserver that posts
 * {type:"HTML_VIEWER_RESIZE",width,height,luma}; the parent validates the
 * message source, clamps the height, and animates the fit smoothly. All
 * pointer and keyboard input passes straight through to the artifact at 60fps.
 *
 * The fence body is model output, so the frame runs in an OPAQUE origin — see
 * `lib/render/htmlSrcDoc.ts` for the sandbox contract and for why the luma
 * probe and the storage shim both live inside the frame (2026-11-06 audit,
 * finding 6). The parent never reads the frame's document.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { isBrokenHtmlFence } from "../../lib/documents/schemas";
import {
  buildSrcDoc,
  HTML_ARTIFACT_SANDBOX,
  shouldInvert,
  type HtmlViewerResizeMessage,
} from "../../lib/render/htmlSrcDoc";
import { downloadDocument, FenceBroken, FencePending, saveBlob } from "./DocumentCard";
import { useElementFullscreen } from "../../hooks/useElementFullscreen";

const MIN_H = 120;
const MAX_H = 2400;

export default function HtmlArtifactBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const [height, setHeight] = useState(420);
  const [clamped, setClamped] = useState(false);
  const [invert, setInvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { fullscreen, toggleFullscreen } = useElementFullscreen(rootRef);

  const broken = !streaming && isBrokenHtmlFence(source);
  const srcDoc = useMemo(() => (streaming || broken ? null : buildSrcDoc(source)), [source, streaming, broken]);

  // Light-background artifacts (white reports/charts with black ink) get an
  // invert+hue-rotate filter so the viewer matches the app's dark chrome —
  // the Download HTML / Export PDF paths are untouched (still white paper).
  // The luma arrives INSIDE the resize message because the frame now runs in
  // an opaque origin: reading `frame.contentDocument` would throw.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return; // reject lookalike posts
      const d = ev.data as Partial<HtmlViewerResizeMessage> | null;
      if (!d || d.type !== "HTML_VIEWER_RESIZE" || typeof d.height !== "number" || !isFinite(d.height)) return;
      setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.round(d.height))));
      // Content taller than the clamp: the frame must scroll internally, or
      // the tail of long split-page PDF previews is unreachable.
      setClamped(d.height > MAX_H);
      setInvert(shouldInvert(d.luma));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (streaming) return <FencePending label="HTML artifact" />;
  if (broken) return <FenceBroken label="html" />;

  const onExportPdf = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadDocument("/api/documents/pdf", source, "artifact.pdf");
    } catch (e) {
      setError((e as Error).message);
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
      <div className="html-artifact-frame" style={{ height }}>
        <iframe
          ref={frameRef}
          title="Interactive HTML artifact"
          className={"html-artifact-iframe" + (invert ? " html-artifact-iframe--invert" : "")}
          sandbox={HTML_ARTIFACT_SANDBOX}
          srcDoc={srcDoc ?? ""}
          scrolling={clamped || fullscreen ? "yes" : "no"}
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
