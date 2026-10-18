"use client";
/**
 * Unified preview-before-download shell (PHASE 5) shared by every document
 * modality: a slim action bar (modality badge • filename), Fullscreen toggle
 * (Esc exits), optional extra actions (Run Slideshow), and Download which
 * POSTs the fence spec to the matching /api/documents/* engine and saves the
 * real file. The preview body renders client-side from the fence JSON, so
 * regeneration re-renders the preview in place with zero round-trips.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Mascot from "../ui/Mascot";
import { useBuildProgress } from "../ui/RobotProgress";

export async function downloadDocument(endpoint: string, spec: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!res.ok) {
    let msg = "Generation failed (" + res.status + ")";
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(cd);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

interface DocumentCardProps {
  badge: string;
  filename: string;
  endpoint: string;
  spec: unknown;
  testId: string;
  /** Extra action buttons rendered before Fullscreen (e.g. Run Slideshow). */
  actions?: ReactNode;
  /** Hides the Fullscreen button (PPTX: the native-FS slideshow replaces it). */
  hideFullscreen?: boolean;
  children: ReactNode;
}

export default function DocumentCard({ badge, filename, endpoint, spec, testId, actions, hideFullscreen, children }: DocumentCardProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // True once the native Fullscreen API actually owns the element — then the
  // browser (not our Esc handler) handles exit, and fullscreenchange syncs us.
  const nativeFsRef = useRef(false);
  // Robot toast: the download POST has no server progress channel, so the
  // staged ramp (lib/ui/stagedProgress) stands in visually until the blob lands.
  const { start, succeed, fail, toast } = useBuildProgress("Building " + badge);

  const toggleFullscreen = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) { void document.exitFullscreen(); return; }
    if (document.fullscreenElement) return; // another element owns fullscreen
    // The CSS class below is the fallback; requestFullscreen additionally
    // hides the browser chrome (URL bar / tabs) when the grant succeeds.
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
      // Native fullscreen consumes Esc (browser exits FS → fullscreenchange
      // syncs state); this handler only covers the CSS-fallback mode.
      if (e.key === "Escape" && !nativeFsRef.current) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const onDownload = useCallback(async () => {
    setBusy(true);
    setError(null);
    start();
    try {
      await downloadDocument(endpoint, spec, filename);
      succeed();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      fail(msg);
    } finally {
      setBusy(false);
    }
  }, [endpoint, spec, filename, start, succeed, fail]);

  return (
    <div ref={cardRef} className={"doc-card" + (fullscreen ? " doc-card--fullscreen" : "")} data-testid={testId}>
      <div className="doc-card-bar">
        <span className="doc-card-badge">{badge}</span>
        <span className="doc-card-filename">{filename}</span>
        <span className="doc-card-actions">
          {actions}
          {!hideFullscreen && (
            <button
              type="button"
              className="doc-card-btn"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </button>
          )}
          <button
            type="button"
            className="doc-card-btn doc-card-btn--primary"
            onClick={onDownload}
            disabled={busy}
            aria-label={"Download " + badge + " file"}
          >
            {busy ? "Building…" : "Download"}
          </button>
        </span>
      </div>
      {error && <div className="doc-card-error" role="alert">{error}</div>}
      <div className="doc-card-body">{children}</div>
      {fullscreen && <div className="doc-card-esc-hint">Press Esc to exit</div>}
      {toast}
    </div>
  );
}

/** Shared placeholder shown while a JSON document fence is still streaming. */
export function FencePending({ label, chars }: { label: string; chars?: number }) {
  // The bar tracks how much of the JSON fence has streamed in (saturating at
  // 90% — the spec only becomes valid once the fence closes).
  const pct = chars != null && chars > 0
    ? Math.min(90, Math.round(90 * (1 - Math.exp(-chars / 1500))))
    : null;
  return (
    <div className="doc-pending" role="status">
      <Mascot size={20} state="working" />
      <span className="doc-pending-dot" aria-hidden="true" />
      <span className="doc-pending-text">Building {label} preview…</span>
      {pct != null && (
        <span className="fence-pending-bar" aria-hidden="true">
          <span className="fence-pending-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}

/** Shared placeholder when the fence body cannot be normalized (repair loop pending). */
export function FenceBroken({ label }: { label: string }) {
  return (
    <div className="doc-broken" role="status">
      The {label} spec is incomplete — waiting for the model to repair the fence.
    </div>
  );
}
