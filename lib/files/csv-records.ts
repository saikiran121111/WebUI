/**
 * F63 — CSV/TSV row addressing.
 *
 * Raw tabular text arrives at the model with PHYSICAL lines, and a quoted
 * field containing a newline shifts every row below it (fr-20261122b fr-T3:
 * "row 50, column b" → "There is no such row" — the 50th physical line was a
 * continuation of an earlier record). Shared by BOTH halves of the pipeline
 * (browser inline read in docProcessor, server extract in extract/index) so
 * the model sees the same row identity on every path: each logical RFC4180
 * record becomes ONE physical line with an explicit label —
 *
 *   Row 0 (header): "section","measure","note"
 *   Row 1: "…","…","…"
 *
 * The re-encoding is faithful: every record and field is preserved, embedded
 * newlines become a literal \n escape, quotes are doubled per RFC4180, and
 * text that is not parseable tabular data (unclosed quote) passes through
 * UNCHANGED — we never invent rows.
 */

/** True for the extensions whose extraction gets row labelling. */
export function isTabularName(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() || "";
  return ext === "csv" || ext === "tsv";
}

/**
 * RFC4180 parse: quoted fields, doubled quotes, embedded newlines, CRLF.
 * Returns null when the text cannot be a tabular file (unclosed quote), so
 * the caller can pass the original through untouched.
 */
export function parseDelimited(text: string, delim: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === "") { quoted = true; i += 1; continue; }
    if (c === '"') { field += '"'; i += 1; continue; } // lenient: mid-field quote stays literal
    if (c === delim) { endField(); i += 1; continue; }
    if (c === "\n") { endRow(); i += 1; continue; }
    if (c === "\r") { if (text[i + 1] === "\n") i += 1; endRow(); i += 1; continue; }
    field += c;
    i += 1;
  }
  if (quoted) return null; // unclosed quote — not safe to claim logical records
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Render one field for the labelled output: escapes embedded line breaks. */
function encodeField(value: string, delim: string): string {
  const escaped = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return '"' + escaped.replace(/"/g, '""') + '"';
}

/**
 * Annotate tabular text with row labels, one physical line per logical
 * record. Non-tabular names and unparseable input return the text unchanged.
 */
export function annotateCsvRecords(text: string, name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext !== "csv" && ext !== "tsv") return text;
  const rows = parseDelimited(text, ext === "tsv" ? "\t" : ",");
  if (!rows || rows.length < 2) return text; // header-only or unparseable: keep raw
  const delim = ext === "tsv" ? "\t" : ",";
  return rows
    .map((r, i) => `Row ${i}${i === 0 ? " (header)" : ""}: ${r.map(f => encodeField(f, delim)).join(delim)}`)
    .join("\n");
}
