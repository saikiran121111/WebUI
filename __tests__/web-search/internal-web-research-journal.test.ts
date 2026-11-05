/**
 * WS05 (audit 2026-11-05, repair item 5) — the research bridge endpoint is
 * where the SERVER journal sits: app/api/internal/web-research/route.ts
 * receives the conversation identity on the request (`conversationId`),
 * journals every completed research turn server-side, and REHYDRATES prior
 * evidence for follow-up turns — passages, provenance (url/title/domain,
 * published + fetched dates) and citation aliases continuing AFTER the
 * current turn's S-ids — merged into the same result frame the Rust bridge
 * already consumes. A turn with no conversation identity gets NO journal
 * write and NO rehydration; a different conversation never sees another
 * conversation's evidence. Client-provided text/metadata is never proof of
 * a fetch — rehydration reads only the server journal.
 *
 * The pipeline module is mocked wholesale (web-research-abort.test.ts
 * pattern), so this file exercises ONLY the route's journal contract — no
 * engines, readers or models are touched regardless of harness behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { runWebResearchSpy } = vi.hoisted(() => ({
  runWebResearchSpy: vi.fn(),
}));

const CURRENT_BLOCK = "=== CURRENT TURN EVIDENCE ===";

vi.mock("@/lib/web-search/pipeline", () => ({
  runWebResearch: runWebResearchSpy,
  buildMainModelContext: () => ({ systemBlock: CURRENT_BLOCK }),
}));

const SECRET = "ws05-bridge-secret";
let tmpDir: string;
let POST: (req: NextRequest) => Promise<Response>;
let readJournal: (id: string) => any[];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws05-route-"));
  process.env.WEBUI_DATA_DIR = tmpDir;
  process.env.RUKE_BROWSER_BRIDGE_SECRET = SECRET;
  POST = (await import("@/app/api/internal/web-research/route")).POST;
  ({ readResearchJournal: readJournal } = await import("@/lib/persistence/research-journal"));
});

afterAll(() => {
  delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
  delete process.env.WEBUI_DATA_DIR;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  runWebResearchSpy.mockReset();
});

function bundle(opts: {
  ids: string[];
  urls: string[];
  queries: string[];
  excerpts: string[];
  published?: string[];
}) {
  const packets = opts.ids.map((sourceId, i) => ({
    sourceId,
    url: opts.urls[i],
    title: `Doc ${sourceId}`,
    domain: new URL(opts.urls[i]).hostname,
    publishedAt: opts.published?.[i],
    extraction: "direct",
    passages: [{ sourceId, url: opts.urls[i], title: `Doc ${sourceId}`, domain: new URL(opts.urls[i]).hostname, publishedAt: opts.published?.[i], passageText: opts.excerpts[i], bm25Score: 5 }],
  }));
  return {
    searchGate: {
      source: "model",
      decision: {
        search_required: true,
        depth: "quick",
        freshness: "week",
        reason: "live facts",
        queries: opts.queries.map((query) => ({ query, intent: "fact" })),
      },
    },
    searchResults: [],
    packets,
    topPassages: packets.flatMap((p: any) => p.passages),
    fromCache: false,
    coverage: 1,
    gapSearchFired: false,
    plannerLaw: {},
    sufficiency: null,
    gapDemand: null,
    demandWaveFired: false,
    presentation: null,
    geoPoints: [],
    richResults: [],
    authRequired: [],
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  const req = new Request("http://localhost:3000/api/internal/web-research", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ruke-internal-secret": SECRET },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
}

async function resultFrame(res: Response): Promise<any> {
  const text = new TextDecoder().decode(await res.arrayBuffer());
  const frames = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const terminal = frames.filter((f) => f.type === "result");
  expect(terminal).toHaveLength(1);
  return terminal[0];
}

describe("research bridge journals evidence server-side and rehydrates follow-ups (WS05)", () => {
  it("the first turn journals its evidence; nothing is rehydrated onto an empty journal", async () => {
    runWebResearchSpy.mockResolvedValueOnce(
      bundle({
        ids: ["S1", "S2"],
        urls: ["https://docs.arborworks.example/platform", "https://blog.arborworks.example/launch"],
        queries: ["arborworks boreal platform documentation"],
        excerpts: ["The Boreal platform ships three API tiers.", "ArborWorks announced Boreal in October."],
        published: ["2026-10-12", "2026-10-20"],
      }),
    );
    const res = await POST(
      makeRequest({
        prompt: "Tell me about the ArborWorks Boreal platform.",
        conversationId: "ws05-conv",
        currentDate: "2026-11-05",
      }),
    );
    const frame = await resultFrame(res);
    expect(frame.status).toBe("bundle");
    // Own-turn citations unchanged in shape…
    expect(Object.keys(frame.citations).sort()).toEqual(["S1", "S2"]);
    // …and the system block is exactly the current-turn block — no prior evidence.
    expect(frame.systemBlock).toBe(CURRENT_BLOCK);
    // Server journal now carries the fetched documents with provenance.
    const j = readJournal("ws05-conv");
    expect(j).toHaveLength(1);
    expect(j[0].queries).toEqual(["arborworks boreal platform documentation"]);
    expect(j[0].sources.map((s: any) => s.url)).toEqual([
      "https://docs.arborworks.example/platform",
      "https://blog.arborworks.example/launch",
    ]);
    expect(j[0].sources[0]).toMatchObject({ publishedAt: "2026-10-12", fetchedAt: expect.any(String) });
    expect(j[0].sources[0].excerpt).toContain("Boreal platform");
  });

  it("a relevant follow-up rehydrates prior passages, provenance and citation aliases", async () => {
    runWebResearchSpy.mockResolvedValueOnce(
      bundle({
        ids: ["S1", "S2"],
        urls: ["https://docs.arborworks.example/support", "https://forum.example/thread"],
        queries: ["boreal support tiers"],
        excerpts: ["Support tiers: Basic 24h, Enterprise 1h response.", "Users report 24h Basic response."],
      }),
    );
    const res = await POST(
      makeRequest({
        prompt: "What does the Boreal platform offer for support?",
        conversationId: "ws05-conv",
        currentDate: "2026-11-05",
      }),
    );
    const frame = await resultFrame(res);
    expect(frame.status).toBe("bundle");
    // Current citations survive; prior sources re-alias AFTER the current S2.
    expect(Object.keys(frame.citations).sort()).toEqual(["S1", "S2", "S3", "S4"]);
    expect(frame.citations["S3"]).toMatchObject({
      url: "https://docs.arborworks.example/platform",
      domain: "docs.arborworks.example",
      publishedAt: "2026-10-12",
    });
    // The model sees the PRIOR passages with server-attested provenance.
    expect(frame.systemBlock.startsWith(CURRENT_BLOCK)).toBe(true);
    expect(frame.systemBlock).toContain("https://docs.arborworks.example/platform");
    expect(frame.systemBlock).toContain("ArborWorks announced Boreal in October.");
    expect(frame.systemBlock).toContain("2026-10-12");
    // And the journal kept growing (turn 2 of the same conversation).
    expect(readJournal("ws05-conv")).toHaveLength(2);
  });

  it("control: a turn without conversation identity journals nothing and rehydrates nothing", async () => {
    runWebResearchSpy.mockResolvedValueOnce(
      bundle({
        ids: ["S1"],
        urls: ["https://other.example/page"],
        queries: ["boreal platform status"],
        excerpts: ["Unrelated current-turn evidence."],
      }),
    );
    const res = await POST(makeRequest({ prompt: "What is the Boreal platform status?", currentDate: "2026-11-05" }));
    const frame = await resultFrame(res);
    // Even though the prompt shares tokens with ws05-conv's journal, an
    // anonymous turn must NEVER reach another conversation's evidence.
    expect(Object.keys(frame.citations)).toEqual(["S1"]);
    expect(frame.systemBlock).toBe(CURRENT_BLOCK);
    // The journal under the tmp dir was not extended by this turn.
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".research.json"));
    expect(files).toEqual(["ws05-conv.research.json"]);
    expect(readJournal("ws05-conv")).toHaveLength(2);
  });

  it("control: another conversation never sees this conversation's journal", async () => {
    runWebResearchSpy.mockResolvedValueOnce(
      bundle({
        ids: ["S1"],
        urls: ["https://other2.example/page"],
        queries: ["boreal platform overview"],
        excerpts: ["Fresh conversation, fresh evidence."],
      }),
    );
    const res = await POST(
      makeRequest({ prompt: "Tell me about the Boreal platform.", conversationId: "ws05-OTHER", currentDate: "2026-11-05" }),
    );
    const frame = await resultFrame(res);
    expect(Object.keys(frame.citations)).toEqual(["S1"]);
    expect(frame.systemBlock).toBe(CURRENT_BLOCK);
  });
});
