import { test, expect, type Page } from "@playwright/test";

/**
 * ANATOMY RETIREMENT (2026-11-07) — HTTP-level routing proof.
 *
 * What this file proves at the HTTP level: the retired anatomy vocabulary
 * never routes to a renderer anymore, and the remaining deliverable modes
 * still do. The unit layer (lib/decision/client.ts + the Rust engine tests)
 * pins the same corpus one level down, and the golden fixtures bind it to
 * Rust parity. The routes here are what a browser actually hits: POST
 * /api/decision (proxied to ruke-server when the Rust backend is live, so
 * this exercises whichever engine is in charge) and the x-decision-mode
 * header the chat route commits BEFORE the model's first byte. Routing is
 * decided in-process/in-engine, never by the big model — the only model cost
 * in this file is the aborted chat turn below, and the outcome is
 * reproducible.
 *
 * History: audit finding 5 (2026-11-06) first narrowed anatomy — it was the
 * only intent naming a SUBJECT rather than a DELIVERABLE, so topic mentions
 * ("What is the anatomy of the knee?") got the renderer plus its core-skill
 * block. The mode was then removed entirely on 2026-11-07 (user directive —
 * it grew out of the retired architecture-design feature), so EVERY former
 * anatomy vector now falls to standard_chat or to the deliverable word the
 * turn carries ("exploded diagram in html" -> html_render).
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

test("anatomy retirement: /api/decision routes no anatomy vocabulary to a renderer", async ({ page }) => {
  await page.goto("/");

  // The former frame-guard corpus (kept verbatim from the audit brief) PLUS
  // the old deliverable-style asks: post-retirement ALL of them fall to
  // standard_chat with no core-skill injection. Every vector here is one the
  // unit layer already pins (and the golden fixtures bind it to Rust).
  const NEGATIVES: [string, string][] = [
    ["What is the anatomy of the knee?", "standard_chat"],
    ["What is an isometric exercise?", "standard_chat"],
    ["tell me about the anatomy of the knee", "standard_chat"],
    ["isometric exercises for beginners", "standard_chat"],
    ["what does anatomy mean?", "standard_chat"],
    ["I have an anatomy exam tomorrow, any tips?", "standard_chat"],
    ["a building cutaway diagram", "standard_chat"],
    ["anatomy of a jet turbine", "standard_chat"],
    ["cutaway of the marine engine", "standard_chat"],
    ["isometric illustration of the server rack", "standard_chat"],
  ];
  for (const [prompt, expected] of NEGATIVES) {
    const env = await postDecision(page, prompt);
    expect(env.active_mode, prompt).toBe(expected);
    expect(env.skill_to_load ?? null, prompt + " (no core-skill injection)").toBe(null);
  }

  // The remaining deliverable modes still route: the retirement must not
  // have hollowed out the intents the old vocabulary used to compete with.
  // The last two rows are former anatomy vectors now carried instead by
  // another deliverable word.
  const POSITIVES: [string, string][] = [
    ["make me a spreadsheet of the results", "excel"],
    ["print this pdf", "pdf"],
    ["chart of this building's architecture", "chart"],
    ["exploded diagram in html", "html_render"],
    ["exploded isometric chart", "chart"],
  ];
  for (const [prompt, expected] of POSITIVES) {
    const env = await postDecision(page, prompt);
    expect(env.active_mode, prompt).toBe(expected);
  }
});

test("anatomy retirement: a real chat turn carries the post-retirement mode", async ({ page }) => {
  await page.goto("/");
  for (const prompt of ["What is the anatomy of the knee?", "What is an isometric exercise?"]) {
    const mode = await chatTurnMode(page, prompt);
    expect(mode, prompt).not.toBeNull();
    expect(mode, prompt).not.toBe("anatomy");
    expect(mode, prompt).toBe("standard_chat");
  }
  // The old deliverable-style ask on the same real chat path: standard_chat
  // now, never the retired renderer.
  expect(await chatTurnMode(page, "anatomy of a jet turbine")).toBe("standard_chat");
  // A surviving deliverable on the same path still routes to its mode.
  expect(await chatTurnMode(page, "print this pdf")).toBe("pdf");
});
