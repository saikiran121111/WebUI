/**
 * Citation-pill tests — the reason the evidence loop's verdicts were invisible
 * in every browser run up to 2026-10-21.
 *
 * Two independent bugs lived in one file:
 *   1. the plugin emitted hast `element` nodes into an MDAST tree (remark), and
 *      react-markdown's mdast→hast converter discards unknown node types;
 *   2. the plugin was a bare `(tree) => {}` transformer pushed straight into
 *      the plugin list, but unified invokes plugins as ATTACHERS — the tree
 *      parameter arrives `undefined` and the plugin silently does nothing.
 * The symptom was `citation pills=0` on answers that plainly contained `[S4]`,
 * while the ledger and the `link-status` chips were correct.
 *
 * These run over a synthetic hast tree: no DOM, no react-markdown, no network.
 */
import { describe, it, expect } from "vitest";
import {
  citationMarkers,
  linkKey,
  rehypeCitations,
  type CitationMap,
} from "../components/render/citations";
import type { ClaimStatus } from "../src/lib/web-verify/types";

const MAP: CitationMap = {
  S2: {
    sourceId: "S2",
    url: "https://www.amazon.in/dp/B0D9R47712",
    title: "Honor 200 5G (Coral Pink, 8GB RAM, 128GB Storage)",
    domain: "amazon.in",
  },
};
const STATUS: Record<string, ClaimStatus> = { S2: "verified" };

const text = (value: string) => ({ type: "text", value });
const el = (tagName: string, ...children: any[]) => ({
  type: "element",
  tagName,
  properties: {},
  children,
});
const root = (...children: any[]) => ({ type: "root", children });

/** Exactly how react-markdown runs it: attacher first, transformer second. */
function render(...children: any[]) {
  const tree = root(...children);
  rehypeCitations(MAP, STATUS)()(tree);
  return tree;
}

describe("rehypeCitations", () => {
  it("is an attacher that returns a transformer (bug 2)", () => {
    const attacher = rehypeCitations(MAP, STATUS);
    expect(typeof attacher).toBe("function");
    const transformer = attacher();
    expect(typeof transformer).toBe("function");

    // The regression itself: an attacher takes no tree at all (the type system
    // refuses `attacher(tree)`), so a plugin written as a bare `(tree) => {}`
    // received `tree === undefined` at runtime and quietly changed nothing.
    expect(attacher.length).toBe(0);
    const untouched = root(el("p", text("₹18,992 [S2]")));
    attacher();
    expect(JSON.stringify(untouched)).toContain("[S2]");

    const done = root(el("p", text("₹18,992 [S2]")));
    transformer(done as any);
    expect(JSON.stringify(done)).not.toContain("[S2]");
  });

  it("turns a mapped marker into a plain citation element (no verdict badge since 2026-10-22)", () => {
    const tree = render(el("p", text("Price ₹18,992 [S2] matched.")));
    const kids = (tree.children[0] as any).children;
    expect(kids.map((k: any) => k.type)).toEqual(["text", "element", "text"]);
    expect(kids[0].value).toBe("Price ₹18,992 ");
    expect(kids[2].value).toBe(" matched.");
    const pill = kids[1];
    expect(pill.tagName).toBe("citation");
    expect(pill.properties["data-source"]).toBe("S2");
    expect(pill.properties["data-url"]).toBe("https://www.amazon.in/dp/B0D9R47712");
    expect(pill.properties["data-title"]).toContain("Honor 200 5G");
    // The per-source verdict that used to ride in data-status is gone with
    // the web-verify ledger — pills are citations, not claims.
    expect(pill.properties["data-status"]).toBeUndefined();
    expect(pill.children).toEqual([{ type: "text", value: "S2" }]);
  });

  it("splits several markers in one text run", () => {
    const tree = render(el("p", text("[S2] shows ₹18,992 [S2] twice.")));
    const kinds = (tree.children[0] as any).children.map((k: any) =>
      k.type === "element" ? k.tagName : "text",
    );
    expect(kinds).toEqual(["citation", "text", "citation", "text"]);
  });

  it("keeps an invented marker as plain text — never a pill", () => {
    const tree = render(el("p", text("see [S9] and [S2]")));
    const kids = (tree.children[0] as any).children;
    expect(kids[0]).toEqual({ type: "text", value: "see " });
    expect(kids[1]).toEqual({ type: "text", value: "[S9]" });
    expect(kids[2]).toEqual({ type: "text", value: " and " });
    expect(kids[3].tagName).toBe("citation");
  });

  it("never rewrites a marker inside code (bug: hast code is an element)", () => {
    const tree = render(
      el("p", el("code", text("cite with [S2] in the template"))),
      el("pre", el("code", text("₹18,992 [S2]"))),
    );
    expect(JSON.stringify(tree)).toContain("[S2]");
    expect(JSON.stringify(tree)).not.toContain("citation");
  });

  it("does nothing when there is no map (legacy messages)", () => {
    const tree = root(el("p", text("₹18,992 [S2]")));
    rehypeCitations({}, STATUS)()(tree);
    expect((tree.children[0] as any).children.length).toBe(1);
  });

  it("finds nested text inside lists and emphasis", () => {
    const tree = render(
      el("ul", el("li", el("strong", text("Out of stock [S2]")))),
    );
    expect(JSON.stringify(tree)).toContain('"tagName":"citation"');
  });
});

describe("citation helpers", () => {
  it("pre-scans raw content for the markers actually present", () => {
    expect([...citationMarkers("₹18,992 [S2], see [S7]")].sort()).toEqual(["S2", "S7"]);
    expect(citationMarkers("no markers here").size).toBe(0);
  });

  it("normalises a URL the same way the server-side audit does", () => {
    expect(linkKey("https://www.Amazon.in/dp/B0D9R47712/")).toBe(
      linkKey("http://amazon.in/dp/B0D9R47712"),
    );
  });
});
