/**
 * F152 targeted reread — two figures, only the requested one runs again.
 *
 * The law under test: when the user explicitly asks for a CLOSER read of one
 * figure in an indexed document, Ruke resolves the region the question aims
 * at (the unit the retrieved passages name), re-inspects ONLY that region,
 * and answers from the result in the SAME turn. Everything else — the other
 * figure's pixels, state and recovered text — keeps its cached evidence,
 * untouched. An ordinary follow-up that names no closer read runs ZERO
 * inspection calls, and a repeated reread never appends the same recovered
 * text twice (identical labels in DIFFERENT regions stay separate, because
 * the dedup key is the region id).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

// One 200-char pick per turn: the reread region is exactly the unit the ONE
// retrieved passage names — no "the whole doc fit in the budget" shortcuts.
vi.hoisted(() => {
  process.env.ATTACH_TURN_BUDGET_CHARS = "200";
});

// embedOne ships a non-empty vector so a reread passage persists durably;
// retrieval itself stays lexical (empty question vectors), as in the pairing
// law spec.
vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [0.5, 0.25],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import fs from "node:fs";
import path from "node:path";

import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import {
  indexDir, readIndex, removeIndex, removeUpload, storeUpload, writeIndex,
} from "@/lib/server/attachindex/store";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";
import { makeRegionReader, rereadRegions } from "@/lib/server/attachindex/reread";
import {
  DOCUMENT_PARSE_CAPABILITY, type MlJobEnvelope, type RunJob,
} from "@/lib/server/extract/document-capability";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A visibly different 1x1 PNG: the refreshed pixels the reread must write.
const NEW_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const R1 = "pptx:1:ppt/media/image-1-1.png";
const R2 = "pptx:2:ppt/media/image-2-1.png";
const OCR_TEXT = "VOLTAGE 240 legend for the intake chart";

function padTo(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + "q".repeat(n - s.length);
}

const scratchDirs: string[] = [];

/** Seed one attachment: two slides (each with a region frame), frames on
 *  disk, and the durable upload the reread re-renders from. */
function seed(att: string, withUpload = true): void {
  removeIndex(att);
  const chunks: IndexChunk[] = [
    { i: 0, startSec: null, endSec: null, vec: [], text: padTo("### slide 1\nInspection image: the AMBER CLOSE trend chart marker.", 200) },
    { i: 1, startSec: null, endSec: null, vec: [], text: padTo("### slide 2\nQuarterly staffing roster for the depot: intake and output.", 200) },
  ];
  const meta: IndexMeta = {
    attId: att, name: "deck.pptx", category: "office", createdAt: 0,
    chunkCount: 2, spine: "", spineBlocks: [],
    frames: [
      { at: 1, file: "frames/d_001.png", label: "slide 1", region: R1, state: "recognised" },
      // The reread target starts as an UNREAD region: a successful closer
      // read must flip exactly this entry's cached state.
      { at: 2, file: "frames/d_002.png", label: "slide 2", region: R2, state: "skipped" },
    ],
  };
  const dir = indexDir(att);
  fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
  for (const n of ["d_001.png", "d_002.png"]) fs.writeFileSync(path.join(dir, "frames", n), Buffer.from(PNG_B64, "base64"));
  writeIndex(att, meta, chunks, chunks.map((c) => c.text).join("\n"));
  if (withUpload) {
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "rr_"));
    scratchDirs.push(dir2);
    const p = path.join(dir2, "deck.pptx");
    fs.writeFileSync(p, Buffer.from("deck bytes — the capability envelope drives the reread"));
    storeUpload(p, att, "pptx");
  }
}
function unseed(att: string): void {
  removeIndex(att);
  removeUpload(att);
}
afterAll(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * The scoped region job, as the python filter behaves: the payload's
 * "regions" list decides EXACTLY which regions render and get recognised —
 * asking for one region returns pixels for that region and nothing else.
 */
function scopedRunJob(
  calls: Record<string, unknown>[],
  outcome: { text?: string | null; state?: string } = {},
): RunJob {
  const text = outcome.text === undefined ? OCR_TEXT : outcome.text;
  const state = outcome.state ?? (text ? "recognised" : "skipped");
  return (async (_cap: string, payload: Record<string, unknown>) => {
    calls.push(payload);
    const regions = Array.isArray(payload.regions) ? (payload.regions as string[]) : [];
    const visual = regions.map(r => {
      const unit = Number(r.split(":")[1]);
      return { page: unit, ops: 0, png_base64: NEW_B64, label: `slide ${unit}`, region: r, region_state: state };
    });
    const blocks = text === null ? [] : regions.map(r => ({
      text, kind: "ocr_text",
      loc: { slide: Number(r.split(":")[1]), engine: "tesseract", language_code: "eng" },
    }));
    return {
      state: "ready",
      capability: DOCUMENT_PARSE_CAPABILITY,
      job_id: "job_rr", run_id: "run_rr", request_id: "req_rr", deadline_s: 90, source: "rust-ml-job",
      result: {
        payload: {
          coverage_complete: true,
          document: {
            kind: "pptx",
            blocks: [
              { text: "Quarterly staffing roster for the depot: intake and output.", kind: "slide_text", loc: { slide: 2 } },
              ...blocks,
            ],
            coverage: {
              method: "ruke-ml pptx reader", note: "2/2 slides read",
              units_total: 2, units_extracted: 2,
              units_succeeded: [1, 2], units_empty: [], units_needing_ocr: [], units_failed: [],
            },
            meta: {}, source_id: "deck.pptx", source_hash: "h",
          },
          ocr: { ran: true, attempted: regions.length, recognized: text === null ? 0 : regions.length, pages: [], engines_recognised: { tesseract: text === null ? 0 : regions.length } },
          visual_pages: visual,
        },
        coverage: { units: "slides", total_source: 2, complete: true, note: "" },
      },
    };
  }) as unknown as RunJob;
}

const userParts = (msgs: any[]) => (msgs.find((m) => m.role === "user")!.content) as any[];
const sysText = (msgs: any[]) => msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

describe("targeted reread of one figure through the production turn (F152)", () => {
  const ATT = "att_reread1";
  const Q = "look closer at the staffing roster on slide 2 — what does the small legend label say?";

  const calls: Record<string, unknown>[] = [];
  const reader = makeRegionReader({ runJob: scopedRunJob(calls) });

  afterAll(() => unseed(ATT));

  it("only the requested region re-runs; its refreshed pixels, state and text serve this same turn", async () => {
    seed(ATT);
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, reader);
    expect(blocks).toBe(1);

    // Invocation proof: EXACTLY one job, scoped to EXACTLY the region of the
    // figure the question names (the passage names slide 2 → region R2).
    // Slide 1's region never appears — its cached evidence is not re-run.
    expect(calls.length).toBe(1);
    expect(calls[0].regions).toEqual([R2]);

    // The recovered fact rides THIS turn's evidence block, with its region
    // id and the actual engine — merged with its source location, not fused
    // into the native text.
    const sys = sysText(msgs);
    expect(sys).toContain("[close re-read this turn");
    expect(sys).toContain(OCR_TEXT);
    expect(sys).toContain(`region ${R2}`);
    expect(sys).toContain("engine tesseract / eng");

    // The refreshed crop — the slide-2 pixels the visual question answers
    // from — is served ONCE, paired to its unit label, with the refreshed
    // bytes (slide 1's stale frame may ride per the pairing law — adjacency
    // named it; that is pairing's law, not the reread's).
    const parts = userParts(msgs);
    const images = parts.filter((p) => p.type === "image_url");
    const fresh = images.filter((p) => p.image_url.url === `data:image/png;base64,${NEW_B64}`);
    expect(fresh.length).toBe(1);
    const labels = parts.filter((p) => p.type === "text").map((p) => p.text as string).join("\n");
    expect(labels).toContain("slide 2 — drawn content:");

    // Durable refresh: ONLY the selected region changes.
    const loaded = readIndex(ATT)!;
    expect(loaded.meta.frames.find(f => f.at === 2)!.state).toBe("recognised");
    expect(loaded.meta.frames.find(f => f.at === 1)!.state).toBe("recognised"); // seeded, untouched
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_002.png")).equals(Buffer.from(NEW_B64, "base64"))).toBe(true);
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_001.png")).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);

    // The recovered text persists with its unit header + region id, exactly
    // once (the cache was invalidated: this readIndex sees it).
    expect(loaded.chunks.length).toBe(3);
    const rrChunk = loaded.chunks[2];
    expect(rrChunk.text).toContain(`### slide 2`);
    expect(rrChunk.text).toContain(`region ${R2}]`);
    expect(rrChunk.text).toContain(OCR_TEXT);
    expect(rrChunk.startSec).toBeNull(); // the route axis stays "text" for documents
    expect(rrChunk.vec.length).toBeGreaterThan(0);
  });

  it("an ordinary visual follow-up reuses the cached evidence: zero inspection calls", async () => {
    const calls2: Record<string, unknown>[] = [];
    const reader2 = makeRegionReader({ runJob: scopedRunJob(calls2) });
    const Q2 = "According to the attached deck, which staffing figure does the slide 2 roster give for the depot?";
    const before = readIndex(ATT)!;
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q2 },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q2, undefined, undefined, undefined, reader2);
    expect(blocks).toBe(1);
    expect(calls2.length).toBe(0);
    expect(sysText(msgs)).not.toContain("[close re-read this turn");
    const after = readIndex(ATT)!;
    expect(after.chunks.length).toBe(before.chunks.length);
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_002.png")).equals(Buffer.from(NEW_B64, "base64"))).toBe(true);
  });

  it("a repeated reread refreshes the region's pixels again but never duplicates its recovered text", async () => {
    seed(ATT); // fresh cached evidence: slide 2 starts unread, text not yet persisted
    const calls3: Record<string, unknown>[] = [];
    const runJob = scopedRunJob(calls3);
    const first = await rereadRegions(ATT, Q, readIndex(ATT)!, [2], { runJob });
    expect(first.regions).toEqual([R2]);
    expect(first.lines.join("\n")).toContain(OCR_TEXT);
    const afterFirst = readIndex(ATT)!;
    expect(afterFirst.chunks.length).toBe(3);

    const second = await rereadRegions(ATT, Q, readIndex(ATT)!, [2], { runJob });
    expect(calls3.length).toBe(2); // the inspection ran again (that's the request)
    expect(calls3[1].regions).toEqual([R2]);
    // ...but the identical recovered text for THIS region id is reused as
    // cached evidence, not appended twice, and earns no duplicate line.
    expect(second.lines.length).toBe(0);
    const afterSecond = readIndex(ATT)!;
    expect(afterSecond.chunks.length).toBe(3);
    expect(afterSecond.chunks.filter(c => c.text.includes(OCR_TEXT)).length).toBe(1);
  });
});

describe("region granularity: two figures on the SAME page (F152 amendment)", () => {
  // Selecting by UNIT re-inspected EVERY picture on the page and mixed their
  // text. The question's figure ordinal (or a word its label carries) must
  // scope the job to EXACTLY one region; the neighbour runs ZERO invocations.
  const ATT = "att_reread4";
  const RA = "pdf:1:page:1/image:0";
  const RB = "pdf:1:page:1/image:1";

  function seedPage(): void {
    removeIndex(ATT);
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, vec: [], text: padTo("### page 1\nProse: the survey ran eleven trials; KAPPA crossed the threshold.", 200) },
    ];
    const meta: IndexMeta = {
      attId: ATT, name: "survey.pdf", category: "pdf", createdAt: 0,
      chunkCount: 1, spine: "", spineBlocks: [],
      frames: [
        { at: 1, file: "frames/d_001.png", label: "page 1, figure 1", region: RA, state: "recognised" },
        { at: 1, file: "frames/d_002.png", label: "page 1, figure 2", region: RB, state: "skipped" },
      ],
    };
    const dir = indexDir(ATT);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    for (const n of ["d_001.png", "d_002.png"]) fs.writeFileSync(path.join(dir, "frames", n), Buffer.from(PNG_B64, "base64"));
    writeIndex(ATT, meta, chunks, chunks.map(c => c.text).join("\n"));
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "rr_"));
    scratchDirs.push(dir2);
    const p = path.join(dir2, "survey.pdf");
    fs.writeFileSync(p, Buffer.from("survey pdf bytes"));
    storeUpload(p, ATT, "pdf");
  }

  afterAll(() => unseed(ATT));

  it("naming figure 2 inspects ONLY figure 2's region; figure 1 ran zero invocations", async () => {
    seedPage();
    const calls: Record<string, unknown>[] = [];
    const out = await rereadRegions(ATT, "zoom in on figure 2 on page 1 — what does its label say?", readIndex(ATT)!, [1], { runJob: scopedRunJob(calls) });
    expect(calls.length).toBe(1);
    expect(calls[0].regions).toEqual([RB]);
    expect(out.regions).toEqual([RB]);
    expect(out.lines.join("\n")).toContain(OCR_TEXT);
    expect(out.lines.join("\n")).toContain(`region ${RB}`);
    const loaded = readIndex(ATT)!;
    expect(loaded.meta.frames.find(f => f.region === RB)!.state).toBe("recognised");
    expect(loaded.meta.frames.find(f => f.region === RA)!.state).toBe("recognised"); // seeded, untouched
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_001.png")).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_002.png")).equals(Buffer.from(NEW_B64, "base64"))).toBe(true);
    expect(loaded.chunks.length).toBe(2);
    expect(loaded.chunks[1].text).toContain(`region ${RB}]`);
  });

  it("the word the question shares with ONE label (an anchor) selects it", async () => {
    // Office labels name the anchor ("sheet 2, cell C4"). The unit ordinal
    // (digit) never decides; "C4" is the shared word.
    removeIndex(ATT);
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, vec: [], text: padTo("### sheet 2\nLedger sheet: eleven rows, intake and output.", 200) },
    ];
    const meta: IndexMeta = {
      attId: ATT, name: "ledger.xlsx", category: "office", createdAt: 0,
      chunkCount: 1, spine: "", spineBlocks: [],
      frames: [
        { at: 2, file: "frames/d_001.png", label: "sheet 2, cell C4", region: "xlsx:2:xl/media/image2-1.png", state: "skipped" },
        { at: 2, file: "frames/d_002.png", label: "sheet 2, cell D9", region: "xlsx:2:xl/media/image2-2.png", state: "skipped" },
      ],
    };
    const dir = indexDir(ATT);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    for (const n of ["d_001.png", "d_002.png"]) fs.writeFileSync(path.join(dir, "frames", n), Buffer.from(PNG_B64, "base64"));
    writeIndex(ATT, meta, chunks, chunks.map(c => c.text).join("\n"));
    // removeIndex deletes the upload (store.ts) — each test owns its upload.
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "rr_"));
    scratchDirs.push(dir2);
    const p = path.join(dir2, "ledger.xlsx");
    fs.writeFileSync(p, Buffer.from("ledger xlsx bytes"));
    storeUpload(p, ATT, "xlsx");
    const calls: Record<string, unknown>[] = [];
    const out = await rereadRegions(ATT, "look closer at the picture at C4", readIndex(ATT)!, [2], { runJob: scopedRunJob(calls) });
    expect(calls.length).toBe(1);
    expect(calls[0].regions).toEqual(["xlsx:2:xl/media/image2-1.png"]);
    expect(out.regions).toEqual(["xlsx:2:xl/media/image2-1.png"]);
  });

  it("a closer read naming the page but NO figure keeps BOTH figures in scope", async () => {
    seedPage();
    const calls: Record<string, unknown>[] = [];
    const out = await rereadRegions(ATT, "zoom in on page 1", readIndex(ATT)!, [1], { runJob: scopedRunJob(calls) });
    expect(calls.length).toBe(1);
    expect(calls[0].regions).toEqual([RA, RB]);
    expect(out.regions).toEqual([RA, RB]);
  });
});

describe("missing retrieved passage → targeted read (F153 §3)", () => {
  // The law (brief, turn.ts:245 ⇔ ruke-attach turn.rs:335): a MISSING
  // retrieved passage is a reason to TRY a targeted read when the original
  // is available — the user uploaded the document, the answer should speak
  // about it. The question's own named unit is the targeting (the cue set
  // is empty when nothing was retrieved); a question naming no unit targets
  // nothing and runs ZERO inspection. If the read recovers text, THAT text
  // is this turn's evidence; if it still fails, the narrow plain line names
  // the exact unreadable part — no wording changes hide missing evidence.
  const ATT = "att_reread5";
  // An ORDINARY question: no closer-read phrasing (the F152 gate alone never
  // fires here) and NO lexical overlap with the one indexed passage.
  const Q = "According to attached deck, what does small legend on slide 2 say?";

  function seedMiss(): void {
    removeIndex(ATT);
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, vec: [], text: padTo("### first panel\nAMBER CLOSE trend marker; intake roster figures for depot.", 200) },
    ];
    const meta: IndexMeta = {
      attId: ATT, name: "deck.pptx", category: "office", createdAt: 0,
      chunkCount: 1, spine: "", spineBlocks: [],
      frames: [
        { at: 1, file: "frames/d_001.png", label: "slide 1", region: R1, state: "recognised" },
        { at: 2, file: "frames/d_002.png", label: "slide 2", region: R2, state: "skipped" },
      ],
    };
    const dir = indexDir(ATT);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    for (const n of ["d_001.png", "d_002.png"]) fs.writeFileSync(path.join(dir, "frames", n), Buffer.from(PNG_B64, "base64"));
    writeIndex(ATT, meta, chunks, chunks.map(c => c.text).join("\n"));
    const dir2 = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "rr_"));
    scratchDirs.push(dir2);
    const p = path.join(dir2, "deck.pptx");
    fs.writeFileSync(p, Buffer.from("deck bytes — original available for targeted read"));
    storeUpload(p, ATT, "pptx");
  }
  afterAll(() => unseed(ATT));

  it("the missing passage triggers the targeted read of the named slide; its recovered text answers THIS turn", async () => {
    seedMiss();
    const calls: Record<string, unknown>[] = [];
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, makeRegionReader({ runJob: scopedRunJob(calls) }));
    expect(blocks).toBe(1);
    // Invocation proof: EXACTLY one job, scoped to EXACTLY the named slide's
    // region — the missing passage, not a closer-read phrase, was the reason.
    expect(calls.length).toBe(1);
    expect(calls[0].regions).toEqual([R2]);

    // The evidence names the attempt plainly and carries the recovered fact
    // with its region id (merged with its location, never fused).
    const sys = sysText(msgs);
    expect(sys).toContain("No passage in this attachment's saved record matched the question");
    expect(sys).toContain(OCR_TEXT);
    expect(sys).toContain(`region ${R2}`);

    // The refreshed crop rides paired to its label — the picture of the part
    // the answer speaks about.
    const parts = userParts(msgs);
    const fresh = parts.filter(p => p.type === "image_url" && p.image_url.url === `data:image/png;base64,${NEW_B64}`);
    expect(fresh.length).toBe(1);
    const labels = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(labels).toContain("slide 2 — drawn content:");

    // Durable refresh for the read region only.
    const loaded = readIndex(ATT)!;
    expect(loaded.meta.frames.find(f => f.at === 2)!.state).toBe("recognised");
    expect(loaded.meta.frames.find(f => f.at === 1)!.state).toBe("recognised"); // seeded, untouched
  });

  it("the read runs and STILL recovers nothing: the block names the exact unreadable part plainly", async () => {
    seedMiss();
    const calls: Record<string, unknown>[] = [];
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: Q },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, Q, undefined, undefined, undefined, makeRegionReader({ runJob: scopedRunJob(calls, { text: null, state: "skipped" }) }));
    expect(blocks).toBe(1);
    expect(calls.length).toBe(1);
    // Narrow and plain: which part, where it sits, what the re-inspection
    // actually did — no canned apology, no engine internals.
    const sys = sysText(msgs);
    expect(sys).toContain(`re-read of slide 2, region ${R2}`);
    expect(sys).toContain("recovered no text (state skipped)");
    // The refreshed picture is what the turn answers from, and it rides.
    const parts = userParts(msgs);
    expect(parts.some(p => p.type === "image_url" && p.image_url.url === `data:image/png;base64,${NEW_B64}`)).toBe(true);
  });

  it("targeting guard: a missing passage with NO unit named in the question runs ZERO inspection", async () => {
    seedMiss();
    const calls: Record<string, unknown>[] = [];
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: "According to attached deck, what does small legend say?" },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, "According to attached deck, what does small legend say?", undefined, undefined, undefined, makeRegionReader({ runJob: scopedRunJob(calls) }));
    // Nothing targets anything: no work, no fabricated evidence (the
    // established no-evidence degradation stands).
    expect(calls.length).toBe(0);
    expect(blocks).toBe(0);
  });
});

describe("reread refusals (F152)", () => {
  it("no closer-read phrasing: the turn runs zero inspection calls", async () => {
    const ATT = "att_reread2";
    seed(ATT);
    const calls: Record<string, unknown>[] = [];
    const msgs: any[] = [{
      role: "user",
      content: [
        { type: "text", text: "According to the attached deck, what does the AMBER CLOSE marker on slide 1 mean?" },
        { type: "attachment_ref", att_id: ATT, name: "deck.pptx", category: "office" },
      ],
    }];
    const blocks = await buildAttachmentTurn(msgs, 0, "According to the attached deck, what does the AMBER CLOSE marker on slide 1 mean?", undefined, undefined, undefined, makeRegionReader({ runJob: scopedRunJob(calls) }));
    expect(blocks).toBe(1);
    expect(calls.length).toBe(0);
    expect(fs.readFileSync(path.join(indexDir(ATT), "frames/d_001.png")).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    unseed(ATT);
  });

  it("a document whose original bytes are gone runs nothing (no source to re-render)", async () => {
    const ATT = "att_reread3";
    seed(ATT, false);
    const calls: Record<string, unknown>[] = [];
    const out = await rereadRegions(ATT, "zoom in on the slide 2 legend", readIndex(ATT)!, [2], { runJob: scopedRunJob(calls) });
    expect(out).toEqual({ lines: [], regions: [] });
    expect(calls.length).toBe(0);
    unseed(ATT);
  });
});
