/**
 * Golden corpus — model-directed web tool loop through /api/chat
 * (MHR-A..D, 2026-11-05). The chat route runs NO search-gate prefetch: the
 * read-only web tool surface (web_search / read_page) is armed on EVERY
 * progress-path chat turn and the MAIN MODEL decides whether/what to
 * retrieve; the harness only supplies resources, executes valid actions,
 * preserves evidence and reports actual outcomes. Frozen scenarios (the
 * gate-era 11/12/13 scenarios were deliberately evolved — §8, brief 2026-11-05):
 *   - 01: the model calls web_search, then read_page, then answers
 *     (stages + tool messages + ledger-gated web_meta + [S#] citations);
 *   - 02: legacy stream:false path = PLAIN FORWARD (no tools, no evidence,
 *     no header pair — post-repair nothing is prefetched on this path);
 *   - 03: starved engine pool — the loop runs, the envelope honestly reports
 *     zero results, the answer still streams (non-fatal);
 *   - 04: the model exhausts the per-turn search budget — the harness
 *     refuses HONESTLY (budget_exhausted names the refused query) and the
 *     turn completes on the next round;
 *   - 05: image-attachment turn — parts passthrough, loop ARMED, the model
 *     answers without tools (zero web frames, zero web_meta: nothing was
 *     attempted, so nothing is reported);
 *   - 06: pure clock turn — zero search traffic, quiet-clock law verbatim
 *     in the live request (behavior pin, no fixture file).
 *
 * Determinism seams (the ONLY things mocked; everything else runs REAL —
 * metasearch RRF + relevance floor, extractor tier cascade, SSRF literal
 * gate (DNS leg mocked), budget/ledger/citation grammar):
 *   - @/lib/web-search/cache  : all cache reads MISS (kills better-sqlite3
 *     native + cross-run TTL pollution; the fixture corpus never shares a DB).
 *   - @/lib/web-search/net    : scripted page fetches (kills impit /
 *     got-scraping / wreq native layers and ALL real network; fetchUrl ->
 *     null so metasearch's local verticals — wikipedia/HN/arXiv/SE/wikidata/
 *     semantic-scholar/IMDb — all return [] deterministically).
 *   - @/lib/web-search/engines: the general-web SERP pool is scripted
 *     (ENGINE_CALLS counts engine legs so zero-search-turn fixtures can prove
 *     zero engine traffic); deduplicateQueries / engineCooldownRemainingMs
 *     stay REAL.
 *   - @/lib/web-search/ssrf   : ONLY the DNS-resolution leg of
 *     isSafeUrlWithDns is replaced (it performs REAL DNS on the always-armed
 *     tool chain); the literal classification stays REAL via actual.isSafeUrl.
 *   - @/lib/web-search/agentBrowser: the extractor's stealth-Chromium
 *     browser tier is scripted (P7 hermeticity fix 2026-11-02). Before it,
 *     SERP URL #5 (old.reddit.com — a REAL live domain with no Tier-1 page)
 *     escalated to a LIVE Chromium session every run, and the live site's
 *     oscillating state (login-wall ARIA snapshot vs. Chromium error page)
 *     silently re-pinned the golden bytes — the "long-standing environmental
 *     flake" the old 30000ms timeout comment documented.
 *
 * VOLATILE MASKING LAW (new chain: the loop mints a random session id per
 * turn and ISO stamps on every ledger record): session ids mask to
 * "ws-<sid>" (searchSessionId + ledger ids ws-<sid>-aN) and ledger stamps
 * mask to "at":"<volatile-at>" — applied to upstream bodies AND to the
 * response text before parsing/recording, so logicalFrames stay diffable.
 * NEVER masks publishedDate/publishedAt (real fixture content).
 *
 * MOCK CAVEAT (MHR-G three-level proof): these fixtures prove the HARNESS
 * contract with a scripted upstream playing the model; they prove NOTHING
 * about a real model's tool-choice quality (that is the semantic-eval +
 * e2e level's job).
 *
 * CONTRACT DISCOVERIES pinned here (recorded, NOT fixed — §8):
 *   - runVisionEntityPrepass (lib/web-search/vision-prepass.ts) has ZERO call
 *     sites: the "Vision-to-Search pre-pass" documented in old route comments
 *     and query-planner docs NEVER RUNS (fixture 05's single-fetch proof).
 *   - search-gate.ts deterministicHardBypass: KNOWN_SITE_TOKEN_RE and
 *     DOMAIN_TLD_TOKEN_RE are dead code (defined, never referenced). The
 *     gate itself still serves app/api/search surfaces — but it is OFF the
 *     chat path (MHR-C): the route arms the tool loop instead, so no gate
 *     frame, no evidence block and no X-Web-Citations/X-Search-Gate pair
 *     ever appear on a chat response (progress OR legacy).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  UpstreamScript,
  anchorSkillBlocks,
  maskRuntimeClock,
  bytesRecord,
  installUpstream,
  normalizeBodyMs,
  parseLogical,
  runChat,
  setGoldenEnv,
  writeJsonFixture,
} from "./support/golden";
import { WEB_TOOL_GUIDANCE } from "@/lib/chat/web-tool-loop";
import { injectSystemBefore } from "@/lib/skills/lazy";

setGoldenEnv({ webSearchDisabled: false });

// Harness knobs the mocks read at CALL time (set per fixture).
const HARNESS = { mode: "normal" as "normal" | "starved" };
// Engine legs actually executed (the loop path is ALWAYS armed, so a
// fixture proves "zero search traffic" by counting these, not frames).
const ENGINE_CALLS = { n: 0 };

vi.mock("@/lib/server/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/settings")>();
  return {
    ...actual,
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

vi.mock("@/lib/web-search/cache", () => ({
  CACHE_TTL_MS: 5 * 60 * 60 * 1000,
  purgeExpiredCache: () => 0,
  startPurgeSweep: () => {},
  hash: (s: string) => s,
  queryCacheKey: () => "golden-key",
  getCachedQuery: () => null,
  putCachedQuery: () => {},
  getCachedPage: () => null,
  putCachedPage: () => {},
  closeCache: () => {},
}));

vi.mock("@/lib/web-search/engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search/engines")>();
  const empty = async () => [] as never;
  const serp = async () => { ENGINE_CALLS.n += 1; return HARNESS.mode === "starved" ? [] : SERP; };
  return {
    ...actual, // deduplicateQueries, engineCooldownRemainingMs, caps stay real
    ddgSearch: empty, yahooSearch: empty, googleSearch: empty, braveSearch: empty,
    redditSearch: empty, bingSearch: empty, bingNewsRssSearch: empty,
    githubSearch: empty, devToSearch: empty,
    runGeneralWebSearch: serp,
    runGeneralWebSearchSharded: serp,
  };
});

// The always-armed tool chain admits URLs through isSafeUrlWithDns, which
// performs REAL DNS resolution (node:dns) — a hermeticity break and a
// determinism hazard on example.com-style hosts. Replace ONLY the DNS leg;
// the literal SSRF classification runs REAL (shared with the net mock).
vi.mock("@/lib/web-search/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search/ssrf")>();
  return { ...actual, isSafeUrlWithDns: async (url: string) => actual.isSafeUrl(url) };
});

// Page bytes served to the extractor Tier-1 (net.fetchPage). Deterministic
// hand-written articles; universal-extractor's HTML->markdown conversion is
// pure CPU, so the resulting tool payload is byte-stable across machines.
const PAGES: Record<string, { status: number; body: string }> = {
  "https://nimbus.example.com/roadmap-2026": {
    status: 200,
    body: "<html><head><title>Project Nimbus Roadmap 2026</title></head><body><article><h1>Project Nimbus Roadmap 2026</h1><p>The Nimbus team published its latest roadmap for 2026. The first milestone ships the Nimbus sync engine in March 2026. The second milestone adds Nimbus offline mode before the end of Q2 2026. A public beta of the Nimbus API gateway is planned for July 2026.</p><p>Q4 2026 closes with the Nimbus mobile clients on iOS and Android.</p></article></body></html>",
  },
  "https://www.example.com/blog/nimbus-sync-engine": {
    status: 200,
    body: "<html><head><title>Nimbus sync engine ships</title></head><body><article><h1>Nimbus sync engine ships</h1><p>Hands on with the Nimbus sync engine: conflict resolution now runs client side. The roadmap keeps offline mode on the Q2 2026 schedule, with a public preview promised earlier for enterprise tenants.</p></article></body></html>",
  },
  "https://nimbus-community.example.org/t/roadmap-thread": {
    status: 200,
    body: "<html><head><title>Roadmap thread</title></head><body><article><h1>Roadmap thread</h1><p>Community megathread on the Project Nimbus roadmap 2026. Maintainers confirmed sync engine in March 2026 and offline mode in Q2 2026; nothing is committed beyond 2026.</p></article></body></html>",
  },
  // No Tier-1 entry for /old-announcement (SERP URL #4) => fetchPage status 0;
  // the scripted browser tier below misses it too, and the Jina/wayback tail
  // runs through the net mock (fetchPage/fetchUrl scripted misses), so the
  // packet keeps its SERP-snippet baseline passage but classifies
  // FAIL_NETWORK_OR_CRASH.
};

// Scripted stealth-Chromium renders (the extractor's browser tier,
// lib/web-search/agentBrowser.ts — see the header seams list). SERP URL #5
// is the only render: it has no Tier-1 page and the cascade ALWAYS escalates
// a blocked/empty Tier 1 to the browser tier, so this scripted thread body
// pins its SUCCESS_BROWSER bytes forever instead of depending on
// old.reddit.com's live state. Hand-written community-thread prose consistent
// with the scripted SERP snippet and the roadmap fiction.
const RENDERED: Record<string, {
  url: string; finalUrl: string; title: string; status: number | null; bodyText: string;
  ariaSnapshot: string; jsonLd: unknown[]; meta: Record<string, string>; windowState: Record<string, string>; ok: boolean;
}> = {
  "https://old.reddit.com/r/projectnimbus/comments/golden1": {
    url: "https://old.reddit.com/r/projectnimbus/comments/golden1",
    finalUrl: "https://old.reddit.com/r/projectnimbus/comments/golden1",
    title: "Project Nimbus discussion",
    status: 200,
    bodyText:
      "Anyone following the latest Project Nimbus roadmap news? The maintainers published the 2026 roadmap: the sync engine ships in March 2026, offline mode lands in Q2 2026, and a public beta of the Nimbus API gateway opens in July 2026. Top comment: nothing is committed beyond 2026, and the mobile clients close out Q4 2026.",
    ariaSnapshot: "",
    jsonLd: [],
    meta: {},
    windowState: {},
    ok: true,
  },
};

vi.mock("@/lib/web-search/agentBrowser", () => ({
  // The ONLY live-network seam left in the golden corpus lives here; every
  // other extractor tier runs REAL against the scripted net/engines mocks.
  // A miss below is deterministic: the cascade falls through to the
  // already-scripted Jina/wayback tail and ends snippet-only. Returning
  // null for a pool context keeps media-captions (NOT on this chain) loudly
  // failing should a future regression ever pull it into the goldens.
  browserPoolDisabled: () => false,
  acquirePoolContext: async () => null,
  releasePoolContext: () => {},
  closeBrowserPool: async () => {},
  extractPageInOnePass: async (url: string) =>
    RENDERED[url] ?? {
      url, finalUrl: url, title: "", status: 0, bodyText: "", ariaSnapshot: "",
      jsonLd: [], meta: {}, windowState: {}, ok: false,
      error: "golden: browser tier scripted miss",
    },
}));

vi.mock("@/lib/web-search/net", async () => {
  const { isSafeUrl } = await import("@/lib/web-search/ssrf");
  const enc = new TextEncoder();
  return {
    isSafeUrl,
    LINK_PREVIEW_UAS: [],
    PAGE_LIMIT_BYTES: 50 * 1024 * 1024,
    PDF_LIMIT_BYTES: 150 * 1024 * 1024,
    tlsClient: () => null,
    closeTlsClient: async () => {},
    pickFingerprint: () => "chrome",
    realisticHeaders: () => ({}),
    apiHeaders: () => ({}),
    readBounded: async () => new Uint8Array(),
    newCookieJar: () => ({}),
    isCertError: () => false,
    fetchPage: async (url: string) => {
      const p = PAGES[url];
      if (!p) return { status: 0, ok: false, body: "", contentType: "", elapsedMs: 0, fingerprint: "chrome", cookies: {}, resolvedUrl: url };
      return { status: p.status, ok: p.status >= 200 && p.status < 300, body: p.body, contentType: "text/html; charset=utf-8", elapsedMs: 0, fingerprint: "chrome", cookies: {}, resolvedUrl: url };
    },
    fetchUrl: async () => null,
    fetchWithLinkPreviewBots: async () => null,
  };
});

// Scripted general-web SERP consumed by metasearch through the engines mock.
// Titles/snippets carry the prompt's core tokens so the lexical relevance
// floor keeps them; engine names pin the RRF weights (1.2 general indexers,
// 1.0 reddit). URL #4 deliberately has NO scripted page (snippet-only path);
// URL #5 has no Tier-1 page but a scripted RENDERED entry (SUCCESS_BROWSER).
const SERP: {
  title: string; url: string; snippet: string; engine: string; rank: number; publishedDate?: string;
}[] = [
  { title: "Project Nimbus Roadmap 2026", url: "https://nimbus.example.com/roadmap-2026", snippet: "The latest Nimbus roadmap: sync engine in March 2026, offline mode in Q2 2026.", engine: "duckduckgo", rank: 1, publishedDate: "2026-02-11T09:00:00Z" },
  { title: "Nimbus sync engine ships", url: "https://www.example.com/blog/nimbus-sync-engine", snippet: "Hands on with the Nimbus sync engine from the 2026 roadmap.", engine: "duckduckgo", rank: 2 },
  { title: "Roadmap thread - Nimbus community", url: "https://nimbus-community.example.org/t/roadmap-thread", snippet: "Maintainers on the Project Nimbus roadmap 2026: sync March, offline Q2.", engine: "brave", rank: 1 },
  { title: "Old announcement - Nimbus 2024 recap", url: "https://nimbus.example.com/old-announcement", snippet: "The Nimbus roadmap for 2024 shipped on schedule.", engine: "bing", rank: 1, publishedDate: "2024-12-30T00:00:00Z" },
  { title: "Project Nimbus discussion", url: "https://old.reddit.com/r/projectnimbus/comments/golden1", snippet: "Anyone following the latest Project Nimbus roadmap news?", engine: "reddit", rank: 1 },
];

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/chat/route")).POST; });

const CHAT_UPSTREAM: UpstreamScript = {
  chunks: [
    'data: {"id":"w1","choices":[{"index":0,"delta":{"content":"search answer"}}]}\n\n',
    "data: [DONE]\n\n",
  ],
};

// One model round that ENDS WITH A TOOL CALL: the exact SSE frame grammar
// the loop's relay parses (⇔ the builders in __tests__/chat/web-tool-loop.test.ts).
function toolCallScript(id: string, name: string, args: unknown): UpstreamScript {
  const frag = (rest: Record<string, unknown>) => "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...rest }] } }] }) + "\n\n";
  return {
    chunks: [
      frag({ id, function: { name } }),
      frag({ function: { arguments: JSON.stringify(args) } }),
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ],
  };
}

// Volatile masking law (see header): random session ids + ledger stamps.
function maskVolatile(s: string): string {
  return s
    .replace(/ws-[a-z0-9]{8}/g, "ws-<sid>")
    .replace(/"at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z"/g, '"at":"<volatile-at>"');
}

const ENV_PRE = {
  WEB_SEARCH_GATE_DISABLED: "unset",
  WEB_SEARCH_LFM_DISABLED: "unset",
  settings_llm_override: MOCK_LLM_URL,
  web_mock_boundary: "cache(miss-only), net(scripted pages, fetchUrl=null), engines(scripted SERP + ENGINE_CALLS counter), agentBrowser(scripted browser tier: golden1 rendered, every other URL misses), ssrf(isSafeUrlWithDns => literal isSafeUrl, no DNS)",
};

function chatBody(text: unknown, stream: boolean | undefined): string {
  const messages = [{ role: "user", content: text }];
  const payload: Record<string, unknown> = { model: "strata-mock", messages };
  if (stream !== undefined) payload.stream = stream;
  return JSON.stringify(payload);
}

async function runAndRecord(o: {
  rel: string;
  scenario: string;
  semantics: string;
  comparison: "byte-exact" | "structural" | "semantic" | "approved-deviation";
  rawBody: string;
  mode?: "normal" | "starved";
  upstream?: UpstreamScript[];
  notes?: string;
}) {
  HARNESS.mode = o.mode ?? "normal";
  ENGINE_CALLS.n = 0;
  const calls = installUpstream(o.upstream ?? [CHAT_UPSTREAM]);
  const run = await runChat(POST as never, o.rawBody);
  const text = maskVolatile(run.text);
  const logical = parseLogical(text);
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  const upstreamCalls = calls.map((c) => {
    const bodyText = c.body === null ? null : maskVolatile(maskRuntimeClock(c.body));
    let bodyJson: unknown = null;
    try { bodyJson = bodyText ? anchorSkillBlocks(JSON.parse(bodyText)).payload : null; } catch { /* raw */ }
    return { url: c.url, method: c.method, headers: Object.fromEntries(Object.entries(c.headers).sort()), bodyText, bodyJson };
  });
  writeJsonFixture(o.rel, {
    request: { rawBody: o.rawBody },
    upstreamCalls,
    response: {
      status: run.status,
      headers: run.headers,
      body: hasStage
        ? { bodyMsNormalized: normalizeBodyMs(text), note: "stage frames carry volatile ms digits; compare logicalFrames + bodyMsNormalized" }
        : bytesRecord(run.bytes),
    },
    logicalFrames: logical.frames,
    streamDone: logical.done,
    unterminatedTail: logical.tail,
  }, {
    scenario: o.scenario,
    semantics: o.semantics,
    comparison: o.comparison,
    harness: "__tests__/rust-golden/web.test.ts",
    env: ENV_PRE,
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path bodies are ms-normalized text. P1 (2026-11-01): the live <runtime_clock> system block carries wall-clock text, so its content is MASKED in bodyText/bodyJson (the clock text itself is pinned by clock unit tests). MHR (2026-11-05): random per-turn web-session ids mask to "ws-<sid>" (bodies + ledger ids) and action-ledger ISO stamps mask to "at":"<volatile-at>"; publishedDate/publishedAt are NEVER masked.',
    notes: o.notes,
  });
  return { run, logical, upstreamCalls };
}

const stages = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  frames.filter((f) => f.kind === "stage").map((f) => (f.obj as { stage?: string }).stage);
const stageFrames = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  frames.filter((f) => f.kind === "stage").map((f) => f.obj as Record<string, unknown>);
const webMeta = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  stageFrames(frames).filter((o) => o.stage === "web_meta");

/** The role:"tool" message contents (JSON envelopes) carried by an upstream body. */
function toolEnvelopes(bodyJson: unknown): Record<string, unknown>[] {
  const messages = (bodyJson as { messages: { role: string; content: unknown }[] }).messages;
  return messages.filter((m) => m.role === "tool").map((m) => JSON.parse(String(m.content)));
}
function toolCallsOf(bodyJson: unknown, msgIdx: number): { id: string; type: string; function: { name: string; arguments: string } }[] {
  return (bodyJson as { messages: { tool_calls?: never }[] }).messages[msgIdx].tool_calls as never;
}

describe("golden: model-directed web tool loop", () => {
  beforeAll(() => {
    HARNESS.mode = "normal";
  });

  // FULLY HERMETIC since the P7 browser-tier fix (2026-11-02): the old
  // live-stealth-Chromium cliff (the documented long-standing flake) is gone
  // — see the agentBrowser entry in the header seams list. The 30000ms is
  // now only slow-machine headroom for the extractor read in round 2;
  // every byte comparison still runs and still fails hangs.
  it("01 model-directed research — web_search → read_page → answer (progress path)", { timeout: 30000 }, async () => {
    const R1_ARGS = { queries: ["project nimbus roadmap 2026"], missing_claims: ["the current milestone dates for project nimbus"] };
    const R2_ARGS = { urls: ["https://nimbus.example.com/roadmap-2026"] };
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/01-search-success-progress.json",
      scenario: "model-directed web research: the (scripted) main model calls web_search, then read_page, then answers; the harness executes, records and cites",
      semantics:
        "MHR-A..D (2026-11-05 — DELIBERATE FIXTURE EVOLUTION from the gate-era prefetch scenario): the route arms the read-only tool " +
        "surface on every progress turn with ZERO prefetched evidence — the model decides. THREE upstream calls: round 1 calls " +
        "web_search (the harness executes it against the scripted engine pool; a plain-text query mints NO [S#] citations — only " +
        "pages actually read mint them), round 2 calls read_page on a SERP URL (extractor cascade REAL, mints [S1] for the page), " +
        "round 3 answers. Tool results travel as role:\"tool\" messages with the exact envelope JSON, and each tool round appends an " +
        "assistant message carrying tool_calls {id,type:'function',function:{name,arguments}} — never an injected evidence block. " +
        "Message chain for the FIRST call: guidance (skill slot, FIRST system block), user, runtime_clock; roles " +
        "[system,user,system]. Every round's payload carries payload.tools = [web_search,read_page]. Stage grammar: " +
        "decision_done, then per tool round ONE 'web:tools' census frame (detail = called names, done/total rounds) immediately " +
        "followed by that round's ledger-gated web_meta frame — NO web:gate/planning/searching/reading/reranking/done frames " +
        "EVER (the prefetch chain is gone from chat). " +
        "EVIDENCE-HONESTY NOTE (recorded, MHR-E observation): a read_page URL carries no SERP title entry, so packet.title stays " +
        "EMPTY — the [S#] citation records title:'' and the tool's page entry falls back to the DOMAIN (extractor packets pass " +
        "through the search-result title, never an HTML <title> sniff). " +
        "web_meta is " +
        "LEDGER-GATED (WS18): round 1 emits one (ledger grew, zero new citations — webCitations {}), round 2 emits one with the " +
        "full merged map ([S1]), and completion emits one final snapshot {toolRounds:2, actions:[web_search,read_page]} — the " +
        "OVERWRITE law. searchGate/presentation/richResults are ABSENT from every frame (route passes null). Progress response " +
        "headers NEVER carry X-Web-Citations/X-Search-Gate. Streaming reliability law (2026-11-12, REPLACES WS06): the " +
        "answer round's content streams LIVE, byte-forwarded from the upstream delta frames (a web:content_revise frame may " +
        "later whole-round-replace it after the server audit — none fired here); tool rounds' terminal frames release per " +
        "round and their [DONE] is swallowed (single-[DONE] grammar). Each tool round opens/closes a web:activity frame " +
        "pair (started → completed with the REAL ledger counts). Volatile masking: ws-<sid> / <volatile-at> (header law).",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      upstream: [toolCallScript("call-a1", "web_search", R1_ARGS), toolCallScript("call-a2", "read_page", R2_ARGS), CHAT_UPSTREAM],
      notes:
        "Mock boundary: cache always-miss; net scripted (fetchUrl=null kills local verticals); engines SERP scripted with an " +
        "ENGINE_CALLS counter; agentBrowser scripted; ssrf DNS leg scripted (literal gate REAL). Everything else (metasearch " +
        "RRF+floor, extractor, budget/ledger/citation grammar) runs REAL and deterministic. The scripted upstream PLAYS the main " +
        "model — these bytes prove the harness contract, not model quality (MHR-G semantic evals cover that).",
    });
    expect(run.status).toBe(200);

    // Stage grammar: census frames ONLY on tool rounds, each round opening and
    // closing its web:activity pair (2026-11-12 law); no prefetch chain.
    const seq = stages(logical.frames);
    expect(seq).toEqual(["decision_done", "web:tools", "web:activity", "web:activity", "web_meta", "web:tools", "web:activity", "web:activity", "web_meta", "web_meta"]);
    const census = stageFrames(logical.frames).filter((o) => o.stage === "web:tools");
    expect(census.map((f) => f.detail)).toEqual(["web_search", "read_page"]);
    expect(census.map((f) => [f.done, f.total])).toEqual([[1, 8], [2, 8]]); // standard budget: maxToolRounds 8 (2026-11-07 re-tune)
    expect(run.headers["x-web-citations"]).toBeUndefined();
    expect(run.headers["x-search-gate"]).toBeUndefined();

    // Live-forward law (2026-11-12, replaces WS06): the upstream answer delta
    // rides through byte-forwarded with its id preserved — no synthesized
    // release frame exists anymore. Live-before-[DONE] order.
    expect(run.text).toContain('"id":"w1","choices":[{"index":0,"delta":{"content":"search answer"}}]');
    expect(run.text.indexOf('"content":"search answer"')).toBeLessThan(run.text.indexOf("data: [DONE]"));
    // Tool rounds honestly end in front of the browser:
    expect(run.text).toContain('"finish_reason":"tool_calls"');

    // web_meta: ledger-gated OVERWRITE frames (round1, round2, completion).
    const metas = webMeta(logical.frames);
    expect(metas.length).toBe(3);
    const led = (i: number) => metas[i]!.researchLedger as { toolRounds: number; actions: Record<string, unknown>[] };
    expect(Object.keys(metas[0]!.webCitations as object)).toEqual([]); // plain query minted nothing
    expect(led(0).toolRounds).toBe(1);
    expect(led(0).actions.length).toBe(1);
    expect(led(0).actions[0]).toMatchObject({ tool: "web_search", ok: true, id: "ws-<sid>-a1" });
    expect(metas[0]!.searchGate).toBeUndefined();
    expect(metas[1]!.webCitations).toEqual({
      S1: { sourceId: "S1", url: "https://nimbus.example.com/roadmap-2026", title: "nimbus.example.com", domain: "nimbus.example.com" },
    });
    expect(led(1).toolRounds).toBe(2);
    expect(led(1).actions.length).toBe(2);
    expect(led(1).actions[1]).toMatchObject({ tool: "read_page", ok: true, id: "ws-<sid>-a2", sources: ["S1"] });
    // Completion frame: the final ledger snapshot.
    expect(Object.keys(metas[2]!.webCitations as object)).toEqual(["S1"]);
    expect(led(2).toolRounds).toBe(2);
    expect(led(2).actions.map((a) => a.tool)).toEqual(["web_search", "read_page"]);
    expect(led(2).actions.map((a) => a.id)).toEqual(["ws-<sid>-a1", "ws-<sid>-a2"]);
    for (const a of led(2).actions) expect(a.at).toBe("<volatile-at>");

    // Three upstream calls: the tool loop, not the harness, drove retrieval.
    expect(upstreamCalls.length).toBe(3);

    // Round 1 request: guidance → user → clock; tools armed; no evidence.
    const p0 = upstreamCalls[0]!.bodyJson as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    expect(p0.messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(p0.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    expect(p0.messages[1].content).toBe("what is the latest roadmap news for project nimbus");
    expect(String(p0.messages[2].content).startsWith("<runtime_clock>")).toBe(true);
    expect(p0.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
    expect(p0.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);

    // Round 2 request: the assistant's tool call survives VERBATIM and the
    // tool envelope (masked) comes back as the role:"tool" turn.
    const p1 = upstreamCalls[1]!.bodyJson as { messages: Record<string, unknown>[] };
    expect(p1.messages.map((m) => m.role)).toEqual(["system", "user", "system", "assistant", "tool"]);
    const asst1 = p1.messages[3] as { content: unknown; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
    expect(asst1.content).toBeNull();
    expect(asst1.tool_calls).toEqual([{ id: "call-a1", type: "function", function: { name: "web_search", arguments: JSON.stringify(R1_ARGS) } }]);
    const [env1] = toolEnvelopes(p1);
    expect(env1).toMatchObject({ ok: true, tool: "web_search", searchSessionId: "ws-<sid>" });
    expect((env1!.queryResults as { query: string }[])[0]!.query).toBe("project nimbus roadmap 2026");
    expect((env1!.resultsReturned as number)).toBeGreaterThanOrEqual(3);
    expect((env1!.results as { url: string }[])[0]!.url).toBe("https://nimbus.example.com/roadmap-2026"); // RRF stable order, REAL fusion
    expect(env1!.remainingBudget).toBeTruthy();

    // Round 3 request: both tool rounds on the transcript; the model answers.
    const p2 = upstreamCalls[2]!.bodyJson as { messages: Record<string, unknown>[]; tools?: unknown[] };
    expect(p2.messages.map((m) => m.role)).toEqual(["system", "user", "system", "assistant", "tool", "assistant", "tool"]);
    const asst2 = p2.messages[5] as { tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
    expect(asst2.tool_calls).toEqual([{ id: "call-a2", type: "function", function: { name: "read_page", arguments: JSON.stringify(R2_ARGS) } }]);
    const env2 = toolEnvelopes(p2)[1];
    expect(env2).toMatchObject({ ok: true, tool: "read_page", searchSessionId: "ws-<sid>" });
    const pages = env2!.pages as { url: string; sourceId: string; title: string }[];
    expect(pages[0]).toMatchObject({ url: "https://nimbus.example.com/roadmap-2026", sourceId: "S1", title: "nimbus.example.com" });
    // The ledger's web_search retrieval count ⇔ the envelope's count (provenance, not decoration).
    const retrievedA1 = led(2).actions[0]!.retrieved as number;
    expect(retrievedA1).toBe(env1!.resultsReturned as number);
  });

  // Legacy stream:false tail: post-repair there is NOTHING to prefetch, so
  // this path is a plain forward — no tools, no evidence, no header pair.
  it("02 legacy stream:false — plain forward (NO tools, NO evidence, NO citation/gate headers)", { timeout: 30000 }, async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/02-legacy-stream-false-plain-forward.json",
      scenario: "legacy stream:false chat turn: plain forward — zero stage frames, zero tool grammar, zero header pair",
      semantics:
        "MHR (2026-11-05 — DELIBERATE FIXTURE EVOLUTION from the header-pair scenario): the gate-era X-Web-Citations/X-Search-Gate " +
        "pair existed ONLY because the gate prefetched. Post-repair NOTHING is prefetched on any chat path, so the legacy tail is a " +
        "PLAIN FORWARD: runTurnPipeline still runs (skill slot + task-scope + clock injection; stage callbacks dropped) but NO web " +
        "tool loop runs (it belongs to the progress path), so payload.tools is absent, no guidance block is injected and no evidence " +
        "block exists. Response: ZERO ruke_stage/web_meta frames, headers carry NEITHER x-web-citations NOR x-search-gate, and the " +
        "body is the upstream SSE bytes byte-exact (the legacy path performs no WS06 answer audit).",
      comparison: "byte-exact",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", false),
    });
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
    expect(run.headers["x-web-citations"]).toBeUndefined();
    expect(run.headers["x-search-gate"]).toBeUndefined();
    expect(run.text).toBe('data: {"id":"w1","choices":[{"index":0,"delta":{"content":"search answer"}}]}\n\ndata: [DONE]\n\n');

    expect(upstreamCalls.length).toBe(1);
    const payload = upstreamCalls[0]!.bodyJson as { messages: { role: string; content: unknown }[]; tools?: unknown[] };
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[0].content).toBe("what is the latest roadmap news for project nimbus");
    expect(payload.messages.some((m) => m.content === WEB_TOOL_GUIDANCE)).toBe(false);
    expect(payload.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
    expect(payload.messages.some((m) => String(m.content).includes("No web evidence"))).toBe(false);
    expect(payload.tools).toBeUndefined();
  });

  it("03 starved engine pool — the loop reports ZERO honestly, the answer still streams", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/03-search-starved-progress.json",
      scenario: "engine pool returns ZERO results: the harness reports the empty result honestly (no sentinel block), non-fatal",
      semantics:
        "MHR (2026-11-05 — DELIBERATE FIXTURE EVOLUTION from the sentinel-block scenario): there is no prefetched bundle anymore, " +
        "so there is no injected 'No web evidence' sentinel — honesty lives in the TOOL ENVELOPE the model itself called: " +
        "web_search returns ok:true with queryResults[0].resultCount=0 and results=[] (the engines genuinely came back empty; " +
        "metasearch does NOT throw for an empty pool). The loop records the attempt (ledger ok:true, retrieved:0) and emits " +
        "ledger-gated web_meta frames (empty citation map — nothing was retrieved, nothing is cited). The round's " +
        "web:activity pair stays HONEST on a starved arm: started → completed with done:0 of total:1 — the retrieval really " +
        "ran and came back empty, so 'completed' is the truth, never 'failed'. The answer round streams LIVE (2026-11-12 " +
        "law); a starved turn NEVER produces an error frame. Engine legs: ENGINE_CALLS ≥ 1 " +
        "proves the retrieval actually ran against the scripted pool.",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      mode: "starved",
      upstream: [toolCallScript("call-a1", "web_search", { queries: ["project nimbus roadmap 2026"], missing_claims: ["milestone dates"] }), CHAT_UPSTREAM],
    });
    expect(ENGINE_CALLS.n).toBeGreaterThanOrEqual(1); // the search genuinely ran
    const seq = stages(logical.frames);
    expect(seq).toEqual(["decision_done", "web:tools", "web:activity", "web:activity", "web_meta", "web_meta"]);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
    expect(logical.done).toBe(true);

    const metas = webMeta(logical.frames);
    expect(metas.length).toBe(2); // per-round + completion, both ledger-gated
    const led = (i: number) => metas[i]!.researchLedger as { toolRounds: number; actions: Record<string, unknown>[] };
    expect(Object.keys(metas[0]!.webCitations as object)).toEqual([]);
    expect(led(0).actions[0]).toMatchObject({ tool: "web_search", ok: true, retrieved: 0 });
    expect(led(1).actions.length).toBe(1);
    // Nothing retrieved ⇒ nothing citable, on BOTH frames:
    expect(Object.keys(metas[1]!.webCitations as object)).toEqual([]);

    expect(upstreamCalls.length).toBe(2);
    const p0 = upstreamCalls[0]!.bodyJson as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    expect(p0.messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(p0.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    // No sentinel block, no evidence block — the loop injects NOTHING at turn start:
    expect(p0.messages.some((m) => String(m.content).includes("No web evidence"))).toBe(false);
    expect(p0.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
    expect(p0.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);

    // The model sees the HONEST empty envelope it asked for:
    const p1 = upstreamCalls[1]!.bodyJson as { messages: Record<string, unknown>[] };
    const [env] = toolEnvelopes(p1);
    expect(env).toMatchObject({ ok: true, tool: "web_search" });
    expect(env!.results).toEqual([]);
    expect(env!.resultsReturned).toBe(0);
    expect((env!.queryResults as { resultCount: number }[])[0]!.resultCount).toBe(0);
  });

  it("04 search budget exhausted — the harness refuses honestly (named target), turn completes", async () => {
    const R1_ARGS = { queries: ["project nimbus roadmap"], missing_claims: ["roadmap dates"] };
    const R2_ARGS = { queries: ["project nimbus sync engine"], missing_claims: ["sync engine status"] };
    const R3_ARGS = { queries: ["project nimbus offline mode"], missing_claims: ["offline mode timeline"] };
    const R4_ARGS = { queries: ["project nimbus data export"], missing_claims: ["data export timeline"] };
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/04-search-budget-exhausted-progress.json",
      scenario: "the model spends the per-turn search budget (standard: 3 calls, 2026-11-07 re-tune) — the fourth web_search is refused with a named target",
      semantics:
        "MHR (2026-11-05 — DELIBERATE FIXTURE EVOLUTION from the injected-throw scenario): budgets are harness resources, not " +
        "model judgment. Standard depth gives THREE search calls (2026-11-07 re-tune); the model spends them, and the fourth is refused with the exact " +
        "budget_exhausted envelope: ok:false, error:'budget_exhausted', a detail naming what was spent and instructing the model " +
        "to answer from the evidence it HAS and say what is still missing, plus remainingBudget. The refusal is RECORDED in the " +
        "action ledger (ok:false, error:'budget_exhausted', queries:[the refused query]) — the third web_meta frame re-emits the " +
        "full record, and the completion snapshot carries all four actions. Only 8 rounds exist (maxToolRounds, 2026-11-07 " +
        "re-tune): four tool rounds + one answer round; the forced-final no-tools directive does NOT trigger (the model answered " +
        "within the cap). Each tool round's web:activity pair reports honestly: rounds 1-3 close 'completed' with REAL counts; " +
        "the refused round 4 closes 'failed' with done:0 total:0 — the harness refused BEFORE execution, so nothing ran.",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      upstream: [
        toolCallScript("call-a1", "web_search", R1_ARGS),
        toolCallScript("call-a2", "web_search", R2_ARGS),
        toolCallScript("call-a3", "web_search", R3_ARGS),
        toolCallScript("call-a4", "web_search", R4_ARGS),
        CHAT_UPSTREAM,
      ],
    });
    const seq = stages(logical.frames);
    expect(seq).toEqual([
      "decision_done",
      "web:tools", "web:activity", "web:activity", "web_meta",
      "web:tools", "web:activity", "web:activity", "web_meta",
      "web:tools", "web:activity", "web:activity", "web_meta",
      "web:tools", "web:activity", "web:activity", "web_meta",
      "web_meta",
    ]);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
    expect(logical.done).toBe(true);

    const metas = webMeta(logical.frames);
    expect(metas.length).toBe(5); // four tool rounds (WS18 ledger-gated) + completion
    const led = (i: number) => metas[i]!.researchLedger as { toolRounds: number; actions: Record<string, unknown>[] };
    expect(led(0).toolRounds).toBe(1);
    expect(led(1).toolRounds).toBe(2);
    expect(led(2).toolRounds).toBe(3);
    expect(led(2).actions.length).toBe(3);
    expect(led(3).toolRounds).toBe(4);
    expect(led(3).actions.length).toBe(4);
    expect(led(3).actions[3]).toMatchObject({
      tool: "web_search", ok: false, error: "budget_exhausted", id: "ws-<sid>-a4", queries: ["project nimbus data export"],
    });
    // The refusal NAMED its target; the completed rounds recorded their spend:
    expect(led(3).actions.map((a) => a.ok)).toEqual([true, true, true, false]);
    expect(led(4).toolRounds).toBe(4);
    expect(led(4).actions.length).toBe(4);

    expect(upstreamCalls.length).toBe(5);
    const p4 = upstreamCalls[4]!.bodyJson as { messages: Record<string, unknown>[] };
    const envs = toolEnvelopes(p4);
    const refused = envs[3];
    expect(refused).toMatchObject({ ok: false, tool: "web_search", searchSessionId: "ws-<sid>", error: "budget_exhausted" });
    expect(String(refused!.detail)).toContain("budget spent (3 search call(s))");
    expect(refused!.remainingBudget).toBeTruthy();
    // Envelope discipline: an error envelope NEVER echoes the model's args
    // back (the refused target is named where it belongs — the ledger pin
    // above); the model already holds its own tool-call arguments.
    expect((refused as Record<string, unknown>).queries).toBeUndefined();
    expect((refused as Record<string, unknown>).urls).toBeUndefined();
    // Rounds 1-3 spent the budget (REAL budget gate, standard depth = 3):
    expect(envs[0]!.remainingBudget).toBeTruthy();
    expect(envs[1]!.ok).toBe(true);
    expect(envs[2]!.ok).toBe(true);
  });

  // browser tier scripted (P7) — headroom budget, see note on test 01
  it("05 image attachment — parts passthrough, loop ARMED, model answers without tools", { timeout: 30000 }, async () => {
    const text = "who is this person";
    const imgUrl = "data:image/jpeg;base64,Z29sZGVuLWltYWdlLWJ5dGVz";
    const content = [
      { type: "text", text },
      { type: "image_url", image_url: { url: imgUrl } },
    ];
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/05-image-attachment-parts-passthrough-progress.json",
      scenario: "image attachment turn: parts passthrough byte-identical; the tool loop is ARMED but the model never calls it — nothing attempted, nothing reported",
      semantics:
        "MHR (2026-11-05 — DELIBERATE FIXTURE EVOLUTION from the image-intent-gate scenario): the gate no longer sits on the chat " +
        "path, so there is no image-intent hard bypass and NO prefetched evidence — the turn behaves like any other: guidance " +
        "(skill slot) + user + clock, payload.tools armed, model decides. The scripted model answers directly, so the honest " +
        "report is EMPTY: zero web: frames beyond decision_done (web:tools rides ONLY tool rounds), zero web_meta frames " +
        "(empty ledger — WS18: frames report ACTIONS, not intent), zero engine legs (ENGINE_CALLS=0) and exactly ONE upstream " +
        "fetch (installUpstream throws on any extra fetch ⇒ the zero-search-traffic proof). CONTRACT DISCOVERY still pinned: " +
        "runVisionEntityPrepass is DEAD (zero call sites) — no vision completion ever precedes the chat forward. The user turn " +
        "passes through to the upstream UNCHANGED (content array + data URL byte-identical). Live-forward grammar " +
        "(2026-11-12): the toolless answer round's upstream delta frame rides through byte-forwarded.",
      comparison: "structural",
      rawBody: chatBody(content, undefined),
      notes:
        "upstreamCalls.length === 1 is the double proof: (a) vision pre-pass DEAD — had the documented pre-pass run, a vision " +
        "completion would appear before the chat forward (installUpstream throws on any extra fetch); (b) zero search traffic — " +
        "ENGINE_CALLS stays 0 because the loop only retrieves through tool calls the model never made.",
    });
    expect(run.status).toBe(200);
    expect(ENGINE_CALLS.n).toBe(0);
    const seq = stages(logical.frames);
    expect(seq).toEqual(["decision_done"]); // no prefetch chain, no tool census
    expect(webMeta(logical.frames).length).toBe(0);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
    expect(run.headers["x-web-citations"]).toBeUndefined();
    expect(run.headers["x-search-gate"]).toBeUndefined();

    // Live-forward grammar (2026-11-12) on a toolless turn — the upstream
    // delta frame rides through byte-forwarded (no WS06 synthesis):
    expect(run.text).toContain('"id":"w1","choices":[{"index":0,"delta":{"content":"search answer"}}]');
    expect(run.text.indexOf('"content":"search answer"')).toBeLessThan(run.text.indexOf("data: [DONE]"));

    expect(upstreamCalls.length).toBe(1);
    const payload = upstreamCalls[0]!.bodyJson as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    const userTurn = payload.messages.find((m) => m.role === "user");
    expect(userTurn!.content).toEqual(content); // parts + data URL untouched
    expect(payload.messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(payload.messages[0].content).toBe(WEB_TOOL_GUIDANCE); // ARMED, unused — capability ≠ prefetch
    expect(payload.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);
    expect(payload.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
  });
});

// Brief §5 behavior test (NO fixture written — the corpus is the Rust replay
// contract; this pins BEHAVIOR at the real-request level only clock unit
// tests can't reach). "What time is it?" must: (a) run NO retrieval at all —
// zero engine legs, zero tool rounds, a single upstream fetch (installUpstream
// throws on ANY extra fetch); (b) show the answering model the NEW quiet-clock
// law VERBATIM inside the real upstream request body (the per-turn
// <runtime_clock> block), in the SESSION zone the client declared. A prompt-
// string unit test alone is NOT an output-behavior test; this exercises the
// actual route → payload path. MHR (2026-11-05 — DELIBERATE evolution): the
// loop is now armed on EVERY progress turn including this one (capability,
// not intent) — the honest zero-search proof moved from gate frames to the
// engine counter + single-fetch throw.
describe("golden: pure clock turn (brief §5 — quiet clock, zero search traffic)", () => {
  it("06 clock question — no retrieval, no evidence, quiet-clock law in the live request", async () => {
    HARNESS.mode = "normal";
    ENGINE_CALLS.n = 0;
    const calls = installUpstream([CHAT_UPSTREAM]);
    const run = await runChat(
      POST as never,
      JSON.stringify({
        model: "strata-mock",
        messages: [{ role: "user", content: "What time is it?" }],
        timezone: "Asia/Kolkata",
      }),
    );
    expect(run.status).toBe(200);
    const logical = parseLogical(maskVolatile(run.text));
    expect(logical.done).toBe(true);
    // (a) Zero retrieval: the loop is ARMED (capability) but never fires a
    // tool round (web:tools rides tool rounds ONLY), no web_meta (empty
    // ledger), and the ONLY upstream fetch in the whole request is the
    // single chat answer round — installUpstream throws on any extra fetch,
    // so this IS the zero-engine + zero-gate-model proof. ENGINE_CALLS=0
    // proves no search pipeline touched the scripted pool.
    expect(calls.length).toBe(1);
    expect(ENGINE_CALLS.n).toBe(0);
    const seq = stages(logical.frames);
    expect(seq).toEqual(["decision_done"]);
    expect(seq.some((s) => s?.startsWith("web:"))).toBe(false);
    expect(logical.frames.some((f) => f.kind === "stage" && (f.obj as { stage?: string }).stage === "web_meta")).toBe(false);
    expect(run.headers["x-web-citations"]).toBeUndefined();

    // (b) The real model-request shape: the quiet-clock law rides the turn.
    // The captured body is the RAW upstream request (JSON text), so static
    // law lines are asserted in their JSON-escaped form (esc()).
    const body = calls[0].body!;
    const esc = (s: string) => JSON.stringify(s).slice(1, -1);
    expect(calls[0].url).toBe(MOCK_LLM_URL);
    expect(body.includes("<runtime_clock>")).toBe(true);
    expect(body.includes("session timezone: Asia/Kolkata (IANA).")).toBe(true);
    // The exact §5 law lines (⇔ clock.rs build_clock_text mirror; both are
    // byte-pinned by the clock unit tests — this proves they reach the
    // ANSWERING model's request, not just the unit fixtures):
    expect(
      body.includes(
        esc(
          'Use this clock silently as background context: resolve "today", "now", "this week", or staleness against it WITHOUT announcing the date, time, or timezone. Do not greet with or otherwise state the current date/time unless the user asks for it, an as-of date materially helps the answer, or you need to explain a temporal ambiguity.',
        ),
      ),
    ).toBe(true);
    expect(
      body.includes(
        esc(
          "The clock does NOT update your knowledge of the outside world: facts that change over time (prices, releases, officeholders, news, availability) still need a web search when verification matters — never answer them from this line alone.",
        ),
      ),
    ).toBe(true);
    // No OLD conflation law ("never a web search" for staleness) may survive:
    expect(body.includes(esc("never a web search — whenever"))).toBe(false);

    const payload = anchorSkillBlocks(JSON.parse(body)).payload as {
      messages: { role: string; content: unknown }[];
      tools?: { function: { name: string } }[];
    };
    // The user turn is never rewritten. MHR (2026-11-05): the turn NOW arms
    // the tool loop — guidance leads (skill slot), the clock follows the
    // user turn, payload.tools is present (capability, never an action);
    // still NO evidence block and no retrieval happened.
    expect(payload.messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
    expect(payload.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    expect(payload.messages[1].content).toBe("What time is it?");
    expect(String(payload.messages[2].content).startsWith("<runtime_clock>")).toBe(true);
    expect(payload.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
    expect(payload.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);
    // And no answer-content fabrication: the scripted answer streams through.
    expect(run.text).toContain("search answer");
  });
});

describe("golden: current-turn image capture survives injections (brief §3)", () => {
  it("07 skill + evidence injections never drop the turn's image parts", async () => {
    // ⇔ the Rust unit test current_turn_image_parts_survive_skill_and_evidence_injections.
    // Real injections via the REAL injectSystemBefore (lib/skills/lazy) —
    // step 4 (decision skill) injects AT lastUserIdx and step 5 (attachment
    // evidence) at lastUserIdx + 1, each shifting the user turn down. The
    // pre-fix raw read `messages[lastUserIdx]` then landed on the injected
    // SYSTEM block: hasImageAttachment flipped false, imageDataUrls went
    // empty, and the image+lookup-intent gate bypass died silently.
    const { resolveTurnIndex, turnImageParts } = await import("@/app/api/chat/route");
    const imageTurn = {
      role: "user",
      content: [
        { type: "text", text: "Attached file: notes.txt\nwho is this person?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    };
    const lastUserIdx = 2;
    const messages: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      imageTurn,
    ];

    // No injections: the entry index already IS the user turn.
    expect(resolveTurnIndex(messages, lastUserIdx)).toBe(lastUserIdx);

    // Step 4 at lastUserIdx, step 5 at lastUserIdx + 1 → user shift +2.
    injectSystemBefore(messages, lastUserIdx, "<core_skill>…");
    injectSystemBefore(messages, lastUserIdx + 1, "<attachment_evidence>…");
    // The defect this fix kills: the RAW slot is now a SYSTEM block with
    // zero image parts — proving the test would have caught the old bug.
    expect(messages[lastUserIdx].role).toBe("system");
    expect(turnImageParts(messages[lastUserIdx]?.content)).toEqual([]);
    const idx = resolveTurnIndex(messages, lastUserIdx);
    expect(idx).toBe(lastUserIdx + 2);
    expect(messages[idx].role).toBe("user");
    expect(turnImageParts(messages[idx]?.content)).toEqual(["data:image/png;base64,AAA"]);

    // Skill injection alone (no evidence): single shift.
    const one: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      imageTurn,
    ];
    injectSystemBefore(one, lastUserIdx, "<core_skill>…");
    expect(resolveTurnIndex(one, lastUserIdx)).toBe(lastUserIdx + 1);
    expect(turnImageParts(one[lastUserIdx + 1]?.content)).toEqual(["data:image/png;base64,AAA"]);
  });
});
