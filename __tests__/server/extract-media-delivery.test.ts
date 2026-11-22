/**
 * F78 Family G media-delivery regression (2026-11-22).
 *
 * Four defects were reproduced at the real production boundary by probe
 * .data/tmp/g98.test.ts (baseline recorded in
 * docs/overnight/F78-FILE-READING-RELEASE.md):
 *   (1) short audio/video transcripts dropped every segment TIME
 *       ("Monday" at ~3 s arrived as an unplaced sentence);
 *   (2) stereo overlap.wav was force-merged to mono, so two speakers on
 *       separate channels became one word salad with no channel attribution;
 *   (3) an exact-time question over a frames-only video index delivered
 *       ZERO evidence (turn.ts skipped the empty-evidence block before the
 *       frames were consulted — the model received nothing for
 *       "What is on screen at 01:31:00?");
 *   (4) the short video path DELETED its eagerly extracted keyframes
 *       (mixed-av.mp4: 25 s and 87.5 s previews, 61 s COBALT VALVE unseen).
 *
 * These tests run the real production path: real ffmpeg decode, real local
 * whisper inference on the recorded f78 fixtures, the real router +
 * retrieve + buildAttachmentTurn. No mocked responses: the release law says
 * a mock response alone cannot pass a content assertion.
 *
 * Pins (set before any production import): RUKE_LLM_AUTOMATIC_HANDOFF=0
 * RUKE_OCR_ALLOW_UNLOAD=0 — a test process never hands off to, probes,
 * unloads or restarts the shared :8080 model. The live-provider guard
 * (vitest setupFiles) fails the run if anything tries to reach it.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

process.env.RUKE_LLM_AUTOMATIC_HANDOFF = "0";
process.env.RUKE_OCR_ALLOW_UNLOAD = "0";
process.env.WHISPER_CPU_IDLE_MS = "0"; // release the checkpoint between clips

const FIX = path.join(process.cwd(), "docs/overnight/fixtures/f78/review-complex-1121");
const ATT = {
  vid: "att_f78gvid",
  snd: "att_f78gsnd",
  ovl: "att_f78govl",
  av: "att_f78gav",
} as const;

let extractFileFromPath: typeof import("@/lib/server/extract").extractFileFromPath;
let store: typeof import("@/lib/server/attachindex/store");
let buildAttachmentTurn: typeof import("@/lib/server/attachindex/turn").buildAttachmentTurn;
let timedTranscriptText: typeof import("@/lib/server/extract").timedTranscriptText;
let composeChannelTranscript: typeof import("@/lib/server/extract").composeChannelTranscript;

beforeAll(async () => {
  ({ extractFileFromPath } = await import("@/lib/server/extract"));
  store = await import("@/lib/server/attachindex/store");
  ({ buildAttachmentTurn } = await import("@/lib/server/attachindex/turn"));
  ({ timedTranscriptText, composeChannelTranscript } = await import("@/lib/server/extract"));
  for (const att of Object.values(ATT)) store.removeIndex(att);
});

afterAll(() => {
  for (const att of Object.values(ATT)) {
    try {
      store.removeIndex(att);
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** First timestamped line whose text contains `fact`, as [startSec, line]. */
function timedLine(transcript: string, fact: string): [number, string] | null {
  for (const line of transcript.split("\n")) {
    if (!line.includes(fact)) continue;
    const m = /^\[(?:channel \d+)?\s*(?:\[)?(\d\d):(\d\d):(\d\d)/.exec(line.trim());
    if (!m) continue;
    return [Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), line];
  }
  return null;
}

function systemText(messages: any[]): string {
  return messages
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : String(m.content?.[0]?.text ?? "")))
    .join("\n\n");
}

test("timedTranscriptText puts every segment in [HH:MM:SS - HH:MM:SS] form", () => {
  const out = timedTranscriptText([
    { text: "  The harbor opens on Monday. ", start: 3, end: 6 },
    { text: "no end segment", start: 61 },
    { text: "   ", start: 10, end: 12 },
  ] as any[]);
  expect(out).toBe("[00:00:03 - 00:00:06] The harbor opens on Monday.\n[00:01:01 - 00:01:01] no end segment");
});

test("composeChannelTranscript labels channels and states overlapping speech", () => {
  const { body, segments } = composeChannelTranscript([
    { ch: 1, segments: [{ text: "opens Monday", start: 0, end: 5 }] },
    { ch: 2, segments: [{ text: "weighs 47 kg", start: 2, end: 7 }, { text: "Toronto", start: 12, end: 15 }] },
  ] as any[]);
  expect(body).toContain("[channel 1] [00:00:00 - 00:00:05] opens Monday");
  expect(body).toContain("[channel 2] [00:00:02 - 00:00:07] weighs 47 kg");
  expect(body).toContain("carries 2 separate audio channels");
  expect(body).toContain("channel 1 and channel 2 carry speech simultaneously between 00:00:02 and 00:00:05");
  // Indexed-path segments carry the channel prefix so the label survives the
  // retrieval chunking too.
  expect(segments.some(s => s.text.startsWith("[channel 2] ") && s.start === 12)).toBe(true);
  // A single-channel recording must NOT claim overlaps.
  const solo = composeChannelTranscript([{ ch: 1, segments: [{ text: "a", start: 0, end: 5 }] }] as any[]);
  expect(solo.body).toContain("No time range carries speech on more than one channel at once.");
});

test(
  "exact-time questions over a frames-only video index serve the nearest saved moments",
  async () => {
    const r = await extractFileFromPath("three-hours.mp4", path.join(FIX, "three-hours.mp4"), ATT.vid);
    expect(r.indexed).toBe(true);
    const idx = store.readIndex(ATT.vid);
    const ats = (idx?.meta.frames ?? []).map(f => f.at).sort((a, b) => a - b);
    expect(ats.length).toBeGreaterThanOrEqual(60);
    expect(ats).toContain(5460); // the 01:31:00 frame is indexed

    const ask = async (q: string, conv: string) => {
      const messages: any[] = [
        {
          role: "user",
          content: [
            { type: "text", text: q },
            { type: "attachment_ref", att_id: ATT.vid, name: "three-hours.mp4", category: "video" },
          ],
        },
      ];
      const blocks = await buildAttachmentTurn(messages, 0, q, undefined, "default", conv);
      // The evidence is injected as a system block BEFORE the user turn, so
      // the user message is no longer necessarily at index 0.
      const user = messages.find(m => m.role === "user");
      return {
        blocks,
        images: ((user?.content ?? []) as any[]).filter((p: any) => p.type === "image_url").length,
        text: systemText(messages),
      };
    };

    // Defect (3): baseline delivered injectedBlocks=0 imageParts=0.
    const one = await ask("What is on screen at 01:31:00?", "conv-f78g-exact");
    expect(one.blocks).toBeGreaterThanOrEqual(1);
    expect(one.images).toBeGreaterThanOrEqual(1);
    expect(one.text).toContain("Asked time 01:31:00");
    expect(one.text).toContain("cannot be confirmed"); // unconfirmable-between law
    expect(one.text).toContain("[coverage:");
    expect(one.text).toContain("[ranking:");

    // The asked instant has no saved moment (PAUSE 793 at 6381-6383 s): the
    // nearest saved moment (6420 s = 01:47:00) is served WITH its distance
    // named — never presented as the asked second itself.
    const near = await ask("What is on screen at 01:46:21?", "conv-f78g-pause");
    expect(near.blocks).toBeGreaterThanOrEqual(1);
    expect(near.text).toContain("Asked time 01:46:21");
    expect(near.text).toContain("01:47:00");

    // Comparative cues: both asked times get their own attribution line.
    const two = await ask("Compare what is on screen at 01:31:00 and at 00:00:45.", "conv-f78g-pair");
    expect(two.blocks).toBeGreaterThanOrEqual(1);
    expect(two.text).toContain("Asked time 01:31:00");
    expect(two.text).toContain("Asked time 00:00:45");
    expect(two.images).toBeGreaterThanOrEqual(2);
  },
  600_000,
);

test(
  "short audio transcript keeps segment times at the spoken moments",
  async () => {
    const r = await extractFileFromPath("sound.wav", path.join(FIX, "sound.wav"), ATT.snd);
    const t = String((r as any).transcript ?? (r as any).text ?? "");
    // Facts (baseline recovered them WITHOUT times).
    expect(t).toContain("Monday");
    expect(t).toContain("47");
    expect(t).toContain("Toronto");
    // Defect (1): every fact must ride a timestamped line near its spoken
    // moment (fixture spec: speech at ~3, ~61, ~119 s; generous ASR window).
    const mon = timedLine(t, "Monday");
    expect(mon, `no timed line for Monday in: ${t}`).not.toBeNull();
    expect(mon![0]).toBeGreaterThanOrEqual(0);
    expect(mon![0]).toBeLessThanOrEqual(20);
    const kg = timedLine(t, "47");
    expect(kg, `no timed line for 47 in: ${t}`).not.toBeNull();
    expect(kg![0]).toBeGreaterThanOrEqual(45);
    expect(kg![0]).toBeLessThanOrEqual(80);
    const tor = timedLine(t, "Toronto");
    expect(tor, `no timed line for Toronto in: ${t}`).not.toBeNull();
    expect(tor![0]).toBeGreaterThanOrEqual(100);
    expect(tor![0]).toBeLessThanOrEqual(125);
  },
  600_000,
);

test(
  "stereo overlap.wav is transcribed per channel with explicit overlap attribution",
  async () => {
    const r = await extractFileFromPath("overlap.wav", path.join(FIX, "overlap.wav"), ATT.ovl);
    const t = String((r as any).transcript ?? (r as any).text ?? "");
    // Defect (2): baseline merged to mono and labeled nothing.
    expect(t).toContain("[channel 1]");
    expect(t).toContain("[channel 2]");
    expect(t).toContain("separate audio channels");
    // Fixture: the opening-day and cargo-weight statements OVERLAP on
    // separate channels — the overlap must be stated explicitly.
    expect(t).toContain("simultaneously between");
    expect(t).toContain("Monday");
    expect(t).toContain("47");
    expect(t).toContain("Toronto");
  },
  600_000,
);

test(
  "short video keeps timed speech AND its spread-out keyframes (61 s alignment control)",
  async () => {
    const r = await extractFileFromPath("mixed-av.mp4", path.join(FIX, "mixed-av.mp4"), ATT.av);
    const t = String((r as any).transcript ?? (r as any).text ?? "");
    expect(r.durationSec).toBeCloseTo(125, 0);
    // Spoken weight at ~61 s with times attached (defect 1, video path).
    expect(t).toContain("47");
    expect(/\[\d\d:\d\d:\d\d - \d\d:\d\d:\d\d\]/.test(t)).toBe(true);
    // Defect (4): baseline delivered 2 previews (25, 87.5 s) and DELETED the
    // eagerly extracted keyframes. Now the saved keyframes ride inline,
    // spread (>=15 s apart) up to the inline cap, and the scratch dir is
    // still cleaned up.
    const ats = ((r as any).frames ?? []).map((f: any) => f.at).sort((a: number, b: number) => a - b);
    expect(ats.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(14);
    expect(ats).toContain(25);
    expect(ats).toContain(87.5);
    expect(fs.existsSync(store.framesDir(ATT.av))).toBe(false); // cleanup preserved
  },
  600_000,
);
