/**
 * AUDIT 2026-11-04 (universal research-depth brief) — topical repetition is
 * NOT answer coverage: literal entity hits must not fake completeness, every
 * recovery state must be actionable (gapQuery dispatchable), sufficiency must
 * track the REQUESTED answer units (named identifiers), and the final evidence
 * block must preserve a relevant named row near the end of a long atomic
 * table instead of a blind 4000-char prefix.
 */
import { it, expect } from "vitest";
import { evaluateCoverage } from "@/lib/web-search/query-planner";
import { derivePlannerLaw, evaluateSufficiency } from "@/lib/web-search/planner-law";
import { evidenceBlock } from "@/lib/web-search/pipeline";

const prompt = "Which foundation models does ArborWorks support?";
const overview =
  "ArborWorks foundation models support overview. The platform provides model orchestration. The actual supported identifiers are on a linked catalog page. ";
const decision: any = {
  search_required: true,
  reason: "official factual lookup",
  depth: "deep",
  freshness: "any",
  queries: [{ query: "ArborWorks supported foundation models", intent: "docs" }],
};
const passage = (sourceId: string, domain: string, text: string): any => ({
  sourceId,
  domain,
  url: "https://" + domain + "/overview",
  title: "Overview",
  passageText: text,
  bm25Score: 1,
});

it("control: literal entity coverage is complete for a page with an explicit named answer", () => {
  const r = evaluateCoverage(prompt, [
    "ArborWorks foundation models support: Boreal-X17 and Cedar-Y23.",
    "The complete supported foundation models list for ArborWorks is Boreal-X17 and Cedar-Y23.",
  ]);
  expect(r.coverage).toBe(1);
  expect(r.needsGapSearch).toBe(false);
});

it("does not mistake two topical overviews for coverage of the requested model identifiers", () => {
  const r = evaluateCoverage(prompt, [overview, overview]);
  console.log("TOPICAL_OVERVIEW", JSON.stringify(r));
  expect(r.needsGapSearch, "topic mentions alone do not answer which named models are supported").toBe(true);
});

it("makes a sparse-evidence recovery actionable when every query token already matched", () => {
  const r = evaluateCoverage(prompt, [overview]);
  expect(r.needsGapSearch).toBe(true);
  expect(r.gapQuery, "the caller requires both needsGapSearch and gapQuery to dispatch recovery").not.toBeNull();
});

it("does not declare key claims supported merely because three sources repeat the question vocabulary", () => {
  const ps = ["official.example.com", "specialist.example.org", "press.example.net"].map((d, i) =>
    passage("S" + (i + 1), d, overview.repeat(4)),
  );
  const packets = ps.map((p) => ({ ...p, extraction: "direct", classification: "SUCCESS_DIRECT", passages: [p] }));
  const cov = evaluateCoverage(prompt, ps.map((p) => p.passageText));
  const result = evaluateSufficiency(packets, ps, cov, decision, derivePlannerLaw(prompt, decision));
  console.log("UNSUPPORTED_NAMES_SUFFICIENCY", JSON.stringify(result));
  expect(result.keyClaimsSupported).toBe(false);
});

it("preserves a relevant named row near the end of an atomic table when assembling the final evidence", () => {
  const table =
    "| Supported foundation model | Availability |\\n| --- | --- |\\n".replaceAll("\\n", "\n") +
    Array.from({ length: 110 }, (_, i) => "| Catalog entry " + i + " | Not relevant to this question |").join("\n") +
    "\n| Boreal-X17 | Supported and specifically requested |";
  const p = passage("S1", "official.example.com", table);
  const result = evidenceBlock({
    topPassages: [p],
    packets: [{ ...p, passages: [p] }],
    searchGate: { decision },
  } as any);
  expect(table.length).toBeGreaterThan(4000);
  expect(result).toContain("Boreal-X17");
});
