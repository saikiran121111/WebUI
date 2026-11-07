"use client";
/**
 * Read-only compatibility card for fences whose viewers were retired:
 * ```scene3d, ```asset3d, ```threejs and ```cad blocks (Ruke plan
 * Phase 4, 2026-11-06) and ```anatomy blocks (2026-11-07, user
 * directive) saved in older conversations.  The fence source is
 * preserved verbatim — viewable, copyable, downloadable — but NEVER
 * executed: no Three.js runtime, no CAD engine, no network.  An honest
 * message instead of a silently-broken viewer.
 */
import { useState } from "react";

const RETIRED: Record<string, { title: string; subject: string }> = {
  scene3d: { title: "3D scene viewer retired", subject: "3D scene specification" },
  asset3d: { title: "3D asset viewer retired", subject: "3D asset specification" },
  threejs: { title: "Three.js live viewer retired", subject: "Three.js scene code" },
  cad: { title: "CAD blueprint viewer retired", subject: "CAD blueprint specification" },
  anatomy: { title: "Anatomy illustration viewer retired", subject: "anatomy illustration specification" },
};

export default function RetiredFenceBlock({ kind, source }: { kind: string; source: string }) {
  const [copied, setCopied] = useState(false);
  const meta = RETIRED[kind] ?? { title: "Renderer retired", subject: "fence source" };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable in this context — the <pre> below is selectable anyway.
    }
  };

  const download = () => {
    const ext = kind === "threejs" ? "js" : "json";
    const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `retired-${kind}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="retired-fence" data-testid="retired-fence" role="note">
      <div className="retired-fence-head">
        <span className="retired-fence-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" strokeLinejoin="round" />
            <path d="M3 8l9 5 9-5M12 13v8" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="retired-fence-copy">
          <strong>{meta.title}</strong>
          <p>
            The built-in 3D, CAD and anatomy viewers were retired on
            2026-11-06 and 2026-11-07. Your saved {meta.subject} is
            preserved below as plain source and is never executed. New
            visuals use charts, Mermaid diagrams and HTML artifacts;
            3D/CAD tooling would arrive later through a dedicated
            integration request.
          </p>
        </div>
      </div>
      <details className="retired-fence-details">
        <summary>Show the saved {meta.subject.toLowerCase()} ({source.length.toLocaleString()} characters)</summary>
        <pre className="retired-fence-source"><code>{source}</code></pre>
      </details>
      <div className="retired-fence-actions">
        <button type="button" className="retired-fence-btn" onClick={copy} data-testid="retired-fence-copy">
          {copied ? "Copied" : "Copy source"}
        </button>
        {/* "Download source", not "Download": what comes down is the saved fence TEXT, never a
            runnable 3D/CAD artifact — the label is part of the honesty contract of this card. */}
        <button type="button" className="retired-fence-btn" onClick={download} data-testid="retired-fence-download">
          Download source
        </button>
      </div>
    </div>
  );
}
