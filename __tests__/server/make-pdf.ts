/**
 * Hand-built minimal PDF generator for the I06 coverage tests.
 *
 * A byte-level PDF with COMPUTED xref offsets is fully deterministic and
 * dependency-free — the Chromium/pdfEngine fixture route was explicitly out
 * of scope for this run. A page with `null` text gets NO /Contents entry at
 * all, which is exactly the shape of a scanned page for a text extractor:
 * pdf.js finds zero text items on it.
 *
 * Object numbers are SEQUENTIAL (catalog, pages tree, n page objects, one
 * content stream per text page, font). The previous numbering skipped the
 * stream slot for scanned pages, leaving `undefined` entries in the xref
 * table — the file was unreadable, not "scanned". Text is placed INSIDE the
 * 300x300 MediaBox so nothing about the fixture depends on pdf.js being
 * generous about out-of-bounds runs.
 */
export function makePdf(pages: (string | null)[]): Buffer {
  const n = pages.length;
  const pageNum = (i: number) => 3 + i;
  let next = 3 + n;
  const streamNum = pages.map((t) => (t === null ? 0 : next++));
  const fontNum = next;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  const obj = (num: number, body: string): void => {
    offsets[num] = Buffer.byteLength(out, "latin1");
    out += `${num} 0 obj\n${body}\nendobj\n`;
  };

  const kids = pages.map((_, i) => `${pageNum(i)} 0 R`).join(" ");
  obj(1, "<</Type/Catalog/Pages 2 0 R>>");
  obj(2, `<</Type/Pages/Kids[${kids}]/Count ${n}>>`);
  pages.forEach((text, i) => {
    const num = pageNum(i);
    if (text === null) {
      obj(num, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>`);
      return;
    }
    const stream = `BT /F1 12 Tf 40 240 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
    obj(num, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents ${streamNum[i]} 0 R/Resources<</Font<</F1 ${fontNum} 0 R>>>>>>`);
    obj(streamNum[i], `<</Length ${Buffer.byteLength(stream, "latin1")}>>\nstream\n${stream}\nendstream`);
  });
  obj(fontNum, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  const size = fontNum + 1;
  const xrefOff = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) out += `${String(offsets[k]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${size}/Root 1 0 R>>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
