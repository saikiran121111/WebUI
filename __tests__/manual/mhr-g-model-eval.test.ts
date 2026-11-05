/**
 * MHR-G (WS27, 2026-11-06) LEVEL 2: configured-model semantic evals.
 *
 * What this proves: the CURRENT build's harness, driven by the REAL
 * configured model (settings.llmApiUrl — no mocks anywhere on the path) and
 * the REAL web-retrieval stack, gets the user's failing request shapes to a
 * grounded outcome. Mocked-model suites (the golden fixtures, the loop
 * unit suites) prove the harness CONTRACT; they deliberately cannot prove
 * model quality — the fixtures' own notes say so. This suite is the model-
 * quality half of the MHR-G three-level proof.
 *
 * Inputs are HELD-OUT shapes, not memorized vocabulary: the four exact
 * failing user sentences (they are the acceptance targets), structurally
 * different paraphrases with new entities (Pune/QA, Dublin rentals), and
 * UNKNOWN entities (invented companies) where the only acceptable outcome
 * is honest gap-reporting. Per the user law these are TEST EXAMPLES, not
 * vocabulary — nothing here feeds back into prompts or code.
 *
 * Pass criteria are DETERMINISTIC and about TOOL USE / EVIDENCE / OUTCOME —
 * never canned text:
 *   A TOOL USE   — the model drove ≥1 tool round (census stages).
 *   B EVIDENCE   — the server actually minted sources / ledger has an ok
 *                  action (harness supplied the resource).
 *   C INTEGRITY  — every [S#] byte in the RELEASED text resolves to a
 *                  server-minted citation (WS06/MHR-F law re-observed on
 *                  live traffic).
 *   D SEMANTICS  — the harness's own report-only diagnosis on the released
 *                  text (diagnoseResearchAnswer) finds NO unresolved
 *                  marker, NO research wording without retrieval, and no
 *                  fabricated volatile sentence — proxied as a volatile
 *                  flagged sentence containing a numeric token absent from
 *                  the human's own turns (re-stated user constraints are
 *                  the documented MHR-F diagnosis blindness, so they are
 *                  not treated as fabrication).
 *   E GROUNDING  — when evidence was retrieved, the released answer CITES
 *                  at least one minted [S#] (outcome rides the evidence).
 *                  Skippable per case ONLY for unknown-entity gaps, where
 *                  the honest outcome is citing NOTHING and naming the gap.
 *
 * KNOWN LIMIT (reported, not hidden): a model that cites genuinely
 * irrelevant retrieved sources passes E/C/D here — grounding-vs-relevance
 * beyond marker integrity is not decidable without a judge; ANALYZE reads
 * the printed action ledger + released excerpt for that.
 *
 * ── RUN POLICY (protects the hermetic battery + single-owner inference) ──
 * Skipped unless MHR_G_MODEL_EVAL=1. NEVER part of a normal battery run.
 * Hits the live model + live web: run ONE case per foreground invocation
 * (each ≤ ~7 min) so nothing competes for inference mid-turn:
 *   MHR_G_MODEL_EVAL=1 node node_modules/vitest/vitest.mjs run \
 *     __tests__/manual/mhr-g-model-eval.test.ts -t "<case name>"
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diagnoseResearchAnswer } from "@/lib/chat/answer-release";

const GATED = process.env.MHR_G_MODEL_EVAL === "1";
const CASE_TIMEOUT = 420_000; // 7 min per turn: standard budget × local latency + retrieval

type RunLoop = (opts: any) => Promise<void>;

describe.skipIf(!GATED)("MHR-G level 2 — configured-model semantic evals", () => {
  let runWebToolLoop: RunLoop;
  let modelId = "";
  let dataDir = "";

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mhr-g-eval-"));
    process.env.WEBUI_DATA_DIR = dataDir; // journal lands in temp, never the real store
    const loop = await import("@/lib/chat/web-tool-loop");
    runWebToolLoop = loop.runWebToolLoop;
    const settings = await import("@/lib/server/settings");
    const url = settings.llmApiUrl();
    const models: any = await fetch(new URL("/v1/models", url).toString()).then((r) => r.json());
    modelId = models?.data?.[0]?.id ?? "";
    if (modelId === "") throw new Error(`no model served at ${url} — start the inference backend`);
    console.log(`[mhr-g] model=${modelId} endpoint=${url}`);
  }, CASE_TIMEOUT);

  afterAll(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const dec = new TextDecoder();

  interface Turn {
    released: string;
    minted: Record<string, any>;
    toolRounds: number;
    actions: any[];
    /** JSON of every tool envelope the server actually returned this turn
     * (the loop appends them in place to payload.messages) — the evidence
     * corpus a cited value must appear in to be non-fabricated. */
    evidence: string;
    failed: string[];
    closed: number;
  }

  async function driveTurn(
    messages: Array<{ role: string; content: string | null; [k: string]: unknown }>,
    fullText: string,
    priorCitations: Record<string, any> | null,
    conversationId?: string,
  ): Promise<Turn> {
    let raw = "";
    const stages: any[] = [];
    const failed: string[] = [];
    let closed = 0;
    const payload: any = { model: modelId, messages, stream: true };
    await runWebToolLoop({
      payload,
      lastUserIdx: messages.length - 1,
      fullText,
      model: modelId,
      depth: "standard",
      webCitationMap: priorCitations,
      searchGateMeta: { depth: "standard", freshness: "any", decidedBy: "llm", queries: [] },
      ...(conversationId ? { conversationId, currentDate: new Date().toISOString().slice(0, 10) } : {}),
      ch: {
        stage: (e: any) => stages.push(e),
        fail: (m: string) => failed.push(m),
        raw: (b: Uint8Array) => { raw += dec.decode(b); },
        close: () => { closed += 1; },
      },
    });
    let released = "";
    for (const frame of raw.split("\n\n")) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        try {
          const v = JSON.parse(line.slice(5).trim());
          const c = v?.choices?.[0]?.delta?.content;
          if (typeof c === "string") released += c;
        } catch { /* frame not content evidence */ }
      }
    }
    const metas = stages.filter((s) => s.stage === "web_meta");
    const lastMeta = metas[metas.length - 1] ?? {};
    const evidence = payload.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => String(m.content ?? ""))
      .join("\n");
    return {
      released,
      minted: lastMeta.webCitations ?? {},
      toolRounds: stages.filter((s) => s.stage === "web:tools").length,
      actions: lastMeta.researchLedger?.actions ?? [],
      evidence,
      failed,
      closed,
    };
  }

  /** PROVEN fabrication: a volatile sentence the harness's own diagnosis
   * reports as resolving to no minted source, whose numeric tokens appear
   * NOWHERE in the human's turns, the prior answer, OR the tool envelopes
   * the server actually returned. A value present in retrieved evidence is
   * an attribution lapse (reported, model-side guidance law), not a
   * fabricated value — the harness may not pretend otherwise. */
  function fabricatedSentences(t: Turn, humanText: string): string[] {
    const ids = new Set(Object.keys(t.minted));
    const d = diagnoseResearchAnswer(t.released, ids, evidenceOf(t));
    const known = humanText + "\n" + t.evidence;
    return d.unsupported.filter((s) =>
      [...s.matchAll(/\d+(?:[.,]\d+)*/g)].some((m) => !known.includes(m[0])),
    );
  }

  const evidenceOf = (t: Turn): boolean =>
    Object.keys(t.minted).length > 0 || t.actions.some((a) => a.ok);

  function expectTurn(t: Turn, humanText: string, opts: { requireGrounding?: boolean } = {}) {
    console.log(
      `[mhr-g] rounds=${t.toolRounds} minted=${Object.keys(t.minted).length} ` +
        `actions=${t.actions.map((a) => `${a.tool}:${a.ok ? "ok" : a.error}`).join(",")} ` +
        `evidenceChars=${t.evidence.length} answer=${JSON.stringify(t.released.slice(0, 400))}`,
    );
    expect(t.failed, `channel failures: ${t.failed.join("; ")}`).toEqual([]);
    expect(t.closed).toBe(1);
    expect(t.released.length).toBeGreaterThan(40);
    const marks = [...t.released.matchAll(/\[S(\d+)\]/g)].map((m) => "S" + m[1]);
    // C INTEGRITY — the WS06/MHR-F law re-observed on live traffic.
    const ids = new Set(Object.keys(t.minted));
    for (const m of marks) expect(ids.has(m), `dangling marker ${m} reached the client`).toBe(true);
    // D SEMANTICS — the harness's own detector as the deterministic oracle.
    const d = diagnoseResearchAnswer(t.released, ids, evidenceOf(t));
    expect(d.unresolved, "unresolved markers in released text").toEqual([]);
    expect(d.claimsResearch, "research wording with zero retrieval").toBe(false);
    const fab = fabricatedSentences(t, humanText);
    expect(fab, `fabricated volatile sentences: ${JSON.stringify(fab)}`).toEqual([]);
    // A TOOL USE
    expect(t.toolRounds, "model made no tool round at all").toBeGreaterThanOrEqual(1);
    // E GROUNDING
    if (opts.requireGrounding !== false && evidenceOf(t)) {
      expect(marks.length, "evidence was retrieved but the answer cites none of it").toBeGreaterThan(0);
    }
  }

  /* ── the four exact failing user sentences (acceptance targets) ─────── */

  it("mhr-g-jobs-hyderabad", async () => {
    const text = "Find jobs in Hyderabad";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-g-apartments-tallinn", async () => {
    const text = "Find apartments to rent in Tallinn";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-g-apply-nairobi", async () => {
    const text = "Research how to apply for jobs in Nairobi";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-g-amul-zepto", async () => {
    const text = "Find Amul Gold milk in Zepto";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  /* ── held-out paraphrases: new entities, different verbs, no memorized
      phrasing — proves the behavior is not vocabulary-matched ─────────── */

  it("mhr-g-jobs-paraphrase-pune-qa", async () => {
    const text = "I'm a QA engineer based in Pune — what's the best way to find companies hiring for my role right now?";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-g-rentals-paraphrase-dublin", async () => {
    const text = "Moving to Dublin next month — what flats are available to rent under 1500 euro a month?";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  /* ── unknown entities: invented companies. The ONLY acceptable outcomes
      are retrieving-and-citing whatever genuinely exists or naming the
      gap — NEVER inventing prices. Grounding (E) is not required here:
      the honest answer may cite nothing. ──────────────────────────────── */

  it("mhr-g-unknown-entity-gap", async () => {
    const text = "Compare the pricing plans of Zorptivity and Glintbox, two AI note-taking apps";
    const t = await driveTurn([{ role: "user", content: text }], text, null);
    expectTurn(t, text, { requireGrounding: false });
    // Extra shape law: if the answer states ANY currency figure it must
    // ride a minted citation — an invented price for a nonexistent
    // company is the exact fabrication this eval exists to catch.
    const valueSentences = t.released
      .split(/(?<=[.!?])\s+/)
      .filter((s) => /[$€£₹]\s?\d|\d[\d.,]*\s?(?:USD|EUR|GBP|INR|dollars?|euros?|rupees?|pounds?)/i.test(s))
      .filter((s) => !/\[S\d+\]/.test(s));
    expect(valueSentences, `uncited price claims about unknown entities: ${JSON.stringify(valueSentences)}`).toEqual([]);
  }, CASE_TIMEOUT);

  /* ── informational follow-up after a purchase request (user example 5;
      the conversation carries research state via the WS05 journal) ───── */

  it("mhr-g-purchase-then-followup", async () => {
    const conv = "mhr-g-eval-" + Date.now();
    const t1Text = "Buy me the cheapest 65 inch TV under 40000 rupees with delivery in Hyderabad";
    const t1 = await driveTurn([{ role: "user", content: t1Text }], t1Text, null, conv);
    expectTurn(t1, t1Text);
    const t2Text = "What refresh rate does the best pick you found have?";
    const t2 = await driveTurn(
      [
        { role: "user", content: t1Text },
        { role: "assistant", content: t1.released },
        { role: "user", content: t2Text },
      ],
      t2Text,
      t1.minted,
      conv,
    );
    // Both human turns are legitimate number sources for a follow-up answer.
    expectTurn(t2, t1Text + " " + t2Text);
    expect(Object.keys(t2.minted).length, "follow-up turn lost every prior [S#] alias").toBeGreaterThan(0);
  }, CASE_TIMEOUT);
});
