/**
 * Cross-engine reopen parity: the RETAINED TypeScript writers (docx/pptx/xlsx/pdf)
 * produce the bytes, and the PYTHON readers used by the production upload path
 * (`ruke_ml.documents.parser.load_document`) read them back.
 *
 * Why this exists: the migration matrix keeps those writers as TypeScript owners,
 * which is a recorded scope deviation, not a completed Python migration. What has to
 * hold regardless of owner is that a file Ruke generates is a file Ruke can read back
 * with real structure - heading kinds, table cells with their cell list, slide order,
 * note parts, formula TEXT plus its CACHED result, page numbers for late evidence, and
 * Unicode that survives the round trip.
 *
 * Real execution, not a mock: the engines write real files under .data/tmp, then this
 * test spawns the project venv interpreter on docs/overnight/probes/reopen_probe.py and
 * asserts against what that reader actually returned. If the venv is not prepared on
 * this machine the file reports an honest skip, never a pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx } from "@/lib/documents/docxEngine";
import { buildPptx } from "@/lib/documents/pptxEngine";
import { buildXlsx } from "@/lib/documents/xlsxEngine";
import { renderPdf } from "@/lib/documents/pdfEngine";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = path.join(ROOT, "python-backend", ".venv", "Scripts", "python.exe");
const PROBE = path.join(ROOT, "docs", "overnight", "probes", "reopen_probe.py");
const VENV_READY = fs.existsSync(PY) && fs.existsSync(PROBE);

interface ProbeFile {
  path: string;
  ok: boolean;
  kind?: string;
  blocks?: number;
  kinds?: Record<string, number>;
  matched?: Record<string, { count: number; first_kind: string | null; first_loc: Record<string, unknown> | null }>;
  formula_cells?: { sheet: string | null; cell: string | null; formula: string | null; cached_value: string | null }[];
  meta?: Record<string, unknown>;
  coverage?: {
    units_total: number; units_extracted: number; units_succeeded: number[];
    units_empty: number[]; units_needing_ocr: number[]; units_failed: number[];
    method: string; note: string;
  };
  blocks_sample?: { kind: string; text: string; loc: Record<string, unknown> }[];
  // Every speaker-note block the reader found, in slide order (not just the head sample).
  notes?: { kind: string; text: string; loc: Record<string, unknown> }[];
  error?: string;
}

let dir = "";
const files: Record<string, string> = {};
let probe: { files: ProbeFile[] } = { files: [] };

function probeByPath(p: string): ProbeFile {
  const found = probe.files.find((f) => path.resolve(f.path) === path.resolve(p));
  expect(found, `the reopen probe reported nothing for ${p}`).toBeTruthy();
  return found as ProbeFile;
}

beforeAll(async () => {
  if (!VENV_READY) return;
  dir = fs.mkdtempSync(path.join(ROOT, ".data", "tmp", "reopen_parity_"));

  // No chart sections in the docx spec: those render real Chromium screenshots
  // (~60 s each) and the Python reader declares that it does not reconstruct images,
  // so a chart here would measure the screenshot path, not the reopen path.
  const docx = await buildDocx({
    filename: "Basin Water Review",
    title: "Basin Water Review",
    author: "Ruke",
    sections: [
      { type: "heading", level: 1, text: "Executive Summary" },
      { type: "paragraph", text: "The aquifer yields 1.4 million cubic metres per month across eleven observation wells — Élan café 25 %." },
      { type: "bullets", items: ["Permits capped at 62%", "Dry-season flow reduced"] },
      { type: "heading", level: 2, text: "Regional Readings" },
      { type: "table", headers: ["Station", "Flow m3/s", "Turbidity NTU"], rows: [["Kandla", "18.4", "12.7"], ["Aranjes", "12.6", "51.2"]] },
      { type: "paragraph", text: "Late appendix: the arbitration award of 14 November 2021 ordered 4,18,25,000 rupees within ninety days." },
    ],
  });

  const pptx = await buildPptx({
    filename: "Launch Brief",
    title: "Launch Brief",
    tier: "simple",
    slides: [
      { layout: "title", title: "Launch Brief", subtitle: "Quarter one", bullets: [], stats: [] },
        // Authored speaker notes on two of the three slides, so the reader can prove it
        // keeps notes separate AND separates them from the automatic slide-number field,
        // while slide 1 (no notes) must produce no note block at all (D-071).
        {
          layout: "bullets", title: "Adoption Curve", subtitle: "", bullets: ["Realtime sync", "Offline first"], stats: [],
          notes: "Open with the pricing question before the roadmap.",
        },
        {
          layout: "stats", title: "Momentum", subtitle: "", bullets: [], stats: [{ label: "Revenue", value: "4.2", suffix: "M" }],
          notes: "Quote 4.2 M gross, not net — clarify the accrual window.",
        },
    ],
  });

  const xlsx = await buildXlsx({
    filename: "Revenue Model",
    sheets: [{
      name: "Revenue",
      columns: [
        { key: "month", label: "Month", format: "text" },
        { key: "units", label: "Units", format: "number" },
        { key: "rev", label: "Revenue", format: "currency" },
      ],
      rows: [
        { month: "2025-01", units: 5, rev: "=B2*2" },
        { month: "2025-02", units: 10, rev: "=SUM(B2:B3)" },
      ],
      freezeHeader: true,
      totalRow: true,
    }],
  });

  // A generated PDF too, so the renderer is covered as well: the Python reader has to
  // see real page numbers and reach evidence on a LATE page, which is exactly what a
  // long-document citation depends on.
  const pdfHtml = "<h1>Basin Operations Review</h1>" +
    Array.from({ length: 10 }, (_, i) => `<section class="card">
      <h2>Section ${i + 1}: Regional Readings</h2>
      <p>Flow at gauge ${i + 1} measured 1${i}.4 cubic metres per second against a turbidity
      of 12.7 NTU inside the dry-season survey window.</p>
      <table><thead><tr><th>Station</th><th>Flow m3/s</th></tr></thead>
      <tbody><tr><td>Kandla gauge ${i + 1}</td><td>1${i}.4</td></tr></tbody></table>
    </section>`).join("") +
    "<h2>Appendix</h2><p>Late evidence marker: the arbitration award of 14 November 2021 " +
    "ordered 4,18,25,000 rupees within ninety days.</p>";
  const pdf = await renderPdf(pdfHtml, "Basin Operations Review");

  for (const [key, out] of Object.entries({ docx, pptx, xlsx, pdf })) {
    const built = out as { buffer: Buffer; filename: string };
    const p = path.join(dir, built.filename);
    fs.writeFileSync(p, Buffer.from(built.buffer));
    files[key] = p;
  }

  const expects = [
    "Executive Summary", "Regional Readings", "1.4 million cubic metres",
    "Élan café 25 %", "Kandla", "Aranjes", "arbitration award of 14 November 2021",
    "Launch Brief", "Adoption Curve", "Realtime sync", "Momentum", "Revenue",
    "Month", "2025-01",
    "Open with the pricing question before the roadmap.",
    "Basin Operations Review", "Section 10: Regional Readings", "Late evidence marker",
  ];
  const run = spawnSync(PY,
    [PROBE, ...expects.flatMap((e) => ["--expect", e]), files.docx, files.pptx, files.xlsx, files.pdf],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    throw new Error(`reopen probe exited ${run.status}: ${(run.stderr || run.error?.message || "").slice(0, 1500)}`);
  }
  probe = JSON.parse(run.stdout) as { files: ProbeFile[] };
  // The raw cross-engine read IS the evidence; keep it next to the run logs.
  fs.writeFileSync(path.join(ROOT, "docs", "overnight", "logs", "f50-reopen-probe.json"),
    JSON.stringify(probe, null, 2));
}, 240000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!VENV_READY)("generated artifact reopen parity (TS writer -> Python reader)", () => {
  it("reads back a generated .docx with heading kinds, table cells and late evidence", () => {
    const f = probeByPath(files.docx);
    expect(f.error ?? "").toBe("");
    expect(f.ok).toBe(true);
    expect(f.kind).toBe("docx");
    expect((f.blocks ?? 0) > 0).toBe(true);
    expect(f.coverage!.units_total).toBe(1);
    expect(f.coverage!.units_succeeded).toEqual([1]);
    const m = f.matched!;
    expect(m["Executive Summary"].count).toBe(1);
    expect(m["Executive Summary"].first_kind).toBe("heading");
    expect(m["Regional Readings"].first_kind).toBe("heading");
    // Typography and non-ASCII text survive the round trip.
    expect(m["Élan café 25 %"].count).toBe(1);
    // Tables come back as ROWS carrying their cell list, not one flattened string.
    expect(m["Kandla"].first_kind).toBe("table_row");
    expect((m["Kandla"].first_loc as { cells?: string[] }).cells).toEqual(["Kandla", "18.4", "12.7"]);
    expect((f.meta as { tables?: number }).tables).toBe(1);
    // The declared reader limits stay declared instead of being papered over.
    expect(((f.meta as { not_extracted?: string[] }).not_extracted ?? []).join(",")).toContain("merged cells");
    // Evidence near the END is reachable, and its paragraph reference sits AFTER the
    // last heading's, so a citation would name the right block.
    expect(m["arbitration award of 14 November 2021"].count).toBe(1);
    const late = Number((m["arbitration award of 14 November 2021"].first_loc as { paragraph: number }).paragraph);
    const head = Number((m["Regional Readings"].first_loc as { paragraph: number }).paragraph);
    expect(late).toBeGreaterThan(head);
  });

  it("reads back a generated .pptx in slide order with every slide addressable", () => {
    const f = probeByPath(files.pptx);
    expect(f.error ?? "").toBe("");
    expect(f.ok).toBe(true);
    expect(f.kind).toBe("pptx");
    expect(f.coverage!.units_total).toBe(3);
    expect(f.coverage!.units_succeeded).toEqual([1, 2, 3]);
    expect(f.coverage!.units_failed).toEqual([]);
    const m = f.matched!;
    expect((m["Launch Brief"].first_loc as { slide: number }).slide).toBe(1);
    expect((m["Adoption Curve"].first_loc as { slide: number }).slide).toBe(2);
    expect(m["Realtime sync"].count).toBeGreaterThan(0);
    expect((m["Momentum"].first_loc as { slide: number }).slide).toBe(3);
    // Speaker notes round-trip. This REPLACED a recorded writer gap: until D-071 the TS
    // writer emitted a notesSlide part holding ONLY the automatic slide-number field, so
    // the only "notes" this reader could ever report were "1"/"2"/"3". Now the two
    // authored notes come back as note blocks on the right slides, the slide with no
    // authored note produces NO note block, and the managed placeholders (slide number,
    // footer, date) never masquerade as note text.
    const notes = f.notes ?? [];
    expect(notes.length).toBe(2);
    expect(notes.map((n) => n.text.trim())).toEqual([
      "Open with the pricing question before the roadmap.",
      "Quote 4.2 M gross, not net \u2014 clarify the accrual window.",
    ]);
    expect(notes.map((n) => n.loc.slide)).toEqual([2, 3]);
    expect(notes.every((n) => n.loc.part === "notes")).toBe(true);
    expect(f.matched!["Open with the pricing question before the roadmap."].first_kind).toBe("note");
    // The notesSlide PARTS still exist for all three slides: "no authored note" is not
    // "no part", and the reader reports which parts it looked at.
    expect(((f.meta as { note_parts?: string[] }).note_parts ?? []).length).toBe(3);
    // F78-D: the reader now extracts chart CACHED VALUES, so the blanket "charts"
    // disclosure became the precise limit: styling and axis scaling stay out.
    expect(((f.meta as { not_extracted?: string[] }).not_extracted ?? []).join(",")).toContain("chart styling and axis scaling (cached values only)");
  });

  it("reads back a generated .xlsx with formulas AND cached results, cell-addressed", () => {
    const f = probeByPath(files.xlsx);
    expect(f.error ?? "").toBe("");
    expect(f.ok).toBe(true);
    expect(f.kind).toBe("xlsx");
    expect(f.coverage!.units_total).toBe(1);
    expect(f.coverage!.units_succeeded).toEqual([1]);
    expect(((f.kinds ?? {}).cell ?? 0) > 0).toBe(true);
    expect(((f.kinds ?? {}).formula ?? 0) >= 2).toBe(true);
    const doubled = f.formula_cells!.find((c) => c.formula === "B2*2");
    expect(doubled, "the cell written as =B2*2 must come back as a formula, not as text").toBeTruthy();
    expect(doubled!.cell).toBe("C2");
    expect(doubled!.sheet).toBe("Revenue");
    expect(Number(doubled!.cached_value)).toBe(10);
    const summed = f.formula_cells!.find((c) => c.formula === "SUM(B2:B3)");
    expect(summed).toBeTruthy();
    expect(Number(summed!.cached_value)).toBe(15);
    // Header labels and a data row come back cell-addressed, so a citation can name
    // the exact cell instead of "somewhere in the sheet".
    expect(m_first_cell(f, "Month")).toBe("cell");
    expect(m_first_cell(f, "2025-01")).toBe("cell");
    expect(typeof (f.matched!["Month"].first_loc as { cell?: string }).cell).toBe("string");
  });

  it("reads back a generated .pdf page by page and reaches the late appendix", () => {
    const f = probeByPath(files.pdf);
    expect(f.error ?? "").toBe("");
    expect(f.ok).toBe(true);
    expect(f.kind).toBe("pdf");
    expect(f.coverage!.units_total).toBeGreaterThanOrEqual(2);
    expect(f.coverage!.units_failed).toEqual([]);
    expect(f.coverage!.method).toContain("pypdf");
    const m = f.matched!;
    expect(m["Basin Operations Review"].count).toBeGreaterThan(0);
    expect(m["Section 10: Regional Readings"].count).toBeGreaterThan(0);
    // The late appendix must be readable, and its page reference must be a real page
    // inside this document's own page count.
    const latePage = Number((m["Late evidence marker"].first_loc as { page: number }).page);
    expect(latePage).toBeGreaterThanOrEqual(2);
    expect(latePage).toBeLessThanOrEqual(f.coverage!.units_total);
  });
});

function m_first_cell(f: ProbeFile, key: string): string | null {
  return f.matched?.[key]?.first_kind ?? null;
}
