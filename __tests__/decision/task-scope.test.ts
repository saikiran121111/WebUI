/**
 * Task-scope parity harness (task-scope audit 2026-11-02, brief items #1/#3/#4/#5/#6).
 *
 * "The corpus is the contract": this vitest suite and the Rust `#[cfg(test)]`
 * tests in `rust-backend/crates/ruke-websearch/src/task_scope.rs` both replay
 * the SAME fixture file — `rust-backend/fixtures/task-scope/cases.json`.
 * Either side drifting without the other fails its suite. No brand lists, no
 * TLD guessing, no fabricated domains — the corpus pins exactly that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  deriveTaskScope,
  mergeTaskScope,
  resolveTarget,
  resolveTaskScope,
  isFollowUp,
  isEnforceableScope,
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

describe("task-scope corpus (parity with ruke-websearch task_scope.rs)", () => {
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
