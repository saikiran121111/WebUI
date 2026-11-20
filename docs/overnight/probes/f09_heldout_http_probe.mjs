/**
 * F12 held-out HTTP scorer: POST every held-out fixture through the REAL production route
 * (app/api/files/extract -> lib/server/extract -> documents.parse capability job over the Rust
 * ml_job bridge -> Python supervisor) and score what the browser would actually receive against
 * the independent answer key in docs/overnight/fixtures/f09/answer-key.json.
 *
 * Why this probe exists: python-backend/tests/test_heldout_readers.py can only see the reader.
 * Coverage notes, engine provenance and body promotion are DELIVERY-layer properties, so the two
 * keys "coverage_must_any" and "accept_any_of" are scored only here. The HTTP score cannot pass a
 * fact the reader did not deliver, because it searches the delivered body string itself.
 *
 * Run while `npm run dev` is up, from the repo root:
 *   node docs/overnight/probes/f09_heldout_http_probe.mjs [name ...]
 * Writes docs/overnight/logs/f09-heldout-<utc>.json and exits non-zero on any miss.
 *
 * Scoring rules (fixed BEFORE the first run against these fixtures, D-037):
 *   - whitespace runs collapse to one space (PDF text layers re-flow spacing); token order and
 *     exact tokens are still required, so a paraphrase or a lost word is a miss.
 *   - "must" and "must_not" are scored against the delivered BODY.
 *   - "coverage_must_any" is scored against the delivered coverageNote (any one string matches).
 *   - "accept_any_of" is an OR of groups; a group is satisfied only when EVERY string in it is
 *     present, in body or coverageNote. It exists for honestly-refused inputs, where the exact
 *     refusal wording is a delivery choice but the reported condition is not.
 * No fixture fact and no refusal condition is relaxed by this probe: a miss is a miss.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RUKE_BASE ?? "http://localhost:3000";
const KEY = path.join("docs", "overnight", "fixtures", "f09", "answer-key.json");
const SRC = path.join(".data", "tmp", "f09-heldout");
const OUT = path.join("docs", "overnight", "logs");
const only = process.argv.slice(2);

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const key = JSON.parse(fs.readFileSync(KEY, "utf8"));
const results = [];
let misses = 0;

for (const [name, spec] of Object.entries(key.files)) {
  if (only.length && !only.includes(name)) continue;
  const file = path.join(SRC, name);
  if (!fs.existsSync(file)) {
    console.log(`${name}: MISSING FIXTURE ${file} - regenerate with docs/overnight/fixtures/f09/ho_docs.py`);
    misses++;
    results.push({ name, error: "fixture missing", ok: false });
    continue;
  }
  const bytes = fs.readFileSync(file);
  const res = await fetch(`${BASE}/api/files/extract?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
  });
  const raw = await res.text();
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch {
    /* non-JSON response is itself a finding, recorded below */
  }
  const body = collapse(j?.text ?? "");
  const note = collapse(j?.coverageNote ?? "");
  const err = j?.error ?? (raw.trim() && !j ? `non-json: ${collapse(raw).slice(0, 160)}` : "");
  const http = spec.http ?? {};
  const checks = [];

  for (const s of http.must ?? []) {
    const want = collapse(s);
    checks.push({ kind: "must", needle: want, ok: body.includes(want) });
  }
  for (const s of http.must_not ?? []) {
    const want = collapse(s);
    checks.push({ kind: "must_not", needle: want, ok: !body.includes(want) && !note.includes(want) });
  }
  if (http.coverage_must_any?.length) {
    const hit = http.coverage_must_any.map(collapse).find((s) => note.includes(s) || body.includes(s));
    checks.push({
      kind: "coverage_must_any",
      needle: http.coverage_must_any.join(" || "),
      ok: Boolean(hit),
      matched: hit ?? null,
    });
  }
  // "accept_any_of" is ONE clause: an OR over groups, where a group is an AND. Counting each
  // non-matching group as a separate miss contradicted the key's own declared semantics
  // (line 21 above) and turned a fixture that satisfied an accepted honest wording into a
  // failure. Fixing the SCORING does not relax the clause: every group is still evaluated,
  // printed and stored, and a clause with no satisfied group is still a miss.
  const groups = (http.accept_any_of ?? []).map((group) => {
    const parts = group.map(collapse);
    return { needle: parts.join(" + "), ok: parts.every((p) => body.includes(p) || note.includes(p)) };
  });
  if (groups.length) {
    const hit = groups.find((g) => g.ok);
    checks.push({
      kind: "accept_any_of",
      needle: groups.map((g) => g.needle).join(" || "),
      ok: Boolean(hit),
      matched: hit?.needle ?? null,
      groups,
    });
  }
  const failed = checks.filter((c) => !c.ok);
  // For a fixture whose content expectations are empty, an honest refusal is scored through
  // accept_any_of only; a hard error with no accepted group is still a miss.
  const ok = failed.length === 0;
  misses += failed.length;
  results.push({
    name,
    ok,
    http_status: res.status,
    error: err,
    category: j?.category ?? null,
    pages: j?.pages ?? null,
    truncated: j?.truncated ?? null,
    body_chars: body.length,
    coverageNote: note,
    checks,
    body,
  });

  console.log("=".repeat(78));
  console.log(`${name}: HTTP ${res.status} ok=${ok} category=${j?.category ?? "-"} body=${body.length} chars${err ? ` error=${err}` : ""}`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "MISS"} ${c.kind}: ${c.needle}${c.matched ? ` [matched: ${c.matched}]` : ""}`);
  }
  if (failed.length) {
    console.log(`  delivered coverageNote: ${note.slice(0, 500)}`);
    console.log(`  delivered body head: ${body.slice(0, 500)}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "");
fs.writeFileSync(path.join(OUT, `f09-heldout-${stamp}.json`), JSON.stringify({ key_version: key.version, results }, null, 2), "utf8");
console.log("=".repeat(78));
console.log(`scored ${results.length} fixture(s), ${misses} miss(es); evidence -> docs/overnight/logs/f09-heldout-${stamp}.json`);
if (misses) {
  for (const r of results) {
    for (const c of (r.checks ?? []).filter((x) => !x.ok)) {
      console.log(`MISS ${r.name} ${c.kind}: ${c.needle}`);
    }
  }
}
process.exit(misses ? 1 : 0);
