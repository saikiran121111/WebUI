/**
 * APPROVED PART-10 PARITY DEVIATION — UNIVERSAL deterministic search
 * pre-gate + runtime date-aware freshness awareness.
 * Mirrors the Rust unit tests that lived in ruke-websearch/src/search_gate.rs
 * (crate removed 2026-11-03; these pins are now the sole owner)
 * (bypass_freshness_forces_search / bypass_local_task_forces_no_search /
 *  bypass_local_task_escapes_on_external_intent /
 *  ambiguous_prompts_reach_the_model_gate / gate_messages_carry_the_current_date /
 *  universal_pre_gate_never_calls_the_llm) — identical prompt matrices,
 *  identical expected labels, reasons and query-shape guarantees.
 *
 * Layers, NO attachment required (that is the universal part) — the
 * 2026-11-04 ordering law: E1 explicit local-only scope → pure clock ask
 * (brief §5) → E2 self-contained skip arms (each escapes on
 * GUARD_EXTERNAL_RE) → only THEN the force-YES evidence layers (URL →
 * web-intent FRAME → freshness FRAME → image intent). A deterministic
 * verdict needs an EVIDENCE NEED expressed as a frame — never bare
 * tokens, proper nouns, or brand tables. Every undecided turn falls
 * through to the model gate, whose NO is first-class (the deleted
 * search-by-default override used to re-veto confident model NOs on
 * capitalized words). Trivial small talk ("what are you doing today")
 * is normalized BEFORE any model call (brief §1 screenshot repro), and
 * queries follow the §4 law: Unicode-preserving, subject-anchored,
 * never stopword-only/subjectless.
 * All deterministic verdicts are proven LLM-free by construction: they
 * come from deterministicHardBypass — the same Stage-0 front door
 * runSearchGate consults BEFORE trivial/mainModelGate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMainGateMessagesForTest,
  deterministicHardBypass,
  runSearchGate,
} from "@/lib/web-search/search-gate";
import type { SearchGateContext } from "@/lib/web-search/types";

const ctx = (userPrompt: string): SearchGateContext => ({ userPrompt });

describe("universal freshness force-SEARCH (approved Part-10 deviation)", () => {
  it("staleness-shaped prompts search deterministically, never reach a model veto", () => {
    for (const prompt of [
      "Who is the CEO of Acme Corp?",
      "How much does the RTX 5090 cost?",
      "Is React 18 still maintained?",
      "What's the weather tonight?",
      "Update me on the most recent funding round.",
      "Is this package up to date?",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("freshness");
      expect(r!.decision.search_required, prompt).toBe(true);
      expect(r!.decision.reason).toBe("deterministic_url_or_intent");
      // Force-YES flows into the shared keyword planner — queries exist.
      expect(r!.decision.queries.length, prompt).toBeGreaterThan(0);
    }
    // Freshness outranks the skip layers even in a task-shaped prompt
    // ("write a script" would otherwise code-gen-skip).
    const r = deterministicHardBypass(ctx("Write a script that reports the most recent release."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("freshness");
    expect(r!.decision.search_required).toBe(true);
  });
});

describe("universal local-task force-SKIP (approved Part-10 deviation)", () => {
  it("self-contained tasks skip deterministically with zero queries", () => {
    for (const prompt of [
      "Write Python code for binary search.",
      "Explain this supplied stack trace.",
      "Summarize this supplied text.",
      "Read this attachment and reply YES.",
      "Translate this paragraph.",
      "What is 15 * 17?",
      "Solve 25 * 47",
      "Create a regex for this pattern.",
      "Fix this code.",
      "Review this uploaded source file.",
      "Refactor this function.",
      "Do not search the web; answer from the pasted code only.",
      "What's wrong with this regex?",
      "Find the bug in this attached log.",
      // §11.2 follow-up: the "…, nothing else." meta-instruction
      // fingerprint (closed-form local answer), flag-free by design —
      // the residual re-test guards it (see the escape suite below).
      "Listen to the attached audio and reply YES. Nothing else.",
      "Repeat after me: hello world. Nothing else.",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("local_task");
      expect(r!.decision.search_required, prompt).toBe(false);
      expect(r!.decision.reason).toBe("deterministic_self_contained");
      expect(r!.decision.queries, prompt).toEqual([]);
    }
  });

  it("the escape hatch: a surviving live-web frame turns the turn into force-YES", () => {
    // The E2 arms escape on GUARD_EXTERNAL_RE — and the surviving web
    // frame then force-YESes deterministically (brief §3: supplied-
    // material turns that ask for external evidence are never suppressed;
    // with an explicit frame they don't even need the model).
    for (const prompt of [
      "Translate this paragraph; check the web for slang usage.",
      "Summarize this text and browse online sources.",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("web_intent");
      expect(r!.decision.search_required, prompt).toBe(true);
    }
    // Layer E1 (explicit local-only intent) deliberately has NO naive
    // frame escape — the phrase list itself contains "web"/"browse", so a
    // guard on the full prompt would self-cancel the user's instruction;
    // only the residual re-test re-arms the gate (see the media suite's
    // E1 guard law).
    const r = deterministicHardBypass(ctx("Don't browse; only from the attached document."));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("local_task");
    expect(r!.decision.search_required).toBe(false);
  });
});

describe("pure clock questions answer from the clock, never the web (brief §5)", () => {
  it("direct date/time/day asks force NO with the clock reason and zero queries", () => {
    for (const prompt of [
      "What is today's date?",
      "What day is it today?",
      "What time is it?",
      "What's the current time?",
    ]) {
      const r = deterministicHardBypass(ctx(prompt));
      expect(r, prompt).not.toBeNull();
      expect(r!.hit.matched, prompt).toBe("clock_question");
      expect(r!.decision.search_required, prompt).toBe(false);
      expect(r!.decision.reason, prompt).toBe("deterministic_clock_question");
      expect(r!.decision.queries, prompt).toEqual([]);
    }
  });

  it("a date-shaped question about an EXTERNAL fact is not a clock ask", () => {
    const r = deterministicHardBypass(ctx("What's the date of the latest release?"));
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("freshness");
    expect(r!.decision.search_required).toBe(true);
  });
});

describe("§4 query law: subject-preserving, Unicode-preserving", () => {
  it("a subjectless follow-up borrows the subject from recent USER context", () => {
    const r = deterministicHardBypass({
      userPrompt: "What is its price now?",
      history: [
        { role: "user", content: "Tell me about the Acme Q900 headphones" },
        { role: "assistant", content: "The Acme Q900 ships with ANC and a 40 h battery." },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.hit.matched).toBe("freshness");
    // The OLD builder emitted the subjectless "price now"; the fix must
    // carry the entity forward instead.
    expect(r!.decision.queries[0]!.query).toBe("acme q900 headphones price");
    // The anchor is role-filtered: assistant prose NEVER rides the query.
    expect(r!.decision.queries[0]!.query).not.toContain("anc");
    expect(r!.decision.queries[0]!.query).not.toContain("battery");
    // Price-now is a continuously-changing fact tier (live_required).
    expect(r!.decision.freshness).toBe("realtime");
  });

  it("non-Latin subjects survive the query builder intact", () => {
    // The old builder stripped everything outside [a-z0-9] — CJK/Devanagari
    // subjects were erased and "price"/stopwords rode to the providers.
    const r = deterministicHardBypass(ctx("東京で牛乳 price today"));
    expect(r).not.toBeNull();
    expect(r!.decision.queries[0]!.query).toBe("東京で牛乳 price");
  });
});

describe("the gray middle still belongs to the model gate", () => {
  it("ambiguous prompts abstain from every deterministic layer", () => {
    for (const prompt of [
      "Tell me about Rust async performance.",
      "Is PostgreSQL better than MongoDB for this architecture?",
      "Why does this GPU sometimes disappear?",
      "Explain recursion.",
      "What are some good books about systems thinking?",
    ]) {
      expect(deterministicHardBypass(ctx(prompt)), prompt).toBeNull();
    }
  });
});

describe("gate messages carry the runtime date (never hardcoded)", () => {
  it("an injected date makes the gate prompt date-dynamic", () => {
    const m = buildMainGateMessagesForTest({
      ...ctx("is python 2 still supported?"),
      currentDate: "2030-06-15",
    })[0];
    expect(m.content.startsWith("Current date: 2030-06-15 (year 2030).")).toBe(true);
    expect(m.content).toContain("parametric knowledge may be STALE");
  });

  it("unset date falls back to the REAL clock, never a frozen constant", () => {
    // Shape-only assertion so the suite never couples to the wall clock.
    const m = buildMainGateMessagesForTest(ctx("hello"))[0];
    expect(m.content).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \(year \d{4}\)\./);
    expect(m.content).not.toContain("2030-06-15");
  });
});

describe("the universal pre-gate never calls the LLM", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("force-YES and force-SKIP both short-circuit before any model touch", async () => {
    // WEB_SEARCH_LLM_ENDPOINT points at an UNROUTABLE port: any model
    // touch would fall back to rulesBasedPlan (source=rules,
    // search_required=true, gateMs>0). source=deterministic + gateMs 0
    // proves ZERO gate-model calls in BOTH universal directions.
    vi.stubEnv("WEB_SEARCH_LLM_ENDPOINT", "http://127.0.0.1:9/chat/completions");
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");

    const yes = await runSearchGate(ctx("Who is the CEO of Acme Corp?"));
    expect(yes.source).toBe("deterministic");
    expect(yes.decision.search_required).toBe(true);
    expect(yes.decision.queries.length).toBeGreaterThan(0);
    expect(yes.gateMs).toBe(0);

    const no = await runSearchGate(ctx("Write Python code for binary search."));
    expect(no.source).toBe("deterministic");
    expect(no.decision.search_required).toBe(false);
    expect(no.decision.queries).toEqual([]);
    expect(no.gateMs).toBe(0);

    // Brief §1 screenshot repro: "what are you doing today" once cost a
    // full gate-model round AND fired a freshness-week search with query
    // "are doing today". It now short-circuits before any model touch:
    // the temporal-suffix normalization ("… today" stripped) hits the
    // trivial set, and the distinct noSearchPlan reason (vs the rules
    // fallback's "rule-based plan…" reason) structurally proves the
    // unroutable endpoint was never attempted — zero LLM calls.
    const smallTalk = await runSearchGate(ctx("what are you doing today"));
    expect(smallTalk.decision.search_required).toBe(false);
    expect(smallTalk.decision.queries).toEqual([]);
    expect(smallTalk.gateMs).toBe(0);
    expect(smallTalk.decision.reason).toBe("trivial prompt — no web content needed");
  });
});
