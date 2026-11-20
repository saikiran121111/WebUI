/**
 * F06 integrated probe: POST the F06 fixtures through the REAL production route
 * (app/api/files/extract/route.ts -> lib/server/extract -> documents.parse capability
 * job over the Rust ml_job bridge -> Python supervisor) and print what the browser
 * would actually receive: engine provenance, per-unit coverage, and whether the
 * answer-bearing content came back.
 *
 * Run while `npm run dev` is up, from the repo root:
 *   node docs/overnight/probes/f06_http_probe.mjs
 * Writes the raw JSON responses to docs/overnight/logs/f06-http-<name>.json.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RUKE_BASE ?? "http://localhost:3000";
const FILES = ["f06-review.pdf", "f06-sheet.xlsx", "f06-notes.docx"];
const SRC = path.join(".data", "tmp", "f06");
const OUT = path.join("docs", "overnight", "logs");

for (const name of FILES) {
  const file = path.join(SRC, name);
  const bytes = fs.readFileSync(file);
  // No `att=` parameter on purpose: without an attachment id nothing is written to the
  // user's durable upload store or knowledge index, so the probe cannot contaminate real
  // conversations/uploads. The durable-store path itself is covered by __tests__/server.
  const url = `${BASE}/api/files/extract?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } });
  const text = await res.text();
  fs.writeFileSync(path.join(OUT, `f06-http-${name}.json`), text, "utf8");
  console.log("=".repeat(78));
  console.log(`${name}: HTTP ${res.status}  body ${text.length} bytes`);
  let j;
  try { j = JSON.parse(text); } catch { console.log("  non-JSON body:", text.slice(0, 300)); continue; }
  if (j.error) { console.log("  ERROR:", j.error); continue; }
  console.log("  category:", j.category, "pages:", j.pages, "truncated:", j.truncated);
  console.log("  coverageNote:", j.coverageNote ?? "(none)");
  console.log("  readUnits:", JSON.stringify(j.readUnits), "unreadUnits:", JSON.stringify(j.unreadUnits));
  console.log("  unitEngines:", JSON.stringify(j.unitEngines ?? j.engines ?? null));
  const body = j.text ?? "";
  console.log("  textLength:", body.length);
  for (const [probe, label] of [
    ["Ridgeway corridor was suspended", "late evidence on the last PDF page"],
    ["PAGE SIX", "last-page header survived"],
    ["PAGE 4 rotated", "rotated page text survived"],
    ["RIGHT COLUMN page 2", "second column text survived"],
    ["merged title", "merged xlsx title cell"],
    ["SUM(B4:B5)", "xlsx formula text"],
    ["cached 20", "xlsx cached formula value"],
    ["Payments | Ana", "docx table row 1 grouping"],
    ["Ledger | 99.9", "docx table row 2 grouping (second table)"],
  ]) {
    console.log(`  probe ${label}: ${body.includes(probe)}`);
  }
  console.log("  engine mentions:", [...new Set(body.match(/python-[a-z0-9.\-/]+|pypdf[0-9.]*|ooxml[a-z\-]*|unpdf|pdf\.js/gi) || [])].join(", ") || "(none)");
}
