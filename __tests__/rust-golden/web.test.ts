/**
 * Golden corpus — web-search pipeline through /api/chat (MIGRATION-MAP §6
 * frozen scenarios 11/12/13: web-search SUCCESS (stages + evidence block +
 * web_meta + citations), web-search FAILURE (non-fatal), image/vision turn).
 *
 * Determinism seams (the ONLY things mocked; everything else runs REAL —
 * search-gate, query-planner, metasearch RRF + relevance floor, extractor
 * tier cascade, BM25 reranker, coverage/gap evaluator):
 *   - @/lib/web-search/cache  : all cache reads MISS (kills better-sqlite3
 *     native + cross-run TTL pollution; the fixture corpus never shares a DB).
 *   - @/lib/web-search/net    : scripted page fetches (kills impit /
 *     got-scraping / wreq native layers and ALL real network; fetchUrl ->
 *     null so metasearch's local verticals — wikipedia/HN/arXiv/SE/wikidata/
 *     semantic-scholar/IMDb — all return [] deterministically).
 *   - @/lib/web-search/engines: the general-web SERP pool is scripted;
 *     deduplicateQueries / engineCooldownRemainingMs stay REAL.
 *   - @/lib/web-search/agentBrowser: the extractor's stealth-Chromium
 *     browser tier is scripted (P7 hermeticity fix 2026-11-02). Before it,
 *     SERP URL #5 (old.reddit.com — a REAL live domain with no Tier-1 page)
 *     escalated to a LIVE Chromium session every run, and the live site's
 *     oscillating state (login-wall ARIA snapshot vs. Chromium error page)
 *     silently re-pinned the golden bytes — the "long-standing environmental
 *     flake" the old 30000ms timeout comment documented.
 *
 * CONTRACT DISCOVERIES pinned here (recorded, NOT fixed — §8):
 *   - runVisionEntityPrepass (lib/web-search/vision-prepass.ts) has ZERO call
 *     sites: the "Vision-to-Search pre-pass" documented in the route comment
 *     at app/api/chat/route.ts and in query-planner docs NEVER RUNS. Image
 *     parts still feed SearchGateContext (hasImageAttachment/imageDataUrls),
 *     which arms the Stage-0 image-intent bypass — but no vision LLM call is
 *     ever made, and entityHints are ALWAYS undefined into planQueries.
 *   - The web evidence block is injected at lastUserIdx + 1 unconditionally
 *     (same off-by-one family as the attachments block): with NO skill block
 *     the evidence system message lands AFTER the user turn.
 *   - search-gate.ts deterministicHardBypass: KNOWN_SITE_TOKEN_RE and
 *     DOMAIN_TLD_TOKEN_RE are dead code (defined, never referenced).
 *   - The web gate NEVER runs the main model on these fixtures: every prompt
 *     hits the Stage-0 deterministic hard bypass (zero LLM calls besides the
 *     single chat forward, gateMs 0).
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

setGoldenEnv({ webSearchDisabled: false });

// Harness knobs the mocks read at CALL time (set per fixture).
const HARNESS = { mode: "normal" as "normal" | "starved" | "throw-cache" };

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
  getCachedQuery: () => {
    if (HARNESS.mode === "throw-cache") throw new Error("golden: injected cache failure");
    return null;
  },
  putCachedQuery: () => {},
  getCachedPage: () => null,
  putCachedPage: () => {},
  closeCache: () => {},
}));

vi.mock("@/lib/web-search/engines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search/engines")>();
  const empty = async () => [] as never;
  return {
    ...actual, // deduplicateQueries, engineCooldownRemainingMs, caps stay real
    ddgSearch: empty, yahooSearch: empty, googleSearch: empty, braveSearch: empty,
    redditSearch: empty, bingSearch: empty, bingNewsRssSearch: empty,
    githubSearch: empty, devToSearch: empty,
    runGeneralWebSearch: async () => (HARNESS.mode === "starved" ? [] : SERP),
    runGeneralWebSearchSharded: async () => (HARNESS.mode === "starved" ? [] : SERP),
  };
});

// Page bytes served to the extractor Tier-1 (net.fetchPage). Deterministic
// hand-written articles; universal-extractor's HTML->markdown conversion is
// pure CPU, so the resulting evidence block is byte-stable across machines.
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

const ENV_PRE = {
  WEB_SEARCH_GATE_DISABLED: "unset",
  WEB_SEARCH_LFM_DISABLED: "unset",
  settings_llm_override: MOCK_LLM_URL,
  web_mock_boundary: "cache(miss-only), net(scripted pages, fetchUrl=null), engines(scripted SERP), agentBrowser(scripted browser tier: golden1 rendered, every other URL misses)",
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
  mode?: "normal" | "starved" | "throw-cache";
  notes?: string;
}) {
  HARNESS.mode = o.mode ?? "normal";
  const calls = installUpstream([CHAT_UPSTREAM]);
  const run = await runChat(POST as never, o.rawBody);
  const logical = parseLogical(run.text);
  const hasStage = logical.frames.some((f) => f.kind === "stage");
  const upstreamCalls = calls.map((c) => {
    const bodyText = c.body === null ? null : maskRuntimeClock(c.body);
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
        ? { bodyMsNormalized: normalizeBodyMs(run.text), note: "stage frames carry volatile ms digits; compare logicalFrames + bodyMsNormalized" }
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
    normalization: 'Stage-event "ms" timing values replaced with "<ms>" in logicalFrames; progress-path bodies are ms-normalized text. P1 (2026-11-01): the live <runtime_clock> system block carries wall-clock text, so its content is MASKED in bodyText/bodyJson (the clock text itself is pinned by clock unit tests).',
    notes: o.notes,
  });
  return { run, logical, upstreamCalls };
}

const stages = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  frames.filter((f) => f.kind === "stage").map((f) => (f.obj as { stage?: string }).stage);
const stageFrames = (frames: ReturnType<typeof parseLogical>["frames"]) =>
  frames.filter((f) => f.kind === "stage").map((f) => f.obj as Record<string, unknown>);

describe("golden: web-search pipeline", () => {
  beforeAll(() => {
    HARNESS.mode = "normal";
  });

  // FULLY HERMETIC since the P7 browser-tier fix (2026-11-02): the old
  // live-stealth-Chromium cliff (the documented long-standing flake) is gone
  // — see the agentBrowser entry in the header seams list. The 30000ms is
  // now only slow-machine headroom for the §11 progressive read batches;
  // every byte comparison still runs and still fails hangs.
  it("01 search success — progress path (stages, evidence block, web_meta)", { timeout: 30000 }, async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/01-search-success-progress.json",
      scenario: "web search SUCCESS: deterministic hard-bypass gate -> full pipeline (progress path)",
      semantics:
        "Gate Stage-0 hard bypass (WEB_INTENT_RE 'latest') decides WITHOUT any model call: search_required true, " +
        "freshness week (newsy), depth standard, one keyword query, source 'deterministic', gateMs 0. Pipeline " +
        "streams web:gate -> web:planning -> web:searching -> web:reading(+progress) -> web:reranking -> web:done " +
        "as ruke_stage frames with stage names prefixed 'web:' (the web_meta frame follows web:done and is NOT " +
        "'web:'-prefixed). P2 (2026-11-02): the bundle arms the model-facing web tool " +
        "loop — WEB_TOOL_GUIDANCE rides as the FIRST system block (skill-slot law: " +
        "immediately before the last user turn) and payload.tools carries the read-only " +
        "web_search/read_page surface. The scripted upstream never ends a round with " +
        "finish_reason 'tool_calls', so the loop still makes exactly ONE upstream call " +
        "and the single-[DONE] grammar is unchanged. Message chain: guidance, user, " +
        "runtime_clock, evidence. One evidence system message is injected at " +
        "lastUserIdx+1 (CONTRACT DISCOVERY: with no skill block that index is AFTER the user turn — same " +
        "off-by-one family as the attachments block; recorded, not fixed). The block = ANTI_REFUSAL_DIRECTIVE + " +
        "'\\n\\n' + evidenceBlock() and is pinned VERBATIM: the <evidence> header, the 8 guideline bullets, the " +
        "CLOSING </evidence> tag BEFORE any [S#] line (LAYOUT QUIRK: passages are appended AFTER the closing tag, " +
        "so </evidence> never ends the message), then [S#] source lines with '(published ...)' suffix and quoted " +
        "excerpts (4000-char cap, whitespace-collapsed, '(BM25=x.xx)' suffix) — its bytes derive ONLY from the scripted SERP + scripted pages, so Rust must reproduce it " +
        "byte-for-byte from the same inputs. The last user turn is UNCHANGED (content stays a plain string). " +
        "web_meta frame carries the full citation map (sourceId -> {sourceId,url,title,domain,publishedAt}) and " +
        "searchGate {depth,freshness,decidedBy,queries[{query,intent}]}. Progress response headers NEVER carry " +
        "X-Web-Citations/X-Search-Gate.",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      notes:
        "Mock boundary: cache always-miss; net scripted (fetchUrl=null kills local verticals); engines SERP " +
        "scripted, agentBrowser browser tier scripted. Everything else (gate/planner/metasearch " +
        "RRF+floor/extractor/BM25/coverage) runs REAL and deterministic. The 4th SERP result has no Tier-1 " +
        "page and misses the scripted browser tier + Jina/wayback tail -> its packet keeps only the " +
        "SERP-snippet baseline passage (FAIL_NETWORK_OR_CRASH classification) yet still gets cited. The 5th " +
        "SERP result (reddit URL) has no Tier-1 page but a scripted browser-tier render -> SUCCESS_BROWSER. " +
        "Vision pre-pass NEVER runs (runVisionEntityPrepass has zero call sites — dead module).",
    });
    expect(run.status).toBe(200);
    const seq = stages(logical.frames);
    expect(seq[0]).toBe("decision_done");
    const webSeq = seq.filter((s) => s?.startsWith("web:"));
    expect(webSeq[0]).toBe("web:gate");
    expect(webSeq[1]).toBe("web:planning");
    expect(webSeq[2]).toBe("web:searching");
    expect(webSeq).toContain("web:reading");
    expect(webSeq).toContain("web:reranking");
    expect(webSeq[webSeq.length - 1]).toBe("web:done");
    expect(webSeq.filter((s) => s === "web:done").length).toBe(1);
    expect(run.headers["x-web-citations"]).toBeUndefined();
    expect(run.headers["x-search-gate"]).toBeUndefined();

    const webMeta = logical.frames
      .map((f) => (f.kind === "stage" ? (f.obj as Record<string, unknown>) : null))
      .filter((o) => o && o.stage === "web_meta");
    expect(webMeta.length).toBe(1);
    const citations = webMeta[0]!.webCitations as Record<string, { sourceId: string; url: string; title: string; domain: string; publishedAt?: string }>;
    expect(Object.keys(citations).length).toBeGreaterThanOrEqual(3);
    const sg = webMeta[0]!.searchGate as { depth: string; freshness: string; decidedBy: string; queries: { query: string; intent: string }[] };
    expect(sg.decidedBy).toBe("deterministic");
    expect(sg.depth).toBe("standard");
    expect(sg.freshness).toBe("week");
    expect(sg.queries.length).toBeGreaterThanOrEqual(1);

    // single LLM call: no gate model, no vision pre-pass; the tool loop
    // closed after one answer round (no tool_calls in the script)
    expect(upstreamCalls.length).toBe(1);
    const payload = upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[] };
    const roles = payload.messages.map((m) => m.role);
    const evidenceIdx = payload.messages.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("<evidence>"),
    );
    expect(evidenceIdx).toBeGreaterThanOrEqual(0);
    const evidenceBlock = payload.messages[evidenceIdx].content as string;
    // ANTI_REFUSAL_DIRECTIVE is prepended whenever the bundle has passages,
    // so the block NEVER starts with "<evidence>" (buildMainModelContext).
    // (audit 2026-11-04) the directive was rewritten to honest evidence-
    // level wording ("IMPORTANT: Before this turn the server attempted live
    // web retrieval…" ⇔ pipeline.ts ANTI_REFUSAL_DIRECTIVE); stale pin
    // refreshed to the CURRENT constant's lead-in — pin verbatim again.
    expect(evidenceBlock.includes("IMPORTANT: Before this turn the server attempted live web retrieval")).toBe(true);
    expect(evidenceBlock.indexOf("<evidence>")).toBeLessThan(evidenceBlock.indexOf("</evidence>"));
    // LAYOUT QUIRK: </evidence> closes the GUIDELINE header only; the [S#]
    // source lines + quoted excerpts are appended AFTER the closing tag.
    expect(evidenceBlock.indexOf("</evidence>")).toBeLessThan(evidenceBlock.indexOf("[S1]"));
    expect(evidenceBlock).toContain('    "');
    expect(evidenceBlock).toMatch(/\(BM25=\d+\.\d{2}\)/);
    // The user turn itself is never rewritten by the web pipeline.
    const lastUser = payload.messages.filter((m) => m.role === "user").pop();
    expect(lastUser!.content).toBe("what is the latest roadmap news for project nimbus");
    // CONTRACT DISCOVERY: off-by-one injection index -> evidence AFTER the user
    // turn. P1 (2026-11-01): the live-clock injection adds one system block
    // ahead of the evidence block. P2 (2026-11-02): the bundle arms the web tool
    // loop — guidance leads the chain (skill slot) and the read-only tool
    // surface rides the payload; the contract (evidence directly after the user
    // turn chain) still holds.
    expect(roles).toEqual(["system", "user", "system", "system"]);
    expect(payload.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    expect(String(payload.messages[2].content).startsWith("<runtime_clock>")).toBe(true);
    expect(evidenceIdx).toBe(3);
    const tools = (upstreamCalls[0].bodyJson as { tools?: { function: { name: string } }[] }).tools;
    expect(tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);
  });

  // browser tier scripted (P7) — headroom budget, see note on test 01
  it("02 search success — legacy path headers (X-Web-Citations / X-Search-Gate)", { timeout: 30000 }, async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/02-search-success-legacy-headers.json",
      scenario: "web search SUCCESS (legacy stream:false path): ZERO stage frames; citations travel as headers",
      semantics:
        "Same pipeline run with stream:false: runTurnPipeline still runs (stage callbacks dropped), the evidence " +
        "block still lands in the upstream payload, but the response contains NO ruke_stage/web_meta frames. " +
        "Metadata surfaces ONLY as response headers: X-Web-Citations = encodeURIComponent(JSON.stringify(citation " +
        "map)) and X-Search-Gate = encodeURIComponent(JSON.stringify(searchGate meta)) — emitted ONLY when the " +
        "map is non-empty. Response body bytes are byte-exact (legacy forward, no stage noise). The legacy " +
        "headers carry upstream content-type 'application/json'.",
      comparison: "byte-exact",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", false),
    });
    expect(logical.frames.some((f) => f.kind === "stage")).toBe(false);
    expect(run.headers["x-web-citations"]).toBeTruthy();
    expect(run.headers["x-search-gate"]).toBeTruthy();
    const citations = JSON.parse(decodeURIComponent(run.headers["x-web-citations"]));
    expect(Object.keys(citations).length).toBeGreaterThanOrEqual(3);
    const gate = JSON.parse(decodeURIComponent(run.headers["x-search-gate"]));
    expect(gate.decidedBy).toBe("deterministic");
    expect(upstreamCalls.length).toBe(1);
    const payload = upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[] };
    // Same ANTI_REFUSAL-prepended block as fixture 01 (preamble, not the <evidence> header, leads the content).
    expect(payload.messages.some((m) => m.role === "system" && String(m.content).includes("<evidence>"))).toBe(true);
  });

  it("03 search starved — non-fatal, 'No web evidence' block, NO web_meta", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/03-search-starved-progress.json",
      scenario: "web search engine pool returns ZERO results (starved; non-fatal)",
      semantics:
        "All engines return []: the relevance floor fires web:recovery (broad retry, still empty), then " +
        "web:done('No search results returned') — runWebResearch returns a NON-NULL empty bundle. The route " +
        "still injects the EXACT sentinel block 'No web evidence could be retrieved. Proceed with your "
        + "knowledge only.' (no ANTI_REFUSAL preamble — topPassages empty) at lastUserIdx+1, but the empty " +
        "citation map means NO web_meta frame and NO citation headers. P2 (2026-11-02): even the starved " +
        "bundle arms the web tool loop — WEB_TOOL_GUIDANCE leads the message chain (guidance, user, " +
        "runtime_clock, sentinel) and payload.tools offers web_search/read_page, so the model may retry " +
        "research itself; the scripted answer round never calls tools, so still exactly ONE upstream call. " +
        "The chat forward + [DONE] are unaffected: " +
        "a starved search NEVER turns into an error frame.",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      mode: "starved",
    });
    const seq = stages(logical.frames);
    expect(seq).toContain("web:recovery");
    expect(seq.filter((s) => s === "web:done").length).toBe(1);
    expect(seq.some((s) => s === "web:reading" || s === "web:reranking")).toBe(false);
    expect(logical.frames.some((f) => f.kind === "stage" && (f.obj as { stage?: string }).stage === "web_meta")).toBe(false);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
    const payload = upstreamCalls[0].bodyJson as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
    expect(payload.messages.some((m) => m.role === "system" && m.content === "No web evidence could be retrieved. Proceed with your knowledge only.")).toBe(true);
    // P2: a starved bundle still arms the tool loop — the model can retry.
    expect(payload.messages.map((m) => m.role)).toEqual(["system", "user", "system", "system"]);
    expect(payload.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    expect(payload.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);
  });

  it("04 search pipeline throws — route catch keeps the chat alive (non-fatal)", async () => {
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/04-search-throw-nonfatal-progress.json",
      scenario: "web-search internals THROW mid-pipeline (cache read failure): route catch, NO evidence, NO web_meta",
      semantics:
        "getCachedQuery throws inside runWebResearch after the web:searching stage frame: the route's try/catch " +
        "logs and CONTINUES — no evidence block is injected, no web_meta frame, no error frame; stage frames " +
        "emitted BEFORE the throw survive verbatim. This pins the route-side non-fatal contract independently " +
        "of the starved case (03), which never throws. The upstream forward is a clean single call with the " +
        "unmodified messages array.",
      comparison: "structural",
      rawBody: chatBody("what is the latest roadmap news for project nimbus", undefined),
      mode: "throw-cache",
    });
    const seq = stages(logical.frames);
    expect(seq).toEqual(["decision_done", "web:gate", "web:planning", "web:searching"]);
    expect(logical.frames.some((f) => f.kind === "error")).toBe(false);
    expect(logical.done).toBe(true);
    const payload = upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[] };
    // P1 (2026-11-01): user turn + the live-clock system block; still NO evidence block.
    expect(payload.messages.length).toBe(2);
    expect(payload.messages.some((m) => String(m.content).includes("<evidence>"))).toBe(false);
  });

  // browser tier scripted (P7) — headroom budget, see note on test 01
  it("05 image attachment — Stage-0 image-intent gate, vision pre-pass DEAD, parts passthrough", { timeout: 30000 }, async () => {
    const text = "who is this person";
    const imgUrl = "data:image/jpeg;base64,Z29sZGVuLWltYWdlLWJ5dGVz";
    const content = [
      { type: "text", text },
      { type: "image_url", image_url: { url: imgUrl } },
    ];
    const { run, logical, upstreamCalls } = await runAndRecord({
      rel: "web-search/05-image-attachment-intent-gate-progress.json",
      scenario: "image attachment turn: hasImageAttachment arms the image-intent hard bypass; NO vision pre-pass call",
      semantics:
        "turnImageParts collects image_url data URLs from the last user turn -> SearchGateContext." +
        "hasImageAttachment=true, so deterministicHardBypass fires hit='image_intent' (IMAGE_LOOKUP_INTENT_RE " +
        "'who is ... person') with ZERO model calls. CONTRACT DISCOVERY: runVisionEntityPrepass is DEAD " +
        "(zero call sites) — no vision LLM fetch ever happens and planner entityHints stay undefined. The user " +
        "turn passes through to the upstream UNCHANGED (content array + data URL byte-identical), and the " +
        "evidence/web_meta/citation behavior matches fixture 01's shape (P2 chain: guidance, user, " +
        "runtime_clock, evidence; tool surface injected; citations map). " +
        "Exactly ONE upstream call is made for the whole request.",
      comparison: "structural",
      rawBody: chatBody(content, undefined),
      notes:
        "upstreamCalls.length === 1 is the vision pre-pass DEAD proof: had the documented pre-pass run, a " +
        "vision completion would appear on the scripted fetch before the chat forward (installUpstream throws " +
        "on any extra fetch).",
    });
    expect(run.status).toBe(200);
    const sgFrame = logical.frames
      .map((f) => (f.kind === "stage" ? (f.obj as Record<string, unknown>) : null))
      .find((o) => o && o.stage === "web_meta");
    expect(sgFrame).toBeTruthy();
    const sg = sgFrame!.searchGate as { decidedBy: string };
    expect(sg.decidedBy).toBe("deterministic");
    expect(upstreamCalls.length).toBe(1);
    const payload = upstreamCalls[0].bodyJson as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    const userTurn = payload.messages.find((m) => m.role === "user");
    expect(userTurn!.content).toEqual(content); // parts + data URL untouched
    // P2: image-intent turns get the same tool-loop treatment as fixture 01.
    expect(payload.messages[0].content).toBe(WEB_TOOL_GUIDANCE);
    expect(payload.tools?.map((t) => t.function.name)).toEqual(["web_search", "read_page"]);
    const seq = stages(logical.frames);
    expect(seq[0]).toBe("decision_done");
    expect(seq).toContain("web:gate");
    expect(seq).toContain("web:done");
  });
});
