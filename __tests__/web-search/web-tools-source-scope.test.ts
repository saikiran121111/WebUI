/**
 * F80 (2026-11-23): attachment source-scope, enforced at DISPATCH.
 *
 * C3 (fr-P1): a question about an ATTACHED PDF (legend range on physical
 * page 17) escaped to three real web searches about Figure SPM.5 and ended
 * with NO completed answer. The fix is a general source-scope rule —
 * question-about-supplied-file → local attachment evidence; missing local
 * evidence → report the limitation from the attachment; only an explicit
 * external-verification intent reaches the web boundary. No keyword lists,
 * no filename lists, no prompt-phrase matchers: the gate LOOKS UP the
 * model's own stated claims in the turn's stored attachment indexes
 * (hybrid retrieval, lexical here), and the model declares external scope
 * structurally via `external_verification: true` (the routing contract).
 *
 * Enforcement lives in the exec layer (TS owns every model-facing
 * envelope — ⇔ Rust transport forwards args verbatim), so BOTH transports
 * are covered by this one seam.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  readIndex: vi.fn(),
}));
const metasearchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/attachindex/store", () => ({
  readIndex: storeMocks.readIndex,
  hasIndex: () => true,
}));
vi.mock("@/lib/web-search/metasearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/metasearch")>()),
  metasearch: metasearchMock,
}));
vi.mock("@/lib/web-search/extractor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web-search/extractor")>()),
  extractUrl: vi.fn(),
}));
vi.mock("@/lib/web-search/segment-filter", () => ({
  applySegmentFilter: vi.fn(),
}));
vi.mock("@/lib/web-search/ssrf", () => ({
  isSafeUrlWithDns: vi.fn(),
}));

import {
  makeWebToolSession,
  execWebSearchTool,
  execReadPageTool,
  webToolDefinitions,
} from "@/lib/web-search/tools";

// The fixture corpus is the fr-P1 law in miniature: the attached paper's
// stored index carries the figure caption + axis ticks as text, so the
// keyed fact (−40 … 40 under "Change (%)") IS locally retrievable.
const INDEX = {
  meta: { attId: "att_f80test01", kind: "pdf", durationSec: null },
  chunks: [
    { i: 0, startSec: null, endSec: null, vec: [], text: "Page 16: methods cohort description" },
    {
      i: 1,
      startSec: null,
      endSec: null,
      vec: [],
      text: "Page 17 Figure SPM.5 Precipitation change per region. Axis ticks: -40, -20, 0, 20, 40 under the label Change (%).",
    },
  ],
};

const ATT = "att_f80test01";

beforeEach(() => {
  storeMocks.readIndex.mockReset().mockReturnValue(INDEX);
  metasearchMock.mockReset().mockResolvedValue([]);
});

const searchArgs = (over: Record<string, unknown> = {}) => ({
  queries: ["SPM.5 precipitation legend range"],
  missing_claims: ["the axis range shown in the Change (%) legend of figure SPM.5"],
  reason: "the attached page carries the legend",
  ...over,
});

describe("F80: attachment turns route file-scoped calls to local evidence at dispatch", () => {
  it("a web_search whose claims the attachment answers is REFUSED with the local passages", async () => {
    const session = makeWebToolSession("quick", 1, "what range does the legend span", null, false, null, [], [ATT]);
    const env = await execWebSearchTool(session, searchArgs(), []);
    expect(env.ok).toBe(false);
    expect(env.error).toBe("local_attachment_evidence");
    expect(String(env.detail)).toContain("Change (%)");
    expect(String(env.detail)).toContain("40");
    // The refusal is not an external lookup: no budget consumed.
    expect(session.searchesUsed).toBe(0);
    expect(session.actionLedger.some((r) => r.ok === false && r.error === "local_attachment_evidence")).toBe(true);
  });

  it("external_verification:true (the routing-contract escape) reaches the web boundary", async () => {
    const session = makeWebToolSession("quick", 1, "is that still true today", null, false, null, [], [ATT]);
    const env = await execWebSearchTool(
      session,
      searchArgs({ external_verification: true, missing_claims: ["the current published value of the same index today"] }),
      [],
    );
    // Proceeded: the engine seam was reached (budget consumed, no refusal code).
    expect(env.error).toBeUndefined();
    expect(session.searchesUsed).toBe(1);
    expect(metasearchMock).toHaveBeenCalled();
  });

  it("a file-scoped claim the attachment does NOT carry is refused with the report-limitation law (web is NOT a substitute for a missing file fact)", async () => {
    const session = makeWebToolSession("quick", 1, "what is the legend range", null, false, null, [], [ATT]);
    const env = await execWebSearchTool(
      session,
      searchArgs({ missing_claims: ["the author home address and personal phone number"] }),
      [],
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("attachment_scope_required");
    expect(session.searchesUsed).toBe(0);
    expect(metasearchMock).not.toHaveBeenCalled();
  });

  it("turns without attachments are untouched (web tools keep full power)", async () => {
    const session = makeWebToolSession("quick", 1, "plain web question", null, false, null, [], []);
    const env = await execWebSearchTool(session, searchArgs(), []);
    expect(session.searchesUsed).toBe(1);
    expect(env.error).not.toBe("local_attachment_evidence");
    expect(env.error).not.toBe("attachment_scope_required");
  });

  it("read_page is gated by the same law on attachment turns", async () => {
    const session = makeWebToolSession("quick", 1, "read the author page", null, false, null, [], [ATT]);
    const env = await execReadPageTool(
      session,
      { urls: ["https://example.com/author-home-address"], focus: "author home address personal" },
      [],
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("attachment_scope_required");
    // Same escape hatch.
    const pass = await execReadPageTool(
      session,
      { urls: ["https://example.com/author-home-address"], external_verification: true },
      [],
    );
    expect(pass.error).not.toBe("attachment_scope_required");
  });

  it("the routing contract declares external_verification on both web tools", () => {
    const defs = webToolDefinitions();
    for (const name of ["web_search", "read_page"]) {
      const d = defs.find((t) => t.function.name === name);
      expect(d, `tool ${name} missing`).toBeTruthy();
      const props = d!.function.parameters.properties as Record<string, { type?: string }>;
      expect(props.external_verification?.type).toBe("boolean");
    }
  });

  it("a session with an unreadable index refuses scope-asserted calls, never crashes", async () => {
    storeMocks.readIndex.mockReturnValue(null);
    const session = makeWebToolSession("quick", 1, "q", null, false, null, [], ["att_gone0000"]);
    const env = await execWebSearchTool(session, searchArgs(), []);
    expect(env.ok).toBe(false);
    expect(env.error).toBe("attachment_scope_required");
    expect(session.searchesUsed).toBe(0);
  });
});
