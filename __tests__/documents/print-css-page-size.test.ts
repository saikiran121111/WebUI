import { describe, it, expect } from "vitest";
import { buildPrintableHtml, PRINT_CSS } from "@/lib/documents/printCss";

// F11: A4 is a default, not a mandate. An explicit page geometry in the artifact
// must survive the injected stylesheet (which is injected LAST in <head> and would
// otherwise out-specify the author), while the break rules still apply.
describe("print CSS honours an explicit page geometry", () => {
  it("keeps A4 when the document declares nothing", () => {
    const html = buildPrintableHtml("<h1>T</h1><table><tr><td>x</td></tr></table>");
    expect(html).toContain("@page { size: A4; margin: 14mm; }");
    expect(html).toContain("break-inside: avoid");
  });

  it("drops only the geometry when the document declares its own @page", () => {
    const src = '<html><head><style>@page { size: A4 landscape; margin: 20mm; }</style></head><body><div class="card">x</div></body></html>';
    const html = buildPrintableHtml(src);
    const from = html.indexOf('<style id="webui-print-css">');
    const injected = html.slice(from, html.indexOf('</style>', from));
    expect(injected).not.toMatch(/@page\s*\{/);
    expect(injected).toContain("break-inside: avoid");
    expect(injected).toContain("table-header-group");
    // the author rule is still the only @page in the document
    expect((html.match(/@page/gi) ?? []).length).toBe(1);
    expect(html).toContain("size: A4 landscape");
  });

  it("a document that merely mentions @page in prose does not disable the default", () => {
    const html = buildPrintableHtml("<p>the @page rule is a CSS at-rule</p>");
    expect(html).toContain("@page { size: A4; margin: 14mm; }");
  });
});
