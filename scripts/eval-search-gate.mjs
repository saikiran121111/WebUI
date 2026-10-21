/**
 * Search-gate scenario eval.
 *
 * Measures how the two candidate authorities behave over labeled scenarios:
 *   A) LFM2.5-1.2B router (:8791) — the current Stage-1 single-boolean gate.
 *   B) Main model (:8080) — the proposed authoritative gate that decides
 *      search-vs-no-search AND generates the queries itself.
 *
 * Run:  node scripts/eval-search-gate.mjs [--main-only] [--lfm-only] [--only=<substring>]
 * Reads no secrets; endpoints come from env with the same defaults as the app.
 */

const FAST_ENDPOINT = process.env.WEB_SEARCH_LFM_FAST_ENDPOINT ?? "http://127.0.0.1:8791/v1/chat/completions";
const LLM_ENDPOINT = process.env.LLM_API_URL ?? "http://127.0.0.1:8080/v1/chat/completions";
const API_KEY = process.env.LLM_API_KEY ?? "no-key";

const THINKING_OFF = {
  reasoning_effort: "none",
  chat_template_kwargs: { enable_thinking: false },
};

const STAGE1_SCHEMA = {
  type: "object",
  properties: { search_required: { type: "boolean" } },
  required: ["search_required"],
};

const STAGE1_SYSTEM_PROMPT = `You are a search-routing classifier.
Given the user's message, decide whether a live web search is required to
answer it accurately.

Answer with ONLY valid JSON: {"search_required": boolean}

Rules:
- search_required = true ONLY when the answer depends on facts that change
  over time (news, prices, versions, releases, weather, sports, current
  events), or the user explicitly references a URL, a specific document,
  or a product with versioned attributes.
- search_required = false for: greetings, chitchat, "how does X work"
  explanations with no time-specific constraint, algorithms, math proofs,
  well-known scientific concepts, history before 2020, coding concepts
  with no version constraint.
Do NOT add anything else to your output.`;

// The proposed main-model gate prompt (authoritative decision + queries).
const MAIN_SYSTEM_PROMPT = `You are the search router for your own answering pipeline.
Decide whether YOU need live web data to answer the user's latest message
accurately, and — if yes — write the web search queries.

Answer with ONLY valid JSON:
{"search_required": boolean, "reason": string,
 "freshness": "none"|"day"|"week"|"month"|"year"|"any",
 "depth": "quick"|"standard"|"deep",
 "queries": [{"query": string, "intent": "general"|"news"|"docs"|"code"|"academic"|"forum", "preferred_domains"?: string[]}]}

Decision rules (check yourself honestly):
- search_required = false when you can answer reliably from your own
  knowledge: greetings, chitchat, coding problems and algorithm questions
  you know (including well-known competitive-programming problems), math,
  writing, translation, explanations of concepts, static facts, and library
  APIs you are confident about.
- search_required = true when the answer depends on facts that change over
  time (news, prices, stock/crypto rates, weather, sports results, releases,
  product availability, local places/businesses, current events), OR when
  the user asks about a specific entity, problem, version, or document that
  you CANNOT recall with confidence. If you are unsure whether you actually
  know the exact details of a specific named thing, search.
- If the message contains an explicit URL, search_required = true.

Query rules (only when search_required = true):
- 2-4 queries. KEYWORD FORM, not full sentences. Never paste the user's
  question verbatim; never write a query that is only stopwords or generic
  phrasing.
- Anchor every query on the concrete entities of the request (names,
  numbers, products, places) plus at most one topic word.
- Example good: ["NVIDIA stock price", "NVDA share price today"].
  Example bad: ["What is the minimum number of cuts needed to partition
  the string so that each part is a palindrome"].
- Use the user's exact terminology for proper nouns and version numbers.
- Set preferred_domains when an authoritative source is obvious.
- freshness = "any" unless the fact is explicitly live (breaking news,
  today's price/weather/score). depth: "quick" single fact, "standard"
  comparison, "deep" multi-source research.
Do NOT add anything else to your output.`;

/** @type {{id:string, label:boolean, prompt:string, tag:string}[]} */
const SCENARIOS = [
  // ── needs search (label true) ─────────────────────────────────────────
  { id: "S01", label: true, tag: "price", prompt: "What is the current price of NVIDIA stock today?" },
  { id: "S02", label: true, tag: "weather", prompt: "What's the weather in Hyderabad right now?" },
  { id: "S03", label: true, tag: "version", prompt: "What is the newest stable version of Node.js and what changed in it?" },
  { id: "S04", label: true, tag: "version", prompt: "What is the latest stable release of Next.js?" },
  { id: "S05", label: true, tag: "sports", prompt: "Who won the most recent UEFA Champions League final?" },
  { id: "S06", label: true, tag: "local", prompt: "Tell me what is the best restaurant in manikonda hyderabad I want to eat biryani" },
  { id: "S07", label: true, tag: "price", prompt: "How much does an RTX 5090 GPU cost right now?" },
  { id: "S08", label: true, tag: "release", prompt: "What is the newest model OpenAI has released?" },
  { id: "S09", label: true, tag: "fx", prompt: "What is the current USD to INR exchange rate?" },
  { id: "S10", label: true, tag: "url", prompt: "Can you read this page and summarize it https://react.dev/blog/2023/03/16/introducing-react-dev" },
  { id: "S11", label: true, tag: "specs", prompt: "What are the system requirements of the MacBook Pro M5?" },
  { id: "S12", label: true, tag: "realtime", prompt: "How is the traffic on the ORR in Hyderabad right now?" },
  { id: "S13", label: true, tag: "release", prompt: "Is Python 3.14 released yet? What changed in it?" },
  { id: "S14", label: true, tag: "politics", prompt: "Who is the current president of Argentina?" },
  { id: "S15", label: true, tag: "review", prompt: "What are reviewers saying about Grand Theft Auto VI?" },
  { id: "S16", label: true, tag: "app-update", prompt: "What's the latest update to the ChatGPT desktop app?" },
  { id: "S17", label: true, tag: "listings", prompt: "find me apartments for rent in madhapur hyderabad under 30000 per month" },
  { id: "S18", label: true, tag: "movies", prompt: "What movies are releasing in Indian theatres this week?" },
  { id: "S19", label: true, tag: "unknown-entity", prompt: "What is LeetCode problem 3200? Give me the exact problem statement." },
  { id: "S20", label: true, tag: "version", prompt: "what is the latest iOS version available for download" },
  { id: "S21", label: true, tag: "cutoff-news", prompt: "Any major earthquakes this week?" },
  { id: "S22", label: true, tag: "docs-specific", prompt: "What exact error message does llama-server print when the context size exceeds the KV cache?" },

  // ── no search (label false) ───────────────────────────────────────────
  { id: "N01", label: false, tag: "leetcode-full", prompt: "Given a string s, partition s such that every substring of the partition is a palindrome. Return the minimum cuts needed for a palindrome partitioning of s.\n\nRust starter:\nimpl Solution {\n    pub fn min_cut(s: String) -> i32 {\n        \n    }\n}" },
  { id: "N02", label: false, tag: "leetcode-famous", prompt: "Can you give me rust code for leetcode problem 23. Merge k sorted lists" },
  { id: "N03", label: false, tag: "algorithm", prompt: "explain quicksort with an example" },
  { id: "N04", label: false, tag: "complexity", prompt: "What is the time complexity of Dijkstra's algorithm with a binary heap?" },
  { id: "N05", label: false, tag: "writing", prompt: "write a haiku about the rain" },
  { id: "N06", label: false, tag: "translate", prompt: "translate 'good morning, how are you' into French" },
  { id: "N07", label: false, tag: "greeting", prompt: "Hey there how are you" },
  { id: "N08", label: false, tag: "thanks", prompt: "thanks!" },
  { id: "N09", label: false, tag: "math", prompt: "prove that the square root of 2 is irrational" },
  { id: "N10", label: false, tag: "concept", prompt: "how does a hash map work internally?" },
  { id: "N11", label: false, tag: "networking", prompt: "explain the difference between TCP and UDP" },
  { id: "N12", label: false, tag: "code", prompt: "write a regex to validate an email address" },
  { id: "N13", label: false, tag: "arithmetic", prompt: "what is 17 * 23?" },
  { id: "N14", label: false, tag: "refactor", prompt: "Refactor this Python to use itertools.groupby instead of the manual dict loop:\n\nresult = {}\nfor item in items:\n    if item.kind not in result:\n        result[item.kind] = []\n    result[item.kind].append(item)" },
  { id: "N15", label: false, tag: "science", prompt: "why is the sky blue?" },
  { id: "N16", label: false, tag: "concept", prompt: "explain what a REST API is" },
  { id: "N17", label: false, tag: "debug", prompt: "fix this bug: for i in range(len(a)): print(a[i+1])" },
  { id: "N18", label: false, tag: "git", prompt: "difference between git merge and git rebase" },
  { id: "N19", label: false, tag: "units", prompt: "convert 5 kilometers to miles" },
  { id: "N20", label: false, tag: "code-test", prompt: "Write a Rust unit test for this min_cut solution:\n\nimpl Solution {\n    pub fn min_cut(s: String) -> i32 {\n        let n = s.len();\n        vec![0]\n    }\n}" },
  { id: "N21", label: false, tag: "concept", prompt: "what is BM25 scoring in information retrieval?" },
  { id: "N22", label: false, tag: "static-api", prompt: "How do I define an associated function and a method in Rust? Show the difference with code." },
];

async function chat(endpoint, body, timeoutMs) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: "default", temperature: 0, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message ?? {};
  const content = typeof msg.content === "string" ? msg.content : "";
  const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  return content || reasoning;
}

function parseJson(raw) {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const b = s.indexOf("{");
  if (b > 0) s = s.slice(b);
  try { return JSON.parse(s); } catch { return null; }
}

async function lfmStage1(prompt) {
  const t0 = Date.now();
  try {
    const raw = await chat(FAST_ENDPOINT, {
      messages: [
        { role: "system", content: STAGE1_SYSTEM_PROMPT },
        { role: "user", content: prompt.slice(0, 2000) },
      ],
      response_format: { type: "json_object", json_schema: STAGE1_SCHEMA },
      json_schema: STAGE1_SCHEMA,
      max_tokens: 16,
      top_k: 1,
      top_p: 1.0,
      ...THINKING_OFF,
    }, 15000);
    const p = parseJson(raw);
    return { sr: typeof p?.search_required === "boolean" ? p.search_required : null, ms: Date.now() - t0 };
  } catch (e) {
    return { sr: null, ms: Date.now() - t0, err: String(e?.message ?? e) };
  }
}

async function mainGate(prompt) {
  const t0 = Date.now();
  try {
    const raw = await chat(LLM_ENDPOINT, {
      messages: [
        { role: "system", content: MAIN_SYSTEM_PROMPT },
        { role: "user", content: prompt.slice(0, 2000) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 320,
      ...THINKING_OFF,
    }, 45000);
    const p = parseJson(raw);
    if (!p || typeof p.search_required !== "boolean") return { sr: null, ms: Date.now() - t0, err: "unparseable" };
    return {
      sr: p.search_required,
      ms: Date.now() - t0,
      freshness: p.freshness,
      depth: p.depth,
      reason: String(p.reason ?? "").slice(0, 100),
      queries: Array.isArray(p.queries) ? p.queries.map((q) => String(q?.query ?? "")).filter(Boolean) : [],
    };
  } catch (e) {
    return { sr: null, ms: Date.now() - t0, err: String(e?.message ?? e) };
  }
}

function score(rows, key) {
  const tp = rows.filter((r) => r.label && r[key] === true).length;
  const fn = rows.filter((r) => r.label && r[key] === false).length;
  const fp = rows.filter((r) => !r.label && r[key] === true).length;
  const tn = rows.filter((r) => !r.label && r[key] === false).length;
  const err = rows.filter((r) => r[key] === null).length;
  const total = rows.length;
  const acc = (tp + tn) / total;
  const prec = tp + fp ? tp / (tp + fp) : 1;
  const rec = tp + fn ? tp / (tp + fn) : 1;
  return { tp, tn, fp, fn, err, acc, prec, rec };
}

function pct(x) { return (x * 100).toFixed(0) + "%"; }

async function main() {
  const args = process.argv.slice(2);
  const mainOnly = args.includes("--main-only");
  const lfmOnly = args.includes("--lfm-only");
  const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7).toLowerCase();
  const scenarios = only
    ? SCENARIOS.filter((s) => s.id.toLowerCase().includes(only) || s.tag.includes(only) || s.prompt.toLowerCase().includes(only))
    : SCENARIOS;

  console.log(`\n=== search-gate eval: ${scenarios.length} scenarios ===`);
  console.log("id   label LFMms LFM→ mainms main→ queries (main, when search)\n");

  const rows = [];
  for (const s of scenarios) {
    const lfm = lfmOnly || (!mainOnly ? await lfmStage1(s.prompt) : { sr: null, ms: 0 });
    const main = mainOnly || (!lfmOnly ? await mainGate(s.prompt) : { sr: null, ms: 0 });
    rows.push({ ...s, lfm: lfm.sr, lfmMs: lfm.ms, main: main.sr, mainMs: main.ms, queries: main.queries ?? [], reason: main.reason ?? "", err: [lfm.err, main.err].filter(Boolean).join("; ") });
    const mark = (v) => (v === null ? "ERR " : v ? "true" : "fals");
    console.log(
      `${s.id} ${s.label ? "srch " : "none"} ${String(lfm.ms).padStart(4)}  ${mark(lfm.sr)} ${String(main.ms ?? 0).padStart(5)}  ${mark(main.sr)}  ` +
      ((main.queries ?? []).length ? JSON.stringify(main.queries.map((q) => q.slice(0, 45))) : "") +
      (rows.at(-1).err ? `  [err: ${rows.at(-1).err}]` : ""),
    );
  }

  console.log("\n--- scores ---");
  if (!mainOnly) {
    const l = score(rows, "lfm");
    console.log(`LFM : acc=${pct(l.acc)} (tp=${l.tp} tn=${l.tn} fp=${l.fp} fn=${l.fn} err=${l.err}) prec=${pct(l.prec)} rec=${l.rec === 1 ? "100%" : pct(l.rec)}  avg=${Math.round(rows.reduce((a, r) => a + r.lfmMs, 0) / rows.length)}ms`);
  }
  if (!lfmOnly) {
    const m = score(rows, "main");
    console.log(`MAIN: acc=${pct(m.acc)} (tp=${m.tp} tn=${m.tn} fp=${m.fp} fn=${m.fn} err=${m.err}) prec=${pct(m.prec)} rec=${m.rec === 1 ? "100%" : pct(m.rec)}  avg=${Math.round(rows.reduce((a, r) => a + (r.mainMs || 0), 0) / rows.length)}ms`);
  }
  if (!mainOnly && !lfmOnly) {
    const agree = rows.filter((r) => r.lfm === r.main).length;
    console.log(`agreement: ${agree}/${rows.length}`);
    const dis = rows.filter((r) => r.lfm !== r.main && r.lfm !== null && r.main !== null);
    if (dis.length) {
      console.log("\ndisagreements (LFM vs MAIN):");
      for (const r of dis) console.log(`  ${r.id} [${r.tag}] label=${r.label ? "search" : "none"} LFM=${r.lfm} MAIN=${r.main}`);
    }
    const wrong = (k) => rows.filter((r) => r[k] !== null && r[k] !== r.label);
    for (const k of ["lfm", "main"]) {
      const w = wrong(k);
      if (w.length) {
        console.log(`\n${k.toUpperCase()} misclassified:`);
        for (const r of w) console.log(`  ${r.id} [${r.tag}] label=${r.label ? "search" : "none"} got=${r[k]} :: ${r.prompt.slice(0, 70).replace(/\n/g, " ")}`);
      }
    }
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
