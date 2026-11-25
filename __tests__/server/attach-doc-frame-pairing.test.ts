/**
 * F152 — indexed documents must keep their pixels, and serve them PAIRED.
 *
 * The reproduced defect: a PPTX whose slide 1 carries an embedded legend
 * image (ppt/media/image-3-1.png) rendered through region inspection — the
 * extract seam shipped labelled frames, the client's indexed branch ships
 * only an attachment_ref (zero pixels, by design), and the retrieval layer
 * dropped the document's frames entirely: meta.frames stayed empty, so the
 * final multimodal request carried no picture for a "which line crosses the
 * threshold?" question about an indexed document.
 *
 * Laws pinned here:
 *  1. an OVERSIZED document's rendered frames PERSIST into the index
 *     (meta.frames), self-describing (label) and region-addressable (region);
 *     the indexed extract result ships NO inline frames (pixels are
 *     server-side; retrieval owns delivery per question);
 *  2. retrieval pairs a labelled frame ONLY with a passage that names its
 *     unit (the page/slide/sheet ordinal stated in the passage's own header)
 *     — a chart's picture never rides with an unrelated unit's text, and
 *     frames whose unit no passage names are not served at all;
 *  3. the video moments law keeps its exact bytes: document pictures ride
 *     their own lead-in, on the unit axis (no 180-second window applies).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Read at module load (attach-turn-budget law): one 200-char pick per turn, so
// the pairing law is measured on a retrieval that serves EXACTLY the passage
// the question is about — no "the whole doc fit in the budget" shortcuts.
vi.hoisted(() => {
  process.env.ATTACH_TURN_BUDGET_CHARS = "200";
});

vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import fs from "node:fs";
import path from "node:path";

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import { retrieveEvidence } from "@/lib/server/attachindex/retrieve";
import { indexDir, readIndex, removeIndex, writeIndex } from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";
import { extractFileFromPath } from "@/lib/server/extract";
import { DOCUMENT_PARSE_CAPABILITY, type MlJobEnvelope, type RunJob } from "@/lib/server/extract/document-capability";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// 1. retrieve: pageCues come from the winning passages' OWN unit headers.
// ---------------------------------------------------------------------------
describe("retrieve pageCues (F152 pairing key)", () => {
  const chunks: IndexChunk[] = [
    { i: 0, startSec: null, endSec: null, vec: [], text: "### slide 1\nInspection image: the AMBER CLOSE threshold marker." },
    { i: 1, startSec: null, endSec: null, vec: [], text: "### page 12 | read by: native\nMaintenance threshold is 61 litres.\n[page 12 reprinted in the appendix]\n### page 13" },
    { i: 2, startSec: null, endSec: null, vec: [], text: "A page of prose that names no unit at all, and a decoy 'page ' with no digits." },
  ];
  const meta: IndexMeta = {
    attId: "att_pagecue1", name: "deck.pptx", category: "office", createdAt: 0,
    chunkCount: 3, spine: "", spineBlocks: [], frames: [],
  };

  beforeAll(() => writeIndex("att_pagecue1", meta, chunks, chunks.map((c) => c.text).join("\n")));
  afterAll(() => removeIndex("att_pagecue1"));

  it("extracts ordinals from every header shape, deduped in first-mention order", () => {
    const ev = retrieveEvidence(readIndex("att_pagecue1")!, "AMBER CLOSE threshold marker litres", [], {
      mode: "point_qa",
      demote: [],
      budget: 24000,
    });
    const text = ev.text;
    expect(text).toContain("AMBER CLOSE");
    expect(text).toContain("Maintenance threshold");
    // "### slide 1" + page 12 (first mention; the appendix reprint is a dup) +
    // "### page 13"; the unit-less chunk contributes nothing; a "page " prefix
    // with no digits is not a cue.
    expect(ev.pageCues).toEqual([1, 12, 13]);
  });

  it("a passage set naming no unit yields zero cues (no frame is ever served unpaired)", () => {
    // Its own index: every retrievable passage is unit-less, so no adjacency
    // expansion can pull a cued neighbour in — the honest zero-cue shape.
    const att = "att_nocue1";
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, vec: [], text: "A page of prose that names no unit at all, and a decoy 'page ' with no digits." },
    ];
    const meta: IndexMeta = {
      attId: att, name: "notes.txt", category: "text", createdAt: 0,
      chunkCount: 1, spine: "", spineBlocks: [], frames: [],
    };
    writeIndex(att, meta, chunks, chunks.map((c) => c.text).join("\n"));
    try {
      const ev = retrieveEvidence(readIndex(att)!, "prose decoy digits", [], {
        mode: "point_qa",
        demote: [],
        budget: 24000,
      });
      expect(ev.text).toContain("names no unit");
      expect(ev.pageCues).toEqual([]);
    } finally {
      removeIndex(att);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. turn: the paired frame arrives, labelled, on the unit axis.
// ---------------------------------------------------------------------------
describe("indexed document frames are served paired to their unit (F152)", () => {
  const ATT = "att_docpair1";
  const Q = "According to the attached deck, which coloured line crosses the AMBER CLOSE threshold?";
  // No "summarize" here: that routes to the notes path, not passage QA.
  const Q2 = "According to the attached deck, what figures are given for warehouse Kappa?";

  function padTo(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n) : s + "q".repeat(n - s.length);
  }
  const text = (unit: number, body: string) => padTo(`### slide ${unit}\n${body}`, 200);

  beforeAll(() => {
    removeIndex(ATT);
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, vec: [], text: text(1, "Inspection image: the AMBER CLOSE threshold marker on the trend chart.") },
      { i: 1, startSec: null, endSec: null, vec: [], text: text(2, "Quarterly staffing roster for the depot.") },
      { i: 2, startSec: null, endSec: null, vec: [], text: text(3, "Warehouse Kappa budget: the quarterly figures total 41,900.") },
      { i: 3, startSec: null, endSec: null, vec: [], text: text(4, "Closing remarks and next steps.") },
    ];
    const meta: IndexMeta = {
      attId: ATT, name: "deck.pptx", category: "office", createdAt: 0,
      chunkCount: 4, spine: "", spineBlocks: [],
      // Two of the four slides carry rendered embedded images; slides 2 and 4
      // are pure text and own no frame.
      frames: [
        { at: 1, file: "frames/d_001.png", label: "slide 1", region: "pptx:1:ppt/media/image-3-1.png" },
        { at: 3, file: "frames/d_003.png", label: "slide 3", region: "pptx:3:ppt/media/image-9-1.png" },
      ],
    };
    // Keyframes must be on disk BEFORE the build (the ffmpeg law): publish
    // validates every declared meta.frames path and moves the bytes into the
    // generation — a declared frame missing on disk fails the publish.
    const dir = indexDir(ATT);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    for (const n of ["d_001.png", "d_003.png"]) fs.writeFileSync(path.join(dir, "frames", n), Buffer.from(PNG_B64, "base64"));
    writeIndex(ATT, meta, chunks, chunks.map((c) => c.text).join("\n"));
  });
  afterAll(() => removeIndex(ATT));

  const userParts = (msgs: any[]) => (msgs.find((m) => m.role === "user")!.content) as any[];
  const sysText = (msgs: any[]) => msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

  it("the passage naming slide 1 serves slide 1's picture — labelled, PNG mime, on the doc lead-in", async () => {
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q);
    expect(blocks).toBe(1);
    // The evidence block is injected BEFORE the user turn — find roles, not positions.
    const sys = sysText(msgs);
    expect(sys).toContain("AMBER CLOSE");
    const parts = userParts(msgs);
    const images = parts.filter((p) => p.type === "image_url");
    expect(images.length).toBe(1);
    expect(images[0].image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
    const joined = parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
    // Document lead-in law (its own — NOT the video moments law).
    expect(joined).toContain("Each picture below is labelled with where it sits in the attached document");
    expect(joined).not.toContain("Moments from the attached video");
    // The image is directly preceded by its unit label.
    const k = parts.findIndex((p) => p.type === "text" && (p.text as string).includes("slide 1 — drawn content:"));
    expect(k).toBeGreaterThanOrEqual(0);
    expect(parts[k + 1].type).toBe("image_url");
    // Coverage counts the frame that was actually shown (2 frames exist).
    expect(sys).toContain("; 1 of 2 saved keyframes shown");
  });

  it("the passage naming slide 3 serves slide 3's picture and never slide 1's", async () => {
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q2 },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q2);
    expect(blocks).toBe(1);
    const sys = sysText(msgs);
    expect(sys).toContain("Warehouse Kappa");
    // The retrieved passage names only unit 3 → only slide 3's frame pairs.
    // Slide 1's picture (the chart legend) never rides with unrelated text.
    const parts = userParts(msgs);
    expect(parts.filter((p) => p.type === "image_url").length).toBe(1);
    const labels = parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
    expect(labels).toContain("slide 3 — drawn content:");
    expect(labels).not.toContain("slide 1 — drawn content:");
    expect(sys).toContain("; 1 of 2 saved keyframes shown");
  });
});

// ---------------------------------------------------------------------------
// 3. extract: an oversized document's frames persist into the index; the
//    indexed result ships no inline pixels.
// ---------------------------------------------------------------------------
describe("oversized document persists labelled region frames into the index (F152)", () => {
  const ATT = "att_docpersist1";
  const padded = "Fuel threshold readings per station. ".repeat(1600); // > TEXT_CHAR_LIMIT

  const envelope = (): MlJobEnvelope =>
    ({
      state: "ready",
      capability: DOCUMENT_PARSE_CAPABILITY,
      job_id: "job_f152", run_id: "run_f152", request_id: "req_f152", deadline_s: 90,
      source: "rust-ml-job",
      result: {
        payload: {
          coverage_complete: true,
          document: {
            kind: "pptx",
            blocks: [{ text: padded, kind: "slide_text", loc: { slide: 1 } }],
            coverage: {
              method: "ruke-ml pptx reader", note: "1/1 slides read",
              units_total: 1, units_extracted: 1,
              units_succeeded: [1], units_empty: [], units_needing_ocr: [], units_failed: [],
            },
            meta: {}, source_id: "deck-big.pptx", source_hash: "h",
          },
          rendered_units: [{ unit: 1, text: `### slide 1\n${padded}`, provenance: "text-layer", engine: "ruke-ml pptx reader", blocks: 1, truncated: false }],
          ocr: { ran: false, pages: [], engines_recognised: {} },
          visual_pages: [
            { page: 1, ops: 0, png_base64: PNG_B64, label: "slide 1", region: "pptx:1:ppt/media/image-3-1.png", region_state: "ocr_read" },
          ],
          visual_note: "1 region rendered",
        },
        coverage: { units: "slides", total_source: 1, complete: true, note: "" },
      },
    }) as unknown as MlJobEnvelope;

  const src = (() => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f152pair_"));
    const p = path.join(dir, "deck-big.pptx");
    fs.writeFileSync(p, Buffer.from("not a real pptx — the capability envelope drives the read"));
    return p;
  })();

  beforeAll(() => removeIndex(ATT));
  afterAll(() => {
    removeIndex(ATT);
    fs.rmSync(path.dirname(src), { recursive: true, force: true });
  });

  it("indexed result carries no inline frames; meta.frames persists label + region, and the file exists", async () => {
    const runJob: RunJob = (async () => envelope()) as RunJob;
    const r = await extractFileFromPath("deck-big.pptx", src, ATT, undefined, undefined, { runJob });
    expect(r.indexed).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.frames).toBeUndefined();
    const loaded = readIndex(ATT);
    expect(loaded).not.toBeNull();
    // F152: the region inspection's state rides along — the cached evidence
    // an explicit reread refreshes.
    expect(loaded!.meta.frames).toEqual([
      { at: 1, file: "frames/d_001.png", label: "slide 1", region: "pptx:1:ppt/media/image-3-1.png", state: "ocr_read" },
    ]);
    expect(fs.existsSync(path.join(indexDir(ATT), "frames/d_001.png"))).toBe(true);
  });
});
