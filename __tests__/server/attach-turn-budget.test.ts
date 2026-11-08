/**
 * I05 + I20 at the TURN layer (2026-11-08):
 *  - the turn's evidence budget is SHARED across attachments (each one used
 *    to get a full ATTACH_RETRIEVE_CHARS allowance);
 *  - an attachment the budget can no longer serve gets an HONEST block, not
 *    silence ("This turn's evidence budget is already full…");
 *  - the block below a served attachment carries an exact dropped-count
 *    marker ("[5 more relevant passages exist… ask to continue…]");
 *  - the shown ledger (I20) persists across turns: a repeat question
 *    surfaces a DIFFERENT passage instead of the same top hit.
 *
 * ATTACH_TURN_BUDGET_CHARS is read at module load — vi.hoisted sets it
 * before any import. The embedder seam returns an empty vector (BM25 alone;
 * the deterministic order is corpus order), so no ONNX model loads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ATTACH_TURN_BUDGET_CHARS = "200";
});

vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import { readShown, removeIndex, writeIndex } from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

const A = "att_turnbudget1";
const B = "att_turnbudget2";

function padTo(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + "q".repeat(n - s.length);
}

function seed(attId: string, name: string) {
  const chunks: IndexChunk[] = Array.from({ length: 6 }, (_, i) => ({
    i, startSec: null, endSec: null,
    text: padTo(`widget ${name}${i} `, 200), // exactly 200 chars each
    vec: [],
  }));
  const meta: IndexMeta = {
    attId, name, category: "text", createdAt: 0, chunkCount: 6,
    spine: "", spineBlocks: [], frames: [],
  };
  writeIndex(attId, meta, chunks, chunks.map((c) => c.text).join("\n"));
}

// >= 60 chars ⇒ not followup-anchored; routes to point_qa (no exhaustive /
// time patterns). "describe everything" must NOT match the exhaustive list.
const Q = "According to the indexed documents, describe everything about widget usage.";

function messages(): { role: string; content: unknown[] }[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: A, name: "doc-a.txt", category: "text" },
        { type: "attachment_ref", att_id: B, name: "doc-b.txt", category: "text" },
      ],
    },
  ];
}

const systemBlocks = (msgs: unknown[]) =>
  (msgs as { role: string; content: unknown }[])
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content));

beforeAll(() => {
  removeIndex(A);
  removeIndex(B);
  seed(A, "ALPHA");
  seed(B, "BETA");
});

afterAll(() => {
  removeIndex(A);
  removeIndex(B);
});

describe("shared turn budget (I05)", () => {
  it("turn 1: first attachment fits the budget and reports its dropped count honestly; the second gets the exhausted block", async () => {
    const msgs = messages();
    // TURN_BUDGET 200: one 200-char chunk fits (cost 200); the next costs
    // 200+2 ⇒ stops at ONE pick with 5 dropped; turnUsed == 200 ⇒ the
    // second attachment sees remaining == 0.
    const blocks = await buildAttachmentTurn(msgs as never[], 0, Q);
    expect(blocks).toBe(2);
    const sys = systemBlocks(msgs).join("\n");
    // Served attachment: exact dropped marker (not the vague truncated one).
    expect(sys).toContain(
      "[5 more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]",
    );
    expect(sys).toContain("widget ALPHA0");
    // Budgeted-out attachment: honest block naming doc-b, not silence.
    expect(sys).toContain('<knowledge_index name="doc-b.txt">');
    expect(sys).toContain(
      "This turn's evidence budget is already full, so no passages from this attachment were retrieved for it. Ask the question again in a new turn.",
    );
    // Only what was actually served rides the ledger.
    expect(readShown(A)).toEqual([0]);
    expect(readShown(B)).toEqual([]);
  });

  it("turn 2 (same question): the shown ledger demotes chunk 0 — a DIFFERENT passage is served", async () => {
    const msgs = messages();
    const blocks = await buildAttachmentTurn(msgs as never[], 0, Q);
    expect(blocks).toBe(2);
    const sys = systemBlocks(msgs).join("\n");
    expect(sys).toContain("widget ALPHA1"); // fresh wins over the shown top hit
    expect(sys).not.toContain("widget ALPHA0");
    expect(readShown(A)).toEqual([0, 1]);
  });
});
