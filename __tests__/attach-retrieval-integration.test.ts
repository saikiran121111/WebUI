import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAttachmentIndex } from "../lib/server/attachindex/build";
import { embedOne } from "../lib/server/attachindex/embed";
import { retrieveEvidence } from "../lib/server/attachindex/retrieve";
import { routeQuery } from "../lib/server/attachindex/router";
import { readIndex, removeIndex } from "../lib/server/attachindex/store";
import type { TranscriptSegment } from "../lib/server/attachindex/types";

/**
 * End-to-end retrieval recall on a synthetic ~30k-char lecture transcript
 * (spec §8): unique markers planted at 0-10%, 45-55% and 90-100% must each
 * come back in the evidence for their question, using REAL MiniLM embeddings
 * (first run downloads ~23MB into .data/models — same precedent as whisper).
 */

const ATT = "att_intgtest01";
const SEG_SECONDS = 8;
const SEG_COUNT = 300; // ~2400 s, ~30k chars

const FILLER = [
  "The instructor reviews the previous problem set and answers questions from the floor.",
  "We continue with the standard notation introduced in the first seminar this week.",
  "A short recap connects today's material to the exam questions from last semester.",
  "The slide shows the usual diagram with the axes labeled in the conventional way.",
  "Students are reminded to submit the weekly worksheet before the next session.",
  "This example follows the same structure as the one discussed two lectures ago.",
  "The board summary lists the assumptions that carry over to the next chapter.",
  "A brief pause allows the class to copy down the definition written on the board.",
];

const MARKERS: { at: number; text: string }[] = [
  { at: 15, text: "The Zephyr protocol calibrates turbine blade resonance at exactly ninety-one hertz." },
  { at: 150, text: "Marisol's theorem states that coastal sediment drift doubles with every eleventh tidal cycle." },
  { at: 285, text: "For the closing exercise, students archive every finding under the codename Lanternfall." },
];

function buildSegments(): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let i = 0; i < SEG_COUNT; i++) {
    const marker = MARKERS.find(m => m.at === i);
    const text = marker ? marker.text : FILLER[i % FILLER.length];
    segs.push({ text, start: i * SEG_SECONDS, end: (i + 1) * SEG_SECONDS });
  }
  return segs;
}

async function evidenceFor(question: string) {
  const index = readIndex(ATT);
  expect(index).not.toBeNull();
  const vec = await embedOne(question);
  return { index: index!, ev: retrieveEvidence(index!, question, vec, routeQuery(question)) };
}

function chunkOf(index: { chunks: { text: string }[] }, needle: string): number {
  return index.chunks.findIndex(c => c.text.includes(needle));
}

describe("attachment retrieval integration (real embeddings)", () => {
  beforeAll(async () => {
    removeIndex(ATT);
    const r = await buildAttachmentIndex({
      attId: ATT,
      name: "synthetic-lecture.txt",
      category: "audio",
      fullText: buildSegments().map(s => s.text).join(" "),
      segments: buildSegments(),
      durationSec: SEG_COUNT * SEG_SECONDS,
    });
    expect(r.chunkCount).toBeGreaterThan(10);
    expect(r.spine).toContain("[");
  }, 300_000);

  afterAll(() => removeIndex(ATT));

  it("recalls a marker planted at the head (0-10%)", async () => {
    const { index, ev } = await evidenceFor(
      "At what frequency does the Zephyr protocol calibrate turbine blade resonance?",
    );
    expect(ev.text).toContain("ninety-one hertz");
    const i = chunkOf(index, "ninety-one hertz");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i / index.chunks.length).toBeLessThan(0.15);
  }, 120_000);

  it("recalls a marker planted in the middle (45-55%)", async () => {
    const { index, ev } = await evidenceFor(
      "According to Marisol's theorem, how often does coastal sediment drift double?",
    );
    expect(ev.text).toContain("eleventh tidal cycle");
    const i = chunkOf(index, "eleventh tidal cycle");
    const frac = i / index.chunks.length;
    expect(frac).toBeGreaterThan(0.35);
    expect(frac).toBeLessThan(0.65);
  }, 120_000);

  it("recalls a marker planted at the tail (90-100%)", async () => {
    const { index, ev } = await evidenceFor(
      "What codename do students use to archive their findings in the closing exercise?",
    );
    expect(ev.text).toContain("Lanternfall");
    const i = chunkOf(index, "Lanternfall");
    expect(i / index.chunks.length).toBeGreaterThan(0.8);
  }, 120_000);

  it("time-range routing pulls the window around the referenced minute", async () => {
    // minute 20 == segment 150 == the Marisol marker region (1200-1208 s).
    const { ev } = await evidenceFor("what was said at minute 20?");
    expect(ev.text).toContain("eleventh tidal cycle");
  }, 120_000);

  it("evidence carries timestamp headers for timed content", async () => {
    const { ev } = await evidenceFor("What codename is used in the closing exercise?");
    expect(ev.text).toMatch(/\[\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}\]/);
  }, 120_000);
});
