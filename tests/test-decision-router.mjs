#!/usr/bin/env node
/**
 * Decision Engine router test — the 9 canonical prompts, one per RendererMode,
 * plus an ambiguous multi-intent stress prompt. Runs against the project-local
 * worker (default http://127.0.0.1:8790, override with DECISION_ENGINE_URL).
 * Verifies for every envelope:
 *   - exact active_mode
 *   - non-empty stripped_prompt
 *   - decided_by === "needle3+lfm2.5" (LFM2.5 ALWAYS decides + strips — the
 *     Needle-confidence skip is gone; zero rule-based stripping)
 *   - enable_validator === active_mode
 *   - disable_validators === exact complement (all 8 other modes)
 *   - skill_to_load / allowed_code_fence match the mode table
 * Exits non-zero on any failure.
 */
const BASE = (process.env.DECISION_ENGINE_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");

const MODES = [
  "excel", "docs", "pdf", "ppt", "3d_asset", "cad_blueprint", "chart", "html_render", "standard_chat",
];

// mode -> [prompt, skill_to_load, allowed_code_fence]
const CASES = [
  ["excel", "Build a 500-row financial transaction tracker with SUMIFS budget alerts and dashboard KPIs", "xlsx", "xlsx"],
  ["3d_asset", "Create a spinning sci-fi energy core logo with glowing rings", "threejs-skills", "scene3d"],
  ["cad_blueprint", "Design a 2-story residential floor plan with structural wall dimensions and plumbing layout", "archify", "cad"],
  ["docs", "Write a formal project handover document with sign-off tables", "docx", "docx"],
  ["pdf", "Export a printable invoice receipt with tax breakdown", "pdf", "html"],
  ["ppt", "Make a 10-slide pitch deck for our Q4 AI roadmap", "pptx", "pptx"],
  ["chart", "Plot a bar chart comparing monthly latency", null, "chart"],
  ["html_render", "Build a responsive pricing page component with dark mode toggle", "html-viewer", "html"],
  ["standard_chat", "Explain why my React useEffect hook is firing twice", null, null],
  // Ambiguous multi-intent stress: two deliverables in one sentence — the
  // PRIMARY artifact (the budget sheet) must win; the 3D mention rides along
  // in a note column and must NOT flip the mode or enable 3D validators.
  ["excel", "Build an Excel budget sheet and explain how 3D rendering pipelines work in a note column", "xlsx", "xlsx"],
  // Harder collision: the explanation names 3D + CAD + rendering + models — the
  // three words that would light up every 3D/CAD validator in a naive pipeline.
  ["excel", "Build a 500-row Excel budget sheet and explain how 3D CAD rendering models work in the notes column", "xlsx", "xlsx"],
];

let failures = 0;
const rows = [];

for (const [mode, prompt, skill, fence] of CASES) {
  let env, error = null;
  try {
    const res = await fetch(BASE + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt, conversationHistory: [] }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    env = await res.json();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const problems = [];
  if (error) {
    problems.push("request failed: " + error);
  } else {
    if (env.active_mode !== mode) problems.push(`active_mode=${env.active_mode} (want ${mode})`);
    if (env.decided_by !== "needle3+lfm2.5") problems.push(`decided_by=${env.decided_by} (want needle3+lfm2.5 — LFM must always run)`);
    if (!env.stripped_prompt || !env.stripped_prompt.trim()) problems.push("stripped_prompt empty");
    if (env.enable_validator !== env.active_mode) problems.push(`enable_validator=${env.enable_validator}`);
    const wantDisabled = MODES.filter((m) => m !== mode).sort().join(",");
    const gotDisabled = [...(env.disable_validators ?? [])].sort().join(",");
    if (gotDisabled !== wantDisabled) problems.push(`disable_validators=[${gotDisabled}] (want all 8 others)`);
    if ((env.skill_to_load ?? null) !== skill) problems.push(`skill_to_load=${env.skill_to_load} (want ${skill})`);
    if ((env.allowed_code_fence ?? null) !== fence) problems.push(`allowed_code_fence=${env.allowed_code_fence} (want ${fence})`);
    if (typeof env.confidence !== "number" || env.confidence < 0 || env.confidence > 1) problems.push(`confidence=${env.confidence}`);
  }

  if (problems.length) failures++;
  rows.push({
    status: problems.length ? "FAIL" : "PASS",
    mode,
    decided_by: env?.decided_by ?? "-",
    conf: env ? env.confidence.toFixed(2) : "-",
    needle_ms: env?.needle_latency_ms ?? "-",
    lfm_ms: env?.lfm_latency_ms ?? "-",
    stripped: env ? (env.stripped_prompt.length > 46 ? env.stripped_prompt.slice(0, 43) + "..." : env.stripped_prompt) : "-",
    problems: problems.join("; "),
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\nDecision Engine router — 9 modes + multi-intent stress @ " + BASE + "\n");
console.log(pad("STATUS", 7) + pad("MODE", 14) + pad("DECIDED_BY", 17) + pad("CONF", 6) + pad("NEEDLEms", 9) + pad("LFMms", 7) + "STRIPPED_PROMPT");
console.log("-".repeat(110));
for (const r of rows) {
  console.log(pad(r.status, 7) + pad(r.mode, 14) + pad(r.decided_by, 17) + pad(r.conf, 6) + pad(r.needle_ms, 9) + pad(r.lfm_ms, 7) + r.stripped);
  if (r.problems) console.log("        ↳ " + r.problems);
}
console.log("-".repeat(110));
console.log(`${CASES.length - failures}/${CASES.length} modes routed correctly` + (failures ? ` — ${failures} FAILED` : " — ALL PASS"));
process.exit(failures ? 1 : 0);
