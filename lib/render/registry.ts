/**
 * Fence renderer registry: decides which component owns a fenced block.
 * Adding a new fence type means adding one entry here plus its component —
 * no conditionals in the chat or markdown components.
 */
export type FenceKind =
  | "mermaid" | "chart" | "widget" | "scene3d" | "asset3d" | "threejs" | "anatomy" | "cad" | "code"
  | "html" | "resume" | "docx" | "xlsx" | "pptx" | "powerbi"
  | "browser_api";

const FENCE_OWNERS: Record<string, FenceKind> = {
  mermaid: "mermaid",
  chart: "chart",
  widget: "widget",
  scene3d: "scene3d",
  asset3d: "asset3d",
  threejs: "threejs",
  anatomy: "anatomy",
  cad: "cad",
  html: "html",
  resume: "resume",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  powerbi: "powerbi",
  // The model's browser-control fence (lib/browser/browserToolProtocol.ts):
  // BrowserApiBlock executes the JSON action against /api/browser and
  // records the outcome for the next turn's system context.
  browser_api: "browser_api",
};

export function fenceKind(rawLang: string): FenceKind {
  const normalized = rawLang.toLowerCase().split(/[:?\s]/)[0];
  return FENCE_OWNERS[normalized] ?? "code";
}
