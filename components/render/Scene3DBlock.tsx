"use client";
import { memo, useMemo } from "react";
import CodeBlock from "./CodeBlock";
import ThreeStudioViewer from "./ThreeStudioViewer";
import { parseJsonFence } from "../../lib/render/schemas";
import { scene3dSpecSchema } from "../../lib/three3d/sceneSchema";

/**
 * Renders ```scene3d fences: validated JSON only (model output is never
 * executed as code), parsed against the v2 schema and handed to
 * ThreeStudioViewer — the full studio front-end (shading modes, outliner,
 * material editor, 3-point lighting, post-FX, explode, multi-format export).
 * three.js and the studio engine load on demand inside the viewer, so the
 * base bundle never pays for three.
 */
interface Scene3DBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

export default memo(function Scene3DBlock({ source, streaming = false, onSend }: Scene3DBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, scene3dSpecSchema), [source]);

  if (!parsed.ok) {
    if (streaming) return null; // partial JSON mid-stream: render nothing yet
    return (
      <div className="scene3d-block" data-testid="scene3d-error">
        <div className="diagram-error-note">3D scene data did not validate — showing the source instead.</div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return (
    <div className="scene3d-block" data-testid="scene3d-block" data-scene-title={parsed.value.title ?? ""}>
      <div className="code-block-header">
        <span className="code-block-lang">{parsed.value.title ?? "3D scene"}</span>
      </div>
      <ThreeStudioViewer spec={parsed.value} onSend={onSend} />
    </div>
  );
});
