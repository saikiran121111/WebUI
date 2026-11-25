import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { attachmentParts } from "../../lib/chat/client";
import { extractFileFromPath } from "../../lib/server/extract";
import type { Attachment } from "../../lib/types";

/**
 * F152: the production PDF reader renders pages whose CONTENT is drawn
 * (vector charts/diagrams — workers/document_jobs.py _visual_pages) and the
 * extract seam ships them as `att.frames` with `at` = 1-based page
 * (lib/server/extract/index.ts). Ask a visual question about such a page
 * ("which coloured line crosses the threshold?") and the pixels never
 * arrived: the `default:` branch of attachmentParts (lib/chat/client.ts)
 * emits ONLY text parts, so a chart page's drawn fact is invisible to the
 * multimodal request even though extraction delivered it.
 *
 * The law: when a document attachment carries rendered page frames, the
 * frames ride into the request labelled with their page, and the text body
 * and the pixels stay distinguishable (text is what was readable, the image
 * is what is drawn). A document with no frames keeps the exact old shape.
 */

function docAtt(extra: Partial<Attachment>): Attachment {
  return {
    id: "att_doc", name: "report.pdf", kind: "file", mime: "application/pdf", size: 8192,
    status: "ready", category: "pdf",
    text: "Opening summary. Maintenance threshold is 61 litres.",
    ...extra,
  } as Attachment;
}

describe("document visual frames survive chat assembly (F152)", () => {
  it("short PDF with rendered page frames: every frame arrives, labelled with its page", () => {
    const parts = attachmentParts(docAtt({
      frames: [
        { dataUrl: "data:image/png;base64,PG1", at: 1 },
        { dataUrl: "data:image/png;base64,PG3", at: 3 },
      ],
    }));
    const images = parts.filter(p => p.type === "image_url");
    expect(images.length).toBe(2);
    const texts = parts.filter(p => p.type === "text").map(p => p.text as string);
    // Each image is directly preceded by a label naming its page.
    for (const label of ["Page 1", "Page 3"]) {
      const k = parts.findIndex(p => p.type === "text" && (p.text as string).includes(label));
      expect(k, label).toBeGreaterThanOrEqual(0);
      expect(parts[k + 1].type, `image directly after ${label}`).toBe("image_url");
    }
    // The native text body is still there, and the frames are framed as the
    // page's DRAWN content — not a transcript substitution.
    const joined = texts.join("\n");
    expect(joined).toContain("[file content begins]");
    expect(joined).toContain("Maintenance threshold is 61 litres.");
  });

  it("pptx frame from an embedded image arrives for the model", () => {
    const parts = attachmentParts(docAtt({
      name: "deck.pptx", category: "office",
      text: "Inspection image",
      frames: [{ dataUrl: "data:image/png;base64,SL1", at: 1 }],
    }));
    expect(parts.filter(p => p.type === "image_url").length).toBe(1);
  });

  it("zero text WITH rendered pixels: the frames serve — never a 'no readable text' refusal (F152)", () => {
    // An image-only PDF (every page drawn, no text layer) extracts with an
    // empty body and rendered frames. Discarding the pixels here ("no
    // readable text was found") hid the file's entire content from the model.
    const parts = attachmentParts(docAtt({ text: "", frames: [{ dataUrl: "data:image/png;base64,PG1", at: 1 }] }));
    const joined = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).not.toContain("no readable text was found");
    expect(joined).toContain("no readable text layer"); // honest: the TEXT is empty…
    const images = parts.filter(p => p.type === "image_url");
    expect(images.length).toBe(1); // …the PIXELS answer.
    const k = parts.findIndex(p => p.type === "text" && (p.text as string).includes("Page 1"));
    expect(parts[k + 1].type).toBe("image_url"); // the frame keeps its page label
  });

  it("control: zero text AND no frames keeps the honest refusal", () => {
    const parts = attachmentParts(docAtt({ text: "" }));
    expect(parts.length).toBe(1);
    expect(parts[0].text).toContain("no readable text was found");
  });

  it("control: document WITHOUT frames keeps the exact old single-part shape", () => {
    const parts = attachmentParts(docAtt({}));
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("text");
  });

  it("indexed document: client sends the ref (pixels are server-side); ref stays last", () => {
    const parts = attachmentParts(docAtt({
      indexed: true, indexId: "att_doc_idx", text: "opening preview",
    }));
    const last = parts[parts.length - 1];
    expect(last.type).toBe("attachment_ref");
    expect(last.att_id).toBe("att_doc_idx");
    // Client carries no pixels for indexed documents — the retrieval side
    // (ruke-attach) owns delivering the relevant page image per question.
    expect(parts.filter(p => p.type === "image_url").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F152 standalone images: the pixels ARE the content and ride to the model
// unchanged; the SAME region-decision law recovers a screenshot's label with
// its engine + region, and a photo pays zero engine calls (no text channel).
// ---------------------------------------------------------------------------

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageEnvelope(opts: { recognized: boolean; note: string }) {
  return {
    state: "ready",
    capability: "documents.parse@1",
    job_id: "job_f152img", run_id: "run_f152img", request_id: "req_f152img", deadline_s: 90,
    source: "rust-ml-job",
    result: {
      payload: {
        coverage_complete: true,
        document: {
          kind: "image",
          blocks: opts.recognized
            ? [{
                text: "VALVE 7 CLOSE", kind: "ocr_text",
                loc: { unit: 1, region: "image:1:shot.png", part: "shot.png",
                       engine: "tesseract", language_code: "eng", provenance: "ocr" },
              }]
            : [],
          coverage: {
            method: "ruke-ml raster region inspection",
            note: opts.note,
            units_total: 1, units_extracted: opts.recognized ? 1 : 0,
            units_succeeded: opts.recognized ? [1] : [], units_empty: opts.recognized ? [] : [1],
            units_needing_ocr: [], units_failed: [],
          },
          meta: {}, source_id: "shot.png", source_hash: "h",
        },
        ocr: { ran: true, pages: [], engines_recognised: opts.recognized ? { tesseract: 1 } : {} },
        visual_pages: [
          { page: 1, region: "image:1:shot.png", label: "image 1",
            region_state: opts.recognized ? "recognised" : "skipped",
            png_base64: PNG_B64 },
        ],
        visual_note: "1 region rendered",
        rendered_units: opts.recognized
          ? [{ unit: 1, text: "VALVE 7 CLOSE", provenance: "ocr", engine: "tesseract", blocks: 1, truncated: false }]
          : [],
      },
      coverage: { units: "units", total_source: 1, complete: true, note: "" },
    },
  } as any;
}

function imageScratch(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f152img_"));
  const p = path.join(dir, "shot.png");
  fs.writeFileSync(p, Buffer.from(PNG_B64, "base64")); // real decodable 1x1 PNG
  return p;
}

describe("standalone image through the production reader (F152)", () => {
  it("screenshot label recovered: text carries engine + region, pixels intact, note recorded", async () => {
    const src = imageScratch();
    try {
      const r = await extractFileFromPath("shot.png", src, undefined, undefined, undefined, {
        runJob: (async () => imageEnvelope({
          recognized: true,
          note: "standalone raster: region inspection read 1 label-bearing region",
        })) as any,
      });
      expect(r.category).toBe("image");
      expect(r.dataUrl?.startsWith("data:image/")).toBe(true); // pixels ride, unchanged
      expect(r.text).toContain("VALVE 7 CLOSE");
      expect(r.text).toContain("tesseract");                    // actual engine
      expect(r.text).toContain("image:1:shot.png");             // stable region id
      expect(r.text).toContain("image 1");                      // unit label
      expect(r.coverageNote).toContain("label-bearing region"); // evidence, not silence
    } finally {
      fs.rmSync(path.dirname(src), { recursive: true, force: true });
    }
  });

  it("photo: inspection ran, zero text recovered → NO text field; pixels keep the answer", async () => {
    const src = imageScratch();
    try {
      const r = await extractFileFromPath("photo.png", src, undefined, undefined, undefined, {
        runJob: (async () => imageEnvelope({
          recognized: false,
          note: "standalone raster: region inspected, no text-bearing region found (photo)",
        })) as any,
      });
      expect(r.dataUrl?.startsWith("data:image/")).toBe(true);
      expect(r.text).toBeUndefined();
      expect(r.coverageNote).toContain("no text-bearing region");
    } finally {
      fs.rmSync(path.dirname(src), { recursive: true, force: true });
    }
  });

  it("chat assembly: recovered text rides AFTER the pixels, labelled as recovered", () => {
    const parts = attachmentParts({
      id: "att_img", name: "shot.png", kind: "image", mime: "image/png", size: 70,
      status: "ready", category: "image",
      dataUrl: `data:image/png;base64,${PNG_B64}`,
      text: "[text recovered by OCR (tesseract) from image 1, region image:1:shot.png]\nVALVE 7 CLOSE",
    } as Attachment);
    const kImg = parts.findIndex(p => p.type === "image_url");
    const kTxt = parts.findIndex(p => p.type === "text" && (p.text as string).includes("Text recovered from this picture"));
    expect(kImg).toBeGreaterThanOrEqual(0);
    expect(kTxt).toBeGreaterThan(kImg); // pixels first: vision is the primary source
    const joined = parts.filter(p => p.type === "text").map(p => p.text as string).join("\n");
    expect(joined).toContain("VALVE 7 CLOSE");
    expect(joined).toContain("the file carries no text layer"); // recovered ≠ native
  });

  it("control: image with no recovered text keeps the exact old shape (label + pixels)", () => {
    const parts = attachmentParts({
      id: "att_img", name: "photo.png", kind: "image", mime: "image/png", size: 70,
      status: "ready", category: "image", dataUrl: `data:image/png;base64,${PNG_B64}`,
    } as Attachment);
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
  });
});
