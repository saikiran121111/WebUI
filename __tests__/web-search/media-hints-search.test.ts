/**
 * F13/P7 (brief part 8, "connect video evidence to search"): the whole point of
 * indexing a video/recording is that its evidence can drive REAL tool behavior.
 * An unused helper is a defect, so these tests pin the complete path that
 * matters:
 *
 *   stored timeline evidence -> MediaSearchHints -> the ACTUAL web_search
 *   arguments the model's round executes
 *
 * Retrieval seams are mocked (same pattern as web-tools.test.ts), so what is
 * pinned is the contract: which queries actually reach the engine, whether the
 * envelope LABELS a derived query with its provenance (never launders it as a
 * model-authored one), and that injection never widens a scope, spends an
 * unbounded number of queries, or asserts an uncorroborated audio guess.
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
  execWebSearchTool,
  makeWebToolSession,
  type WebToolSession,
} from "@/lib/web-search/tools";
import {
  MEDIA_HINT_QUERY_CAP,
  clueKey,
  mediaHintQueryPairs,
  type MediaHint,
} from "@/lib/server/attachindex/media-hints";
import { scopeHosts, type TaskScope } from "@/lib/decision/task-scope";

const ROOT = path.resolve(__dirname, "..", "..");
const PY_HINTS = path.join(ROOT, "python-backend", "ruke_ml", "video", "search_hints.py");

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

function hint(over: Partial<MediaHint> = {}): MediaHint {
  return {
    value: "Aurora Fast Ferries",
    kind: "observed_name",
    startSec: 42,
    endSec: 47,
    provenance: "transcript@42s:name",
    corroboratedBy: [],
    ...over,
  } as MediaHint;
}

function sessionWith(hints: MediaHint[], question = "which company runs the night route"): WebToolSession {
  return makeWebToolSession("standard", 1, question, null, false, null, hints);
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

function engineQueries(): string[] {
  return mocks.metasearch.mock.calls.map((c: any[]) => c[0][0].query);
}

describe("media evidence reaches the real search-tool arguments (F13/P7)", () => {
  it("a timeline clue becomes an executed engine query, labelled with provenance", async () => {
    mocks.metasearch.mockResolvedValue([ranked("https://aurora.example.com/timetable")]);
    const s = sessionWith([hint()]);
    const out = await execWebSearchTool(
      s,
      { queries: ["night ferry route schedule"], missing_claims: ["operator"] },
      [],
    );
    expect(out.ok).toBe(true);
    // The clue actually reached the engines - not just the prompt.
    expect(engineQueries()).toContain("Aurora Fast Ferries");
    const entry = (out.queryResults as any[]).find((q) => q.query === "Aurora Fast Ferries");
    expect(entry, "the injected leg must appear in queryResults").toBeTruthy();
    // HONESTY: the envelope says where it came from; it is never laundered as a
    // model-authored query.
    expect(entry.origin).toBe("media-evidence");
    expect(entry.evidence).toBe("transcript@42s:name");
    expect(out.notices).toContain(
      "media-evidence clue searched: Aurora Fast Ferries (transcript@42s:name)",
    );
    // A model-authored leg carries NO origin stamp - the two stay distinguishable.
    const modelLeg = (out.queryResults as any[]).find((q) => q.query === "night ferry route schedule");
    expect(modelLeg.origin).toBeUndefined();
    expect(modelLeg.evidence).toBeUndefined();
  });

  it("idempotence: a clue the model already asked for is never searched twice", async () => {
    const s = sessionWith([hint()], "book tickets with Aurora Fast Ferries");
    await execWebSearchTool(
      s,
      { queries: ["Aurora Fast Ferries evening departure"], missing_claims: ["time"] },
      [],
    );
    expect(engineQueries()).toEqual(["Aurora Fast Ferries evening departure"]);
  });

  it("bounded: one round injects at most MEDIA_HINT_QUERY_CAP clues", async () => {
    const hints = [
      hint({ value: "first clue phrase", kind: "distinctive_speech" }),
      hint({ value: "second observed name", kind: "observed_name" }),
      hint({ value: "third scene keyword", kind: "scene_clue" }),
      hint({ value: "fourth quoted phrase", kind: "distinctive_speech" }),
    ];
    const s = sessionWith(hints);
    await execWebSearchTool(s, { queries: ["model question"], missing_claims: ["m"] }, []);
    expect(engineQueries().length).toBe(1 + MEDIA_HINT_QUERY_CAP);
  });

  it("an uncorroborated audio guess is a quoted probe, never an asserted identity", async () => {
    const s = sessionWith([hint({ value: "acrobatics fly away", kind: "uncertain_audio" })]);
    const out = await execWebSearchTool(s, { queries: ["what song plays at the fair"], missing_claims: ["song"] }, []);
    const Q = String.fromCharCode(34); // exact-phrase probe, not an assertion
    expect(engineQueries()).toContain(Q + "acrobatics fly away" + Q);
    const pairs = mediaHintQueryPairs([hint({ value: "acrobatics fly away", kind: "uncertain_audio" })]);
    expect(pairs[0]!.query).toBe("\"acrobatics fly away\"");
    expect(out.ok).toBe(true);
  });

  it("a corroborated audio clue is not quoted - corroboration changes the claim strength", () => {
    const pairs = mediaHintQueryPairs([
      hint({ value: "acrobatics fly away", kind: "uncertain_audio", corroboratedBy: ["ocr"] }),
    ]);
    expect(pairs[0]!.query).toBe("acrobatics fly away");
  });

  it("url-shaped clues follow the url law: READ semantics, never an engine query", async () => {
    const s = sessionWith([hint({ value: "https://booking.example.com/ferry", kind: "url", provenance: "ocr@88s:frame" })]);
    const out = await execWebSearchTool(s, { queries: ["where do I book the night route"], missing_claims: ["booking site"] }, []);
    expect(engineQueries()).toEqual(["where do I book the night route"]);
    expect(mocks.extractUrl).toHaveBeenCalledTimes(1);
    expect(mocks.extractUrl.mock.calls[0][0].url).toBe("https://booking.example.com/ferry");
    expect(out.notices).toContain(
      "media-evidence url routed to read_page semantics: https://booking.example.com/ferry (ocr@88s:frame)",
    );
  });

  it("injection NEVER widens a task scope: off-scope evidence reads stay blocked", async () => {
    const scope: TaskScope = {
      intent: "operate",
      targets: [
        {
          phrase: "scope ok",
          state: "resolved",
          host: "scope-ok.com",
          url: "",
          candidates: [],
          provenance: "explicit_domain",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    const s = makeWebToolSession(
      "standard",
      1,
      "order the zeta flurb on scope ok",
      scope,
      false,
      null,
      [hint({ value: "https://evil-off.com/deal", kind: "url", provenance: "transcript@5s:url" })],
    );
    const out = await execWebSearchTool(s, { queries: ["zeta flurb order page"], missing_claims: ["order url"] }, []);
    expect(mocks.extractUrl, "the evidence url must not be fetched outside its scope").not.toHaveBeenCalled();
    expect(out.notices).toContain(
      "read blocked: evil-off.com is outside the task scope (scope-ok.com)",
    );
    expect(scopeHosts(s.scope!)).toEqual(["scope-ok.com"]);
  });

  it("evidence-derived SERP results face the SAME off-scope drop as model legs", async () => {
    const scope: TaskScope = {
      intent: "operate",
      targets: [
        {
          phrase: "scope ok",
          state: "resolved",
          host: "scope-ok.com",
          url: "",
          candidates: [],
          provenance: "explicit_domain",
        },
      ],
      excludedPhrases: [],
      authorizedHosts: [],
    };
    const s = makeWebToolSession(
      "standard",
      1,
      "order the zeta flurb on scope ok",
      scope,
      false,
      null,
      [hint({ value: "Zeta Flurb supplier network", kind: "distinctive_speech", provenance: "transcript@12s:quoted" })],
    );
    mocks.metasearch.mockImplementation(async (plan: any[]) => {
      return plan[0].query === "Zeta Flurb supplier network"
        ? [ranked("https://evil-off.com/wholesale")] 
        : [ranked("https://scope-ok.com/order")];
    });
    const out = await execWebSearchTool(s, { queries: ["zeta flurb order page"], missing_claims: ["order url"] }, []);
    expect(out.resultsReturned).toBe(1);
    expect((out as any).results[0].url).toBe("https://scope-ok.com/order");
    expect(out.notices).toContain("off-scope result dropped: evil-off.com (task scope: scope-ok.com)");
  });

  it("positive control: a turn with no media evidence changes nothing", async () => {
    const s = sessionWith([]);
    expect(s.mediaHints).toEqual([]);
    const out = await execWebSearchTool(s, { queries: ["plain question"], missing_claims: ["m"] }, []);
    expect(engineQueries()).toEqual(["plain question"]);
    expect(out.queryResults).toEqual([{ query: "plain question", intent: "general", resultCount: 0 }]);
    expect((out.queryResults as any[]).some((q) => q.origin)).toBe(false);
  });
});

describe("clue comparison is script-preserving and example-neutral (F05 law)", () => {
  it("folds case/punctuation but keeps every script, so a non-Latin clue is still comparable", () => {
    expect(clueKey("  Aurora  Fast‑Ferries!! ")).toBe("aurora fast ferries");
    expect(clueKey("తెలుగు".normalize("NFC"))).toBe("తెలుగు".normalize("NFC"));
    expect(clueKey("東京タワー")).toBe("東京タワー");
    // An ASCII-only fold would silently drop these and then treat "no match"
    // as "already searched" - that is how non-English evidence disappears.
    expect(clueKey("कोइ जीन का नाम?").length).toBeGreaterThan(0);
    expect(clueKey("!!! ??? ,,,")).toBe("");
  });

  it("a clue is judged against what was asked, not against a keyword list", () => {
    const asked = clueKey("tell me about Aurora Fast Ferries schedules");
    expect(asked.includes(clueKey("Aurora Fast Ferries"))).toBe(true);
    expect(asked.includes(clueKey("night ferry route"))).toBe(false);
  });
});

describe("the TS and Python MediaSearchHints contract stays one law", () => {
  it("the python side declares exactly the kinds this mirror ranks", () => {
    const src = fs.readFileSync(PY_HINTS, "utf8");
    const block = /rank = \{([\s\S]*?)\}/.exec(src);
    expect(block, "python to_queries() rank table must exist").toBeTruthy();
    const pairs = [...block![1].matchAll(/"([a-z_]+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
    const py = new Map<string, number>(pairs as [string, number][]);
    expect([...py.keys()].sort()).toEqual(
      [
        "distinctive_speech",
        "observed_name",
        "scene_clue",
        "uncertain_audio",
        "url",
        "visible_text",
      ],
    );
    // Ranking law: a directly identifying clue outranks a vague audio guess.
    expect(py.get("url")).toBeLessThan(py.get("visible_text")!);
    expect(py.get("visible_text")!).toBeLessThan(py.get("uncertain_audio")!);
    // The TS mirror orders the same way (same kinds, same relative order).
    const order = mediaHintQueryPairs(
      [
        hint({ value: "audio candidate phrase", kind: "uncertain_audio" }),
        hint({ value: "scene clue keyword", kind: "scene_clue" }),
        hint({ value: "observed proper name", kind: "observed_name" }),
        hint({ value: "quoted speech phrase", kind: "distinctive_speech" }),
        hint({ value: "visible caption text", kind: "visible_text" }),
        hint({ value: "https://seen.example/x", kind: "url" }),
      ],
      8,
    ).map((p) => p.hint.kind);
    expect(order).toEqual(
      [...py.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]),
    );
  });
});
