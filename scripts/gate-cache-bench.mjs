/**
 * GATE WARM-CACHE BENCHMARK (brief: "Cache claims MUST be backed by
 * measurements on the actual backend").
 *
 * Measures what a tiny binary YES/NO gate call interleaved between chat
 * continuations costs on the ACTUAL deployed backend (single loaded model
 * service).  All numbers come from the engine's own telemetry:
 *   - usage.prompt_tokens_details.cached_tokens  (prefix the engine reused)
 *   - timings.prompt_n / prompt_ms / prompt_per_second  (newly-evaluated prompt)
 *   - /metrics requests[] reused / prompt_read / first_engine_token_s
 *     (before/after snapshots; requests_kept=500)
 * Client wall time is recorded too; queue interference shows as
 * wall - (prompt_ms + predicted_ms) >> 0.
 *
 * Arms per round (each round uses FRESH corpora so checkpoints start cold):
 *   A  chat(k) consecutively            — warm continuation baseline
 *   B  gate; chat(k) interleaved        — the gate's true cache cost
 *   D  ~2K unrelated prompt; chat(k)    — large-interloper ceiling
 *   F  two conversations interleaved    — multi-conversation thrash ceiling
 *   G  gate alone, alternating YES/NO   — gate's own cost + gate-gate reuse
 * Round 1 additionally serves as the labeled cold-start control.
 *
 * No app code is touched; the backend must already be running.
 * Usage: node scripts/gate-cache-bench.mjs [--rounds 3] [--levels 5] [--smoke]
 */

const BASE = process.env.LLM_API_URL || "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = "default";

// ── deterministic corpus (fixed bytes across runs; fresh TEXT per round) ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS =
  "the report region market growth quarter revenue hiring remote senior engineer product team demand growth salary range office commute weekly onsite hybrid policy update forecast analysts expect supply chain logistics warehouse fleet delivery route index value volume quarter outlook guidance revision notes earnings call transcript operator margin input costs pricing customer retention onboarding support ticket latency uptime incident review postmortem action items checklist".split(" ");

function sentence(rnd) {
  const n = 8 + Math.floor(rnd() * 8);
  const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(" ") + ".";
}
function block(seed, approxWords) {
  const rnd = mulberry32(seed);
  const out = [];
  let n = 0;
  while (n < approxWords) {
    const s = sentence(rnd);
    out.push(s);
    n += s.split(" ").length;
  }
  return out.join(" ");
}

// Byte-stable chat head (production answer-stage law: tools always present,
// byte-identical across YES/NO turns).
const SYS_CHAT =
  "You are a careful research assistant. Answer from evidence. " +
  block(1000, 400);
const TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the public web. Synthetic bench stub; never executed.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_page", description: "Read one public page. Synthetic bench stub; never executed.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

// Byte-stable gate head (production design: fixed tiny instruction as system,
// only the trailing user line varies).
const SYS_GATE =
  "Decide only whether answering the latest user request requires web research. " +
  "Reply with exactly YES or exactly NO. No other text, no punctuation.";
const GATE_LINES = [
  "What is the current version of Node.js?",
  "Summarize the attached meeting notes.",
  "Is the conference still accepting paper submissions?",
  "Translate this sentence into French.",
  "What flights are available next week?",
];

// ── request plumbing ──
async function completion(messages, { maxTokens = 8, tools = null, tag }) {
  const body = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } };
  if (tools) body.tools = tools;
  const t0 = Date.now();
  const ctrl = AbortSignal.timeout(180_000);
  try {
    const res = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl });
    const j = await res.json();
    const wall = Date.now() - t0;
    if (!j.usage) return { tag, error: JSON.stringify(j).slice(0, 200), wall };
    return {
      tag,
      prompt_n: j.usage.prompt_tokens,
      cached: j.usage.prompt_tokens_details?.cached_tokens ?? null,
      prompt_ms: j.timings?.prompt_ms ?? null,
      prompt_tps: j.timings?.prompt_per_second ?? null,
      pred_ms: j.timings?.predicted_ms ?? null,
      pred_tps: j.timings?.predicted_per_second ?? null,
      wall,
    };
  } catch (e) {
    return { tag, error: String(e?.message || e).slice(0, 200), wall: Date.now() - t0 };
  }
}
async function metricsSnapshot() {
  try {
    const m = await (await fetch("http://127.0.0.1:8080/metrics", { signal: AbortSignal.timeout(5000) })).json();
    return {
      conversation_cache: m.conversation_cache,
      totals: { requests: m.totals?.requests, prompt_tokens: m.totals?.prompt_tokens, reused: m.totals?.reused },
      hardware: { ram_used: m.hardware?.ram_used, ram_total: m.hardware?.ram_total, vram_free_mib: m.engine?.vram_free_mib },
      recent: (m.requests || []).slice(0, 60).map((r) => ({ id: r.id, prompt: r.prompt_tokens, reused: r.reused, read: r.prompt_read, ttft: r.first_engine_token_s, prompt_ms: r.prompt_ms })),
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function chatMessages(turns) {
  // turns: [user, assistant, user, assistant, ...]
  const msgs = [{ role: "system", content: SYS_CHAT }];
  for (const t of turns) msgs.push({ role: t.role, content: t.text });
  return msgs;
}

// ── per-round corpora ──
function corpora(round, levels, smoke) {
  const turnW = smoke ? 150 : 700; // ~1000 bench tokens/turn
  const mk = (seed) => Array.from({ length: levels }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: block(seed + i * 97, turnW),
  }));
  return {
    conv: mk(1000 + round * 1013),           // round-unique conversation corpus
    convP: mk(9000 + round * 2011),          // F: conversation P
    convQ: mk(15000 + round * 3019),         // F: conversation Q
    pollute: Array.from({ length: levels }, (_, i) => block(20000 + round * 4021 + i * 131, smoke ? 250 : 1500)),
  };
}

function fmt(rows) {
  const ok = rows.filter((r) => !r.error);
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const f = (x, d = 1) => (x == null ? "-" : typeof x === "number" ? x.toFixed(d) : String(x));
  const g = (fn) => med(ok.map(fn).filter((x) => x != null));
  return `n=${ok.length} prompt_n=${g((r) => r.prompt_n)} cached=${g((r) => r.cached)} re-read=${g((r) => r.prompt_n != null && r.cached != null ? r.prompt_n - r.cached : null)} prompt_ms=${f(g((r) => r.prompt_ms))} tps=${f(g((r) => r.prompt_tps), 0)} wall=${f(g((r) => r.wall))} err=${rows.length - ok.length}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? parseInt(argv[i + 1], 10) : d; };
  const smoke = argv.includes("--smoke");
  const rounds = smoke ? 1 : num("--rounds", 3);
  const levels = smoke ? 2 : num("--levels", 5);

  const health = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
  if (!health || !health.loaded) { console.error("backend not loaded at :8080 — refusing to run"); process.exit(1); }
  console.log(`backend: ${health.model} ctx=${health.max_context}; rounds=${rounds} levels=${levels}${smoke ? " (SMOKE)" : ""}`);

  const all = [];
  const before = await metricsSnapshot();
  const t0 = Date.now();

  for (let round = 1; round <= rounds; round++) {
    const C = corpora(round, levels, smoke);
    console.log(`\n== round ${round} (fresh corpora${round === 1 ? "; doubles as cold-start control" : ""}) ==`);

    // A: warm continuation baseline
    const A = [];
    for (let k = 1; k <= levels; k++) A.push(await completion(chatMessages(C.conv.slice(0, k)), { tools: TOOLS, tag: `A.r${round}.k${k}` }));
    all.push(...A); console.log(`A chat-sequential   ${fmt(A)}`);

    // B: gate interleaved (the design under test)
    const Bg = [], Bc = [];
    for (let k = 1; k <= levels; k++) {
      Bg.push(await completion([{ role: "system", content: SYS_GATE }, { role: "user", content: GATE_LINES[(k - 1) % GATE_LINES.length] }], { maxTokens: 2, tag: `B.gate.r${round}.k${k}` }));
      Bc.push(await completion(chatMessages(C.conv.slice(0, k)), { tools: TOOLS, tag: `B.chat.r${round}.k${k}` }));
    }
    all.push(...Bg, ...Bc);
    console.log(`B gate+chat interleave  gate ${fmt(Bg)}\n                          chat ${fmt(Bc)}`);

    // G: gate alone alternating YES/NO lines — its own cost + gate-gate reuse
    const Gg = [];
    for (let k = 1; k <= levels; k++) {
      Gg.push(await completion([{ role: "system", content: SYS_GATE }, { role: "user", content: GATE_LINES[(k + 2) % GATE_LINES.length] }], { maxTokens: 2, tag: `G.gate.r${round}.k${k}` }));
      // between gates, push one chat continuation so each gate follows chat state
      if (k < levels) all.push(await completion(chatMessages(C.conv.slice(0, 1)), { tools: TOOLS, tag: `G.pad.r${round}.k${k}` }));
    }
    all.push(...Gg); console.log(`G gate-after-chat     ${fmt(Gg)}`);

    // D: large unrelated interloper (ceiling reference)
    const Dp = [], Dc = [];
    for (let k = 1; k <= levels; k++) {
      Dp.push(await completion([{ role: "user", content: C.pollute[k - 1] + "\nSummarize in ten words." }], { tag: `D.poll.r${round}.k${k}` }));
      Dc.push(await completion(chatMessages(C.conv.slice(0, k)), { tools: TOOLS, tag: `D.chat.r${round}.k${k}` }));
    }
    all.push(...Dp, ...Dc);
    console.log(`D interloper+chat     pollute ${fmt(Dp)}\n                          chat ${fmt(Dc)}`);

    // F: two conversations interleaved turn-by-turn (thrash ceiling)
    const F = [];
    for (let k = 1; k <= levels; k++) {
      F.push(await completion(chatMessages(C.convP.slice(0, k)), { tools: TOOLS, tag: `F.P.r${round}.k${k}` }));
      F.push(await completion(chatMessages(C.convQ.slice(0, k)), { tools: TOOLS, tag: `F.Q.r${round}.k${k}` }));
    }
    all.push(...F); console.log(`F two-conversation    ${fmt(F)}`);
  }

  const after = await metricsSnapshot();
  const out = {
    when: new Date().toISOString(),
    backend: health,
    settings: { rounds, levels, smoke, model: MODEL, base: BASE },
    before, after,
    wall_total_s: ((Date.now() - t0) / 1000).toFixed(1),
    requests: all,
  };
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = `${os.tmpdir()}\\gate-cache-bench-${Date.now()}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 1));
  console.log(`\nfull results: ${path}  (${out.wall_total_s}s wall)`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
