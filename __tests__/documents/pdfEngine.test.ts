import { describe, it, expect } from "vitest";
import { renderPdf, pdfPageCount, renderChartPng } from "@/lib/documents/pdfEngine";
import { chartHtmlDocument } from "@/lib/documents/chartHtml";

const longReport = `
<h1>Annual Operations Review</h1>
${Array.from({ length: 14 }, (_, i) => `
  <section class="card">
    <h2>Section ${i + 1}: Regional Performance</h2>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit.</p>
    <table>
      <thead><tr><th>Quarter</th><th>Revenue</th><th>Growth</th></tr></thead>
      <tbody>
        <tr><td>Q1</td><td>$${100 + i}k</td><td>4.${i}%</td></tr>
        <tr><td>Q2</td><td>$${200 + i}k</td><td>6.${i}%</td></tr>
      </tbody>
    </table>
  </section>`).join("")}
`;

describe("pdf engine", () => {
  it("renders a multi-page A4 PDF with the mandatory print CSS applied", async () => {
    const out = await renderPdf(longReport, "Annual Review");
    expect(out.filename).toBe("Annual_Review.pdf");
    expect(out.buffer.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = await pdfPageCount(out.buffer);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(out.pageCount).toBe(pages);
  }, 60000);

  it("chart screenshot returns a real PNG at 2x scale and cleans up its temp html", async () => {
    const html = chartHtmlDocument({ type: "bar", title: "T", categories: ["A", "B"], series: [{ name: "S", data: [3, 7] }] }, { width: 400, height: 300, theme: "dark" });
    const shot = await renderChartPng(html, { width: 400, height: 300, scale: 2 });
    expect(shot.buffer.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(shot.width).toBeGreaterThanOrEqual(400);
  }, 60000);
});
