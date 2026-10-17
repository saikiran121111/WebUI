"use client";

import { memo } from "react";
import ThreeStudioViewer from "./ThreeStudioViewer";

interface ThreeCodeBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
  /** Reports a code-level failure (syntax/runtime/empty scene) for auto-repair. */
  onRuntimeError?: (error: string) => void;
}

/**
 * ```threejs fence (and Three.js-looking ```js fences): model-authored
 * executable Three.js mounted in the same ThreeStudioViewer as scene3d
 * JSON — outliner, picking, gizmos, shading modes, explode and exporters
 * all index the named parts the code creates.
 */
export default memo(function ThreeCodeBlock({ source, streaming = false, onSend, onRuntimeError }: ThreeCodeBlockProps) {
  // Never execute a half-streamed fence: wait for the closing ```.
  if (streaming) return null;
  return (
    <div className="scene3d-block" data-testid="threejs-block">
      <div className="code-block-header">
        <span className="code-block-lang">Three.js code</span>
        <span className="scene3d-title">Executable model</span>
      </div>
      <ThreeStudioViewer code={source} onSend={onSend} onRuntimeError={onRuntimeError ? info => onRuntimeError(info.error) : undefined} />
    </div>
  );
});
