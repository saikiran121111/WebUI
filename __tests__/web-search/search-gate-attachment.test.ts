/**
 * Attachment-aware search gate — REVISED 2026-11-04 (brief §3). The old
 * attachment force-NO layer (and its EXPLICIT_WEB_INTENT_RE escape hatch)
 * is GONE: a boolean flag is not evidence SUFFICIENCY. Local-evidence
 * turns skip only because the UNIVERSAL self-contained arms recognize
 * them ("Summarize this PDF." is a supplied-content transform flag-free);
 * turns that need EXTERNAL evidence (citations, open positions, studies,
 * independent verification) are never suppressed by the flag — they
 * either force-YES through the shared web/freshness frames or fall
 * through to the model gate, which is told the local-evidence situation
 * (attNote in buildMainGateMessages). The flag itself only neutralizes
 * attachment self-references in the web-intent PROBE (media anaphora).
 *
 * The rule lives INSIDE deterministicHardBypass — the same Stage-0
 * front door runSearchGate consults BEFORE trivial/mainModelGate — so a
 * non-null verdict here structurally proves ZERO gate-LLM calls, zero
 * planner work, and zero engine traffic for the decided prompts.
 */
import { describe, expect, it } from "vitest";
import { deterministicHardBypass } from "@/lib/web-search/search-gate";
import type { SearchGateContext } from "@/lib/web-search/types";

const att = (userPrompt: string): SearchGateContext => ({ userPrompt, hasAttachmentEvidence: true });
const ctx = (userPrompt: string): SearchGateContext => ({ userPrompt });

describe("attachment-aware search gate (approved Part-10 deviation)", () => {
  it("supplied-material transforms skip as self-contained, flag or not", () => {
    for (const prompt of [
      "Read the attached file and reply YES if you can read it.",
      "Summarize this PDF.",
      "Find the bug in this attached source file.",
      "Explain this screenshot.",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      // There is no attachment-specific verdict: these skip through the
      // UNIVERSAL supplied-transform arm (brief §3 — identical verdict
      // with or without the flag; the flag changes nothing here).
      expect(r!.hit.matched, prompt).toBe("local_task");
      expect(r!.decision.search_required, prompt).toBe(false);
      expect(r!.decision.reason, prompt).toBe("deterministic_self_contained");
      expect(r!.hit.detected).toEqual([]);
      // A search query must never represent an operational instruction —
      // the suppressed path builds no queries at all.
      expect(r!.decision.queries, prompt).toEqual([]);
    }
    // Flag-free identity: byte-identical verdicts prove the flag itself
    // never forces a NO (the honest anti-inert-guard — attachment turns
    // are recognized by their shape, not by a boolean).
    const off = deterministicHardBypass({
      userPrompt: "Summarize this PDF.",
      hasAttachmentEvidence: false,
    });
    expect(off).not.toBeNull();
    expect(off!.hit.matched).toBe("local_task");
    expect(off!.decision.reason).toBe("deterministic_self_contained");
  });

  it("explicit web/current/external intent is never suppressed", () => {
    // The URL detector outranks the rule.
    const url = deterministicHardBypass(att("Compare this file with https://example.com"));
    expect(url).not.toBeNull();
    expect(url!.hit.matched).toBe("url");
    expect(url!.decision.search_required).toBe(true);

    // An explicit live-web FRAME force-YESes even on a supplied-material
    // turn — the flag never suppresses it (brief §3; the shared frames,
    // not an attachment escape hatch, carry these).
    const web = deterministicHardBypass(att("Search the web and fact-check this document."));
    expect(web).not.toBeNull();
    expect(web!.hit.matched).toBe("web_intent");
    expect(web!.decision.search_required).toBe(true);

    // "job listings" is a universal freshness FRAME (open-positions tier),
    // never a domain table: a resume-vs-listings comparison searches.
    const jobs = deterministicHardBypass(att("Compare this resume against current job listings."));
    expect(jobs).not.toBeNull();
    expect(jobs!.hit.matched).toBe("freshness");
    expect(jobs!.decision.search_required).toBe(true);

    // High-confidence freshness wording ("still accurate/true/current") is
    // force-YESed by the universal freshness layer — a staleness question
    // about a document must search deterministically; the model can veto
    // it neither way.
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

    // Hybrid attachment+web phrasing force-YES through the shared frames
    // (STRENGTHENED 2026-11-04: these used to fall through). The probe
    // neutralizes the attachment self-reference but the frame itself
    // survives the strip, so these turns need no model at all.
    for (const prompt of [
      "Browse the web and verify this attached document.",
      "Find recent sources supporting this file.",
      "Look online for news about the uploaded article.",
    ]) {
      const r = deterministicHardBypass(att(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }

    // The flag forces NOTHING in either direction: wording that is
    // neither an arm nor a frame falls through to the model gate, which
    // IS told about the attachment evidence (attNote). Boundary law
    // holds — "research" does not count through "search" (neither
    // suppressed nor forced, decided honestly by the model):
    //  · "say" is no supplied-transform verb,
    //  · "latest regulations"/"latest information" are no frames
    //    ("information" is deliberately not a research noun).
    for (const prompt of [
      "What does this file say about quarterly revenue?",
      "Compare this PDF with the latest regulations.",
      "Read this document and find the latest information about the company.",
      "Research this file and rewrite it professionally.",
    ]) {
      expect(deterministicHardBypass(att(prompt)), prompt).toBeNull();
    }
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
    //     force-YESes through a self-reference — and the flag changes
    //     NOTHING: both shapes skip through the same supplied read arm
    //     (the GUARD escape stays quiet because no external frame
    //     survives outside the supplied-material phrase).
    const burned = "Read the text burned into the attached video. Reply with exactly what you see.";
    const withFlag = deterministicHardBypass(att(burned));
    expect(withFlag).not.toBeNull();
    expect(withFlag!.hit.matched).toBe("local_task");
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
    // Flag on: the self-ref strip can NEVER erase a genuine web frame —
    // explicit live-web wording keeps BOTH evidence sources.
    const hybrid = deterministicHardBypass(
      att("Watch the attached video and search the web for the latest news about the actor."),
    );
    expect(hybrid).not.toBeNull();
    expect(hybrid!.hit.matched).toBe("web_intent");
    expect(hybrid!.decision.search_required).toBe(true);
    // …while a BARE "latest" next to a media noun is not a frame: these
    // fall through to the model gate. (The deleted attachment escape
    // hatch used to force-YES them; the honest owner is now the model —
    // a token like "latest" must never decide retrieval on its own, and
    // the flag suppresses nothing either.)
    for (const prompt of [
      "Compare this audio recording with the latest field recordings.",
      "What's the latest video from NVIDIA?",
    ]) {
      expect(deterministicHardBypass(att(prompt)), prompt).toBeNull();
    }
  });

  it("the E1 guard law: live intent surviving OUTSIDE the phrase still searches", () => {
    const r = deterministicHardBypass(ctx("Watch the launch event tomorrow, nothing else."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("web_intent");
    expect(r!.decision.search_required).toBe(true);
  });
});
