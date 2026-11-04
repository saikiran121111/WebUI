/**
 * AUDIT 2026-11-04 (universal research-depth brief) — the gate must recognize
 * an EXTERNAL EVIDENCE NEED from request meaning + evidence required, not from
 * magic search words. Required prompts attribute the answer to an external
 * source ("from their documentation", "in …'s guidelines") or ask an exact
 * enumerable catalog of an unknown entity; NO wording veto, gate outage or
 * malformed verdict may collapse them into no-search. Controls keep the
 * self-contained tasks local (no search-everything regression).
 */
import { it, expect, vi, afterEach } from "vitest";
import { runSearchGate } from "@/lib/web-search/search-gate";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const required = [
  "Tell me about accenture's ai foundary from accenture's doument",
  "Tell me about ArborWorks' Boreal platform from their documentation.",
  "Which foundation models does ArborWorks support?",
  "What are the eligibility requirements in the Government of India's PM-KISAN guidelines?",
];

for (const mode of ["veto", "unavailable", "malformed"]) {
  for (const prompt of required) {
    it(mode + ": independently recognizes external source needs: " + prompt, async () => {
      vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
      vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (mode === "unavailable") throw Error("Controlled gate outage");
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      mode === "malformed"
                        ? "not-json"
                        : JSON.stringify({
                            search_required: false,
                            reason: "Confident from memory",
                            freshness: "none",
                            depth: "quick",
                            queries: [],
                          }),
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }),
      );
      const r = await runSearchGate({ userPrompt: prompt, hasAttachmentEvidence: false, history: [] });
      console.log("IMPLICIT_SOURCE_NEED", JSON.stringify({ mode, prompt, result: r }));
      expect(
        r.decision.search_required,
        "an external attribution or unknown exact supported catalog needs evidence without magic search words",
      ).toBe(true);
    });
  }
}

for (const prompt of [
  "Explain what a foundation model is.",
  "Translate “Which foundation models does ArborWorks support?” into Hindi.",
]) {
  it("control: stays local with adequate self-contained task: " + prompt, async () => {
    vi.stubEnv("WEB_SEARCH_GATE_DISABLED", "");
    vi.stubEnv("WEB_SEARCH_LFM_DISABLED", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    search_required: false,
                    reason: "Self-contained task",
                    freshness: "none",
                    depth: "quick",
                    queries: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const r = await runSearchGate({ userPrompt: prompt, history: [] });
    expect(r.decision.search_required).toBe(false);
  });
}
