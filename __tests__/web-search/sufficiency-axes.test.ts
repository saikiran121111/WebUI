/**
 * §5d (2026-11-13 brief) — sufficiency ANATOMY:
 *   "Separate lexical coverage, claim support, list completeness, and
 *   overall sufficiency. Unknown support must remain explicit."
 *
 * Before this law everything collapsed into
 *   keyClaimsSupported = (lexicalScore >= 0.6 && !needsGapSearch)
 * — entity vocabulary STOOD IN for claim support, there was no list
 * completeness axis at all, and "no signal either way" was silently
 * flattened into the same boolean false as "known unsupported".
 *
 * The axes now report separately and EVERY gate keeps its old behavior —
 * positive controls pin the unchanged dispatch law (needsGapSearch /
 * gapQuery / keyClaimsSupported / stopEarly composition). Fictional
 * entities only (Kestrel-Oda, Marlin-9, Tideway-7, PollFlow, Helios
 * Merchant Hub, Meridian Ledger, Caldera Trench, Varela Island); test
 * strings stay out of production.
 */
import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "../../lib/web-search/query-planner";
import { derivePlannerLaw, evaluateSufficiency } from "../../lib/web-search/planner-law";
import type { EvidencePacket, EvidencePassage, SearchDecision } from "../../lib/web-search/types";

const dec = (
  depth: SearchDecision["depth"],
  freshness: SearchDecision["freshness"],
): SearchDecision => ({
  search_required: true,
  reason: "",
  freshness,
  depth,
  queries: [],
});
const pk = (sourceId: string, domain: string): EvidencePacket => ({
  sourceId,
  url: `https://${domain}/x`,
  title: "T",
  domain,
  extraction: "direct",
  passages: [],
  classification: "SUCCESS_OK",
});
const ep = (sourceId: string, domain: string, text: string): EvidencePassage => ({
  sourceId,
  url: `https://${domain}/x`,
  title: "T",
  domain,
  passageText: text,
  bm25Score: 0,
});

// Long-form ask on purpose: every thin-fixture case then has SIX+
// guaranteed entity misses (payment/gateway/integration/options/helios/
// merchant/hub absent from the off-topic passages), so the
// coverage<0.6 divergence pins hold under ANY entity-extraction width.
const ASK = "Which payment gateway integration options does Kestrel-Oda support for Helios Merchant Hub?";

/** REAL evaluateCoverage feeding REAL evaluateSufficiency — the axes are
 *  pinned end-to-end through the law layer, not through hand-made fakes. */
const sufficiencyOf = (prompt: string, passageTexts: string[]) => {
  const coverage = evaluateCoverage(prompt, passageTexts);
  const dd = dec("deep", "any");
  const packets = passageTexts.map((_, i) => pk(`S${i + 1}`, `src${i + 1}.example.net`));
  const passages = passageTexts.map((t, i) => ep(`S${i + 1}`, `src${i + 1}.example.net`, t));
  const report = evaluateSufficiency(
    packets,
    passages,
    coverage,
    dd,
    derivePlannerLaw(prompt, dd),
  );
  return { coverage, report };
};

describe("claim support is its own axis, not the lexical score", () => {
  it("divergence: the SUPPORT law holds while the lexical gate fails (one boolean used to erase both)", () => {
    const { coverage, report } = sufficiencyOf(ASK, [
      "Kestrel-Oda supports Marlin-9 and Tideway-7 for merchant settlement.",
      "Settlement notes and clearing schedules for regional offices.",
    ]);
    expect(coverage.enumerativeAsk).toBe(true);
    expect(coverage.answerSupport).toBe("supported"); // answer-support law found it
    expect(report.claimSupport).toBe("supported");
    // The separation proof: the lexical coverage axis FAILS here — the old
    // conflated boolean would have reported "claims not supported",
    // fabricating a support problem that does not exist.
    expect(coverage.coverage).toBeLessThan(0.6);
    expect(report.keyClaimsSupported).toBe(false); // the lexical gate is preserved…
    expect(report.listCompleteness).toBe("addressed"); // …while the true axes say otherwise
  });

  it("question-vocabulary echo is lexical coverage, NOT claim support (audited failure, novel entities)", () => {
    const { coverage, report } = sufficiencyOf(ASK, [
      "Kestrel-Oda payment gateways support overview. Payment gateway support portal with gateway docs and support tiers.",
      "Kestrel-Oda payment gateways support hub. Gateway support coverage explained for payment integration teams.",
    ]);
    expect(coverage.enumerativeAsk).toBe(true);
    // Lexically the passages cover the query words completely-ish — but the
    // passages never ASSERT an answer, so the support axis says so:
    expect(coverage.answerSupport).toBe("unsupported");
    expect(report.claimSupport).toBe("unsupported");
    expect(report.listCompleteness).toBe("not_addressed");
    expect(report.keyClaimsSupported).toBe(false); // gate behavior unchanged
    expect(coverage.needsGapSearch, "dispatch law preserved: recovery still fires").toBe(true);
    expect(coverage.gapQuery).not.toBeNull();
  });

  it("unaddressable evidence yields EXPLICIT unknown — never silently 'unsupported'", () => {
    const { coverage, report } = sufficiencyOf(ASK, [
      "Meridian Ledger processes invoices quarterly across twelve regional clearing houses, refreshed annually with audit notes.",
      "Meridian Ledger reconciles bank statements nightly and archives settlement receipts for seven years.",
    ]);
    expect(coverage.coverage).toBe(0); // the evidence is about something else entirely
    expect(coverage.answerSupport).toBe("unknown");
    expect(report.claimSupport).toBe("unknown"); // explicit unknown, NOT "unsupported"
    expect(report.listCompleteness).toBe("unknown");
    expect(coverage.needsGapSearch, "dispatch law preserved: recovery still fires").toBe(true);
  });

  it("control: one hedged example never closes the list axis either (support law unchanged)", () => {
    const { coverage, report } = sufficiencyOf(ASK, [
      "For example, Marlin-9 is a supported payment gateway on Kestrel-Oda.",
      "Kestrel-Oda payment gateway support overview with integration options notes for Helios Merchant Hub partners.",
    ]);
    expect(coverage.enumerativeAsk).toBe(true);
    expect(coverage.answerSupport).toBe("unsupported"); // HEDGE law unchanged
    expect(report.listCompleteness).toBe("not_addressed"); // the list axis AGREES with support
  });
});

describe("list completeness and the overall verdict", () => {
  it("control: a genuinely supported enumerative ask passes on every axis together", () => {
    const { coverage, report } = sufficiencyOf(ASK, [
      "Which payment gateway integration options does Kestrel-Oda support for Helios Merchant Hub? The support matrix maps each option regionally: Marlin-9, Tideway-7 and PollFlow.",
      "Kestrel-Oda payment gateway integration support documentation and notes for Helios Merchant Hub partners.",
    ]);
    expect(coverage.enumerativeAsk).toBe(true);
    expect(coverage.answerSupport).toBe("supported");
    expect(coverage.coverage).toBeGreaterThanOrEqual(0.6);
    expect(report.claimSupport).toBe("supported");
    expect(report.listCompleteness).toBe("addressed");
    expect(report.keyClaimsSupported).toBe(true); // gates untouched — positive control
    expect(report.stopEarly, "full-agreement run still stops early").toBe(true);
  });

  it("non-enumerative ask: the lexical gate may pass while claim support stays UNKNOWN (gate != assertion)", () => {
    const FACT = "How deep is the Caldera Trench off Varela Island?";
    const { coverage, report } = sufficiencyOf(FACT, [
      "The Caldera Trench lies roughly eleven hundred meters below the sea floor near Varela Island.",
      "Survey vessels measured how deep the water column reaches above the trench floor off the island.",
    ]);
    expect(coverage.enumerativeAsk).toBe(false);
    // The deterministic law can only CERTIFY support (a signal found); a
    // non-enumerative miss proves nothing, so the axis stays unknown —
    // it is never promoted to "supported" and never flattened to a claim.
    expect(coverage.answerSupport).toBe("unknown");
    expect(report.claimSupport).toBe("unknown");
    expect(report.listCompleteness).toBe("not_enumerative");
    expect(report.keyClaimsSupported).toBe(true); // gate behavior preserved
  });

  it("control: the no-entity sparse path keeps its dispatch law and reports unknown support", () => {
    const r = evaluateCoverage("", ["just one retrieved passage here"]);
    expect(r.enumerativeAsk).toBe(false);
    expect(r.needsGapSearch, "actionability law preserved: sparse still dispatches").toBe(true);
    expect(r.gapQuery).not.toBeNull();
    expect(r.answerSupport).toBe("unknown");
  });
});
