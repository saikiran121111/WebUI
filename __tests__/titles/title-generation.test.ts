/**
 * Title generation with a FAKE model transport — no real inference in unit
 * tests. Covers: writing rules (length/quotes/intros/multi-line), full-
 * history transcript construction, the single-pass path, the map-reduce path
 * for long conversations, and failure behaviour (never throws, never
 * corrupts: invalid or empty output resolves to null).
 */

import { describe, expect, it } from "vitest";
import {
  callMainModel,
  normalizeTitle,
  planTitle,
  TITLE_SYSTEM,
  SUMMARY_SYSTEM,
  TITLE_CHUNK_CHARS,
  TITLE_TRANSCRIPT_CHARS,
  type CallModel,
} from "@/lib/server/titles/generate";
import { buildTranscript, chunkTurns, transcriptChars } from "@/lib/server/titles/transcript";

const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  id: `${role}-${Math.random().toString(36).slice(2)}`,
  conversationId: "c_test",
  role,
  content,
  reasoning: "",
  attachments: [],
  createdAt: Date.now(),
  state: "complete",
  ...extra,
});

interface Call {
  system: string;
  user: string;
  maxTokens: number;
}

function fakeModel(reply: (call: Call, index: number) => string | null) {
  const calls: Call[] = [];
  const fn: CallModel = async (system, user, opts) => {
    const call = { system, user, maxTokens: opts.maxTokens };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { fn, calls };
}

describe("normalizeTitle (writing rules)", () => {
  it("passes a clean title through", () => {
    expect(normalizeTitle("Whisper Audio Timestamp Fix")).toBe("Whisper Audio Timestamp Fix");
  });
  it("strips quotes and trailing punctuation", () => {
    expect(normalizeTitle('"GPU Detection Troubleshooting".')).toBe("GPU Detection Troubleshooting");
  });
  it('strips "Title:" style prefixes', () => {
    expect(normalizeTitle("Title: Conversation Title Generation Fix")).toBe("Conversation Title Generation Fix");
    expect(normalizeTitle("Suggested Conversation Title - Video Notes")).toBe("Video Notes");
  });
  it("strips intro sentences", () => {
    expect(normalizeTitle("This conversation is about debugging GPU driver detection")).toBe(
      "debugging GPU driver detection",
    );
  });
  it("takes the first line and drops numbered candidate lists", () => {
    expect(normalizeTitle("Whisper Timestamp Fix\n2. Audio Sync Bug\n3. Model Loading")).toBe("Whisper Timestamp Fix");
  });
  it("truncates over-long output on a word boundary within 60 chars", () => {
    const long = "A very long conversation title that keeps going and going well past the sixty character limit";
    const out = normalizeTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toBe("A very long conversation title that keeps going and going"); // cut at word boundary
    expect(out.endsWith(" ")).toBe(false);
  });
  it("collapses internal whitespace", () => {
    expect(normalizeTitle("GPU   Driver  Debug\tThread")).toBe("GPU Driver Debug Thread");
  });
  it("returns null for empty/whitespace/one-char output", () => {
    expect(normalizeTitle(null)).toBeNull();
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle("   \n  ")).toBeNull();
    expect(normalizeTitle('"A"')).toBeNull();
  });
});

describe("buildTranscript (full chronological history)", () => {
  it("keeps user + assistant turns in order and drops system/tool turns", () => {
    const turns = buildTranscript([
      msg("system", "you are a helpful assistant with credentials sk-..."),
      msg("user", "first question"),
      msg("assistant", "first answer"),
      msg("tool", "internal tool output"),
      msg("user", "middle question"),
      msg("assistant", "middle answer"),
      msg("user", "last question"),
      msg("assistant", "last answer"),
    ]);
    expect(turns.map((t) => t.text)).toEqual([
      "first question",
      "first answer",
      "middle question",
      "middle answer",
      "last question",
      "last answer",
    ]);
  });
  it("uses the typed text (first part) + attachment names, never inlined file content", () => {
    const turns = buildTranscript([
      msg("user", [
        { type: "text", text: "why does the video drift?" },
        { type: "text", text: "<20k chars of inlined transcript that must never reach the title prompt>" },
      ], { attachments: [{ id: "att_x", name: "lecture.mp4" }] }),
    ]);
    expect(turns[0].text).toBe("why does the video drift? [attached: lecture.mp4]");
    expect(turns[0].text).not.toContain("inlined transcript");
  });
  it("includes MIDDLE messages of a long conversation (no first/last-only fallback)", () => {
    const many = [];
    for (let i = 0; i < 12; i++) {
      many.push(msg("user", `question number ${i} about the topic`));
      many.push(msg("assistant", `answer number ${i} about the topic`));
    }
    const turns = buildTranscript(many);
    expect(turns.length).toBe(24);
    const joined = turns.map((t) => t.text).join("\n");
    for (let i = 0; i < 12; i++) expect(joined).toContain(`number ${i}`);
  });
  it("chunkTurns covers every turn exactly once, chronologically", () => {
    const turns = buildTranscript(
      Array.from({ length: 40 }, (_, i) => msg("user", "x".repeat(300) + ` marker${i}`)),
    );
    const chunks = chunkTurns(turns, TITLE_CHUNK_CHARS);
    expect(chunks.length).toBeGreaterThan(1);
    const flat = chunks.flat();
    expect(flat.length).toBe(turns.length);
    expect(flat.map((t) => t.text)).toEqual(turns.map((t) => t.text));
  });
});

describe("planTitle", () => {
  const shortConv = [
    msg("user", "Can you watch this video and explain the timestamp drift issue in detail please"),
    msg("assistant", "Sure — the drift comes from variable frame rate."),
    msg("user", "how do I fix it in ffmpeg?"),
    msg("assistant", "Re-encode with -vsync cfr."),
  ];

  it("requires a meaningful assistant reply before generating", async () => {
    const { fn, calls } = fakeModel(() => "Should Not Happen");
    const out = await planTitle([msg("user", "hello there")], { callModel: fn });
    expect(out).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("short conversation: ONE call over the whole history, concise title out (not a copy of the long first message)", async () => {
    const { fn, calls } = fakeModel(() => '"Video Timestamp Drift Fix".');
    const out = await planTitle(shortConv, { callModel: fn });
    expect(out).toBe("Video Timestamp Drift Fix");
    expect(calls.length).toBe(1);
    expect(calls[0].system).toBe(TITLE_SYSTEM);
    // The model sees the ENTIRE conversation, first and last turn included.
    expect(calls[0].user).toContain("timestamp drift issue");
    expect(calls[0].user).toContain("-vsync cfr");
    // Tiny output budget.
    expect(calls[0].maxTokens).toBeLessThanOrEqual(32);
  });

  it("dominant topic differs from the first prompt (later turns carry the signal)", async () => {
    const conv = [
      msg("user", "Can you watch this video and tell me what it says"),
      msg("assistant", "It is a lecture about audio synchronization."),
      msg("user", "ok but my real problem: whisper timestamps drift on my recordings"),
      msg("assistant", "Whisper drift usually comes from VFR input."),
      msg("user", "how should I re-encode before running whisper?"),
      msg("assistant", "ffmpeg -vsync cfr -r 30 fixes it."),
    ];
    const { fn, calls } = fakeModel(() => "Whisper Timestamp Drift Fix");
    const out = await planTitle(conv, { callModel: fn });
    expect(out).toBe("Whisper Timestamp Drift Fix");
    expect(calls[0].user).toContain("whisper timestamps drift");
    expect(calls[0].user).toContain("ffmpeg -vsync cfr");
  });

  it("long conversation: map-reduce over chronological chunks, final title sees ALL summaries", async () => {
    // Push the transcript past the single-pass budget.
    const conv = [];
    for (let i = 0; i < 60; i++) {
      conv.push(msg("user", `question ${i}: ` + "u".repeat(300)));
      conv.push(msg("assistant", `answer ${i}: ` + "a".repeat(300)));
    }
    expect(transcriptChars(buildTranscript(conv))).toBeGreaterThan(TITLE_TRANSCRIPT_CHARS);

    const { fn, calls } = fakeModel((call, i) =>
      call.system === SUMMARY_SYSTEM ? `summary line ${i + 1}` : "Dominant Thread Title",
    );
    const out = await planTitle(conv, { callModel: fn });
    expect(out).toBe("Dominant Thread Title");

    const summaryCalls = calls.filter((c) => c.system === SUMMARY_SYSTEM);
    const finalCalls = calls.filter((c) => c.system === TITLE_SYSTEM);
    expect(summaryCalls.length).toBeGreaterThan(1);
    expect(finalCalls.length).toBe(1);

    // Chronological coverage: first chunk contains the FIRST turn, last chunk
    // contains the LAST turn — nothing is silently dropped.
    expect(summaryCalls[0].user).toContain("question 0:");
    expect(summaryCalls[summaryCalls.length - 1].user).toContain("answer 59:");

    // The final pass is driven by the summaries, not raw history.
    const finalUser = finalCalls[0].user;
    for (let i = 1; i <= summaryCalls.length; i++) expect(finalUser).toContain(`summary line ${i}`);
  });

  it("invalid model output (explanation, refusal, empty, junk) yields null — the sidebar title is never corrupted", async () => {
    for (const bad of [
      "",
      "   ",
      "\n\n",
      "!",
      "I cannot summarize this conversation.",
      "This conversation covers several topics. The user asks about video timestamps and then about ffmpeg encoding flags for hours on end.",
    ]) {
      const { fn } = fakeModel(() => bad);
      expect(await planTitle(shortConv, { callModel: fn })).toBeNull();
    }
  });

  it("model call throwing (server down) resolves null and never throws", async () => {
    const fn: CallModel = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
    };
    await expect(planTitle(shortConv, { callModel: fn })).resolves.toBeNull();
  });

  it("planTitle returns null when the signal is already aborted (yields without model traffic)", async () => {
    // Real transport, already-aborted signal: fetch rejects pre-flight, the
    // catch keeps the last valid title — no request ever reaches :8080.
    const c = new AbortController();
    c.abort();
    expect(await planTitle(shortConv, { signal: c.signal })).toBeNull();
  });

  it("all-empty summaries yield null (no title from nothing)", async () => {
    const conv = [];
    for (let i = 0; i < 60; i++) {
      conv.push(msg("user", `q${i}: ` + "u".repeat(300)));
      conv.push(msg("assistant", `a${i}: ` + "a".repeat(300)));
    }
    const { fn } = fakeModel(() => null);
    expect(await planTitle(conv, { callModel: fn })).toBeNull();
  });
});

describe("callMainModel abort wiring", () => {
  it("an already-aborted signal rejects pre-flight (never reaches the model)", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      callMainModel("sys", "user", { model: "m", maxTokens: 8, signal: c.signal }),
    ).rejects.toThrow();
  });
});
