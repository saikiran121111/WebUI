import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { buildDocx } from "@/lib/documents/docxEngine";

const spec = {
  filename: "Market Report",
  title: "Q4 Market Report",
  author: "WebUI",
  sections: [
    { type: "heading", level: 1, text: "Executive Summary" },
    { type: "paragraph", text: "Revenue grew across all regions this quarter." },
    { type: "bullets", items: ["NA up 12%", "EMEA up 8%", "APAC up 21%"] },
    { type: "heading", level: 2, text: "Revenue by Region" },
    { type: "table", headers: ["Region", "Revenue", "Growth"], rows: [["NA", "1.2M", "12%"], ["EMEA", "0.9M", "8%"]] },
    { type: "chart", title: "Quarterly Revenue", chart: { type: "bar", categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "Revenue", data: [10, 14, 17, 21] }] } },
    { type: "chart", title: "Share by Region", chart: { type: "donut", categories: ["NA", "EMEA", "APAC"], series: [{ name: "Share", data: [45, 30, 25] }] } },
  ],
};

describe("docx engine", () => {
  it("embeds 2 chart screenshots, keeps heading hierarchy and deletes every temp file", async () => {
    // Isolated temp dir: parallel test files (pdfEngine) also create
    // temp_chart_* files, so scanning the shared OS temp dir races them.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "docx_test_"));
    process.env.DOC_TEMP_DIR = tempDir;
    let out;
    try {
      out = await buildDocx(spec);
    } finally {
      delete process.env.DOC_TEMP_DIR;
    }
    expect(out.filename).toBe("Market_Report.docx");

    const zip = unzipSync(new Uint8Array(out.buffer));
    const doc = new TextDecoder().decode(zip["word/document.xml"]);
    expect(doc).toContain("Executive Summary");
    expect(doc).toContain('w:val="Heading1"');
    expect(doc).toContain('w:val="Heading2"');
    expect(doc).toContain("Q4 Market Report");

    const media = Object.keys(zip).filter((n) => n.startsWith("word/media/") && n.endsWith(".png"));
    expect(media.length).toBe(2);
    for (const m of media) expect(zip[m].length).toBeGreaterThan(1000); // real screenshots, not stubs

    // A4 page size in sectPr (11906 × 16838 DXA)
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');

    // no temp_chart_* files left behind in the engine's temp dir
    const leftovers = fs.readdirSync(tempDir).filter((f) => f.startsWith("temp_chart_"));
    expect(leftovers).toEqual([]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }, 60000);
});
