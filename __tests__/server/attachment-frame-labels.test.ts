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

  it("F76: both video shapes carry the sampling law in the intro (isolated moments, no span claims)", () => {
    // The defect this pins: two sampled instants read correctly, then the model
    // claimed the marker was visible "throughout" the clip. The law must ride
    // the attachment intro of BOTH delivery shapes, verbatim (the third surface,
    // the retrieval lead-in, is byte-replayed by the attachment goldens).
    // Content-neutral on purpose — this is a universal delivery law, not a
    // fixture rule, so no marker strings or subject matter may appear here.
    const LAW_BITS = [
      "isolated moments",
      "no evidence about the time between, before or after them",
      "visible throughout",
      "unchanged across any stretch between two shown moments",
      "the rest cannot be confirmed",
    ];
    for (const parts of [
      attachmentParts(videoAtt({ transcript: "the codeword is zephyr" })),
      attachmentParts(videoAtt({ indexed: true, indexId: "att_vl_idx", transcript: "opening preview" })),
    ]) {
      const intro = parts.find(p => p.type === "text")!.text as string;
      for (const bit of LAW_BITS) expect(intro).toContain(bit);
    }
  });

  it("F76: inline text delivery carries the numeric-fidelity law (digit-exact quoting, verified restatements)", () => {
    // The defect this pins: extraction delivered the printed amount verbatim,
    // then the answer re-grouped it 10x (one figure, two contradictory values).
    // The law is universal — no currency, unit, value or subject may appear.
    // (The indexed-delivery side of the same law rides the rules() base in
    // lib/server/attachindex/turn.ts ⇔ ruke-attach turn.rs, byte-replayed by
    // the attachment goldens and pinned by the Rust rules unit test.)
    const att = {
      id: "att_tx", name: "quarterly.txt", kind: "file", mime: "text/plain", size: 64,
      status: "ready", category: "document", text: "Revenue this quarter: 12,34,567.",
    } as unknown as Attachment;
    const parts = attachmentParts(att);
    expect(parts.length).toBe(1);
    const body = parts[0].text as string;
    expect(body).toContain("[file content begins]\nRevenue this quarter: 12,34,567.\n[file content ends]");
    for (const bit of [
      "keep its exact digits and digit grouping",
      "state the exact conversion being applied",
      "verify the restated figure has the same value",
      "never give two versions of one figure that have different values",
      "This applies to every restated version anywhere in the answer, including brief asides",
    ]) expect(body).toContain(bit);
  });

  it("frame labels format across the hour boundary (1:02:03-style stamps)", () => {
    const parts = attachmentParts(
      videoAtt({ frames: [{ dataUrl: "data:image/png;base64,CCCC", at: 3723 }], durationSec: 4000 }),
    );
    expectLabelledImages(parts, ["At 1:02:03 in the video"]);
  });
});

/**
 * F66/F67 (fr-20261122b): the server decoder (F78-B) decodes every page of a
 * multi-page TIFF and every frame of an animated GIF, and docProcessor carries
 * them in `att.frames` — but the delivery seam dropped them: category "image"
 * sent ONLY `att.dataUrl`. The model truthfully reported "I can only see the
 * first page" (fr-I1) and answered from frame-1 content on a last-frame
 * question (fr-I3, frame-1 title = designed trap).
 * The law: when an image attachment carries a sequence, EVERY image arrives,
 * IN ORDER, each labelled with its position, and the intro says the file IS a
 * sequence — never one anonymous first page.
 */
function imageAtt(extra: Partial<Attachment>): Attachment {
  return {
    id: "att_img", name: "img-1.tiff", kind: "image", mime: "image/tiff", size: 4096,
    status: "ready", category: "image",
    dataUrl: "data:image/png;base64,AAAA",
    ...extra,
  } as Attachment;
}

describe("multipage/animated image delivery (F66/F67)", () => {
  const seq = (n: number) =>
    Array.from({ length: n - 1 }, (_, i) => ({ dataUrl: `data:image/png;base64,BB${i}`, at: i + 2 }));

  it("TIFF with 3 decoded pages: all 3 images arrive in order, page 2 addressable", () => {
    const parts = attachmentParts(imageAtt({ pages: 3, frames: seq(3) }));
    expectLabelledImages(parts, ["Image 1 of 3", "Image 2 of 3", "Image 3 of 3"]);
    const joined = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("3 images in sequence");
    // Questions say "page 2" / "the last frame" — the label law must bridge both.
    expect(joined).toContain("page N");
    expect(joined).toContain("frame N");
  });

  it("animated GIF with 4 frames: the LAST frame is present and labelled, not just frame 1", () => {
    const parts = attachmentParts(
      imageAtt({ name: "lecture.gif", mime: "image/gif", pages: 4, frames: seq(4) }),
    );
    expectLabelledImages(parts, ["Image 1 of 4", "Image 2 of 4", "Image 3 of 4", "Image 4 of 4"]);
    const last = parts[parts.length - 1];
    expect(last.type).toBe("image_url");
  });

  it("capped animation: partial set is disclosed, the LAST frame is labelled with its true position", () => {
    // The live GIF has 24 frames; the decoder ships an evenly spread subset
    // (first + last + spread). The intro must disclose the coverage, and the
    // last shown frame must be labelled Image 24 of 24 — "the last frame".
    const frames = [3, 7, 10, 13, 16, 20, 24].map(at => ({ dataUrl: `data:image/png;base64,BB${at}`, at }));
    const parts = attachmentParts(imageAtt({ name: "lecture.gif", mime: "image/gif", pages: 24, frames }));
    const images = parts.filter(p => p.type === "image_url").length;
    expect(images).toBe(8); // first + 7 spread frames, all shown
    for (const label of ["Image 1 of 24", "Image 3 of 24", "Image 24 of 24"]) {
      const k = parts.findIndex(p => p.type === "text" && (p.text as string).includes(label));
      expect(k, label).toBeGreaterThanOrEqual(0);
      expect(parts[k + 1].type, `image directly after ${label}`).toBe("image_url");
    }
    const joined = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("24 images in sequence");
    expect(joined).toContain("Showing 8 of them IN ORDER, including the first and the LAST");
  });

  it("single-frame image keeps the exact old two-part shape (control)", () => {
    const parts = attachmentParts(imageAtt({ pages: 1 }));
    expect(parts.length).toBe(2);
    expect(parts[0].text).toBe("Attached file: img-1.tiff (image)");
    expect(parts[1].image_url.url).toBe("data:image/png;base64,AAAA");
  });

  it("browser detail strips (no page count): overview plus EVERY labelled strip", () => {
    const parts = attachmentParts(imageAtt({
      name: "long-screenshot.png",
      frames: [
        { dataUrl: "data:image/png;base64,SS1", at: 1 },
        { dataUrl: "data:image/png;base64,SS2", at: 2 },
      ],
    }));
    expectLabelledImages(parts, ["(image)", "Detail 1 of 2", "Detail 2 of 2"]);
  });

  it("unreadable image keeps the typed refusal", () => {
    const parts = attachmentParts(imageAtt({ dataUrl: undefined }));
    expect(parts.length).toBe(1);
    expect(parts[0].text).toContain("could not be read");
  });
});

/**
 * F68 (fr-20261122b, fr-I4): asked for the pixel dimensions of an uploaded
 * HEIC, the model answered "1250 × 612" — a vision estimate of 1280×720,
 * because the delivery NEVER stated the decoder-verified dimensions. The law:
 * when the pipeline KNOWS the image's pixel dimensions, the model is told
 * verbatim; when it doesn't, nothing is claimed.
 */
describe("image dimensions are stated verbatim (F68)", () => {
  it("single image with verified dimensions: label carries W × H pixels", () => {
    const parts = attachmentParts(imageAtt({ name: "img-4.heic", mime: "image/heic", width: 1280, height: 720 }));
    const text = parts[0].text as string;
    expect(text).toContain("1280 × 720");
    expect(text).toContain("pixels");
  });

  it("sequence intro carries the verified dimensions too", () => {
    const parts = attachmentParts(imageAtt({ pages: 3, width: 918, height: 3564, frames: [
      { dataUrl: "data:image/png;base64,BB1", at: 2 },
      { dataUrl: "data:image/png;base64,BB2", at: 3 },
    ] }));
    const intro = parts.find(p => p.type === "text")!.text as string;
    expect(intro).toContain("918 × 3564");
  });

  it("unknown dimensions claim NOTHING (no invented numbers)", () => {
    const parts = attachmentParts(imageAtt({ pages: 1 }));
    expect(parts[0].text).toBe("Attached file: img-1.tiff (image)");
    expect(parts.map(p => p.text ?? "").join(" ")).not.toMatch(/\d+ × \d+/);
  });
});
