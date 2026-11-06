import { test, expect, type Page } from "@playwright/test";

/**
 * AUDIT FINDING 5 (2026-11-06) — HTTP-level routing proof.
 *
 * The unit layer (__tests__/decision/anatomy-intent.test.ts, 15 tests) pins the
 * matcher; the golden fixtures pin Rust parity. What was still unproven is the
 * route a browser actually hits: POST /api/decision (proxied to ruke-server when
 * the Rust backend is live, so this exercises whichever engine is in charge) and
 * the x-decision-mode header the chat route commits BEFORE the model's first
 * byte. Both layers here are deterministic — the routing decision is made
 * in-process/in-engine, never by the big model — so the only model cost in this
 * file is the aborted chat turn below, and the outcome is reproducible.
 *
 * The bug: anatomy was the only intent naming a SUBJECT rather than a
 * DELIVERABLE, so a turn that merely named the vocabulary as its topic got the
 * anatomy renderer plus its core-skill block ("What is the anatomy of the
 * knee?", "What is an isometric exercise?").
 */

interface DecisionEnvelopeLike {
  active_mode?: string;
  skill_to_load?: string | null;
  decided_by?: string;
}

async function postDecision(page: Page, message: string): Promise<DecisionEnvelopeLike> {
  return page.evaluate(async (text) => {
    const res = await fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error("/api/decision responded " + res.status);
    return (await res.json()) as DecisionEnvelopeLike;
  }, message);
}

/**
 * Real production chat turn: read the x-decision-mode header the route commits
 * at EARLY-OPEN, then abort. The route wires the same signal into the upstream
 * generation and the research gate, so the model never gets past a fraction of a
 * second — this proves the CHAT path's routing, not just the inspection route.
 */
async function chatTurnMode(page: Page, message: string): Promise<string | null> {
  return page.evaluate(async (text) => {
    const ctrl = new AbortController();
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      signal: ctrl.signal,
    });
    const mode = res.headers.get("x-decision-mode");
    ctrl.abort(); // zombie-turn protection kills upstream generation + the gate
    if (!res.ok) throw new Error("/api/chat responded " + res.status);
    return mode;
  }, message);
}

test("finding 5: /api/decision stops routing topic mentions to the anatomy renderer", async ({ page }) => {
  await page.goto("/");

  // The two prompts from the audit brief, verbatim.
  // Every vector here is one the unit layer already pins, so this is the same
  // corpus proven one level up (and the golden fixtures bind it to Rust).
  const NEGATIVES: [string, string][] = [
    ["What is the anatomy of the knee?", "standard_chat"],
    ["What is an isometric exercise?", "standard_chat"],
    ["tell me about the anatomy of the knee", "standard_chat"],
    ["isometric exercises for beginners", "standard_chat"],
    ["what does anatomy mean?", "standard_chat"],
    ["I have an anatomy exam tomorrow, any tips?", "standard_chat"],
  ];
  for (const [prompt, expected] of NEGATIVES) {
    const env = await postDecision(page, prompt);
    expect(env.active_mode, prompt).toBe(expected);
    expect(env.skill_to_load ?? null, prompt + " (no core-skill injection)").toBe(null);
  }

  // Deliverable asks still get the renderer: the repair must not have hollowed
  // out the intent it was tightening.
  const POSITIVES: [string, string][] = [
    ["anatomy of a jet turbine", "anatomy"],
    ["exploded diagram in html", "anatomy"],
    ["cutaway of the marine engine", "anatomy"],
    ["isometric illustration of the server rack", "anatomy"],
    ["make me a spreadsheet of the results", "excel"],
    ["print this pdf", "pdf"],
    ["chart of this building's architecture", "chart"],
  ];
  for (const [prompt, expected] of POSITIVES) {
    const env = await postDecision(page, prompt);
    expect(env.active_mode, prompt).toBe(expected);
  }
});

test("finding 5: a real chat turn carries the corrected mode in x-decision-mode", async ({ page }) => {
  await page.goto("/");
  for (const prompt of ["What is the anatomy of the knee?", "What is an isometric exercise?"]) {
    const mode = await chatTurnMode(page, prompt);
    expect(mode, prompt).not.toBeNull();
    expect(mode, prompt).not.toBe("anatomy");
    expect(mode, prompt).toBe("standard_chat");
  }
  // The deliverable half of the same real path.
  expect(await chatTurnMode(page, "anatomy of a jet turbine")).toBe("anatomy");
});
