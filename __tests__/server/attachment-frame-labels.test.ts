import { describe, expect, it } from "vitest";
import { attachmentParts } from "../../lib/chat/client";
import type { Attachment } from "../../lib/types";

/**
 * I18a: video images used to reach the model anonymously. Ask "what happens
 * around minute six?" and the model had nothing to anchor to — so it either
 * guessed or refused. Every frame must now ride behind a text label naming
 * its position ON THE VIDEO'S OWN TIMELINE (never "frame", never "image at
 * timestamp" — the record-honesty law from video-narration stays intact).
 */

function videoAtt(extra: Partial<Attachment>): Attachment {
  return {
    id: "att_vl", name: "lecture.mp4", kind: "video", mime: "video/mp4", size: 4096,
    status: "ready", category: "video",
    frames: [
      { dataUrl: "data:image/png;base64,AAAA", at: 65 },
      { dataUrl: "data:image/png;base64,BBBB", at: 400 },
    ],
    durationSec: 500,
    ...extra,
  } as Attachment;
}

/** Assert every image_url part is immediately preceded by its timestamp label. */
function expectLabelledImages(parts: any[], labels: string[]): void {
  const imageIdx = parts.map((p, i) => (p.type === "image_url" ? i : -1)).filter(i => i >= 0);
  expect(imageIdx.length).toBe(labels.length);
  labels.forEach((label, k) => {
    const before = parts[imageIdx[k] - 1];
    expect(before?.type).toBe("text");
    expect(before.text).toContain(label);
  });
}

describe("video frames carry their video timestamps into the prompt (I18a)", () => {
  it("non-indexed video: length line + a timestamp label directly before every image", () => {
    const parts = attachmentParts(videoAtt({ transcript: "the codeword is zephyr" }));
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);

    expect(texts).toContain("Video length: 8:20.");
    expectLabelledImages(parts, ["At 1:05 in the video", "At 6:40 in the video"]);
    // Record honesty: the label belongs to the VIDEO, not to "a frame".
    const joined = texts.join("\n");
    expect(joined).toContain("speak of it as the video at that time, never as an image or a still");
    expect(joined).not.toContain("Audio track");
    expect(joined).not.toContain("sampled frames");
  });

  it("indexed video: same timestamp labels inside the map+preview framing", () => {
    const parts = attachmentParts(
      videoAtt({ indexed: true, indexId: "att_vl_idx", transcript: "opening preview" }),
    );
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);

    expect(texts).toContain("Moments from the video:");
    expect(texts).toContain("Video length: 8:20.");
    expectLabelledImages(parts, ["At 1:05 in the video", "At 6:40 in the video"]);

    const last = parts[parts.length - 1];
    expect(last.type).toBe("attachment_ref");
    expect(last.att_id).toBe("att_vl_idx");
  });

  it("frame labels format across the hour boundary (1:02:03-style stamps)", () => {
    const parts = attachmentParts(
      videoAtt({ frames: [{ dataUrl: "data:image/png;base64,CCCC", at: 3723 }], durationSec: 4000 }),
    );
    expectLabelledImages(parts, ["At 1:02:03 in the video"]);
  });
});
