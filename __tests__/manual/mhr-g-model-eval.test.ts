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
    // Number FORMAT normalization (Indian/Western grouping): the user's own
    // restated constraint "40000 rupees" is the SAME value as a citation-
    // backed "₹40,000" — treating format variance as an unknown number is
    // the exact re-stated-constraint blindness the header law forbids.
    // Canonicalize digit-grouped separators on both sides; a value that
    // appears in NO normalized form is still PROVEN fabrication.
    const canon = (s: string) => s.replace(/(\d),(\d)/g, "$1$2");
    const known = canon(humanText + "\n" + t.evidence);
    // lakh/crore SUMMARY forms ("that ₹1.2 lakh M.R.P." rounding a cited
    // ₹1,19,990 listing) are inherently approximate: the exact token can
    // never substring-match. Ground them NUMERICALLY: a scaled token passes
    // only if the corpus contains a number within ±5% of the scaled value.
    // An invented magnitude still has no corpus number nearby → flagged.
    const corpusNums = [...known.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const SCALE = { lakh: 1e5, lac: 1e5, crore: 1e7 };
    return d.unsupported.filter((s) => {
      const spans: number[][] = [];
      for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(lakh|lac|crore)/gi)) {
        spans.push([m.index!, m.index! + m[0].length]);
        const v = Number(m[1].replace(/,/g, "")) * SCALE[m[2].toLowerCase() as "lakh"];
        if (!corpusNums.some((n) => Math.abs(n - v) <= 0.05 * v)) return true;
      }
      const inScaled = (i: number) => spans.some(([a, b]) => i >= a && i < b);
      return [...s.matchAll(/\d+(?:[.,]\d+)*/g)].some(
        (m) => !inScaled(m.index!) && !known.includes(canon(m[0])),
      );
    });
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

  /* Split per-turn (2026-11-07 measured: one 4-round turn alone can burn
     the full single-ceiling, so TWO turns in one test time out on
     infrastructure, not semantics). vitest runs these sequentially in
     file order inside one process, so the closure carries the journal
     state; run BOTH with -t "mhr-g-purchase". */
  const PURCHASE_T1 = "Buy me the cheapest 65 inch TV under 40000 rupees with delivery in Hyderabad";
  let purchaseConv = "";
  let purchaseT1: Turn | null = null;

  it("mhr-g-purchase-t1-purchase-request", async () => {
    purchaseConv = "mhr-g-eval-" + Date.now();
    purchaseT1 = await driveTurn([{ role: "user", content: PURCHASE_T1 }], PURCHASE_T1, null, purchaseConv);
    expectTurn(purchaseT1, PURCHASE_T1);
    // Handoff for the split selector case (-t …-t1 alone, then -t …-t2 in
    // a second foreground invocation): same conv id + prior minted map, so
    // the journal law under test is identical either way.
    // (dataDir itself is rm'd in afterAll — the handoff lives at a stable path)
    fs.writeFileSync(
      path.join(os.tmpdir(), "mhr-g-purchase-handoff.json"),
      JSON.stringify({
        conv: purchaseConv,
        released: purchaseT1.released,
        minted: purchaseT1.minted,
        // The user's conversation legitimately carries EARLIER turns'
        // retrieved evidence: a follow-up restating a number the harness
        // already fetched in t1 is grounded, not fabricated — the oracle
        // corpus spans the whole conversation, not one process's payload.
        evidence: purchaseT1.evidence,
      }),
    );
  }, CASE_TIMEOUT);

  it("mhr-g-purchase-t2-informational-followup", async () => {
    if (!purchaseT1) {
      const f = path.join(os.tmpdir(), "mhr-g-purchase-handoff.json");
      if (!fs.existsSync(f))
        throw new Error('follow-up needs t1 in the same process — run both via -t "mhr-g-purchase"');
      const st = JSON.parse(fs.readFileSync(f, "utf8"));
      purchaseConv = st.conv;
      purchaseT1 = { ...st, released: st.released, minted: st.minted };
    }
    const t2Text = "What refresh rate does the best pick you found have?";
    // Corpus law: t1's retrieved evidence is legitimate known material for
    // a follow-up (the real UI carries the conversation, not one payload).
    const t2 = await driveTurn(
      [
        { role: "user", content: PURCHASE_T1 },
        { role: "assistant", content: purchaseT1.released },
        { role: "user", content: t2Text },
      ],
      t2Text,
      purchaseT1.minted,
      purchaseConv,
    );
    // Both human turns are legitimate number sources for a follow-up answer.
    t2.evidence = [String((purchaseT1 as any).evidence ?? ""), t2.evidence].filter(Boolean).join("\n");
    expectTurn(t2, PURCHASE_T1 + " " + t2Text);
    expect(Object.keys(t2.minted).length, "follow-up turn lost every prior [S#] alias").toBeGreaterThan(0);
  }, CASE_TIMEOUT);

  /* ── UNIVERSALITY DIRECTIVE (user, 2026-11-07): the fix must work on
      ANY commercial / local / job surface — Amazon, Flipkart, Walmart,
      QVC, Best Buy, local areas, multi-portal job crawling — with ZERO
      per-site code in the pipeline (the same 4-stage universal waterfall
      serves every host; tests/universal-websites.spec.ts pins that law).
      Acceptable outcomes are identical everywhere: REAL retrieved data
      cited to minted sources, or an honest gap report naming the wall
      mechanism. On failure, fix the UNIVERSAL mechanism — never
      site-name vocabulary. ───────────────────────────────────────────── */

  it("mhr-u-amazon-phones-20k", async () => {
    const text = "best phones under 20k in amazon";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-flipkart-fridge", async () => {
    const text = "best fridge I can buy in flipkart";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-bestbuy-laptop", async () => {
    const text = "what is the cheapest laptop I can buy in bestbuy";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-walmart-tv", async () => {
    const text = "what is the cheapest 43 inch TV I can buy at Walmart";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-qvc-deals", async () => {
    const text = "find good deals on kitchen appliances at QVC";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-manikonda-restaurant", async () => {
    const text = "find best restaurant near manikonda area in hyderabad";
    expectTurn(await driveTurn([{ role: "user", content: text }], text, null), text);
  }, CASE_TIMEOUT);

  it("mhr-u-aml-job-roles", async () => {
    const text = "find the job roles for AI ML engineer and where I can apply them";
    const t = await driveTurn([{ role: "user", content: text }], text, null);
    expectTurn(t, text);
    // The user's stated expectation is portal SPREAD: the answer must ride
    // evidence from more than one distinct source host. This is an outcome
    // assertion, not vocabulary — breadth is the model's decision within
    // the harness's standard budget.
    const hosts = new Set(
      Object.values(t.minted)
        .map((c: any) => {
          try {
            return new URL(c.url).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        })
        .filter((h) => h !== ""),
    );
    expect(hosts.size, `single-host research trail: ${JSON.stringify([...hosts])}`).toBeGreaterThanOrEqual(2);
  }, CASE_TIMEOUT);
});
