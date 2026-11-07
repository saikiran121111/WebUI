/**
 * Task-scope parity harness (task-scope audit 2026-11-02, brief items #1/#3/#4/#5/#6).
 *
 * "The corpus is the contract": this vitest suite and the Rust `#[cfg(test)]`
 * tests in `rust-backend/crates/ruke-server/src/task_scope.rs` both replay
 * the SAME fixture file — `rust-backend/fixtures/task-scope/cases.json`.
 * Either side drifting without the other fails its suite. No brand lists, no
 * TLD guessing, no fabricated domains — the corpus pins exactly that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  deriveTaskScope,
  foldTaskScope,
  mergeTaskScope,
  resolveTarget,
  resolveTaskScope,
  isFollowUp,
  isEnforceableScope,
  routesToBrowserTurn,
  browserActivates,
  explicitBrowserRequest,
  scopeHosts,
  registrableHost,
  type SiteTarget,
  type TaskScope,
} from "../../lib/decision/task-scope";

// ── Corpus loader (shared with the Rust test suite) ────────────────────────

interface FixtureCase {
  name: string;
  prompt: string;
  intent: TaskScope["intent"];
  targets: SiteTarget[];
  excludedPhrases: string[];
  authorizedHosts: string[];
}
interface FixtureResolution {
  name: string;
  phrase: string;
  max: number;
  candidates: string[];
  expect: SiteTarget;
}
interface FixtureMerge {
  name: string;
  prev: TaskScope;
  prompt: string;
  expect: TaskScope;
}
interface Fixture {
  cases: FixtureCase[];
  resolutions: FixtureResolution[];
  merges: FixtureMerge[];
}

const CORPUS_PATH = new URL(
  "../../rust-backend/fixtures/task-scope/cases.json",
  import.meta.url,
);
const CORPUS = JSON.parse(
  readFileSync(fileURLToPath(CORPUS_PATH), "utf8"),
) as Fixture;

/** Exact-shape comparison (field-for-field; key order irrelevant to toEqual). */
const targetShape = (t: SiteTarget) => ({
  phrase: t.phrase,
  state: t.state,
  host: t.host,
  url: t.url,
  candidates: t.candidates,
  provenance: t.provenance,
});
const scopeShape = (s: TaskScope) => ({
  intent: s.intent,
  targets: s.targets.map(targetShape),
  excludedPhrases: s.excludedPhrases,
  authorizedHosts: s.authorizedHosts,
});

describe("task-scope corpus (parity with ruke-server task_scope.rs)", () => {
  it("corpus is present and substantial", () => {
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(30);
    expect(CORPUS.resolutions.length).toBeGreaterThanOrEqual(5);
    expect(CORPUS.merges.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of CORPUS.cases) {
    it(`derive: ${c.name}`, () => {
      const got = deriveTaskScope(c.prompt);
      expect(scopeShape(got)).toEqual({
        intent: c.intent,
        targets: c.targets.map(targetShape),
        excludedPhrases: c.excludedPhrases,
        authorizedHosts: c.authorizedHosts,
      });
    });
  }

  for (const r of CORPUS.resolutions) {
    it(`resolve: ${r.name}`, () => {
      const input: SiteTarget = {
        phrase: r.phrase,
        state: "unresolved",
        host: "",
        url: "",
        candidates: [],
        provenance: "none",
      };
      const got = resolveTarget(input, r.candidates, r.max, "resolved_search");
      expect(targetShape(got)).toEqual(targetShape(r.expect));
    });
  }

  for (const m of CORPUS.merges) {
    it(`merge: ${m.name}`, () => {
      expect(scopeShape(mergeTaskScope(m.prev, m.prompt))).toEqual(
        scopeShape(m.expect),
      );
    });
  }
});

// ── TS-side law tests (mirrored inline by the Rust #[cfg(test)] module) ────

describe("task-scope laws (TS side)", () => {
  it("registrableHost is PSL-aware (registrable domain, not suffix)", () => {
    expect(registrableHost("https://www.zepto.com/x")).toBe("zepto.com");
    expect(registrableHost("docs.example.dev")).toBe("example.dev");
    expect(registrableHost("foo.community")).toBe("foo.community");
    expect(registrableHost("blinkit.com")).toBe("blinkit.com");
    expect(registrableHost("")).toBeNull();
  });

  it("no sentence-initial word can become a site ('what.com' bug family)", () => {
    const s = deriveTaskScope(
      "What is the price of kingfisher beer 650ml on the official site?",
    );
    expect(s.targets).toHaveLength(0);
    expect(s.intent).not.toBe("operate");
    for (const t of s.targets) {
      expect(t.host).not.toBe("what.com");
      expect(t.phrase.toLowerCase()).not.toBe("what");
    }
  });

  it("bare operational targets are NEVER given a guessed domain", () => {
    const s = deriveTaskScope("Order milk on Zepto");
    expect(s.intent).toBe("operate");
    expect(s.targets[0].phrase).toBe("Zepto");
    expect(s.targets[0].host).toBe("");
    expect(s.targets[0].state).toBe("unresolved");
    expect(isEnforceableScope(s)).toBe(true);
    // resolution ONLY from real retrieval candidates, never fabricated
    const r = resolveTaskScope(s, ["https://zepto.com/brand/x"], {
      max: 8,
      provenance: "resolved_search",
    });
    expect(r.targets[0].host).toBe("zepto.com");
    expect(scopeHosts(r)).toEqual(["zepto.com"]);
  });

  it("resolveTarget returns the input untouched when no candidate matches", () => {
    const input: SiteTarget = {
      phrase: "milkman",
      state: "unresolved",
      host: "",
      url: "",
      candidates: [],
      provenance: "none",
    };
    const got = resolveTarget(input, ["dmart.com", "jio.com"], 8, "resolved_search");
    expect(got).toEqual(input);
  });

  it("follow-up inheritance needs a real previous scope", () => {
    expect(isFollowUp("now find the price")).toBe(true);
    const got = mergeTaskScope(null, "now find the price");
    expect(got.intent).toBe("none");
    expect(got.targets).toHaveLength(0);
  });

  it("fold carries scope across short follow-ups", () => {
    // ⇔ Rust fold_carries_scope_across_followups (brief #6).
    const s = foldTaskScope([
      "Order milk on Zepto",
      "what about the delivery fee",
    ]);
    expect(s.targets.length).toBeGreaterThan(0);
    expect(s.targets.some((t) => t.phrase.toLowerCase() === "zepto")).toBe(true);
  });

  it("fold: an unrelated fresh ask REPLACES the old scope", () => {
    // ⇔ Rust fold_unrelated_fresh_ask_replaces_scope — the merge replace
    // law holds through the fold; old constraints never leak forward.
    const s = foldTaskScope([
      "Order milk on Zepto",
      "compare amazon.com vs flipkart.com laptops",
    ]);
    expect(s.targets.every((t) => t.phrase.toLowerCase() !== "zepto")).toBe(true);
    expect(s.targets.length).toBeGreaterThan(0);
  });

  it("fold: empty/blank prompt lists yield the empty scope", () => {
    // ⇔ Rust fold_blank_and_empty_prompts_yield_empty_scope.
    const empty: TaskScope = { intent: "none", targets: [], excludedPhrases: [], authorizedHosts: [] };
    expect(foldTaskScope([])).toEqual(empty);
    expect(foldTaskScope(["", "   "])).toEqual(empty);
  });

  it("browser-turn routing matrix (⇔ rust browser_turn_routing_matrix)", () => {
    const scoped = (intent: TaskScope["intent"]): TaskScope => ({
      intent,
      targets: [
        {
          phrase: "x.com",
          state: "resolved",
          host: "x.com",
          url: "https://x.com",
          candidates: [],
          provenance: "explicit_domain",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    });
    expect(routesToBrowserTurn(scoped("operate"))).toBe(true);
    for (const intent of ["none", "research", "site_info", "compare_sites"] as const) {
      expect(routesToBrowserTurn(scoped(intent))).toBe(false);
    }
    expect(
      routesToBrowserTurn({ intent: "none", targets: [], excludedPhrases: [], authorizedHosts: [] }),
    ).toBe(false);
  });

  it("operate implies a target; verbs alone never activate the browser (⇔ rust browser_operate_implies_a_target)", () => {
    const s = deriveTaskScope("order milk on Zepto");
    expect(routesToBrowserTurn(s)).toBe(true);
    expect(s.targets.length).toBeGreaterThan(0);
    const n = deriveTaskScope("please do it now");
    expect(routesToBrowserTurn(n)).toBe(false);
    expect(n.targets).toHaveLength(0);
  });

  it("acceptance browser prompts route operate (⇔ rust acceptance_browser_prompts_route_operate)", () => {
    // The EXACT prompts from tests/browser-model-acceptance.spec.ts
    // (FIXTURE_BASE = http://127.0.0.1:3210). If any of these ever stops
    // deriving an Operate scope, the scope-driven routing law would drop
    // the journey out of the browser loop — this test fails first.
    const prompts = [
      'Use the browser tools. A browser tab is already open at http://127.0.0.1:3210/easy. On that SAME tab (do not open new tabs), click the link with CSS selector "#go-arrived", then read the page text and tell me the exact marker text shown in the "#arrived-marker" element.',
      'Use the browser tools on the already-open tab at http://127.0.0.1:3210/medium (do not open new tabs): type RUKE-MEDIUM-42X into the input with CSS selector "#note-input"; select the option value "business" in the select "#tier-select"; tick the checkbox "#subscribe-box"; check the radio button with CSS selector input[name="plan"][value="annual"]; then click the button "#submit-btn". Finally read the page and list the echoed lines you see.',
      'Use the browser tools. Step 1: open a NEW tab at http://127.0.0.1:3210/hard/popup. Step 2: on that page click the button with CSS selector "#open-popup" — it opens a popup, which appears as another browser tab. Step 3: list the browser tabs, find the child tab whose URL ends with "/hard/popup-child", and call the "tab_mark_deliverable" tool on that child tab so it is kept. Step 4: read the child page and tell me the marker text shown.',
    ];
    for (const p of prompts) {
      const s = deriveTaskScope(p);
      expect(s.targets.length, `acceptance prompt lost its site target: ${p.slice(0, 40)}`).toBeGreaterThan(0);
      expect(s.intent, `acceptance prompt not operational: ${p.slice(0, 40)}`).toBe("operate");
      expect(routesToBrowserTurn(s)).toBe(true);
    }
  });

  it("browser activation gate (⇔ rust browser_activates_gate)", () => {
    // User rescope (2026-11-07): an OPERATE fold alone NEVER activates the
    // interactive browser — the human armed it (panel open at send) or the
    // turn's own words name the harness browser.
    const op = deriveTaskScope("order milk on Zepto");
    expect(routesToBrowserTurn(op)).toBe(true);
    expect(
      browserActivates(op, "order milk on Zepto", false),
      "an instrument-free OPERATE sentence activated the engine",
    ).toBe(false);
    expect(
      browserActivates(
        deriveTaskScope("Find apartments to rent in Tallinn"),
        "Find apartments to rent in Tallinn",
        false,
      ),
      "the MHR-2 sentence activated the interactive browser",
    ).toBe(false);
    // Panel OPEN at send = the human's explicit "open browser" channel.
    expect(browserActivates(op, "order milk on Zepto", true)).toBe(true);
    // Or the words name the instrument (panel then auto-opens honestly).
    expect(browserActivates(op, "order milk on Zepto — use the browser tools", false)).toBe(true);
    expect(browserActivates(op, "order milk on Zepto, but don't use the browser", false)).toBe(false);
    // The scope half still gates: non-OPERATE never activates, even armed
    // AND naming the instrument. Sentence is the one the pre-existing
    // operate-implies-target pin already holds non-OPERATE in BOTH
    // languages; the job-hunt example was NOT usable here — "apply" ∈
    // OP_VERBS and it genuinely folds OPERATE, which the rescope law only
    // stops via the two activation halves.
    const rs = deriveTaskScope("please do it now");
    expect(routesToBrowserTurn(rs)).toBe(false);
    expect(
      browserActivates(rs, "please do it now — use the browser tools", true),
    ).toBe(false);
  });

  it("explicit browser-request words (⇔ rust explicit_browser_request_table)", () => {
    // The instrument words name the HARNESS capability — not a site-
    // vocabulary patch. Same table as the Rust test.
    for (const p of [
      "Use the browser tools. Open a NEW tab at http://127.0.0.1:3210/scope/quipqort",
      "open the browser and check my cart on example.com",
      "can you use a browser to verify the listing",
      "please use browsers to open example.com",
      "navigate with the browser to example.com",
      "launch that browser and sign in to example.com",
    ]) {
      expect(explicitBrowserRequest(p), `browser request missed: ${p}`).toBe(true);
    }
    for (const p of [
      "Find apartments to rent in Tallinn",
      "Buy me the cheapest 65 inch TV under 40000 rupees",
      "Find jobs in Hyderabad",
      "don't use the browser, just search the web",
      "no browser please, research this",
      "my browser crashed again",
      "what even is a headless browser",
      "close the browser tab later",
      "browser games are fun",
    ]) {
      expect(explicitBrowserRequest(p), `false browser request: ${p}`).toBe(false);
    }
  });

  it("scope hosts keep first-seen order and include authorized hosts", () => {
    const s = deriveTaskScope(
      "you can use paytm.com to pay on the blinkit order",
    );
    expect(s.intent).toBe("operate");
    const resolved = {
      ...s,
      targets: s.targets.map((t) =>
        t.phrase.toLowerCase() === "blinkit" ? { ...t, state: "resolved" as const, host: "blinkit.com" } : t,
      ),
    };
    expect(scopeHosts(resolved)).toEqual(["blinkit.com", "paytm.com"]);
  });
});
