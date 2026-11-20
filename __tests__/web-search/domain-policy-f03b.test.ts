/**
 * F03b (2026-11-16 generalization brief, domain probes 6-8). FROZEN answer key:
 * written BEFORE the implementation increment, deliberately a SEPARATE file so
 * the existing domain-constraints-f03.test.ts corpus stays untouched.
 *
 *   6. "Only use orbit.example, not beacon.example."
 *        -> orbit is the ALLOWED set (wall), beacon is the EXCLUSION.
 *   7. "Do not restrict yourself to orbit.example."
 *        -> NO domain policy at all (the negation targets the restriction, not
 *           the site). The affirmative control arms the wall.
 *   8. "I previously said only orbit.example; now use any source."
 *        -> the earlier allow-wall is SUPERSEDED (nothing allowed, nothing
 *           blocked, target recorded as withdrawn).
 *
 * Every case is a MECHANISM probe (elliptical negator, discontinuous exclusive
 * frame, explicit supersession of an exclusion), never a phrase exception: the
 * same law must hold under entity substitution, paraphrase and role reversal.
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

/* -- probe 6: exclusion after a restriction (elliptical "not") ------------- */

describe("F03b probe 6: a restriction and an exclusion apply to their own targets", () => {
  it("elliptical_not_excludes_the_second_target_while_the_wall_holds", () => {
    const l = law("Only use orbit.example, not beacon.example.");
    expect(l.allowedDomains).toEqual(["orbit.example"]);
    expect(l.blockedDomains).toEqual(["beacon.example"]);
  });

  it("substituted_entities_and_an_added_verb_read_identically", () => {
    const l = law("Consult solely nova.example, never lumen.example.");
    expect(l.allowedDomains).toEqual(["nova.example"]);
    expect(l.blockedDomains).toEqual(["lumen.example"]);
  });

  it("an_elliptical_exclusion_survives_a_clause_reorder", () => {
    const l = law("Stick to vale.example, not dune.example.");
    expect(l.allowedDomains).toEqual(["vale.example"]);
    expect(l.blockedDomains).toEqual(["dune.example"]);
  });

  it("bare_not_about_a_non_domain_fact_creates_no_policy", () => {
    // "not" here is a copula, not an elliptical exclusion cue.
    const l = law("That claim is not nova.example's fault.");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("the_exclusion_is_typed_as_a_block_and_the_wall_as_exclusive_allow", () => {
    const cs = deriveDomainConstraints("Only use orbit.example, not beacon.example.");
    expect(cs).toHaveLength(2);
    const [orbit, beacon] = cs;
    expect(orbit.polarity).toBe("allow");
    expect(orbit.exclusivity).toBe(true);
    expect(beacon.polarity).toBe("block");
    expect(beacon.exclusivity).toBe(false);
    const policy = resolveDomainPolicy(cs);
    expect(policy.allowed).toEqual(["orbit.example"]);
    expect(policy.blocked).toEqual(["beacon.example"]);
  });
});

/* -- probe 7: negated restriction creates NO domain policy ----------------- */

describe("F03b probe 7: a negated restriction infers no domain policy", () => {
  it("do_not_restrict_yourself_to_arms_nothing", () => {
    const l = law("Do not restrict yourself to orbit.example.");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
    expect(l.preferredDomains).toEqual([]);
  });

  it("the_same_frame_under_a_substituted_verb_and_host_arms_nothing", () => {
    const l = law("Please do not limit the search to nova.example");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("role_reversal_the_affirmative_frame_arms_the_wall", () => {
    const l = law("Restrict yourself to orbit.example.");
    expect(l.allowedDomains).toEqual(["orbit.example"]);
    expect(l.blockedDomains).toEqual([]);
    const cs = deriveDomainConstraints("Restrict yourself to orbit.example.");
    expect(cs).toHaveLength(1);
    expect(cs[0].cueClass).toBe("exclusive");
    expect(cs[0].polarity).toBe("allow");
    expect(cs[0].exclusivity).toBe(true);
  });

  it("the_negated_frame_withdraws_instead_of_inventing_a_block", () => {
    const cs = deriveDomainConstraints("Do not restrict yourself to orbit.example.");
    expect(cs).toHaveLength(1);
    expect(cs[0].cueClass).toBe("exclusive");
    expect(cs[0].polarity).toBe("cancel");
    const policy = resolveDomainPolicy(cs);
    expect(policy.allowed).toEqual([]);
    expect(policy.blocked).toEqual([]);
    expect(policy.withdrawn).toEqual(["orbit.example"]);
  });

  it("an_unnegated_limit_frame_still_arms_only_that_host", () => {
    const l = law("Limit the search to nova.example.");
    expect(l.allowedDomains).toEqual(["nova.example"]);
    expect(l.blockedDomains).toEqual([]);
  });
});

/* -- probe 8: a current instruction supersedes an obsolete restriction ----- */

describe("F03b probe 8: the current instruction supersedes an obsolete restriction", () => {
  it("previously_only_x_now_any_source_withdraws_the_wall", () => {
    const l = law("I previously said only orbit.example; now use any source.");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("the_withdrawal_is_recorded_not_silently_dropped", () => {
    const cs = deriveDomainConstraints(
      "I previously said only orbit.example; now use any source.",
    );
    const policy = resolveDomainPolicy(cs);
    expect(policy.withdrawn).toEqual(["orbit.example"]);
    expect(policy.allowed).toEqual([]);
  });

  it("a_paraphrased_supersession_withdraws_just_as_cleanly", () => {
    const l = law("Earlier I said stick to vale.example, but now all sites are fine.");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
  });

  it("a_broadening_without_any_supersession_marker_keeps_the_wall", () => {
    // No supersession wording => no inferred retraction (never broaden silently).
    const l = law("Only use orbit.example, any source is unreliable there.");
    expect(l.allowedDomains).toEqual(["orbit.example"]);
  });

  it("supersession_of_a_restriction_never_invents_an_exclusion", () => {
    const l = law("I earlier said only nova.example; now use any source at all.");
    expect(l.allowedDomains).toEqual([]);
    expect(l.blockedDomains).toEqual([]);
  });
});
