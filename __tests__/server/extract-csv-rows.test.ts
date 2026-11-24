/**
 * F63 — CSV row addressing.
 *
 * A quoted field containing a newline makes PHYSICAL lines diverge from
 * LOGICAL records: asking the model for "data row 50, column b" of
 * quoted-multiline.csv returned "There is no such row" because the raw text it
 * received counted physical lines (fr-20261122b, fr-T3). The law under test:
 *  - tabular text (csv/tsv) is re-encoded into ONE physical line per logical
 *    record, with an explicit row label, across quoted newlines, escaped
 *    quotes and CRLF (shared module lib/files/csv-records.ts, used by BOTH
 *    the browser inline path and the server extract path);
 *  - the re-encoding is faithful: every record and field survives, embedded
 *    newlines are escaped (literal \n), and malformed input (unclosed quote)
 *    passes through UNCHANGED — no invented rows;
 *  - row/column identity survives index chunking (record never split across
 *    chunks);
 *  - a CSV the size of the live fixture (18 KB ≤ 48000) takes the browser
 *    path, so the shared annotator must be exercised there too.
 * Offline: ATTACH_EMBED=off — lexical indexing, no model, slot untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractFileFromPath } from "@/lib/server/extract/index";
import { removeIndex, readIndex } from "@/lib/server/attachindex/store";
import { processAttachment, validateAttachment } from "@/lib/files/docProcessor";

const ATT = "att_f63csv01";
let dir: string;

function scratch(name: string, text: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, "utf8");
  return p;
}

/** RFC4180 render: every field quoted, CRLF line endings, trailing newline. */
function csv(rows: string[][]): string {
  return rows.map(r => r.map(f => `"${f.replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}

/** The live fixture's shape: header + 100 data rows; data row 50 column b
 *  (0-indexed field 1) carries the embedded-newline key cell. */
function keyCsv(): string {
  const rows: string[][] = [["section", "measure", "note"]];
  for (let i = 1; i <= 100; i++) {
    rows.push(
      i === 50
        ? [`Staff and pay costs ${i}`, "Average cost per FTE \n / £", "S1.2a"]
        : [`Section ${i}`, `value ${i}`, "note"],
    );
  }
  return csv(rows);
}

/** Every physical line of `text` that carries a Row label, as [label, line]. */
function rowLines(text: string | undefined): Map<string, string> {
  if (text === undefined) throw new Error("extract returned no text");
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^Row (\d+)(?: \(header\))?: /.exec(line);
    if (m) out.set(m[1], line);
  }
  return out;
}

const PREV_EMBED = process.env.ATTACH_EMBED;

beforeAll(() => {
  process.env.ATTACH_EMBED = "off";
  dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f63csv_"));
  removeIndex(ATT);
});

afterAll(() => {
  removeIndex(ATT);
  fs.rmSync(dir, { recursive: true, force: true });
  if (PREV_EMBED === undefined) delete process.env.ATTACH_EMBED;
  else process.env.ATTACH_EMBED = PREV_EMBED;
});

describe("server extract path: logical CSV records address by row label", () => {
  it("data row 50 column b (embedded newline) is one labelled physical line (F63 repro)", async () => {
    const p = scratch("quoted-multiline.csv", keyCsv());
    const res = await extractFileFromPath("quoted-multiline.csv", p);
    expect(res.category).toBe("text");
    const lines = rowLines(res.text);
    // Header is row 0; the 50th DATA row is labelled Row 50.
    expect(lines.get("0"), "header label").toContain("section");
    const key = lines.get("50");
    expect(key, "Row 50 label exists").toBeDefined();
    // One physical line carries the whole logical record: the embedded
    // newline inside the quoted field is escaped, not a real line break.
    expect(key).toContain('"Average cost per FTE \\n / £"');
    expect(key).not.toContain("\r");
    // All 100 data rows present, so physical and logical counts agree.
    expect(lines.size).toBe(101);
  });

  it("an unseen multiline CSV keeps every record and field (independent count)", async () => {
    // 40 logical records, 9 of them spanning multiple physical lines,
    // embedded commas, doubled quotes, LF endings, no trailing newline.
    const rows: string[][] = [["id", "desc", "qty"]];
    for (let i = 1; i <= 39; i++) {
      const multiline = i % 4 === 1;
      rows.push([
        `D${i}`,
        multiline ? `line one,\nsecond "quoted" part` : `plain ${i}`,
        String(i),
      ]);
    }
    const text = rows.map(r => r.map(f => `"${f.replace(/"/g, '""')}"`).join(",")).join("\n");
    const physical = text.split("\n").length;
    expect(physical).toBeGreaterThan(40); // multiline fields present
    const p = scratch("unseen-multiline.csv", text);
    const res = await extractFileFromPath("unseen-multiline.csv", p);
    const lines = rowLines(res.text);
    expect(lines.size).toBe(40); // logical, not physical
    expect(lines.get("5")).toContain('"line one,\\nsecond ""quoted"" part"');
    expect(lines.get("39")).toContain('"D39","plain 39","39"');
  });

  it("malformed tabular text (unclosed quote) passes through UNCHANGED", async () => {
    const broken = 'a,b\n"unclosed,real value\nnext,row\n';
    const p = scratch("broken.csv", broken);
    const res = await extractFileFromPath("broken.csv", p);
    expect(res.text).toBe(broken.replace(/\r\n/g, "\n").trim());
    expect(res.text).not.toContain("Row 0");
  });

  it("tsv is annotated too; plain .txt is never touched", async () => {
    const tsv = "id\tmeas\n1\tx\n2\ty\n";
    const p1 = scratch("grid.tsv", tsv);
    const r1 = await extractFileFromPath("grid.tsv", p1);
    expect(rowLines(r1.text).get("1")).toContain('"1"\t"x"'); // stays tab-delimited
    const p2 = scratch("notes.txt", "a,b\nline one\nline two\n");
    const r2 = await extractFileFromPath("notes.txt", p2);
    expect(r2.text).toBe("a,b\nline one\nline two");
  });
});

describe("browser inline path annotates identically (the live fixture size)", () => {
  it("an 18 KB CSV read in the browser carries the same Row 50 label", async () => {
    // The live fixture is ~18 KB — under the 48000 inline limit, so fr-T3
    // took the BROWSER path. Row labels must be identical on both paths.
    const text = keyCsv();
    expect(text.length).toBeLessThan(48000);
    const file = new File([text], "quoted-multiline.csv", { type: "text/csv" });
    const att = await processAttachment(file, validateAttachment(file));
    expect(att.status).toBe("ready");
    const server = rowLines((await extractFileFromPath("quoted-multiline.csv", scratch("mirror.csv", text))).text);
    const browser = rowLines(att.text || "");
    expect(browser.get("50")).toBeDefined();
    expect(browser.get("50")).toBe(server.get("50"));
    expect(browser.get("50")).toContain('"Average cost per FTE \\n / £"');
  });
});

describe("row identity survives index chunking (indexed CSV)", () => {
  it("no chunk splits a logical record; the key row is whole in one chunk", async () => {
    // Large enough to index (> 48000 chars) and deliberately adversarial for
    // the sentence-splitting chunker: fields contain ". " so a line-based
    // prose chunker WOULD split records mid-field.
    const rows: string[][] = [["id", "desc", "qty"]];
    for (let i = 1; i <= 1200; i++) {
      rows.push([`S${i}`, i === 640
        ? "Average cost per FTE \n / £. Ends here. Next sentence."
        : `filler ${i} of the long record. With a period. And more prose to widen it.`, "7"]);
    }
    const p = scratch("big.csv", csv(rows));
    const res = await extractFileFromPath("big.csv", p, ATT);
    expect(res.indexed).toBe(true);
    const idx = readIndex(ATT);
    expect(idx).not.toBeNull();
    const recordLine = /^Row \d+( \(header\))?: "/;
    for (const chunk of idx!.chunks) {
      for (const line of chunk.text.split("\n")) {
        if (!line.trim()) continue;
        expect(line, "chunk boundary splits a record").toMatch(recordLine);
      }
    }
    const all = idx!.chunks.map(c => c.text).join("\n");
    expect(all).toContain('"Average cost per FTE \\n / £. Ends here. Next sentence."');
  });
});
