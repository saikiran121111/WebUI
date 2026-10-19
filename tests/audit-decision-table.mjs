#!/usr/bin/env node
/**
 * Architectural audit probe — prints a full Markdown table of every decision:
 * prompt, final mode, confidence, decided_by, per-stage latency, and the FULL
 * model-generated stripped_prompt (no truncation). Includes:
 *   - the 9 canonical mode prompts
 *   - the excel-vs-3D/CAD collision stress prompt
 *   - a detail-preservation probe (numbers, SUMIFS, hex colors must survive)
 *   - a multi-turn follow-up probe (turn 2 pronoun-only must stay 3d_asset)
 * Needle priors are NOT in the envelope — read them from the worker log
 * ([decision] ... prior=[...]@conf) after the run.
 */
const BASE = (process.env.DECISION_ENGINE_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");

const CASES = [
  ["excel", "Build a 500-row financial transaction tracker with SUMIFS budget alerts and dashboard KPIs"],
  ["3d_asset", "Create a spinning sci-fi energy core logo with glowing rings"],
  ["cad_blueprint", "Design a 2-story residential floor plan with structural wall dimensions and plumbing layout"],
  ["docs", "Write a formal project handover document with sign-off tables"],
  ["pdf", "Export a printable invoice receipt with tax breakdown"],
  ["ppt", "Make a 10-slide pitch deck for our Q4 AI roadmap"],
  ["chart", "Plot a bar chart comparing monthly latency"],
  ["html_render", "Build a responsive pricing page component with dark mode toggle"],
  ["standard_chat", "Explain why my React useEffect hook is firing twice"],
  ["excel", "Build a 500-row Excel budget sheet and explain how 3D CAD rendering models work in the notes column"],
  ["excel", "Build a 500-row Excel budget sheet with columns Date, Vendor, Amount; use SUMIFS over column C to flag rows over $1,250 in red (#FF0000), add a KPI dashboard tab with a pie chart, and freeze the header row"],
];

const MULTI_TURN = {
  message: "Make the outer ring spin faster and change it to red",
  conversationHistory: [
    { role: "user", content: "Create a sci-fi energy core logo with glowing rings" },
    { role: "assistant", content: "Here is your core:\n\n```scene3d\n{\"name\":\"energy-core\",\"rings\":[{\"radius\":2.4,\"spin\":0.4,\"color\":\"#39c5ff\"}]}\n```" },
  ],
};

async function decide(message, conversationHistory = []) {
  const res = await fetch(BASE + "/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationHistory }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}

const rows = [];
for (const [want, prompt] of CASES) {
  const env = await decide(prompt);
  rows.push({ want, prompt, env });
}
const mt = await decide(MULTI_TURN.message, MULTI_TURN.conversationHistory);

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
console.log("\n| # | Prompt | Final mode (want) | Conf | decided_by | Needle ms | LFM ms | stripped_prompt |");
console.log("|---|--------|-------------------|------|------------|-----------|--------|-----------------|");
rows.forEach((r, i) => {
  console.log(`| ${i + 1} | ${esc(r.prompt)} | ${r.env.active_mode} (${r.want})${r.env.active_mode === r.want ? " ✅" : " ❌"} | ${r.env.confidence} | ${r.env.decided_by} | ${r.env.needle_latency_ms} | ${r.env.lfm_latency_ms} | ${esc(r.env.stripped_prompt)} |`);
});
console.log(`| 12 | [multi-turn] "Make the outer ring spin faster and change it to red" (history: turn-1 sci-fi core, scene3d fence) | ${mt.active_mode} (3d_asset)${mt.active_mode === "3d_asset" ? " ✅" : " ❌"} | ${mt.confidence} | ${mt.decided_by} | ${mt.needle_latency_ms} | ${mt.lfm_latency_ms} | ${esc(mt.stripped_prompt)} |`);

// Detail-preservation check on case 11: every hard token must survive the
// strip. Checked against the END-TO-END forwarded view — stripped_prompt plus
// the Required Specs constraints the chat route appends (app/api/chat/route.ts)
// — which is exactly what the main LLM sees.
const keep = ["500", "Date", "Vendor", "Amount", "SUMIFS", "1,250", "#FF0000", "KPI", "pie", "freeze"];
const forwarded11 = (rows[10].env.stripped_prompt ?? "") + " " + (rows[10].env.task_constraints ?? []).join(" ");
const lost = keep.filter((t) => !forwarded11.includes(t));
console.log("\nDetail-preservation (case 11): " + (lost.length ? "LOST -> " + lost.join(", ") : "ALL 10 hard tokens preserved ✅"));
