/**
 * P2 model-facing web tools — SHARED VECTOR SUITE (lib/web-search/tools.ts).
 *
 * TS is the sole owner of everything pinned here (TS-ownership rollback
 * 2026-11-03): the Rust counterpart `crates/ruke-websearch/src/tools.rs`
 * was removed. What stays cross-language is the guidance/directive byte
 * parity against the Rust transport's fallback consts in
 * `crates/ruke-server/src/chat/web_loop.rs` — the Rust loop may inline
 * those bytes if the create-RPC omits them, so they must stay identical:
 *   failure classifier vectors .. TS-only classifier table
 *   budget table ................ TS-only budget pins
 *   definition bounds ........... TS-only model-tools shape
 *   byte probes ................. web-tool-loop.ts ⇔ ruke-server web_loop.rs
 * The exec tests run against mocked retrieval seams (metasearch/extractor/
 * ssrf/segment-filter) so the ENVELOPE CONTRACT — structured failures,
 * budget accounting, [S#] numbering, §11.18 URL routing — is what gets
 * pinned, never live network behavior.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const mocks = vi.hoisted(() => ({
  metasearch: vi.fn(),
  extractUrl: vi.fn(),
  applySegmentFilter: vi.fn(),
  isSafeUrlWithDns: vi.fn(),
}));

vi.mock("@/lib/web-search/metasearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/metasearch")>()),
  metasearch: mocks.metasearch,
}));
vi.mock("@/lib/web-search/extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/extractor")>()),
  extractUrl: mocks.extractUrl,
}));
vi.mock("@/lib/web-search/segment-filter", () => ({
  applySegmentFilter: mocks.applySegmentFilter,
}));
vi.mock("@/lib/web-search/ssrf", () => ({
  isSafeUrlWithDns: mocks.isSafeUrlWithDns,
}));

import {
  classifyRetrievalFailure,
  webToolBudgetFor,
  makeWebToolSession,
  remainingBudget,
  webToolDefinitions,
  execWebSearchTool,
  execReadPageTool,
  WEB_SEARCH_TOOL_DESCRIPTION,
  READ_PAGE_TOOL_DESCRIPTION,
  WEB_TOOL_MAX_ROUNDS_CAP,
  type WebToolSession,
  type CitationSeed,
} from "@/lib/web-search/tools";
// The guidance constants live in the LOOP module; import them from there so
// the probe pins the bytes the loop actually sends (⇔ Rust tools.rs).
import { WEB_TOOL_GUIDANCE, WEB_TOOL_FINAL_DIRECTIVE } from "@/lib/chat/web-tool-loop";
import { scopeHosts, type TaskScope } from "@/lib/decision/task-scope";

const ROOT = path.resolve(__dirname, "..", "..");
const TS_TOOLS = path.join(ROOT, "lib", "web-search", "tools.ts");
const TS_LOOP = path.join(ROOT, "lib", "chat", "web-tool-loop.ts");
const RUST_LOOP = path.join(ROOT, "rust-backend", "crates", "ruke-server", "src", "chat", "web_loop.rs");

function readSrc(file: string): string {
  // CRLF-normalize: parity is about the TEXT bytes; the checkout line-ending
  // policy applies uniformly to both files (same law as retrieval-quality).
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function expectOnceIn(file: string, probe: string, label: string): void {
  const occurrences = readSrc(file).split(probe).length - 1;
  expect(occurrences, `${path.basename(file)}: ${label} must appear exactly once (found ${occurrences})`).toBe(1);
}

/* ── classifyRetrievalFailure (⇔ rust classify_retrieval_failure_vectors) ─ */

describe("classifyRetrievalFailure shared vectors (⇔ rust tools.rs)", () => {
  const VECTORS: Array<[Record<string, unknown>, string]> = [
    // 1. aborted outranks everything
    [{ aborted: true }, "cancelled"],
    [{ aborted: true, status: 500, errorMessage: "captcha" }, "cancelled"],
    // 2. extractor classification map
    [{ classification: "FAIL_SILENT_LOGIN_WALL" }, "auth_required"],
    [{ classification: "FAIL_SILENT_LOGIN_WALL", status: 403 }, "auth_required"],
    [{ classification: "FAIL_SILENT_BOT_BLOCK" }, "captcha_required"],
    [{ classification: "PAGE_BODGET_PLACEHOLDER_NOT_A_REAL_CODE" }, "parse_failure"],
    [{ classification: "PAGE_BUDGET_TIMEOUT" }, "timeout"],
    // classification map beats the HTTP status bucket (js shell on a 599)
    [{ classification: "FAIL_EMPTY_JS_SHELL", status: 599 }, "parse_failure"],
    // 3. message needles (order: unsafe→robots→captcha→rate→auth→size→mime→dns→timeout)
    [{ errorMessage: "SSRF guard rejected resolved address" }, "unsafe_destination"],
    [{ errorMessage: "the destination is unsafe" }, "unsafe_destination"],
    [{ errorMessage: "robots.txt disallows this path" }, "robots_denied"],
    [{ errorMessage: "HTTP 403 Forbidden — captcha challenge required", status: 403 }, "captcha_required"],
    [{ errorMessage: "challenge page: select all traffic lights", status: 429 }, "captcha_required"],
    [{ errorMessage: "Too Many Requests" }, "rate_limited"],
    [{ errorMessage: "upstream rate-limit tripped" }, "rate_limited"],
    [{ errorMessage: "429 upstream" }, "rate_limited"],
    [{ errorMessage: "401 Unauthorized" }, "auth_required"],
    [{ errorMessage: "response body too large" }, "content_too_large"],
    [{ errorMessage: "maxBodyLengthExceeded" }, "content_too_large"],
    [{ errorMessage: "unsupported MIME type application/pdf" }, "unsupported_mime"],
    [{ errorMessage: "getaddrinfo ENOTFOUND foo.invalid" }, "dns_failure"],
    [{ errorMessage: "connect ETIMEDOUT 1.2.3.4:443" }, "timeout"],
    [{ errorMessage: "deadline exceeded" }, "timeout"],
    // needle scan runs BEFORE the status bucket: a 500 whose message says
    // "dns" is a dns_failure, not http_status
    [{ errorMessage: "temporary DNS outage during resolution", status: 500 }, "dns_failure"],
    // 4/5. status bucket + network-or-crash default
    [{ status: 500 }, "http_status"],
    [{ status: 404, errorMessage: "page shape unrecognized" }, "http_status"],
    [{ classification: "FAIL_NETWORK_OR_CRASH" }, "http_status"],
    [{ status: 499, classification: "FAIL_NETWORK_OR_CRASH" }, "http_status"],
    // 6. fallback
    [{}, "parse_failure"],
    [{ errorMessage: "socket hang up" }, "parse_failure"],
    [{ status: 200 }, "parse_failure"],
  ];
  for (const [probe, expected] of VECTORS) {
    it(`⇔ rust: ${JSON.stringify(probe)} → ${expected}`, () => {
      expect(classifyRetrievalFailure(probe as never)).toBe(expected);
    });
  }
});

/* ── budget table (⇔ rust budget_table_pins) ────────────────────────────── */

describe("depth budget table (⇔ rust budget_for_depth)", () => {
  it("pins every depth row exactly", () => {
    expect(webToolBudgetFor("quick")).toEqual({ maxSearchCalls: 1, maxReadUrls: 6, maxToolRounds: 2 });
    expect(webToolBudgetFor("standard")).toEqual({ maxSearchCalls: 2, maxReadUrls: 12, maxToolRounds: 4 });
    expect(webToolBudgetFor("deep")).toEqual({ maxSearchCalls: 4, maxReadUrls: 20, maxToolRounds: 6 });
    expect(WEB_TOOL_MAX_ROUNDS_CAP).toBe(20);
  });

  it("remainingBudget counts down and clamps at zero", () => {
    const s = makeWebToolSession("standard", 1, "q");
    expect(remainingBudget(s)).toEqual({ searches: 2, readUrls: 12, rounds: 4 });
    s.searchesUsed = 5; // overspend must not go negative
    s.roundsUsed = 4;
    expect(remainingBudget(s)).toEqual({ searches: 0, readUrls: 12, rounds: 0 });
  });

  it("session seeds [S#] continuation and clips the focus context", () => {
    const s = makeWebToolSession("quick", 0, "x".repeat(900));
    expect(s.nextSource).toBe(1); // Math.max(1, seed)
    expect(s.queryContext.length).toBe(500);
    expect(s.searchSessionId).toMatch(/^ws-[a-z0-9]+$/);
    expect(makeWebToolSession("quick", 9, "q").nextSource).toBe(9);
  });
});

/* ── model-visible definitions (⇔ rust model_tools_shape_pins) ─────────── */

describe("webToolDefinitions shape (⇔ rust model_tools)", () => {
  it("pins the tool surface, required sets, and bounds exactly", () => {
    const defs = webToolDefinitions();
    expect(defs.map((d) => d.function.name)).toEqual(["web_search", "read_page"]);

    const ws = defs[0].function.parameters as Record<string, any>;
    const rp = defs[1].function.parameters as Record<string, any>;
    expect(ws.required).toEqual(["queries", "missing_claims"]);
    expect(ws.additionalProperties).toBe(false);
    expect([ws.properties.queries.minItems, ws.properties.queries.maxItems]).toEqual([1, 4]);
    expect([ws.properties.missing_claims.minItems, ws.properties.missing_claims.maxItems]).toEqual([1, 6]);
    expect(ws.properties.freshness.enum).toContain("realtime");
    expect(ws.properties.desired_source_types.items.enum).toEqual(["general", "news", "docs", "code", "academic", "forum"]);
    expect(rp.required).toEqual(["urls"]);
    expect(rp.additionalProperties).toBe(false);
    expect([rp.properties.urls.minItems, rp.properties.urls.maxItems]).toEqual([1, 8]);
    expect([rp.properties.timeoutMs.minimum, rp.properties.timeoutMs.maximum]).toEqual([1000, 60000]);
  });
});

describe("prompt/description byte pins (TS sole owner; guidance / directive ⇔ Rust transport fallback)", () => {
  it("tool descriptions appear exactly once in tools.ts", () => {
    for (const text of [WEB_SEARCH_TOOL_DESCRIPTION, READ_PAGE_TOOL_DESCRIPTION]) {
      expectOnceIn(TS_TOOLS, text, "tool description");
    }
  });

  it("every guidance line appears exactly once in web-tool-loop.ts AND web_loop.rs", () => {
    for (const line of WEB_TOOL_GUIDANCE.split("\n")) {
      expectOnceIn(TS_LOOP, line, "guidance line");
      expectOnceIn(RUST_LOOP, line, "guidance line");
    }
  });

  it("the final directive appears exactly once in web-tool-loop.ts AND web_loop.rs", () => {
    expectOnceIn(TS_LOOP, WEB_TOOL_FINAL_DIRECTIVE, "final directive");
    expectOnceIn(RUST_LOOP, WEB_TOOL_FINAL_DIRECTIVE, "final directive");
  });

  it("queries param description appears exactly once in tools.ts", () => {
    const probe = "new keyword-form searches (3-6 keywords each); never repeat a query already run this turn";
    expectOnceIn(TS_TOOLS, probe, "queries param description");
  });
});

/* ── executors: envelope contract against mocked retrieval seams ───────── */

function ranked(url: string, over: Record<string, unknown> = {}) {
  return {
    url,
    canonical: url,
    title: "T",
    snippet: "S",
    domain: new URL(url).hostname,
    engine: "brave",
    rrf: 0.5,
    engines: ["brave"],
    engineRanks: { brave: 1 },
    ...over,
  } as any;
}

function packet(over: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/a",
    title: "Page Title",
    domain: "example.com",
    extraction: "jina",
    passages: [{ passageText: "hello world passage" }],
    ...over,
  } as any;
}

function session(depth: "quick" | "standard" | "deep" = "standard", seed = 1): WebToolSession {
  return makeWebToolSession(depth, seed, "the user question focus");
}

beforeEach(() => {
  mocks.metasearch.mockReset();
  mocks.metasearch.mockResolvedValue([]);
  mocks.extractUrl.mockReset();
  mocks.extractUrl.mockImplementation(async (r: any) => packet({ url: r.url, domain: r.domain }));
  mocks.applySegmentFilter.mockReset();
  mocks.isSafeUrlWithDns.mockReset();
  mocks.isSafeUrlWithDns.mockResolvedValue(true);
});

describe("execWebSearchTool envelope (⇔ rust exec_web_search)", () => {
  it("invalid arguments: empty queries or empty missing_claims", async () => {
    const s = session();
    const out = await execWebSearchTool(s, { queries: ["  "], missing_claims: ["x"] }, []);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("invalid_arguments");
    expect(out.detail).toBe("queries[] (1-4) and missing_claims[] (1+) are both required");
    expect(out.remainingBudget).toEqual({ searches: 2, readUrls: 12, rounds: 4 });
    expect(mocks.metasearch).not.toHaveBeenCalled();
    const out2 = await execWebSearchTool(s, { queries: ["a b"], missing_claims: [] }, []);
    expect(out2.error).toBe("invalid_arguments");
    expect(mocks.metasearch).not.toHaveBeenCalled();
  });

  it("budget exhaustion is an honest envelope, not a guess", async () => {
    const s = session("quick"); // maxSearchCalls 1
    const first = await execWebSearchTool(s, { queries: ["alpha beta"], missing_claims: ["fact"] }, []);
    expect(first.ok).toBe(true);
    expect(s.searchesUsed).toBe(1);
    const second = await execWebSearchTool(s, { queries: ["gamma delta"], missing_claims: ["fact"] }, []);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("budget_exhausted");
    expect(second.detail).toContain("web_search budget spent (1 search call(s))");
    expect(second.detail).toContain("Answer from the evidence you already have");
    expect((second as any).remainingBudget.searches).toBe(0);
    // the exhausted call fired no extra retrieval
    expect(mocks.metasearch).toHaveBeenCalledTimes(1);
  });

  it("fresh queries reach metasearch with the mapped intent + freshness, capped at 10", async () => {
    const s = session();
    mocks.metasearch.mockResolvedValue([ranked("https://a.com/1"), ranked("https://b.com/2")]);
    const out = await execWebSearchTool(
      s,
      { queries: ["spice market prices"], missing_claims: ["current price"], freshness: "week", desired_source_types: ["general", "news"] },
      [],
    );
    expect(mocks.metasearch).toHaveBeenCalledWith([{ query: "spice market prices", intent: "news", freshness: "week" }], 10);
    expect(out.queryResults).toEqual([{ query: "spice market prices", intent: "news", resultCount: 2 }]);
    expect(out.resultsReturned).toBe(2);
    expect((out as any).results[0]).toMatchObject({ url: "https://a.com/1", engine: "brave", origin: "search" });
    expect(out.remainingBudget).toEqual({ searches: 1, readUrls: 12, rounds: 4 });
  });

  it("intent mapping: 'general' does NOT short-circuit; unknown families fall through", async () => {
    mocks.metasearch.mockResolvedValue([]);
    const s = session();
    await execWebSearchTool(s, { queries: ["q one"], missing_claims: ["m"], desired_source_types: ["general", "docs"] }, []);
    expect(mocks.metasearch).toHaveBeenLastCalledWith([{ query: "q one", intent: "docs", freshness: "any" }], 10);
    await execWebSearchTool(session(), { queries: ["q two"], missing_claims: ["m"], desired_source_types: ["forum"] }, []);
    expect(mocks.metasearch).toHaveBeenLastCalledWith([{ query: "q two", intent: "forum", freshness: "any" }], 10);
    await execWebSearchTool(session(), { queries: ["q three"], missing_claims: ["m"], desired_source_types: ["podcasts"] }, []);
    expect(mocks.metasearch).toHaveBeenLastCalledWith([{ query: "q three", intent: "general", freshness: "any" }], 10);
  });

  it("§11.18: URL-shaped queries become READ semantics, never engine queries", async () => {
    const s = session();
    const cites: CitationSeed[] = [];
    const out = await execWebSearchTool(
      s,
      { queries: ["https://example.com/pricing", "plain keywords"], missing_claims: ["fact"], reason: "pricing focus" },
      cites,
    );
    // only the keyword query reaches the engines
    expect(mocks.metasearch).toHaveBeenCalledTimes(1);
    expect(mocks.metasearch.mock.calls[0][0][0].query).toBe("plain keywords");
    // the URL got real read semantics
    expect(mocks.extractUrl).toHaveBeenCalledTimes(1);
    expect(mocks.extractUrl.mock.calls[0][0].url).toBe("https://example.com/pricing");
    expect(mocks.extractUrl.mock.calls[0][0].engine).toBe("tool-read");
    expect(s.readUrlsUsed).toBe(1);
    expect((out as any).pages).toHaveLength(1);
    expect(out.notices).toEqual(["url-shaped query routed to read_page semantics: https://example.com/pricing"]);
    // segment filter ran with the reason as focus; [S#] numbering from the seed
    expect(mocks.applySegmentFilter).toHaveBeenCalledWith([expect.any(Object)], "pricing focus");
    expect(cites.map((c) => c.sourceId)).toEqual(["S1"]);
  });

  it("segment filter falls back to the session focus when no reason is given", async () => {
    const s = session("standard");
    await execWebSearchTool(s, { queries: ["https://example.com/x"], missing_claims: ["m"] }, []);
    expect(mocks.applySegmentFilter).toHaveBeenCalledWith([expect.any(Object)], s.queryContext);
  });

  it("metasearch failure: structured failure, envelope stays ok:true", async () => {
    const s = session();
    mocks.metasearch.mockRejectedValue(new Error("connect ETIMEDOUT while dialing engine"));
    const out = await execWebSearchTool(s, { queries: ["doomed query"], missing_claims: ["m"] }, []);
    expect(out.ok).toBe(true);
    expect(out.queryResults).toEqual([{ query: "doomed query", intent: "general", resultCount: 0 }]);
    expect(out.failures).toEqual([{ query: "doomed query", failure: "timeout" }]);
  });

  it("dedupes across queries via normalizeUrl and truncates snippets at 300+…", async () => {
    const s = session();
    mocks.metasearch.mockImplementation(async (plan: any[]) => {
      const q = plan[0].query;
      if (q === "first") return [ranked("https://a.com/x?utm_source=fb&fbclid=9")];
      return [ranked("https://a.com/x"), ranked("https://b.com/y", { snippet: "z".repeat(350), publishedDate: "2026-01-05" })];
    });
    const out = await execWebSearchTool(s, { queries: ["first", "second"], missing_claims: ["m"] }, []);
    expect(out.resultsReturned).toBe(2); // the utm twin collapsed
    const withDate = (out as any).results.find((r: any) => r.url === "https://b.com/y");
    expect(withDate.snippet).toBe("z".repeat(300) + "…");
    expect(withDate.publishedDate).toBe("2026-01-05");
    // dedupe keys on the NORMALIZED url; the first-seen raw url rides along
    const noDate = (out as any).results.find((r: any) => r.domain === "a.com");
    expect(noDate.url).toBe("https://a.com/x?utm_source=fb&fbclid=9");
    expect("publishedDate" in noDate).toBe(false);
  });
});

describe("execReadPageTool envelope (⇔ rust exec_read_page)", () => {
  it("invalid urls", async () => {
    const out = await execReadPageTool(session(), { urls: ["not a url", 5] }, []);
    expect(out.error).toBe("invalid_arguments");
    expect(out.detail).toBe("urls[] must hold 1-8 absolute http(s) URLs");
    expect(mocks.extractUrl).not.toHaveBeenCalled();
  });

  it("SSRF-unsafe URL: structured unsafe_destination, extractor never touched", async () => {
    const s = session();
    mocks.isSafeUrlWithDns.mockResolvedValueOnce(false);
    const out = await execReadPageTool(s, { urls: ["http://127.0.0.1:8080/admin"] }, []);
    expect(out.ok).toBe(true); // the ROUND succeeded; the PAGE honestly failed
    expect(out.pages).toEqual([{ url: "http://127.0.0.1:8080/admin", fetched: false }]);
    expect(out.failures).toEqual([
      { url: "http://127.0.0.1:8080/admin", failure: "unsafe_destination", detail: "the SSRF guard rejected this URL or one of its resolved addresses" },
    ]);
    expect(mocks.extractUrl).not.toHaveBeenCalled();
    // a throwing guard is the same honest outcome
    mocks.isSafeUrlWithDns.mockRejectedValueOnce(new Error("resolver blew up"));
    const out2 = await execReadPageTool(s, { urls: ["https://rebind.example"] }, []);
    expect((out2 as any).failures[0].failure).toBe("unsafe_destination");
  });

  it("wall outcomes stay structural: login wall → auth_required failure, no bypass", async () => {
    mocks.extractUrl.mockResolvedValueOnce(
      packet({ classification: "FAIL_SILENT_LOGIN_WALL", passages: [], title: "" }),
    );
    const out = await execReadPageTool(session(), { urls: ["https://journal.example/locked"] }, []);
    expect(out.failures).toEqual([
      { url: "https://journal.example/locked", failure: "auth_required", detail: "FAIL_SILENT_LOGIN_WALL" },
    ]);
    expect(out.pages).toEqual([{ url: "https://journal.example/locked", title: "journal.example", fetched: false }]);
  });

  it("a FAIL classification with readable text keeps BOTH entry and failure", async () => {
    mocks.extractUrl.mockResolvedValueOnce(packet({ classification: "PAGE_BUDGET_TIMEOUT" }));
    const out = await execReadPageTool(session(), { urls: ["https://slow.example"] }, []);
    // the readable-text entry carries NO fetched:false marker — only failed
    // pages do; a FAIL classification still rides through honestly
    expect((out as any).pages[0]).toMatchObject({ classification: "PAGE_BUDGET_TIMEOUT", sourceId: "S1" });
    expect("fetched" in (out as any).pages[0]).toBe(false);
    expect((out as any).pages[0].truncated).toBe(false);
    expect(out.failures).toEqual([
      { url: "https://slow.example", failure: "timeout", detail: "PAGE_BUDGET_TIMEOUT" },
    ]);
  });

  it("extractor throw classifies from the message", async () => {
    mocks.extractUrl.mockRejectedValueOnce(new Error("socket hang up"));
    const out = await execReadPageTool(session(), { urls: ["https://flaky.example"] }, []);
    expect(out.failures).toEqual([{ url: "https://flaky.example", failure: "parse_failure" }]);
  });

  it("[S#] numbering continues from the citation seed; publishedAt rides both maps", async () => {
    const s = session("standard", 7);
    mocks.extractUrl.mockImplementation(async (r: any) => packet({ url: r.url, publishedAt: "2026-02-02" }));
    const cites: CitationSeed[] = [];
    const out = await execReadPageTool(s, { urls: ["https://one.example", "https://two.example"] }, cites);
    expect(cites.map((c) => c.sourceId)).toEqual(["S7", "S8"]);
    expect(cites[0].publishedAt).toBe("2026-02-02");
    expect((out as any).pages[0].publishedDate).toBe("2026-02-02");
    expect((out as any).pages[0].sourceId).toBe("S7");
    expect(s.nextSource).toBe(9);
  });

  it("read budget drops whole URLs with an honest notice (N pages per round)", async () => {
    const s = session("quick"); // maxReadUrls 6
    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/p${i + 1}`);
    const out = await execReadPageTool(s, { urls }, []);
    expect(mocks.extractUrl).toHaveBeenCalledTimes(6);
    expect(out.notices).toContain("read budget exhausted: 2 URL(s) dropped (remaining 6)");
    expect(s.readUrlsUsed).toBe(6);
    expect((out as any).remainingBudget.readUrls).toBe(0);
    // a fully-spent read budget returns the exhausted envelope, never a guess
    const again = await execReadPageTool(s, { urls: ["https://example.com/late"] }, []);
    expect(again.error).toBe("budget_exhausted");
    expect(again.detail).toContain("read_page budget spent (6 URL read(s))");
  });

  it("the 20k batch char budget omits whole pages honestly, never halves one", async () => {
    // 6 blocks × 2001 chars per page (each passage clipped at 2000+…):
    // page1 keeps 6 (12006), page2 keeps 3 of 6, page3 cannot fit one → omitted.
    mocks.extractUrl.mockImplementation(async (r: any) =>
      packet({ url: r.url, passages: Array.from({ length: 6 }, () => ({ passageText: "x".repeat(2001) })) }),
    );
    const cites: CitationSeed[] = [];
    const out = await execReadPageTool(session(), { urls: ["https://a.example", "https://b.example", "https://c.example"] }, cites);
    const [p1, p2, p3] = (out as any).pages;
    expect(p1.passages).toHaveLength(6);
    expect(p1.truncated).toBe(false);
    expect(p2.passages).toHaveLength(3);
    expect(p2.truncated).toBe(true);
    expect(p3.omitted).toBe("char_budget");
    expect(p3.fetched).toBe(true);
    expect(out.notices).toContain("1 page(s) omitted: read_page char budget spent");
    expect(cites).toHaveLength(2); // the omitted page mints no dangling citation
  });

  it("timeoutMs clamps into [1000, 60000] and the deadline rides into extractUrl", async () => {
    let deadline = 0;
    mocks.extractUrl.mockImplementation(async (_r, dl: number) => {
      deadline = dl;
      return packet();
    });
    await execReadPageTool(session(), { urls: ["https://x.example"], timeoutMs: 1 }, []);
    expect(deadline - Date.now()).toBeGreaterThan(500);
    expect(deadline - Date.now()).toBeLessThan(1600);
    await execReadPageTool(session(), { urls: ["https://x.example"], timeoutMs: 999999 }, []);
    expect(deadline - Date.now()).toBeGreaterThan(58000);
  });

  it("focus reaches the segment filter verbatim", async () => {
    await execReadPageTool(session(), { urls: ["https://x.example"], focus: "only pricing sections" }, []);
    expect(mocks.applySegmentFilter).toHaveBeenCalledWith([expect.any(Object)], "only pricing sections");
  });
});

/* ── task-scope admission (⇔ rust tools.rs scope admission tests) ─────────
   Audit 2026-11-02, brief #1/#4/#6/#8/#9: a site-bound OPERATE contract is
   enforced on evidence ADMITTED to the session, before the model sees it and
   before a read_page URL is fetched. The session contract only ever narrows. */

describe("task-scope admission (⇔ rust scope admission)", () => {
  function operateScope(host: string, phrase: string, resolved: boolean): TaskScope {
    return {
      intent: "operate",
      targets: [
        {
          phrase,
          state: resolved ? "resolved" : "unresolved",
          host: resolved ? host : "",
          url: "",
          candidates: [],
          provenance: resolved ? "explicit_domain" : "none",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
  }
  function scopedSession(resolved: boolean): WebToolSession {
    return makeWebToolSession(
      "standard",
      1,
      "order the zeta flurb on scope ok",
      operateScope("scope-ok.com", "scope ok", resolved),
    );
  }

  it("web_search drops off-scope results with honest notices; the contract survives", async () => {
    mocks.metasearch.mockResolvedValue([
      ranked("https://scope-ok.com/pricing"),
      ranked("https://evil-off.com/blog"),
    ]);
    const s = scopedSession(true);
    const out = await execWebSearchTool(s, { queries: ["zeta flurb pricing"], missing_claims: ["the price"] }, []);
    expect(out.ok).toBe(true);
    expect(out.resultsReturned).toBe(1); // the off-scope SERP result never reaches the model
    expect((out as any).results[0].url).toBe("https://scope-ok.com/pricing");
    expect(out.notices).toContain("off-scope result dropped: evil-off.com (task scope: scope-ok.com)");
    expect(scopeHosts(s.scope!)).toEqual(["scope-ok.com"]); // only ever narrows
  });

  it("an unresolved target resolves ONLY through real SERP evidence, admitting same-round", async () => {
    mocks.metasearch.mockResolvedValue([
      ranked("https://scope-ok.com/pricing"),
      ranked("https://evil-off.com/blog"),
    ]);
    const s = scopedSession(false);
    const out = await execWebSearchTool(s, { queries: ["zeta flurb pricing"], missing_claims: ["the price"] }, []);
    expect(out.ok).toBe(true);
    const t = s.scope!.targets[0];
    expect(t.state).toBe("resolved");
    expect(t.host).toBe("scope-ok.com"); // validated PSL host, never a guess
    expect(t.provenance).toBe("resolved_search");
    expect(out.resultsReturned).toBe(1); // fresh host governed this same round
    expect((out as any).results[0].url).toBe("https://scope-ok.com/pricing");
  });

  it("read_page blocks off-scope URLs BEFORE the fetch, unbilled and notice-bearing", async () => {
    const evil = "https://evil-off.com/blog";
    const ok = "https://scope-ok.com/pricing";
    const s = scopedSession(true);
    const out = await execReadPageTool(s, { urls: [evil, ok], focus: "pricing" }, []);
    expect(out.ok).toBe(true);
    expect((out as any).pages).toHaveLength(1);
    expect(s.readUrlsUsed).toBe(1); // blocked reads never charge the budget
    // "a check after an unauthorized page has loaded is insufficient": the
    // blocked URL must never reach the retrieval seam at all.
    const fetched = mocks.extractUrl.mock.calls.map((c: any[]) => c[0]?.url);
    expect(fetched).not.toContain(evil);
    expect(out.notices).toContain("read blocked: evil-off.com is outside the task scope (scope-ok.com)");
  });

  it("§7: an on-scope read that 302s OFF the scope fails honestly — no laundering", async () => {
    // admitReadUrls lawed the REQUESTED URL; the redirect must not smuggle
    // the landing site's content into a site-bound answer. The failure
    // names the landing site; no citation is minted for unread content.
    const s = scopedSession(true);
    mocks.extractUrl.mockImplementation(async () =>
      packet({
        url: "https://deals-squatter.example/hotdeals",
        domain: "deals-squatter.example",
        classification: "SUCCESS_REDIRECTED",
      }),
    );
    const cites: CitationSeed[] = [];
    const out = await execReadPageTool(s, { urls: ["https://scope-ok.com/pricing"] }, cites);
    const f = (out.failures as any[])[0];
    expect(f.url).toBe("https://scope-ok.com/pricing");
    expect(f.failure).toBe("off_scope_redirect");
    expect(f.detail).toContain("https://deals-squatter.example/hotdeals");
    expect(f.detail).toContain("outside the task scope (scope-ok.com)");
    expect((out.pages as any[])[0]).toEqual({
      url: "https://scope-ok.com/pricing",
      fetched: false,
      redirectedTo: "https://deals-squatter.example/hotdeals",
    });
    expect(cites).toEqual([]);
  });

  it("§7: an in-scope redirect is KEPT and the entry carries the final origin", async () => {
    const s = scopedSession(true);
    mocks.extractUrl.mockImplementation(async (r: any) =>
      packet({
        url: "https://shop.scope-ok.com/pricing",
        domain: "shop.scope-ok.com",
        classification: "SUCCESS_REDIRECTED",
      }),
    );
    const cites: CitationSeed[] = [];
    const out = await execReadPageTool(s, { urls: ["https://scope-ok.com/pricing"] }, cites);
    expect(out.failures).toBeUndefined();
    const page = (out.pages as any[])[0];
    expect(page.passages).toEqual(["hello world passage"]); // in-scope content KEPT
    expect(page.classification).toBe("SUCCESS_REDIRECTED");
    expect(page.redirectedTo).toBe("https://shop.scope-ok.com/pricing");
    expect(cites[0].url).toBe("https://shop.scope-ok.com/pricing"); // citation rides the FINAL URL
  });

  it("§7: with no armed scope, a crossing redirect stays KEPT but honest", async () => {
    const s = session();
    mocks.extractUrl.mockImplementation(async () =>
      packet({
        url: "https://moved.example/final",
        domain: "moved.example",
        classification: "SUCCESS_REDIRECTED",
      }),
    );
    const out = await execReadPageTool(s, { urls: ["https://example.com/a"] }, []);
    expect(out.failures).toBeUndefined();
    const page = (out.pages as any[])[0];
    expect(page.passages).toEqual(["hello world passage"]);
    expect(page.redirectedTo).toBe("https://moved.example/final");
  });

  it("no scope (null) ⇒ no enforcement: legacy sessions keep pre-audit behavior", async () => {
    mocks.metasearch.mockResolvedValue([ranked("https://anything.example/1"), ranked("https://other.example/2")]);
    const out = await execWebSearchTool(session(), { queries: ["alpha beta"], missing_claims: ["fact"] }, []);
    expect(out.resultsReturned).toBe(2);
    expect(out.notices ?? []).not.toContainEqual(expect.stringContaining("off-scope"));
  });
});
