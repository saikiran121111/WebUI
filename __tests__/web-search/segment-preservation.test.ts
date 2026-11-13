/**
 * §5c (2026-11-13 brief) — evidence-passage PRESERVATION law (TS-only;
 * the Rust twin filter_passage_segments died with the 2026-11-03 rollback,
 * its vectors stay pinned in retrieval-quality.test.ts):
 *
 *   "Long paragraphs lacking keywords are deleted irreversibly. This is
 *   destructive because important facts may use synonyms or explanations
 *   with no direct query-term overlap. Preserve source text and
 *   addressable passages, then apply bounded ranking or context windows."
 *
 * The §11.12 fetch-side filter keeps its flood-control behavior (the
 * working view still drops zero-coverage long prose — that law was a
 * deliberate anti-noise fix and the brief asks for non-destructiveness,
 * not for removing the filter). What must change: the drop can no longer
 * DESTROY the bytes. When filtering mutates a passage, the complete
 * pre-filter text is preserved on `originalPassageText` (addressable via
 * the passage's own url + offsets), so bounded ranking/context choices
 * downstream stay reversible and honest about what they inspected.
 *
 * Novel fixture entities; positive controls pin the surviving §11.12
 * behavior (counterexample to over-correcting into "never filter").
 */
import { describe, it, expect } from "vitest";

import {
  filterPassageSegments,
  applySegmentFilter,
} from "../../lib/web-search/segment-filter";
import type { EvidencePacket } from "../../lib/web-search/types";

const QUERY = "kubernetes ingress timeout";

// heading + covered prose + one long zero-overlap paragraph (synonyms
// only — no query term appears in it) + a table (always kept).
const PAGE = [
  "## Deployment notes",
  "The kubernetes ingress timeout defaults vary by controller version.",
  "Grafana dashboards, alert routing policies, on-call rotations, and postmortem templates are owned by the reliability guild; documentation lives under the handbook tree and is refreshed every quarter with training exercises and vendor escalations.",
  "| region | p99 |",
  "| --- | --- |",
  "| eu-west | 210ms |",
].join("\n\n");

const packetWith = (text: string): EvidencePacket => ({
  sourceId: "S7",
  url: "https://runbook.example.net/deploy",
  title: "Deployment notes",
  domain: "example.net",
  extraction: "direct",
  passages: [
    {
      sourceId: "S7",
      url: "https://runbook.example.net/deploy",
      title: "Deployment notes",
      domain: "example.net",
      passageText: text,
      bm25Score: 0,
    },
  ],
});

describe("the §11.12 filter still filters (positive control)", () => {
  it("long zero-coverage prose is dropped from the working view", () => {
    const out = filterPassageSegments(PAGE, QUERY);
    expect(out).not.toBe(PAGE); // a drop happened
    expect(out).toContain("kubernetes ingress timeout");
    expect(PAGE).toContain("on-call rotations"); // sanity: the paragraph exists in the INPUT
    expect(out).not.toContain("reliability guild"); // dropped from the filtered view
    expect(out).not.toContain("on-call rotations");
  });

  it("inert paths return the original bytes untouched", () => {
    expect(filterPassageSegments(PAGE, "")).toBe(PAGE); // no query terms
    const twoBlocks = "## H\nOnly one covered kubernetes timeout sentence.";
    expect(filterPassageSegments(twoBlocks, QUERY)).toBe(twoBlocks); // ≤2 blocks
  });
});

describe("filtering is never irreversible destruction", () => {
  it("a mutated passage keeps its complete pre-filter text on originalPassageText", () => {
    const p = packetWith(PAGE);
    applySegmentFilter([p], QUERY);
    const passage = p.passages[0];
    expect(passage.passageText).not.toContain("reliability guild");
    expect(passage.originalPassageText).toBe(PAGE); // the WHOLE pre-filter passage
    expect(passage.originalPassageText).toContain("reliability guild");
  });

  it("idempotence: a second filter pass never overwrites the true original", () => {
    const p = packetWith(PAGE);
    applySegmentFilter([p], QUERY);
    applySegmentFilter([p], QUERY); // gap hop re-runs the filter
    expect(p.passages[0].originalPassageText).toBe(PAGE);
  });

  it("unmutated passages carry NO copy (no-change law: original bytes verbatim)", () => {
    const p = packetWith("Only one kubernetes timeout sentence here.");
    applySegmentFilter([p], QUERY);
    expect(p.passages[0].passageText).toBe("Only one kubernetes timeout sentence here.");
    expect(p.passages[0].originalPassageText).toBeUndefined(); // no copy when nothing changed
  });
});
