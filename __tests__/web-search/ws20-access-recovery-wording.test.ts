/**
 * AUDIT 2026-11-04 item 20 (WS20) — "The web-specific text at
 * WEB_TOOL_GUIDANCE and evidenceBlock guidelines should clearly separate a
 * page/provider failure from exhaustion of the research task. A block should
 * lead to bounded alternative providers, already discovered public routes,
 * supported session/render recovery and other primary documents. Public
 * corroborating information must not be mistaken for private authenticated
 * content. Report the remaining gap only after useful alternatives are
 * exhausted, or a necessary clarification is identified."
 *
 * The old text told the model to "stop reaching for that page. Answer from
 * the sources you can read and name what you could not" — correct about the
 * wall, silent (and therefore permissive) about quitting the TASK on one
 * page-level failure, and silent about the public-vs-authenticated-content
 * confusion. This file pins the distinction in the three live texts; the
 * existing byte-lock probe (web-tools.test.ts: guidance line exactly once in
 * web-tool-loop.ts AND web_loop.rs) forces the Rust fallback to move with
 * the TS text. Wording only — no semantic engine lives in these strings
 * (user law: implementation lives in the harness, not in policy text).
 */
import { it, expect } from "vitest";
import { WEB_TOOL_GUIDANCE } from "@/lib/chat/web-tool-loop";
import { evidenceBlock, ANTI_REFUSAL_DIRECTIVE } from "@/lib/web-search/pipeline";

const bundle = () =>
  ({
    searchGate: {
      decision: {
        depth: "standard",
        freshness: "any",
        queries: [{ query: "wall probe fact", intent: "general" }],
      },
    },
    topPassages: [
      {
        sourceId: "S1",
        url: "https://one.example.com/a",
        domain: "one.example.com",
        title: "One",
        passageText: "The probe fact stated by the readable source.",
        bm25Score: 1,
      },
    ],
    packets: [
      {
        sourceId: "S1",
        url: "https://one.example.com/a",
        domain: "one.example.com",
        title: "One",
        extraction: "direct",
        classification: "SUCCESS_DIRECT",
        passages: [
          {
            sourceId: "S1",
            url: "https://one.example.com/a",
            domain: "one.example.com",
            title: "One",
            passageText: "The probe fact stated by the readable source.",
            bm25Score: 1,
          },
        ],
      },
    ],
  }) as any;

it("WS20 WEB_TOOL_GUIDANCE: a wall stops the PAGE, not the TASK, and the gap is named only after alternatives run out", () => {
  expect(WEB_TOOL_GUIDANCE).toMatch(/page-level access state, not an exhausted research task/);
  expect(WEB_TOOL_GUIDANCE).toMatch(/name the remaining gap only after those useful alternatives run out/);
});

it("WS20 evidenceBlock guidelines: a wall on one source does not exhaust the block and public corroboration is never private content", () => {
  const block = evidenceBlock(bundle());
  expect(block).toMatch(/does not exhaust the block/);
  expect(block).toMatch(
    /never present public corroborating material as if it were the blocked page's private content/,
  );
});

it("WS20 ANTI_REFUSAL_DIRECTIVE: one page/provider failure is an access state for that URL only", () => {
  expect(ANTI_REFUSAL_DIRECTIVE).toMatch(/access state for that URL only/);
  expect(ANTI_REFUSAL_DIRECTIVE).toMatch(/necessary clarification is identified/);
});
