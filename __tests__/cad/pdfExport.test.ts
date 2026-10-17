import { describe, expect, it } from "vitest";
import { cadSpecSchema } from "../../lib/cad/cadSchema";
import { cadToPdf } from "../../lib/cad/pdfExport";

const spec = cadSpecSchema.parse({
  title: "Pdf export test",
  units: "m",
  layers: [{ id: "walls", color: "#F87171" }],
  entities: [
    { kind: "line", layer: "walls", from: [0, 0], to: [10, 0] },
    { kind: "circle", layer: "walls", cx: 5, cy: 3, r: 1 },
    { kind: "text", layer: "walls", x: 2, y: 2, content: "Hall (A) \\ B", height: 0.4 },
  ],
  walls: [{ id: "w1", layer: "walls", path: [[0, 0], [10, 0], [10, 6]], closed: true }],
  slabs: [],
  floors: [],
  hotspots: [],
  flows: [],
  titleBlock: { projectName: "Proj", sheetTitle: "Plan (test)", scaleLabel: "1:100", date: "2026-10-17", author: "CAD", sheetNumber: "A-101" },
});

describe("cadToPdf", () => {
  it("produces a valid PDF 1.4 with correct xref offsets", async () => {
    const blob = await cadToPdf(spec);
    expect(blob.type).toBe("application/pdf");
    const text = await blob.text();
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    expect(Number.isFinite(startxref)).toBe(true);
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) \d{5} n /gm)].map(m => Number(m[1]));
    expect(offsets.length).toBeGreaterThanOrEqual(6);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  it("escapes parentheses in text strings", async () => {
    const text = await (await cadToPdf(spec)).text();
    expect(text).toContain("\\(");
    expect(text).toContain("\\)");
  });
});
