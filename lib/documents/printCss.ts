/**
 * Mandatory A4 print stylesheet injected into every PDF render (PHASE 3).
 * Guarantees: no orphan headings, no sliced charts/figures, no clipped table
 * rows — thead repeats on every page. Tables MAY split across pages (rows
 * flow to fill each page; a whole-table break-inside:avoid left huge dead
 * zones that inflated page count), but individual rows never break, and
 * charts/flowcharts/figures are kept whole on one page.
 */
export const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
.card, .chart-container, figure, tr, blockquote, pre, .resume-section-item { break-inside: avoid; page-break-inside: avoid; }
table { break-inside: auto; page-break-inside: auto; }
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
p { orphans: 3; widows: 3; }
`;

/** Base document defaults so model HTML prints like a real report. */
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  font-size: 10.5pt; line-height: 1.5; color: #111827; background: #ffffff;
}
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 14pt; margin: 14pt 0 6pt; color: #0f172a; }
h3 { font-size: 12pt; margin: 10pt 0 4pt; }
p { margin: 0 0 6pt; }
table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt; }
th, td { border: 1px solid #d1d5db; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f3f4f6; }
.card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10pt; margin: 8pt 0; }
.chart-container { margin: 8pt 0; }
.chart-container svg { max-width: 100%; height: auto; }
blockquote { border-left: 3px solid #9ca3af; margin: 8pt 0; padding: 2pt 10pt; color: #374151; }
pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6pt; font-size: 9pt; white-space: pre-wrap; }
`;

/** Wrap a fragment/document into a full printable HTML document. */
export function buildPrintableHtml(source: string): string {
  const isFullDoc = /<html[\s>]/i.test(source);
  const body = isFullDoc
    ? source
    : `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8" />\n</head>\n<body>\n${source}\n</body>\n</html>`;
  const style = `<style id="webui-print-css">${BASE_CSS}${PRINT_CSS}</style>`;
  if (/<\/head>/i.test(body)) return body.replace(/<\/head>/i, style + "\n</head>");
  return body.replace(/<body([^>]*)>/i, style + "\n<body$1>");
}
