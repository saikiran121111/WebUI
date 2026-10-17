"use client";

import { memo, useMemo } from "react";
import { parseJsonFence } from "../../lib/render/schemas";
import { cadSpecSchema } from "../../lib/cad/cadSchema";
import ArchitectureCadViewer from "./ArchitectureCadViewer";
import CodeBlock from "./CodeBlock";

function CadBlock({
  source,
  streaming,
  onSend,
}: {
  source: string;
  streaming: boolean;
  onSend?: (text: string) => void;
}) {
  const parsed = useMemo(() => parseJsonFence(source, cadSpecSchema), [source]);

  if (!parsed.ok && streaming) return null;

  if (!parsed.ok) {
    return (
      <div className="cad-block" data-testid="cad-error">
        <div className="cad-error-note">{parsed.error}</div>
        <CodeBlock code={source} lang="cad" streaming={streaming} />
      </div>
    );
  }

  return (
    <div className="cad-block" data-testid="cad-block">
      <div className="code-block-header">
        <span className="code-block-lang">{parsed.value.title || "CAD drawing"}</span>
      </div>
      <ArchitectureCadViewer spec={parsed.value} onSend={onSend} />
    </div>
  );
}

export default memo(CadBlock);
