/**
 * Fence renderer registry: decides which component owns a fenced block.
 * Adding a new fence type means adding one entry here plus its component —
 * no conditionals in the chat or markdown components.
 */
export type FenceKind = "mermaid" | "chart" | "widget" | "scene3d" | "code";

const FENCE_OWNERS: Record<string, FenceKind> = {
  mermaid: "mermaid",
  chart: "chart",
  widget: "widget",
  scene3d: "scene3d",
};

export function fenceKind(rawLang: string): FenceKind {
  const normalized = rawLang.toLowerCase().split(/[:?\s]/)[0];
  return FENCE_OWNERS[normalized] ?? "code";
}
