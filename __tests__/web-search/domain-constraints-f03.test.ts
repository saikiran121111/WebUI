/**
 * F03 domain-constraint semantics (2026-11-16 brief). Independent suite: it
 * never edits the existing planner-law goldens, it pins the CONSTRAINT MODEL
 * the brief demands (target / polarity / scope / exclusivity / evidence span /
 * instruction authority) and the multilingual vocabulary probes.
 *
 * Phase A = public law surface (derivePlannerLaw). Phase B (added after the
 * mechanism lands) = the typed constraint records themselves.
 */
import { describe, expect, it } from "vitest";
import { derivePlannerLaw } from "../../lib/web-search/planner-law";
import {
  deriveDomainConstraints,
  resolveDomainPolicy,
} from "../../lib/web-search/domain-constraints";
import type { SearchDecision } from "../../lib/web-search/types";

const dec = (): SearchDecision => ({
  search_required: true,
  reason: "",
  freshness: "none",
  depth: "standard",
  queries: [],
});
const law = (prompt: string) => derivePlannerLaw(prompt, dec());

describe("F03 contrast scope: a cue stops at a contrastive boundary", () => {
  it("do_not_then_only_blocks_the_first_allows_the_second", () => {
    const l = law("Do not use alpha.com, but only use beta.com");
    expect(l.blockedDomains).toEqual(["alpha.com"]);
    expect(l.allowedDomains).toEqual(["beta.com"]);
  });

  it("however_separates_an_exclusion_from_a_later_preference", () => {
    const l = law("Exclude gamma.com; however, only use delta.com for charts");
    expect(l.blockedDomains).toEqual(["gamma.com"]);
    expect(l.allowedDomains).toEqual(["delta.com"]);
  });
});

describe("F03 preference is ranking, exclusivity is a separate axis", () => {
  it("trust_plus_consult_never_arms_a_wall", () => {
    const l = law("Trust alpha.com, but also consult beta.com");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
    expect(l.preferredDomains).toEqual(["alpha.com", "beta.com"]);
  });

  it("an_explicit_exclusivity_marker_arms_the_wall_for_a_prefer_cue", () => {
    const l = law("Consult alpha.com only");
    expect(l.allowedDomains).toEqual(["alpha.com"]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("preference_never_blocks_the_compared_target", () => {
    const l = law("I trust alpha.com more than beta.com, use either");
    expect(l.blockedDomains).toEqual([]);
  });
});

describe("F03 quotation role: target vs instruction", () => {
  it("quoted_site_operator_being_explained_creates_no_policy", () => {
    const l = law('In the query "site:alpha.com" the prefix limits hits to one site');
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
    expect(l.preferredDomains).toEqual([]);
  });

  it("quoted_host_that_is_the_operand_of_a_cue_is_a_target", () => {
    const l = law('Only use "alpha.com" and nothing else');
    expect(l.allowedDomains).toEqual(["alpha.com"]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("single_quoted_host_operand_still_binds", () => {
    const l = law("Only use 'alpha.com' for the changelog");
    expect(l.allowedDomains).toEqual(["alpha.com"]);
  });
});

describe("F03 negation composition and exclusion cues", () => {
  it("negated_block_cue_cancels_instead_of_blocking", () => {
    const l = law("Do not exclude alpha.com from the comparison");
    expect(l.blockedDomains).toEqual([]);
    expect(l.allowedDomains).toEqual([]);
  });

  it("exclusion_cue_excludes_its_target", () => {
    const l = law("Search everything except alpha.com");
    expect(l.blockedDomains).toEqual(["alpha.com"]);
    expect(l.allowedDomains).toEqual([]);
  });

  it("other_than_is_an_exclusion_cue", () => {
    const l = law("Any source other than alpha.com is out of date");
    expect(l.blockedDomains).toEqual(["alpha.com"]);
  });

  it("correction_retracts_an_earlier_exclusion", () => {
    const l = law("Do not use alpha.com. Actually use alpha.com for the price table.");
    expect(l.blockedDomains).toEqual([]);
  });
});

describe("F03 positive controls (existing law must survive)", () => {
  it("semicolon_clause_boundaries", () => {
    const l = law("Do not use alpha.com; use beta.com.");
    expect(l.blockedDomains).toEqual(["alpha.com"]);
    expect(l.allowedDomains).toEqual([]);
  });
  it("allow_then_never_per_token", () => {
    const l = law("Only use alpha.com, never beta.com.");
    expect(l.allowedDomains).toEqual(["alpha.com"]);
    expect(l.blockedDomains).toEqual(["beta.com"]);
  });
  it("quoted_speech_is_not_policy", () => {
    const l = law('My old boss always said "never use reddit.com" - that mindset aged badly.');
    expect(l.blockedDomains).toEqual([]);
    expect(l.allowedDomains).toEqual([]);
  });
  it("code_never_becomes_policy", () => {
    const l = law("the snippet `skip medium.com` compiles and the fence below runs:\n```\ndon't use twitter.com\n```\nlooks fine");
    expect(l.blockedDomains).toEqual([]);
    expect(l.allowedDomains).toEqual([]);
  });
  it("cueless_mention_creates_no_policy", () => {
    const l = law("what do people on reddit.com say about this?");
    expect(l.blockedDomains).toEqual([]);
    expect(l.allowedDomains).toEqual([]);
  });
  it("explicit_site_operator_is_user_scoping", () => {
    const l = law("site:react.dev examples please");
    expect(l.allowedDomains).toEqual(["react.dev"]);
    expect(l.blockedDomains).toEqual([]);
  });
  it("never_trust_composes_to_a_block", () => {
    const l = law("Never trust quora.com for medical advice.");
    expect(l.blockedDomains).toEqual(["quora.com"]);
    expect(l.allowedDomains).toEqual([]);
  });
});

describe("F03 multilingual cue vocabulary (script-aware boundaries)", () => {
  const cases: Array<[string, string, "allow" | "block"]> = [
    ["es_only", "Solo usa alpha.com para esto", "allow"],
    ["es_except", "Busca en todas partes excepto alpha.com", "block"],
    ["de_only", "Nur alpha.com verwenden", "allow"],
    ["de_except", "Alle Quellen außer alpha.com", "block"],
    ["fr_only", "Utilise uniquement alpha.com", "allow"],
    ["fr_except", "Cherche partout sauf alpha.com", "block"],
    ["hi_only", "केवल alpha.com", "allow"],
    ["hi_except", "alpha.com के सिवाय", "block"],
    ["ja_only", "alpha.com のみ", "allow"],
    ["ja_except", "alpha.com 以外", "block"],
    ["zh_only", "只使用 alpha.com", "allow"],
    ["zh_except", "除了 alpha.com 都能搜", "block"],
    ["ar_only", "فقط alpha.com", "allow"],
    ["ar_except", "ما عدا alpha.com", "block"],
    ["te_only", "కేవలం మాత్రమే alpha.com", "allow"],
    ["te_except", "alpha.com మినహాయించి", "block"],
    ["vi_only", "Chỉ dùng alpha.com", "allow"],
    ["vi_except", "tìm mọi trang trừ alpha.com", "block"],
  ];
  for (const [name, prompt, want] of cases) {
    it(name, () => {
      const l = law(prompt);
      if (want === "allow") {
        expect(l.allowedDomains).toEqual(["alpha.com"]);
        expect(l.blockedDomains).toEqual([]);
      } else {
        expect(l.blockedDomains).toEqual(["alpha.com"]);
        expect(l.allowedDomains).toEqual([]);
      }
    });
  }
});

/* -- Phase B: the typed constraint RECORDS themselves ----------------------
 * The policy lists above are what the planner consumes; the brief also demands
 * that the constraint layer itself carry target / polarity / scope /
 * exclusivity / evidence span / authority, so those are pinned directly. */
describe("F03 typed constraint records", () => {
  const prompt = "Do not use alpha.com, but only use beta.com";

  it("each_constraint_is_a_typed_record_with_evidence_span", () => {
    const cs = deriveDomainConstraints(prompt);
    expect(cs).toHaveLength(2);

    const [alpha, beta] = cs;
    expect(alpha.target).toBe("alpha.com");
    expect(alpha.polarity).toBe("block");
    expect(alpha.cueClass).toBe("negator");
    expect(alpha.cue).toBe("Do not");
    expect(alpha.authority).toBe("user");
    expect(alpha.exclusivity).toBe(false);
    expect(alpha.clauseIndex).toBe(0);
    expect(alpha.scopeStart).toBe(0);

    expect(beta.target).toBe("beta.com");
    expect(beta.polarity).toBe("allow");
    expect(beta.cueClass).toBe("exclusive");
    expect(beta.cue).toBe("only");
    expect(beta.exclusivity).toBe(true);
    // The contrast word ENDED the negator scope: beta is governed by a scope
    // starting after alpha, so "but only" never drapes onto alpha and the
    // negator never drapes onto beta.
    expect(beta.scopeStart).toBeGreaterThan(alpha.targetStart);
    expect(beta.scopeStart).toBeLessThanOrEqual(beta.cueStart);
    expect(beta.cueStart).toBeLessThan(beta.targetStart);

    for (const c of cs) {
      expect(prompt.slice(c.targetStart, c.targetEnd)).toBe(c.evidence);
      expect(prompt.slice(c.cueStart, c.cueEnd)).toBe(c.cue);
    }
    expect(cs.map((c) => c.evidence)).toEqual(["alpha.com", "beta.com"]);
  });

  it("a_quoted_operand_keeps_its_own_authority", () => {
    const p = "Only use \u0022alpha.com\u0022 and nothing else";
    const cs = deriveDomainConstraints(p);
    expect(cs).toHaveLength(1);
    expect(cs[0].authority).toBe("quoted-operand");
    expect(cs[0].polarity).toBe("allow");
    expect(cs[0].exclusivity).toBe(true);
    // The operand span keeps the quotes: the QUOTED TOKEN is the target.
    expect(p.slice(cs[0].targetStart, cs[0].targetEnd)).toBe("\u0022alpha.com\u0022");
  });

  it("an_explained_site_operator_produces_no_record_at_all", () => {
    const p = "In the query \u0022site:alpha.com\u0022 the prefix limits hits to one site";
    expect(deriveDomainConstraints(p)).toEqual([]);
  });

  it("a_typed_site_operator_is_its_own_authority", () => {
    const cs = deriveDomainConstraints("site:react.dev examples please");
    expect(cs).toHaveLength(1);
    expect(cs[0].authority).toBe("site-operator");
    expect(cs[0].polarity).toBe("allow");
    expect(cs[0].exclusivity).toBe(true);
    expect(cs[0].cueClass).toBeNull();
  });

  it("a_postposed_cue_is_marked_and_stays_postposed", () => {
    const p = "alpha.com \u0915\u0947 \u0938\u093f\u0935\u093e\u092f"; // hi: ke sirvaay
    const cs = deriveDomainConstraints(p);
    expect(cs).toHaveLength(1);
    expect(cs[0].postposed).toBe(true);
    expect(cs[0].cueClass).toBe("exclusion");
    expect(cs[0].polarity).toBe("block");
    expect(cs[0].cueStart).toBeGreaterThan(cs[0].targetEnd);
    expect(p.slice(cs[0].cueStart, cs[0].cueEnd)).toBe(cs[0].cue);
  });

  it("a_double_negation_withdraws_instead_of_inventing_a_block", () => {
    const cs = deriveDomainConstraints("Do not exclude alpha.com from the comparison");
    expect(cs).toHaveLength(1);
    expect(cs[0].polarity).toBe("cancel");
    const policy = resolveDomainPolicy(cs);
    expect(policy.blocked).toEqual([]);
    expect(policy.allowed).toEqual([]);
    expect(policy.withdrawn).toEqual(["alpha.com"]);
  });

  it("a_later_correction_clause_retracts_the_earlier_policy", () => {
    const p = "Do not use alpha.com. Actually use alpha.com for the price table.";
    const cs = deriveDomainConstraints(p);
    expect(cs).toHaveLength(2);
    expect(cs[0].polarity).toBe("block");
    expect(cs[0].clauseIndex).toBe(0);
    expect(cs[1].polarity).toBe("cancel");
    expect(cs[1].cueClass).toBe("correction");
    expect(cs[1].corrected).toBe(true);
    expect(cs[1].clauseIndex).toBeGreaterThan(cs[0].clauseIndex);
    const policy = resolveDomainPolicy(cs);
    expect(policy.blocked).toEqual([]);
    expect(policy.withdrawn).toEqual(["alpha.com"]);
  });

  it("preference_promotes_to_a_wall_only_with_an_exclusivity_marker", () => {
    const promoted = deriveDomainConstraints("Consult alpha.com only");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].cueClass).toBe("prefer");
    expect(promoted[0].polarity).toBe("allow");
    expect(promoted[0].exclusivity).toBe(true);

    const ranking = deriveDomainConstraints("Trust alpha.com, but also consult beta.com");
    expect(ranking.every((c) => c.polarity === "prefer")).toBe(true);
    expect(ranking.every((c) => c.exclusivity === false)).toBe(true);
    const policy = resolveDomainPolicy(ranking);
    expect(policy.allowed).toEqual([]);
    expect(policy.preferred).toEqual(["alpha.com", "beta.com"]);
  });
});