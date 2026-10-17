"use client";

import { memo, useMemo } from "react";
import { normalizeScene3d } from "../../lib/three3d/normalizeScene";
import { fenceFixRequest } from "../../lib/render/fenceRepair";
import ThreeStudioViewer from "./ThreeStudioViewer";
import CodeBlock from "./CodeBlock";

interface Scene3DBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

/**
 * ```scene3d fence: fault-tolerant by design. The normalizer repairs model
 * drift (segment caps, unknown animation targets, kind aliases, missing
 * params) so the studio viewer ALWAYS mounts when there is an objects array.
 * The old all-or-nothing "did not validate" wall only appears when the JSON
 * is truly unusable — and even then with a "Fix with AI" retry path.
 */
export default memo(function Scene3DBlock({ source, streaming = false, onSend }: Scene3DBlockProps) {
  const result = useMemo(() => normalizeScene3d(source), [source]);

  if (!result.ok) {
    if (streaming) return null; // mid-stream JSON is always incomplete — stay quiet
    return (
      <div className="scene3d-block" data-testid="scene3d-error">
        <div className="diagram-error-note">3D scene could not be loaded: {result.error}</div>
        <button
          type="button"
          className="scene3d-tool-btn"
          data-testid="scene3d-fix-ai"
          onClick={() => onSend?.(fenceFixRequest("scene3d", result.error))}
        >
          🔧 Fix with AI
        </button>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }

  return (
    <div className="scene3d-block" data-testid="scene3d-block" data-scene-title={result.spec.title ?? ""}>
      <div className="code-block-header">
        <span className="code-block-lang">3D studio</span>
        {result.spec.title && <span className="scene3d-title">{result.spec.title}</span>}
      </div>
      <ThreeStudioViewer spec={result.spec} onSend={onSend} />
    </div>
  );
});
