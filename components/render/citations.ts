/**
 * Citation pill plugin for the web-research evidence loop.
 *
 * Turns literal "[S1]", "[S2]"... markers in the assistant reply into
 * clickable pills that open the source URL. The plugin is a no-op when no
 * citationMap is provided (legacy / non-research messages), so existing
 * content renders unchanged.
 *
 * The strategy:
 *   1. Pre-scan the raw content for [S#] markers (citationMarkers()).
 *   2. Only when markers exist AND the citationMap has a matching entry,
 *      run the remark plugin to replace the exact whole-text-node
 *      `[S#]` values with a custom `citation` hast element.
 *
 * Because the pipeline always emits [S1]...[Sn] on their own (the main
 * model is instructed to use inline citations), the whole-text-node
 * strategy covers all real cases without fighting the markdown parser.
 * For the (rare) mixed case "[S1] and more", the text falls through
 * verbatim — it still renders as `[S1]` which is readable and links
 * via the research-trail card above the message.
 */

export interface CitationEntry {
  sourceId: string; // "S1"
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

export type CitationMap = Record<string, CitationEntry>;

/**
 * A remark plugin that rewrites whole-text `[S#]` nodes into a custom
 * hast element (`citation`) that react-markdown routes to our
 * `citation` component override in MD_COMPONENTS.
 */
export function remarkCitations(citationMap: CitationMap) {
  return function plugin(tree: any) {
    if (!citationMap || Object.keys(citationMap).length === 0) return;
    walkTextNodes(tree, (node: any, parent: any, index: number) => {
      if (!parent || index < 0) return;
      const value: string = node.value ?? "";
      const whole = value.match(/^\[S(\d+)\]$/);
      if (!whole) return;
      const sourceId = "S" + whole[1];
      const entry = citationMap[sourceId];
      if (!entry) return;
      parent.children[index] = {
        type: "element",
        tagName: "citation",
        properties: {
          "data-source": sourceId,
          "data-url": entry.url,
          "data-domain": entry.domain,
          "data-title": entry.title,
        },
        children: [{ type: "text", value: sourceId }],
      };
    });
  };
}

/**
 * Pre-scan helper: returns the set of [S#] markers actually present in the
 * raw content string. Callers use it to decide whether the plugin is
 * worth running (zero work when absent).
 */
export function citationMarkers(content: string): Set<string> {
  const out = new Set<string>();
  const re = /\[S(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.add("S" + m[1]);
  return out;
}

/* ── tiny tree walker (no unist dependency) ─────────────────────────── */

function walkTextNodes(
  node: any,
  visit: (n: any, parent: any, index: number) => void,
  parent: any = null,
  index = -1,
): void {
  if (node.type === "text") visit(node, parent, index);
  if (Array.isArray(node.children)) {
    node.children.forEach((c: any, i: number) => walkTextNodes(c, visit, node, i));
  }
}
