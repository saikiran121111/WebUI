/**
 * F07 (2026-11-15) - attachment retrieval INTENT must be modality/context
 * aware, and the "already shown" ledger must be scoped to a conversation AND
 * to the query that produced it, not to the attachment alone.
 *
 * These are mechanism laws, not phrase whitelists:
 *  1. the TIME AXIS belongs to the content (a document has no timeline, so a
 *     "1:20" ratio inside it must not fabricate a video window);
 *  2. comparative asks carry separate cue windows, never one hull span that
 *     sweeps in everything between the cues;
 *  3. negation is clause-local, so "do not summarize" does not become a
 *     whole-content summary, and an explicit occurrence ask is exhaustive;
 *  4. an exact repeat of a question gets its own top passages BACK, while an
 *     explicit continuation ask or an exhaustive scan rotates to fresh ones;
 *  5. another chat's shown list can never demote evidence here;
 *  6. retrieval is RAW-FIRST: an unrelated short follow-up is no longer glued
 *     onto the previous question's topic, and the antecedent is a bounded
 *     fallback used only when the raw question found nothing.
 *
 * The embed seam returns an empty vector (BM25 alone), so no ONNX model loads
 * and the ranking order is deterministic.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // One 200-char passage fits a turn, the next one (200 + separator) does not,
  // so "which passage was served" is directly observable.
  process.env.ATTACH_TURN_BUDGET_CHARS = "260";
});

vi.mock("@/lib/server/attachindex/embed", () => ({
  embedOne: async () => [],
  embedTexts: async (texts: string[]) => texts.map(() => []),
}));

import {
  fingerprintQuery,
  isContinuationAsk,
  routeQuery,
} from "@/lib/server/attachindex/router";
import { retrieveEvidence } from "@/lib/server/attachindex/retrieve";
import {
  readIndex,
  readShown,
  readShownEntry,
  removeIndex,
  writeIndex,
  writeShown,
} from "@/lib/server/attachindex/store";
import { buildAttachmentTurn } from "@/lib/server/attachindex/turn";
import type { IndexChunk, IndexMeta } from "@/lib/server/attachindex/types";

/* ------------------------------------------- ledger identity (cross-language) */

describe("F07 query identity shared with the Rust router", () => {
  it("fingerprints match the Rust fixtures byte for byte", () => {
    // Pinned a second time in ruke-attach/src/router.rs
    // (`fingerprint_query_pinned_across_languages_f07`); the ledger lives in
    // ONE shared .shown.json, so both sides must produce the same string.
    const pins: [string, string][] = [
      ["widget alpha one", "bc2f2351:16"],
      ["keep going", "7c57360a:10"],
      ["do not summarize", "de4eccdc:16"],
      ["summarise cafe\u00e9", "91973a50:16"],
      ["list every occurrence of the logo", "276bfe32:33"],
      ["widget alpha0 alpha1", "5682d2ba:20"],
    ];
    for (const [q, want] of pins) {
      expect(fingerprintQuery(q)).toBe(want);
    }
  });

  it("normalizes case and whitespace but never tokens", () => {
    expect(fingerprintQuery("  Keep\tGOING  ")).toBe(fingerprintQuery("keep going"));
    expect(fingerprintQuery("keep going")).not.toBe(fingerprintQuery("keep going now"));
  });

  it("recognizes an explicit continuation ask in any case", () => {
    expect(isContinuationAsk("Keep going with the other passages")).toBe(true);
    expect(isContinuationAsk("what is the CPU fan speed")).toBe(false);
  });
});

/* ------------------------------------------------------------------ router */

describe("F07 axis law (the time axis belongs to the content)", () => {
  it("a document question with a 1:20 ratio gets NO time window", () => {
    const q = "what does the 1:20 ratio in this chart mean";
    expect(routeQuery(q, { axis: "text" }).mode).toBe("point_qa");
    // Same wording on a timeline-bearing attachment still routes to time_range.
    const r = routeQuery(q);
    expect(r.mode).toBe("time_range");
    // 80 s is inside the 80+-180 window, so the window floor clamps at 0.
    expect(r.fromSec).toBe(0);
    expect(r.toSec).toBe(260);
  });

  it("relative-minutes rules are axis-gated too", () => {
    expect(routeQuery("show me the first 5 minutes", { axis: "text" }).mode).toBe("point_qa");
    expect(routeQuery("show me the first 5 minutes").mode).toBe("time_range");
    expect(routeQuery("the last 10 minutes", { axis: "text" }).mode).toBe("point_qa");
    expect(routeQuery("the last 10 minutes").mode).toBe("time_range");
    expect(routeQuery("at minute 4", { axis: "text" }).mode).toBe("point_qa");
  });
});

describe("F07 comparative asks keep their cues separate", () => {
  it("two juxtaposed cues carry two windows, not one hull", () => {
    const r = routeQuery("compare what happens at 0:30 with what happens at 9:00");
    expect(r.mode).toBe("time_range");
    expect(r.fromSec).toBe(30); // hull stays for one-range consumers
    expect(r.toSec).toBe(540);
    expect(r.windows).toHaveLength(2);
    expect(r.windows![0]).toEqual({ fromSec: 0, toSec: 210 });
    expect(r.windows![1]).toEqual({ fromSec: 360, toSec: 720 });
  });

  it("an explicit span stays ONE range (pinned replay behaviour)", () => {
    const r = routeQuery("summarize the part from 1:00 to 9:00");
    expect(r.mode).toBe("time_range");
    expect(r.fromSec).toBe(60);
    expect(r.toSec).toBe(540);
    expect(r.windows).toBeUndefined();
    const back = routeQuery("from 10:00 BACK to 5:00");
    expect(back.windows).toBeUndefined();
  });

  it("retrieval honours the windows and skips what lies between the cues", () => {
    // Uneven chunk starts: a uniform grid would put a chunk boundary exactly in
    // the gap and hide the defect. Segment 2 (250-340) lies between the cues.
    const starts = [0, 100, 250, 400, 500, 600];
    const chunks: IndexChunk[] = starts.map((startSec, i) => ({
      i,
      startSec,
      endSec: startSec + 90,
      text: `segment ${i} about widget topic ${i}`,
      vec: [],
    }));
    const meta: IndexMeta = {
      attId: "att_f07gaps1", name: "clip.mp4", category: "video", createdAt: 0,
      durationSec: 700, chunkCount: chunks.length, spine: "", spineBlocks: [], frames: [],
    };
    writeIndex("att_f07gaps1", meta, chunks, chunks.map(c => c.text).join("\n"));
    const index = readIdx("att_f07gaps1");
    const q = "compare the intro at 0:30 with the recap at 9:00";
    const ev = retrieveEvidence(index, q, [], { ...routeQuery(q), budget: 8000 });
    // Cue windows are [0,210] and [360,720]. A single hull [30,540] would also
    // have served segment 2, which mentions neither cue.
    expect(ev.chunkIdxs).toEqual([0, 1, 3, 4, 5]);
    expect(ev.text).not.toContain("segment 2 ");
    removeIndex("att_f07gaps1");
  });
});

describe("F07 negation is clause-local, occurrence phrasing is exhaustive", () => {
  it("a negated summary verb does not hijack the route", () => {
    expect(routeQuery("do not summarize; find the invoice number").mode).toBe("point_qa");
    expect(routeQuery("no summary needed, just find the invoice number").mode).toBe("point_qa");
    // Positive controls stay positive.
    expect(routeQuery("give me a summary").mode).toBe("whole_video");
    expect(routeQuery("skip the recap, summarize the rest").mode).toBe("whole_video");
  });

  it("explicit occurrence asks are exhaustive; look-alikes are not", () => {
    expect(routeQuery("find every occurrence of the logo").mode).toBe("exhaustive");
    expect(routeQuery("list all the instances of the logo").mode).toBe("exhaustive");
    expect(routeQuery("how many times does the kernel appear").mode).toBe("exhaustive");
    // Negative controls (pinned before this change, still point_qa).
    expect(routeQuery("where do we meetup everytime we meet").mode).toBe("point_qa");
    expect(routeQuery("what is the average of all the quiz scores").mode).toBe("point_qa");
  });

  it("a negated exhaustive verb does not hijack the route either", () => {
    expect(routeQuery("do not list every mention; explain the intro").mode).toBe("point_qa");
  });
});

describe("F07 query identity and continuation are shared laws", () => {
  it("fingerprint fixtures (byte-FNV over the normalized UTF-8 bytes) - Rust must agree", () => {
    expect(fingerprintQuery("widget alpha one")).toBe("bc2f2351:16");
    expect(fingerprintQuery("keep going")).toBe("7c57360a:10");
    expect(fingerprintQuery("  Do   NOT Summarize  ")).toBe("de4eccdc:16");
    expect(fingerprintQuery("summarise cafe\u00e9")).toBe("91973a50:16");
    expect(fingerprintQuery("list every occurrence of the logo")).toBe("276bfe32:33");
    expect(fingerprintQuery("widget ALPHA0   ALPHA1")).toBe("5682d2ba:20");
  });

  it("continuation asks are recognized; an unanswered repeat is not one", () => {
    expect(isContinuationAsk("keep going")).toBe(true);
    expect(isContinuationAsk("show me other passages")).toBe(true);
    expect(isContinuationAsk("what is the invoice number")).toBe(false);
    expect(isContinuationAsk("the cpu fan noise")).toBe(false);
  });
});

/* ------------------------------------------------------------------- store */

function readIdx(attId: string) {
  const idx = readIndex(attId);
  if (!idx) throw new Error("index missing: " + attId);
  return idx;
}

describe("F07 shown ledger is conversation-scoped and query-tagged", () => {
  const A = "att_f07ledger1";

  beforeAll(() => removeIndex(A));

  it("conversation A's list never applies to conversation B", () => {
    writeShown(A, [0, 1], { conversationId: "conv_a", queryFp: "fp-a" });
    expect(readShown(A, "conv_a")).toEqual([0, 1]);
    expect(readShownEntry(A, "conv_b")).toBeNull();
    expect(readShown(A, "conv_b")).toEqual([]);
    expect(readShownEntry(A, "conv_a")).toEqual({ q: "fp-a", ids: [0, 1] });
  });

  it("a v1 (bare array) entry is still readable and keeps q empty", () => {
    // store.ts pins its own root to <cwd>/.data/attach-index (ROOT), NOT to
    // WEBUI_DATA_DIR - the ledger path here must mirror that exactly.
    const file = path.join(process.cwd(), ".data", "attach-index", ".shown.json");
    const map = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    map["att_f07legacy1"] = [3, 4];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
    expect(readShown("att_f07legacy1")).toEqual([3, 4]);
    expect(readShownEntry("att_f07legacy1", "conv_new")).toEqual({ q: "", ids: [3, 4] });
    expect(readShownEntry("att_f07legacy1", "")).toEqual({ q: "", ids: [3, 4] });
    delete map["att_f07legacy1"];
    fs.writeFileSync(file, JSON.stringify(map));
  });

  it("rebuilding an index clears every conversation-scoped key for it", () => {
    writeShown(A, [1], { conversationId: "conv_x", queryFp: "fp-x" });
    writeShown(A, [2], { conversationId: "conv_y", queryFp: "fp-y" });
    expect(readShown(A, "conv_x")).toEqual([1]);
    const chunks: IndexChunk[] = [
      { i: 0, startSec: null, endSec: null, text: "widget rebuild", vec: [] },
    ];
    const meta: IndexMeta = {
      attId: A, name: "doc.txt", category: "text", createdAt: 0,
      chunkCount: 1, spine: "", spineBlocks: [], frames: [],
    };
    writeIndex(A, meta, chunks, "widget rebuild");
    expect(readShown(A, "conv_x")).toEqual([]);
    expect(readShown(A, "conv_y")).toEqual([]);
  });

  it("an invalid attachment id never reaches the ledger", () => {
    writeShown("att", [1], { conversationId: "conv_a" });
    expect(readShown("att", "conv_a")).toEqual([]);
  });
});

/* -------------------------------------------------------------- turn layer */

function padTo(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + "q".repeat(n - s.length);
}

function seedText(attId: string, texts: string[]) {
  const chunks: IndexChunk[] = texts.map((t, i) => ({
    i,
    startSec: null,
    endSec: null,
    text: padTo(t, 200),
    vec: [],
  }));
  const meta: IndexMeta = {
    attId, name: attId + ".txt", category: "text", createdAt: 0,
    chunkCount: chunks.length, spine: "", spineBlocks: [], frames: [],
  };
  writeIndex(attId, meta, chunks, chunks.map(c => c.text).join("\n"));
}

function seedTimed(attId: string, n: number) {
  const chunks: IndexChunk[] = Array.from({ length: n }, (_, i) => ({
    i,
    startSec: i * 100,
    endSec: i * 100 + 90,
    text: padTo(`clip segment ${i} about widget thing ${i} `, 190),
    vec: [],
  }));
  const meta: IndexMeta = {
    attId, name: attId + ".mp4", category: "video", createdAt: 0,
    durationSec: n * 100, chunkCount: n, spine: "", spineBlocks: [], frames: [],
  };
  writeIndex(attId, meta, chunks, chunks.map(c => c.text).join("\n"));
}

function msgs(attId: string, text: string) {
  return [
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "attachment_ref", att_id: attId, name: attId + ".txt", category: "text" },
      ],
    },
  ];
}

function msgsTimed(attId: string, text: string) {
  const m = msgs(attId, text);
  (m[0].content[1] as { name: string }).name = attId + ".mp4";
  (m[0].content[1] as { category: string }).category = "video";
  return m;
}

const systemText = (m: unknown[]) =>
  (m as { role: string; content: unknown }[])
    .filter(x => x.role === "system" && typeof x.content === "string")
    .map(x => String(x.content))
    .join("\n");

const REP_Q = "According to the indexed document, which passage explains the widget rating scale?";

describe("F07 turn layer: repeat, continuation and conversation scoping", () => {
  const A = "att_f07repeat1";

  beforeAll(() => {
    removeIndex(A);
    seedText(A, [
      "widget f07zero rating scale explanation ",
      "widget f07one rating scale explanation ",
      "widget f07two rating scale explanation ",
    ].map(t => t.trim()));
  });
  afterAll(() => removeIndex(A));

  it("turn 1 serves the top passage", async () => {
    const m = msgs(A, REP_Q);
    const n = await buildAttachmentTurn(m as never[], 0, REP_Q, undefined, undefined, "conv_a");
    expect(n).toBe(1);
    expect(systemText(m)).toContain("widget f07zero");
    expect(readShown(A, "conv_a")).toEqual([0]);
  });

  it("the SAME question again gets its own answer BACK (the F07 defect)", async () => {
    const m = msgs(A, REP_Q);
    const n = await buildAttachmentTurn(m as never[], 0, REP_Q, undefined, undefined, "conv_a");
    expect(n).toBe(1);
    const sys = systemText(m);
    expect(sys).toContain("widget f07zero");
    expect(sys).not.toContain("widget f07one");
    expect(readShown(A, "conv_a")).toEqual([0]);
  });

  it("an explicit continuation ask rotates to fresh passages", async () => {
    const q = "show me other passages of the indexed document about widget ratings";
    const m = msgs(A, q);
    const n = await buildAttachmentTurn(m as never[], 0, q, undefined, undefined, "conv_a");
    expect(n).toBe(1);
    expect(systemText(m)).toContain("widget f07one");
    expect(readShown(A, "conv_a")).toEqual([0, 1]);
  });

  it("a DIFFERENT conversation is never demoted by conv_a's ledger", async () => {
    const m = msgs(A, REP_Q);
    const n = await buildAttachmentTurn(m as never[], 0, REP_Q, undefined, undefined, "conv_b");
    expect(n).toBe(1);
    expect(systemText(m)).toContain("widget f07zero");
  });
});

describe("F07 turn layer: raw-first retrieval and the axis law", () => {
  const T = "att_f07topic1";
  const V = "att_f07video01";
  const D = "att_f07docscal1";

  beforeAll(() => {
    removeIndex(T);
    seedText(T, [
      "whale migration routes cross the southern ocean every season ",
      "the cpu fan noise rises when the laptop is under heavy load ",
      "whale calves travel with their pods along the same route ",
    ].map(t => t.trim()));
    removeIndex(V);
    seedTimed(V, 6);
    removeIndex(D);
    seedText(D, ["the chart caption states a 1:20 aspect ratio for the figure "]);
  });
  afterAll(() => {
    removeIndex(T);
    removeIndex(V);
    removeIndex(D);
  });

  it("an unrelated short follow-up is NOT glued onto the previous topic", async () => {
    const m = [
      { role: "user", content: [{ type: "text", text: "why do whales migrate along the southern ocean every year" }] },
      { role: "assistant", content: [{ type: "text", text: "because of feeding grounds and water temperature." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "and the cpu fan noise?" },
          { type: "attachment_ref", att_id: T, name: T + ".txt", category: "text" },
        ],
      },
    ];
    const n = await buildAttachmentTurn(m as never[], 2, "and the cpu fan noise?", undefined, undefined, "conv_t");
    expect(n).toBe(1);
    const sys = systemText(m);
    expect(sys).toContain("cpu fan");
    expect(sys).not.toContain("whale");
  });

  it("a question the raw text cannot answer still falls back to the antecedent", async () => {
    const m = [
      { role: "user", content: [{ type: "text", text: "why do whales migrate along the southern ocean every year" }] },
      { role: "assistant", content: [{ type: "text", text: "because of feeding grounds." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "and in winter?" },
          { type: "attachment_ref", att_id: T, name: T + ".txt", category: "text" },
        ],
      },
    ];
    const n = await buildAttachmentTurn(m as never[], 2, "and in winter?", undefined, undefined, "conv_u");
    expect(n).toBe(1);
    expect(systemText(m)).toContain("whale");
  });

  it("a document with no timeline cannot be routed to a time window", async () => {
    const q = "what does the 1:20 aspect ratio mean in the chart caption";
    const m = msgs(D, q);
    const n = await buildAttachmentTurn(m as never[], 0, q, undefined, undefined, "conv_v");
    expect(n).toBe(1);
    expect(systemText(m)).toContain("aspect ratio");
  });

  it("a timeline-bearing attachment still resolves an explicit cue", async () => {
    // 5:30 -> the +-180 s window [150,510]; the budget serves the FIRST chunk
    // overlapping it (segment 1, 100-190), not the one nearest the cue.
    const q = "what happens in the clip at 5:30";
    const m = msgsTimed(V, q);
    const n = await buildAttachmentTurn(m as never[], 0, q, undefined, undefined, "conv_w");
    expect(n).toBe(1);
    const sys = systemText(m);
    expect(sys).toContain("clip segment 1");
    expect(sys).toContain("[00:01:40 - 00:03:10]");
  });
});
