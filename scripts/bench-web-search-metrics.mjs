#!/usr/bin/env node
/**
 * bench-web-search-metrics.mjs — §11.26 BEFORE/AFTER web-search turn benchmark
 * driver (P7 deliverable). This is NOT a Playwright tool: it POSTs live chat
 * turns through the RUNNING dev server's /api/chat progress path and records
 * client-side wall-clock deltas for the §11.26 timeline landmarks, the
 * server-reported per-stage `ms` from ruke_stage frames, and the counters the
 * §11.26 record requires (queries, citations, passages/evidence packets).
 *
 * Usage:
 *   node scripts/bench-web-search-metrics.mjs --base http://localhost:3000 \
 *     [--model <id>] [--label after] [--out bench-after.json] [--runs 2]
 *
 * Landmarks (client-side ms since request send):
 *   decision_ms        first "decision_done" stage frame
 *   gate_ms            first "web:gate" frame (P2-era builds may lack it; null then)
 *   planning_ms        first "web:planning" frame
 *   first_search_ms    first "web:searching" frame
 *   candidate_ready_ms web:searching detail/frame completion proxy (first
 *                      "web:reading" frame = candidates ready to read)
 *   first_page_ms      first "web:reading" frame
 *   first_evidence_ms  first web:reading progress frame carrying >=1 kept passage
 *   evidence_sufficient_ms first "web:reranking" frame (coverage decision done)
 *   answer_first_token_ms  first upstream content delta
 *   total_ms           "[DONE]" arrival
 * Counters come from the web_meta frame (citations, gate queries) and the
 * web:done detail (passages). Full per-run frame transcripts are kept raw.
 */
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const MODEL = arg("model", "qwen3.8-flash-next-iq3_s");
const LABEL = arg("label", "run");
const OUT = arg("out", `bench-${LABEL}.json`);
const RUNS = Math.max(1, parseInt(arg("runs", "2"), 10) || 2);
const WARMUP = "hello";

// §11.26 benchmark prompts: live-web intents whose evidence (not model
// creativity) dominates the timeline. Kept tiny so upstream generation time
// is small relative to retrieval time on BOTH builds.
// Prompt set A — identical set replayed cold (cache wiped) against BOTH
// builds, so per-turn comparability holds. (Turn totals run 60-180s each:
// the LOCAL model's evidence-grounded answer generation dominates total_ms;
// retrieval landmarks are the comparable part.)
const PROMPTS = [
  "latest release notes for postgres",
  "weather in london today",
  "typescript latest version announcement",
  "when was the first qwen model released",
];

// stream:true = the production UI path (Rust ruke-server emits stage frames +
// streamed deltas + [DONE]; without it ruke-server answers one JSON blob).
const WARM = { model: MODEL, stream: true, messages: [{ role: "user", content: WARMUP }] };

async function warmup() {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(WARM),
  });
  // Drain to let Next JIT-compile the route + the web pipeline modules.
  const reader = res.body.getReader();
  while (!(await reader.read()).done) { /* drain */ }
}

function makeOnLine(state) {
  return (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    const now = Date.now() - state.t0;
    if (data === "[DONE]") { state.total_ms = now; return; }
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (obj && typeof obj === "object" && "ruke_stage" in obj) {
      const st = obj.ruke_stage || {};
      const name = String(st.stage ?? "");
      state.frames.push({ at_ms: now, stage: name, ms: st.ms, detail: st.detail ?? st.progress ?? null });
      const first = (k, v) => { if (state.landmarks[k] === undefined) state.landmarks[k] = v; };
      if (name === "decision_done") first("decision_ms", now);
      if (name === "web:gate") first("gate_ms", now);
      if (name === "web:planning") first("planning_ms", now);
      if (name === "web:searching") first("first_search_ms", now);
      if (name === "web:reading") {
        first("candidate_ready_ms", now);
        first("first_page_ms", now);
      }
      if (name === "web:reading_progress" || (name === "web:reading" && /progress|\d+\s*\/\s*\d+/.test(String(st.detail ?? "")))) {
        first("first_evidence_ms", now);
      }
      if (name === "web:reranking") first("evidence_sufficient_ms", now);
      if (name === "web:done") {
        const m = String(st.detail ?? "").match(/(\d+)\s+passages?/i);
        if (m) state.counters.evidence_packets = parseInt(m[1], 10);
      }
      if (name === "web_meta") {
        const cits = st.webCitations || {};
        state.counters.citations = Object.keys(cits).length;
        const q = st.searchGate && Array.isArray(st.searchGate.queries) ? st.searchGate.queries.length : 0;
        state.counters.queries_completed = q;
        state.counters.candidates = st.searchGate && st.searchGate.candidates != null ? st.searchGate.candidates : state.counters.candidates;
      }
      return;
    }
    if (obj && typeof obj === "object" && Array.isArray(obj.choices)) {
      const c = obj.choices[0] || {};
      const d = (c.delta && c.delta.content) ?? (c.message && c.message.content);
      if (typeof d === "string" && d.length > 0 && state.landmarks.answer_first_token_ms === undefined) {
        state.landmarks.answer_first_token_ms = now;
      }
    }
  };
}

async function runOnce(prompt, idx) {
  const state = {
    t0: 0, landmarks: {}, counters: { citations: 0, queries_completed: 0 }, frames: [],
    total_ms: null,
  };
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  state.t0 = Date.now();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const onLine = makeOnLine(state);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line.trim());
    }
  }
  if (buf.trim()) onLine(buf.trim());
  return { run: idx, status: res.status, prompt, ...state, frames: undefined, framesCount: state.frames.length, frames: state.frames };
}

const fs = await import("node:fs");
const out = { label: LABEL, base: BASE, model: MODEL, started: new Date().toISOString(), gitHead: (await import("node:child_process")).execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(), runs: [] };
await warmup();
for (const prompt of PROMPTS) {
  for (let r = 1; r <= RUNS; r++) {
    const run = await runOnce(prompt, r);
    out.runs.push(run);
    // Incremental persistence: partial results survive interruption.
    fs.appendFileSync(`${OUT}.partial.ndjson`, JSON.stringify(run) + "\n");
    const L = run.landmarks;
    console.log(`[${LABEL}] "${prompt.slice(0, 40)}" run${r}: decision=${L.decision_ms ?? "-"} planning=${L.planning_ms ?? "-"} search=${L.first_search_ms ?? "-"} firstPage=${L.first_page_ms ?? "-"} rerank=${L.evidence_sufficient_ms ?? "-"} firstToken=${L.answer_first_token_ms ?? "-"} total=${run.total_ms ?? "-"} citations=${run.counters.citations} packets=${run.counters.evidence_packets ?? "-"}`);
  }
}
out.finished = new Date().toISOString();
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT}`);
