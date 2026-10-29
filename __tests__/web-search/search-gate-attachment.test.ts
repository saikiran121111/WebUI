/**
 * APPROVED PART-10 PARITY DEVIATION — attachment-aware search gate.
 * Mirrors the Rust unit tests in ruke-websearch/src/search_gate.rs
 * (bypass_attachment_evidence_forces_no_search /
 *  bypass_attachment_escape_hatch_never_suppresses).
 *
 * The rule lives INSIDE deterministicHardBypass — the same Stage-0
 * front door runSearchGate consults BEFORE trivial/mainModelGate — so a
 * non-null verdict here structurally proves ZERO gate-LLM calls, zero
 * planner work, and zero engine traffic for the suppressed prompts.
 */
import { describe, expect, it } from "vitest";
import { deterministicHardBypass } from "@/lib/web-search/search-gate";
import type { SearchGateContext } from "@/lib/web-search/types";

const att = (userPrompt: string): SearchGateContext => ({ userPrompt, hasAttachmentEvidence: true });
const ctx = (userPrompt: string): SearchGateContext => ({ userPrompt });

describe("attachment-aware search gate (approved Part-10 deviation)", () => {
  it("local attachment tasks force NO search, zero queries (meta-instruction guard)", () => {
    for (const prompt of [
      "Read the attached file and reply YES if you can read it.",
      "Summarize this PDF.",
      "What does this file say about quarterly revenue?",
      "Find the bug in this attached source file.",
      "Explain this screenshot.",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched).toBe("attachment_evidence");
      expect(r!.decision.search_required).toBe(false);
      expect(r!.decision.reason).toBe("deterministic_attachment_local");
      expect(r!.hit.detected).toEqual([]);
      // A search query must never represent an operational instruction —
      // the suppressed path builds no queries at all.
      expect(r!.decision.queries, prompt).toEqual([]);
    }
    // Part-10 UNIVERSAL pre-gate: the same words WITHOUT an attachment are
    // now a deterministic self-contained skip (layer E2) — the rule is no
    // longer attachment-only, so it is NOT inert here. Mirrors the Rust
    // bypass_attachment_evidence_forces_no_search inert-guard update.
    const inert = deterministicHardBypass({ userPrompt: "Summarize this PDF." });
    expect(inert).not.toBeNull();
    expect(inert!.hit.matched).toBe("local_task");
    expect(inert!.decision.reason).toBe("deterministic_self_contained");
    const off = deterministicHardBypass({
      userPrompt: "Summarize this PDF.",
      hasAttachmentEvidence: false,
    });
    expect(off).not.toBeNull();
    expect(off!.hit.matched).toBe("local_task");
  });

  it("explicit web/current/external intent is never suppressed", () => {
    // The URL detector outranks the rule.
    const url = deterministicHardBypass(att("Compare this file with https://example.com"));
    expect(url).not.toBeNull();
    expect(url!.hit.matched).toBe("url");
    expect(url!.decision.search_required).toBe(true);

    // Narrow live-intent words force-YES AHEAD of the attachment rule.
    // ("still current" moved to the freshness group below — same
    // force-YES verdict, different matched label: the universal freshness
    // layer fires ahead of WEB_INTENT_RE, "freshness never loses".)
    for (const prompt of [
      "Compare this PDF with the latest regulations.",
      "Search the web and fact-check this document.",
      "Read this document and find the latest information about the company.",
      "Compare this resume against current job listings.",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }

    // High-confidence freshness wording ("still accurate/true/current") is
    // force-YESed by the universal freshness layer AHEAD of the attachment
    // escape — a staleness question about a document must search
    // deterministically; the model can veto it neither way.
    for (const prompt of [
      "Is this information still current?",
      "Check whether the claims in this PDF are still accurate online.",
      "Is the information in this document still true?",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("freshness");
      expect(r!.decision.search_required, prompt).toBe(true);
    }

    // Remaining hybrid phrasing falls through to the NORMAL gate — never
    // suppressed; the model planner still owns those turns.
    for (const prompt of [
      "Browse the web and verify this attached document.",
      "Find recent sources supporting this file.",
      "Look online for news about the uploaded article.",
    ]) {
      expect(deterministicHardBypass(att(prompt)), prompt).toBeNull();
    }

    // Boundary law: "research" must NOT count through "search".
    const r = deterministicHardBypass(att("Research this file and rewrite it professionally."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("attachment_evidence");
    expect(r!.decision.search_required).toBe(false);
  });
});

describe("media self-references never masquerade as web intent (§11.2 follow-up)", () => {
  it("attached-audio/video meta-instructions are deterministic NOs, flag-free or not", () => {
    // (a) The exact user-reported audio meta-prompt. Even with NO flag
    // the "…, nothing else." fingerprint force-SKIPs it — a meta-
    // instruction can never reach the model gate or an engine query.
    const heard =
      "Listen to the attached audio and reply with exactly YES followed by the codeword that is spoken, or NO if you cannot hear it. Nothing else.";
    for (const c of [ctx(heard), att(heard)]) {
      const r = deterministicHardBypass(c);
      expect(r, c.userPrompt).not.toBeNull();
      expect(r!.decision.search_required, c.userPrompt).toBe(false);
      expect(r!.decision.queries, c.userPrompt).toEqual([]);
    }
    expect(deterministicHardBypass(ctx(heard))!.hit.matched).toBe("local_task");

    // (b) Burned-text video: the narrow `video` token no longer
    //     force-YESes through a self-reference. Flag ⇒ attachment
    //     force-NO; no flag ⇒ read-the-(attached-)video supplied arm.
    const burned = "Read the text burned into the attached video. Reply with exactly what you see.";
    const withFlag = deterministicHardBypass(att(burned));
    expect(withFlag).not.toBeNull();
    expect(withFlag!.hit.matched).toBe("attachment_evidence");
    expect(withFlag!.decision.search_required).toBe(false);
    const noFlag = deterministicHardBypass(ctx(burned));
    expect(noFlag).not.toBeNull();
    expect(noFlag!.hit.matched).toBe("local_task");
  });

  it("genuine external media intent survives every strip", () => {
    // Un-anchored media nouns (no flag ⇒ pronoun anaphora NOT stripped).
    for (const prompt of [
      "watch this video on youtube",
      "search for a video about the keynote",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }
    // Flag on: the self-ref is stripped but watch/latest/search-the-web
    // are not — hybrid attachment+web turns keep BOTH evidence sources.
    for (const prompt of [
      "Watch the attached video and search the web for the latest news about the actor.",
      "Compare this audio recording with the latest field recordings.",
      "What's the latest video from NVIDIA?",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }
  });

  it("the E1 guard law: live intent surviving OUTSIDE the phrase still searches", () => {
    const r = deterministicHardBypass(ctx("Watch the launch event tomorrow, nothing else."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("web_intent");
    expect(r!.decision.search_required).toBe(true);
  });
});
