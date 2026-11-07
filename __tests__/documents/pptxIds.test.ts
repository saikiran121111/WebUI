/**
 * Regression for the 2026-11-07 P7-loop pptx-5a failure: the explainer deck's
 * Download threw "PPTX package validation failed: duplicate shape id="3"
 * appears 2× in slide /ppt/slides/slide2.xml" — the table slide. Root cause
 * is upstream (PptxGenJS numbers graphic frames from a per-type counter), so
 * lib/documents/pptxIds.ts renumbers before the package is read by anything.
 */
import { describe, it, expect } from "vitest";
import PptxGenJS from "pptxgenjs";
import { unzipSync } from "fflate";
import { loadPresentation, validatePresentation } from "@office-kit/pptx";
import { ensureUniqueShapeIds } from "@/lib/documents/pptxIds";
import { buildPptx } from "@/lib/documents/pptxEngine";

const slideXmls = (buffer: Buffer) => {
  const zip = unzipSync(new Uint8Array(buffer));
  return Object.keys(zip)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((n) => new TextDecoder().decode(zip[n]));
};
const dupIds = (xml: string) => {
  const seen = new Map<string, number>();
  for (const m of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return [...seen].filter(([, c]) => c > 1);
};

describe("PptxGenJS duplicate shape-id workaround (lib/documents/pptxIds)", () => {
  it("reproduces the upstream defect, then the fix makes the slide unique", async () => {
    const p = new PptxGenJS();
    const s = p.addSlide();
    s.addText("Heading", { x: 0.5, y: 0.5, w: 9, h: 1 });
    s.addTable([["A", "B"], ["1", "2"]] as never, { x: 0.5, y: 2, w: 9 });
    const raw = (await p.write({ outputType: "nodebuffer" })) as unknown as Buffer;

    // The defect really exists in the pinned pptxgenjs — if upstream fixes
    // this counter one day, this pin tells us the workaround can retire.
    const before = slideXmls(raw);
    expect(before.some((x) => dupIds(x).length > 0), "expected the pptxgenjs per-type id counter to collide").toBe(true);

    const fixed = ensureUniqueShapeIds(raw);
    for (const xml of slideXmls(fixed)) expect(dupIds(xml)).toEqual([]);
    const pres = await loadPresentation(new Uint8Array(fixed));
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);
  });

  it("leaves a collision-free package byte-identical", async () => {
    const p = new PptxGenJS();
    const s = p.addSlide();
    s.addText("One", { x: 0.5, y: 0.5, w: 9, h: 1 });
    s.addText("Two", { x: 0.5, y: 2, w: 9, h: 1 });
    const raw = (await p.write({ outputType: "nodebuffer" })) as unknown as Buffer;
    expect(ensureUniqueShapeIds(raw)).toBe(raw);
  });

  it("the failing journey shape — normal tier, morph pair, table slide — exports and validates clean", async () => {
    const out = await buildPptx({
      filename: "predictive-maintenance-explained.pptx",
      title: "Predictive Maintenance",
      tier: "normal",
      theme: { bg: "#0D0D0D", accent: "#38BDF8", positive: "#22C55E" },
      slides: [
        { layout: "title", title: "Predictive Maintenance", subtitle: "A five-slide explainer", bullets: [], stats: [] },
        {
          layout: "table", title: "There are only three ways to look after a machine", subtitle: "",
          bullets: [], stats: [], morphGroup: "ways",
          table: {
            headers: ["Approach", "When you act", "The everyday version", "What it costs you"],
            rows: [
              ["Reactive", "After it breaks", "Drive until the light comes on", "Tow truck, missed deadline"],
              ["Preventive", "On a fixed calendar", "Oil change every 5,000 miles", "Good parts thrown away early"],
              ["Predictive", "When the machine says so", "Your car texts you", "A planned two-hour fix"],
            ],
          },
        },
        {
          layout: "table", title: "What the evidence says", subtitle: "",
          bullets: [], stats: [], morphGroup: "ways",
          table: {
            headers: ["Claim", "Range"],
            rows: [["Maintenance cost", "18-25%"], ["Unplanned downtime", "up to 50%"]],
          },
        },
        { layout: "bullets", title: "Two cautions", subtitle: "", bullets: ["Consultancy ranges, not audits", "Payback figures disagree"], stats: [] },
      ],
    });
    // The model wrote ".pptx" in the fence filename — the engine must not double it.
    expect(out.filename).toBe("predictive-maintenance-explained.pptx");

    const pres = await loadPresentation(new Uint8Array(out.buffer));
    expect(validatePresentation(pres).filter((v) => v.severity === "error")).toEqual([]);
    for (const xml of slideXmls(out.buffer)) expect(dupIds(xml)).toEqual([]);
  });
});
