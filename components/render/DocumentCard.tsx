"use client";
/**
 * Unified preview-before-download shell (PHASE 5) shared by every document
 * modality: a slim action bar (modality badge • filename), Fullscreen toggle
 * (Esc exits), optional extra actions (Run Slideshow), and Download which
 * POSTs the fence spec to the matching /api/documents/* engine and saves the
 * real file. The preview body renders client-side from the fence JSON, so
 * regeneration re-renders the preview in place with zero round-trips.
 */
import { ReactNode, useCallback, useEffect, useState } from "react";

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
  children: ReactNode;
}

export default function DocumentCard({ badge, filename, endpoint, spec, testId, actions, children }: DocumentCardProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const onDownload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadDocument(endpoint, spec, filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [endpoint, spec, filename]);

  return (
    <div className={"doc-card" + (fullscreen ? " doc-card--fullscreen" : "")} data-testid={testId}>
      <div className="doc-card-bar">
        <span className="doc-card-badge">{badge}</span>
        <span className="doc-card-filename">{filename}</span>
        <span className="doc-card-actions">
          {actions}
          <button
            type="button"
            className="doc-card-btn"
            onClick={() => setFullscreen((f) => !f)}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
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
    </div>
  );
}

/** Shared placeholder shown while a JSON document fence is still streaming. */
export function FencePending({ label }: { label: string }) {
  return (
    <div className="doc-pending" role="status">
      <span className="doc-pending-dot" aria-hidden="true" />
      Building {label} preview…
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
