/**
 * Fence renderer registry: decides which component owns a fenced block.
 * Adding a new fence type means adding one entry here plus its component —
 * no conditionals in the chat or markdown components.
 */
// scene3d/asset3d/threejs/cad are RETIRED kinds (Ruke plan Phase 4,
// 2026-11-06) and anatomy joined them on 2026-11-07 (user directive —
// the route grew out of the same architecture-design feature): their
// entries stay so saved-conversation fences keep routing here, and
// FenceRouter sends them to the read-only RetiredFenceBlock
// compatibility card instead of a viewer.
export type FenceKind =
  | "mermaid" | "chart" | "widget" | "scene3d" | "asset3d" | "threejs" | "anatomy" | "cad" | "code"
  | "html" | "resume" | "docx" | "xlsx" | "pptx" | "powerbi";

const FENCE_OWNERS: Record<string, FenceKind> = {
  mermaid: "mermaid",
  chart: "chart",
  widget: "widget",
  scene3d: "scene3d", // retired -> compatibility card
  asset3d: "asset3d", // retired -> compatibility card
  threejs: "threejs", // retired -> compatibility card
  anatomy: "anatomy", // retired 2026-11-07 -> compatibility card
  cad: "cad", // retired -> compatibility card
  html: "html",
  resume: "resume",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  powerbi: "powerbi",
};

export function fenceKind(rawLang: string): FenceKind {
  const normalized = rawLang.toLowerCase().split(/[:?\s]/)[0];
  return FENCE_OWNERS[normalized] ?? "code";
}
