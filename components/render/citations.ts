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
 *      run the rehype plugin, which splits every text node on `[S#]` and
 *      swaps each mapped marker for a custom `citation` hast element.
 *
 * Splitting (rather than matching a text node that is EXACTLY `[S#]`) is what
 * makes inline attribution work: "₹18,992 [S2]" and "[S1] shows…" both render
 * as pills. Markers with no entry in the citationMap stay as literal text, so
 * a hallucinated `[S7]` never becomes a clickable pill.
 *
 * WHY IT IS A REHYPE PLUGIN AND NOT A REMARK ONE (the failure this fixes): the
 * emitted nodes are hast `element` nodes, and a remark transformer runs on the
 * mdast tree — react-markdown then converts mdast→hast and DROPS unknown node
 * types. Every run of the evidence loop rendered `citation pills=0` while the
 * answer plainly contained `[S4]`: the adjudication existed and simply never
 * reached the page. Running on hast is also what makes the code exemption
 * possible — in hast, code spans are `<code>`/`<pre>` ELEMENTS holding text
 * nodes, so the walker has to refuse them explicitly; the old mdast shape
 * (dedicated `inlineCode`/`code` node types) got that for free.
 *
 * Second, quieter half of the same bug: unified invokes a plugin as an
 * ATTACHER, which must RETURN the transformer. A `(tree) => {}` function pushed
 * straight into the plugin list is called with `tree === undefined` and does
 * nothing at all — no error, no pill, no console warning. `rehypeCitations()`
 * therefore returns an attacher, which returns the transformer.
 */

import type { ClaimStatus } from "../../src/lib/web-verify/types";

export interface CitationEntry {
  sourceId: string; // "S1"
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

export type CitationMap = Record<string, CitationEntry>;

/**
 * sourceId → the verdict the verification layer reached for THAT source.
 * OPTIONAL since 2026-10-22 (the web-verify ledger that produced these
 * verdicts is gone): pills are plain citations now and this map is left in
 * the type surface only so any older stored message data still parses.
 */
export type CitationStatusMap = Record<string, ClaimStatus>;

/**
 * A rehype plugin that rewrites `[S#]` text runs into a custom hast element
 * (`citation`) that react-markdown routes to our `citation` component override
 * in MD_COMPONENTS. Attacher → transformer, because that is how unified calls
 * plugins; see the header for why a transformer-shaped plugin silently no-ops.
 */
export function rehypeCitations(citationMap: CitationMap, _statusMap?: CitationStatusMap) {
  return function attacher() {
    return function transformer(tree: any) {
    if (!citationMap || Object.keys(citationMap).length === 0) return;
    walkTextNodes(tree, (node: any, parent: any, index: number) => {
      if (!parent || index < 0) return;
      const value: string = node.value ?? "";
      if (!value.includes("[S")) return;
      // Split on every marker, keeping the captured numbers at odd indices.
      const parts = value.split(/\[S(\d+)\]/);
      if (parts.length < 2) return;
      const out: any[] = [];
      let mapped = 0;
      for (let i = 0; i < parts.length; i++) {
        const chunk = parts[i];
        if (i % 2 === 0) {
          if (chunk) out.push({ type: "text", value: chunk });
          continue;
        }
        const sourceId = "S" + chunk;
        const entry = citationMap[sourceId];
        // No entry for this id: the model invented a marker we have no source
        // for. Keep it as visible text — never a pill, never a link.
        if (!entry) {
          out.push({ type: "text", value: `[S${chunk}]` });
          continue;
        }
        mapped++;
        out.push({
          type: "element",
          tagName: "citation",
          properties: {
            "data-source": sourceId,
            "data-url": entry.url,
            "data-domain": entry.domain,
            "data-title": entry.title,
          },
          children: [{ type: "text", value: sourceId }],
        });
      }
      if (mapped === 0) return;
      parent.children.splice(index, 1, ...out);
    });
    };
  };
}

/**
 * URL identity, for "is this link one of the sources we actually retrieved?".
 * Protocol/www/trailing-slash/case insensitive — the same normalisation the
 * server-side claim audit applies, so the UI and the audit agree on which
 * links are composed rather than copied.
 */
export function linkKey(url: string): string {
  return (url ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[.,;:)\]}'"]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * linkKey(url) → the verdict the evidence ledger reached for the SOURCE that
 * URL came from (plus its role label, e.g. "Seller product page"). The renderer
 * wears this on the answer's own links, so the ✓/⚠ verdict is visible even when
 * the model quotes a bare URL instead of an `[S#]` marker — which a small local
 * model does constantly, and the user should still see which links were checked.
 */
export interface LinkVerdict {
  status: ClaimStatus;
  label: string;
}
export type LinkStatusMap = Record<string, LinkVerdict>;

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
  if (!node || typeof node !== "object") return;
  // In hast, a code span is a <code> ELEMENT and a fenced block a <pre> one,
  // both holding ordinary text nodes — so unlike mdast, code is not exempt by
  // node type. A `[S1]` written inside code is sample text, never a citation.
  if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) return;
  if (node.type === "comment" || node.type === "doctype") return;
  if (node.type === "text") visit(node, parent, index);
  if (Array.isArray(node.children)) {
    node.children.forEach((c: any, i: number) => walkTextNodes(c, visit, node, i));
  }
}
