"use client";

import { memo, useMemo } from "react";
import { normalizeCad } from "../../lib/cad/normalizeCad";
import { fenceFixRequest } from "../../lib/render/fenceRepair";
import ArchitectureCadViewer from "./ArchitectureCadViewer";
import CodeBlock from "./CodeBlock";

interface CadBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

/**
 * ```cad fence: fault-tolerant by design. The normalizer aliases text/label
 * to content, defaults missing layers, accepts width/height + x1y1x2y2 +
 * x/y/radius spellings, repairs the stray empty-key layer typo, and skips
 * individual malformed entities instead of failing the whole drawing — so
 * `entities.12.content: Required (+115 more)` can never kill the viewer.
 */
export default memo(function CadBlock({ source, streaming = false, onSend }: CadBlockProps) {
  const result = useMemo(() => normalizeCad(source), [source]);

  if (!result.ok) {
    if (streaming) return null;
    return (
      <div className="cad-block" data-testid="cad-error">
        <div className="cad-error-note">CAD drawing could not be loaded: {result.error}</div>
        <button
          type="button"
          className="scene3d-tool-btn"
          data-testid="cad-fix-ai"
          onClick={() => onSend?.(fenceFixRequest("cad", result.error))}
        >
          🔧 Fix with AI
        </button>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }

  return (
    <div className="cad-block" data-testid="cad-block" data-cad-title={result.spec.title}>
      <div className="code-block-header">
        <span className="code-block-lang">CAD sheet</span>
        <span className="cad-title">{result.spec.title}</span>
      </div>
      <ArchitectureCadViewer spec={result.spec} onSend={onSend} />
    </div>
  );
});
