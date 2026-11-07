/**
 * AUDIT 2026-11-04 (universal research-depth brief) — read_page must be able
 * to reach a FOCUS-matched requested fact beyond the prefix of a long page,
 * must surface the discovered next route (the linked catalog), and must
 * disclose accurately when the returned window discarded page content.
 */
import { it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({ long: false }));

vi.mock("@/lib/web-search/ssrf", async (original) => ({
  ...(await original<any>()),
  isSafeUrlWithDns: async () => true,
}));

vi.mock("@/lib/web-search/extractor", () => ({
  extractUrl: async (r: any) => ({
    sourceId: "",
    url: r.url,
    domain: "docs.example.com",
    title: "Model guide",
    extraction: "direct",
    classification: "SUCCESS_DIRECT",
    passages: [
      {
        sourceId: "",
        url: r.url,
        domain: "docs.example.com",
        title: "Model guide",
        passageText:
          // Fill sized from the LIVE window cap (2026-11-07 re-tune): the
          // "long" fixture must always be >2 window-widths so the tail is
          // genuinely beyond the prefix, whatever the cap is set to.
          (state.long
            ? "Foundation models support overview. ".repeat(
                Math.ceil((MAX_PASSAGE_CHARS * 2) / "Foundation models support overview. ".length),
              )
            : "") +
          "The supported model is Boreal-X17. Detailed catalog: [Full catalog](https://docs.example.com/reference/model-catalog).",
        bm25Score: 0,
      },
    ],
  }),
  renumberPackets: (packets: any[], n = 1) => {
    for (const p of packets) {
      p.sourceId = "S" + n++;
      for (const x of p.passages) x.sourceId = p.sourceId;
    }
  },
}));

import { execReadPageTool, makeWebToolSession, MAX_PASSAGE_CHARS } from "@/lib/web-search/tools";

async function read(long: boolean) {
  state.long = long;
  return await execReadPageTool(
    makeWebToolSession("standard", 1, "supported foundation models"),
    { urls: ["https://docs.example.com/guide"], focus: "supported foundation models" },
    [],
  );
}

it("control: read_page returns a short answer and its discovered catalog link", async () => {
  const r = await read(false);
  expect(JSON.stringify(r)).toContain("Boreal-X17");
  expect(JSON.stringify(r)).toContain("/reference/model-catalog");
});

it("read_page focus can reach a requested fact and route after the prefix of a long passage", async () => {
  const r = await read(true);
  expect(JSON.stringify(r)).toContain("Boreal-X17");
  expect(JSON.stringify(r)).toContain("/reference/model-catalog");
});

it("read_page discloses when it discarded the tail of a fetched passage", async () => {
  const r = await read(true);
  expect((r.pages as any[])[0].truncated).toBe(true);
});
