import { afterEach, describe, expect, it, vi } from "vitest";

import { attachmentParts } from "../lib/chat/client";
import { processAttachment } from "../lib/files/docProcessor";
import type { Attachment } from "../lib/types";

/**
 * F152 audit (2026-11-24), repair 1: the upload DROPPED the reader's coverage
 * verdict. ExtractResponse carried coverageNote (the honest "what could NOT be
 * read" line the server weaves for frame/speech/page failures), the returned
 * Attachment copied text/frames/transcript/spine — never the note — so a
 * partially readable file reached the model claiming completeness
 * ("nothing was discarded", "its complete spoken content").
 *
 * The law proved here, end-to-end over the three seams the reviewer named:
 *  - UPLOAD: processAttachment copies data.coverageNote onto the Attachment.
 *  - SAVE/REOPEN: the field rides the conversation JSON untouched (the store
 *    persists the whole Attachment object), so a reopened chat knows.
 *  - FINAL TURN: attachmentParts states the limitation and grounds the
 *    completeness claims — the usable evidence (valid speech, valid native
 *    text) stays fully in the turn.
 * Older saved attachments (field absent) keep the pre-audit wording verbatim,
 * and partially readable files stay USABLE — the limitation never gates them.
 */

function baseAtt(category: Attachment["category"]): Attachment {
  return {
    id: "att_cov", name: "clip.mp4", kind: "video", mime: "video/mp4", size: 4096,
    status: "ready", category,
  } as Attachment;
}

const SPEECH_OK_VISUAL_FAIL =
  "its visual content could not be decoded (ffmpeg exited: no decodable video " +
  "frames) — the spoken content below WAS read.";

describe("coverageNote survives upload (processAttachment)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("video with a frame-decode failure and valid speech: the note rides the Attachment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        category: "video",
        transcript: "The maintenance threshold is sixty one litres.",
        frames: [],
        durationSec: 12,
        coverageNote: SPEECH_OK_VISUAL_FAIL,
      }),
    })));
    const file = new File([new Uint8Array([0])], "clip.mp4", { type: "video/mp4" });
    const att = await processAttachment(file, baseAtt("video"));
    // Usable evidence survives…
    expect(att.status).toBe("ready");
    expect(att.transcript).toContain("sixty one litres");
    // …and so does the coverage limitation (this is what the old upload dropped).
    expect(att.coverageNote).toBe(SPEECH_OK_VISUAL_FAIL);
  });

  it("PDF with a visual-read failure and valid native text: note and text both ride", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        category: "pdf",
        text: "Page 1. The KAPPA 9 threshold sits at 61 litres.\n[2 of 3 page(s) recognised]",
        pages: 3,
        coverageNote: "2 of 3 page(s) recognised; page 2 returned no text.",
      }),
    })));
    const file = new File([new Uint8Array([0])], "report.pdf", { type: "application/pdf" });
    const att = await processAttachment(file, baseAtt("pdf"));
    att.name = "report.pdf";
    expect(att.status).toBe("ready");
    expect(att.text).toContain("KAPPA 9 threshold sits at 61 litres");
    expect(att.coverageNote).toBe("2 of 3 page(s) recognised; page 2 returned no text.");
  });
});

describe("coverageNote survives save/reopen (conversation JSON passthrough)", () => {
  it("a saved-and-reopened message keeps the note; older records simply lack it", () => {
    const att: Attachment = {
      ...baseAtt("video"),
      transcript: "The maintenance threshold is sixty one litres.",
      coverageNote: SPEECH_OK_VISUAL_FAIL,
    };
    const saved = JSON.stringify({ id: "m1", role: "user", content: "x", attachments: [att] });
    const reopened: { attachments: Attachment[] } = JSON.parse(saved);
    expect(reopened.attachments[0].coverageNote).toBe(SPEECH_OK_VISUAL_FAIL);
    // An attachment saved before the field existed: absent, not defaulted.
    const legacy = JSON.stringify({ id: "m0", role: "user", content: "x", attachments: [{ ...att, coverageNote: undefined }] });
    expect(JSON.parse(legacy).attachments[0].coverageNote).toBeUndefined();
  });
});

describe("coverageNote shapes the final turn (attachmentParts)", () => {
  it("video, frame-decode failed, speech valid: evidence AND limitation ride; no completeness claim", () => {
    const att: Attachment = {
      ...baseAtt("video"),
      transcript: "The maintenance threshold is sixty one litres.",
      coverageNote: SPEECH_OK_VISUAL_FAIL,
    };
    const texts = attachmentParts(att).filter(p => p.type === "text").map(p => p.text as string);
    const joined = texts.join("\n");
    expect(joined).toContain("sixty one litres");            // usable evidence kept
    expect(joined).toContain("visual content could not be decoded"); // limitation stated
    expect(joined).toContain("I couldn't read the label on page 2");  // honest-answer law
    expect(joined).not.toContain("complete saved record");    // claim grounded
    expect(joined).not.toContain("nothing was discarded");
  });

  it("video with NO note keeps the pinned record wording verbatim (older attachments)", () => {
    const att: Attachment = { ...baseAtt("video"), transcript: "hello", frames: [{ dataUrl: "data:image/png;base64,AA==", at: 1 }] };
    const joined = attachmentParts(att).filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("you are given its complete saved record");
  });

  it("indexed video with NO note keeps both pinned claims verbatim", () => {
    const att: Attachment = {
      ...baseAtt("video"), indexed: true, indexId: "idx1", spine: "TOC",
      transcript: "a long lecture…", frames: [{ dataUrl: "data:image/png;base64,AA==", at: 1 }],
    };
    const joined = attachmentParts(att).filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("(nothing was discarded)");
    expect(joined).toContain("complete saved record is kept whole in the index");
  });

  it("indexed attachment with a note: the completeness claims go, the limitation arrives before the ref", () => {
    const att: Attachment = {
      ...baseAtt("audio"), name: "lecture.m4a", indexed: true, indexId: "idx1",
      transcript: "a long lecture…", coverageNote: "the final 4 minutes of audio were never decoded.",
    };
    const parts = attachmentParts(att);
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);
    const joined = texts.join("\n");
    expect(joined).not.toContain("nothing was discarded");
    expect(joined).toContain("the content recovered from it");
    expect(joined).toContain("the final 4 minutes of audio were never decoded");
    const limitIdx = parts.findIndex(p => p.type === "text" && (p.text as string).startsWith("Coverage of this file"));
    const refIdx = parts.findIndex(p => p.type === "attachment_ref");
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(limitIdx).toBeLessThan(refIdx);
  });

  it("audio with a note: content is labelled as recovered, limitation stated; no complete-spoken claim", () => {
    const att: Attachment = {
      ...baseAtt("audio"), name: "call.mp3",
      transcript: "We agreed on sixty one litres.",
      coverageNote: "the pinned speech backend is not available on this host; parts of the recording were not transcribed",
    };
    const joined = attachmentParts(att).filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("We agreed on sixty one litres");     // evidence kept
    expect(joined).toContain("the spoken content recovered from the recording follows");
    expect(joined).not.toContain("its complete spoken content");
    expect(joined).toContain("parts of the recording were not transcribed");
    expect(joined).toContain("never name the software, workers or services");
  });

  it("audio with NO note keeps the complete-spoken wording verbatim (older attachments)", () => {
    const att: Attachment = { ...baseAtt("audio"), name: "call.mp3", transcript: "We agreed on sixty one litres." };
    const joined = attachmentParts(att).filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("its complete spoken content, taken directly from the recording, follows");
  });

  it("partially readable PDF stays usable: native text and rendered frames ride; no refusal", () => {
    const att: Attachment = {
      ...baseAtt("pdf"), name: "report.pdf",
      // The producer weaves the coverage note INTO the text body (document-capability).
      text: "2 of 3 page(s) recognised; page 2 returned no text.\n\nPage 1. The KAPPA 9 threshold sits at 61 litres.",
      frames: [{ dataUrl: "data:image/png;base64,PGI=", at: 2, label: "page 2" }],
      coverageNote: "2 of 3 page(s) recognised; page 2 returned no text.",
    };
    const parts = attachmentParts(att);
    const joined = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("KAPPA 9 threshold sits at 61 litres");
    expect(joined).toContain("2 of 3 page(s) recognised");
    expect(parts.some(p => p.type === "image_url")).toBe(true);   // page 2 pixels ride
    expect(joined).not.toContain("no readable text was found");   // file stays usable
  });
});
