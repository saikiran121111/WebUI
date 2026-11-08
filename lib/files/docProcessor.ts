import type { Attachment } from "../types";
import {
  classifyFile,
  TEXT_CHAR_LIMIT,
  type FileCategory,
} from "./extensions";
import { decodeText } from "./encoding";

/**
 * Client half of the attachment pipeline.
 *
 * Plain text and browser-decodable images are read right here in the browser;
 * everything else is posted to /api/files/extract, where the extraction
 * tooling bundled in node_modules (ffmpeg, whisper, 7za, pdf.js) does the work.
 */

/** Shape returned by /api/files/extract (mirrors ExtractResult). */
interface ExtractResponse {
  name: string;
  category: FileCategory;
  text?: string;
  truncated?: boolean;
  pages?: number;
  transcript?: string;
  dataUrl?: string;
  frames?: { dataUrl: string; at: number }[];
  durationSec?: number;
  indexed?: boolean;
  chunkCount?: number;
  spine?: string;
  error?: string;
  /** I16: honest statement of what could NOT be read (its text also rides in `text`). */
  coverageNote?: string;
}

/** Images are downscaled to this before being handed to the model. */
const MAX_IMAGE_SIDE = 1280;

function kindFor(cat: FileCategory): Attachment["kind"] {
  if (cat === "image") return "image";
  if (cat === "video") return "video";
  if (cat === "unknown") return "other";
  return "document";
}

function cap(text: string): { text: string; truncated: boolean } {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= TEXT_CHAR_LIMIT) return { text: clean, truncated: false };
  return { text: clean.slice(0, TEXT_CHAR_LIMIT), truncated: true };
}

/**
 * Cheap, synchronous gate run the moment a file is picked. No size limit —
 * uploads stream straight to disk (local app); only an empty file is refused.
 */
export function validateAttachment(file: File): Attachment {
  if (file.size === 0) throw new Error(`${file.name} is empty`);

  const category = classifyFile(file.name, file.type);
  return {
    id: "att_" + Math.random().toString(36).slice(2, 12),
    name: file.name,
    kind: kindFor(category),
    category,
    mime: file.type || "",
    size: file.size,
    status: "pending",
  };
}

/**
 * Turn a picked file into a ready attachment: text body, image data URL,
 * transcript, or sampled frames — whatever the model can be shown.
 *
 * I15c: `signal` lets the caller cancel the read when its chip is removed —
 * the server-side extraction (ffmpeg/whisper) aborts WITH the request,
 * instead of grinding to completion for a file the user already dropped.
 */
export async function processAttachment(
  file: File,
  base: Attachment,
  signal?: AbortSignal,
): Promise<Attachment> {
  const att: Attachment = { ...base, status: "processing" };

  try {
    switch (att.category) {
      case "text": {
        // Bytes ≥ characters, so anything at or under the budget is safe to
        // read in the browser. Bigger files go to the server, where oversized
        // content is indexed instead of truncated (the browser path can't).
        if (file.size > TEXT_CHAR_LIMIT) return await extractOnServer(file, att, signal);
        // I10: file.text() always decodes UTF-8 — a UTF-16 or cp1252 file
        // turned into NUL garbage / mojibake with no warning. Decode by
        // content (BOM / heuristics / best-guess fallback) and label guesses.
        const dec = decodeText(new Uint8Array(await file.arrayBuffer()));
        const capped = cap(dec.text);
        const note = dec.lossy
          ? `[encoding: this file is not valid UTF-8 — decoded as ${dec.encoding}, so some characters may be wrong]\n\n`
          : "";
        return {
          ...att,
          text: capped.text ? note + capped.text : capped.text,
          truncated: capped.truncated,
          status: "ready",
        };
      }

      case "image":
        try {
          const { dataUrl, width, height, frames } = await encodeImage(file);
          return {
            ...att, dataUrl, width, height,
            ...(frames?.length ? { frames } : {}),
            status: "ready",
          };
        } catch {
          // Browser can't decode it (tif/heic/ico/…) — let ffmpeg try instead.
          return await extractOnServer(file, att, signal);
        }

      default:
        return await extractOnServer(file, att, signal);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not read this file";
    console.warn("[attachment]", att.name, "-", message);
    return { ...att, status: "error", error: message };
  }
}

async function extractOnServer(
  file: File,
  att: Attachment,
  signal?: AbortSignal,
): Promise<Attachment> {
  // Raw bytes, not multipart: the browser streams the File straight off disk
  // and the server streams it straight to its scratch file — multi-GB media
  // never sit whole in memory on either side.
  const res = await fetch(
    `/api/files/extract?name=${encodeURIComponent(file.name)}&att=${encodeURIComponent(att.id)}`,
    {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
      ...(signal ? { signal } : {}),
    },
  );
  const data = (await res.json().catch(() => null)) as ExtractResponse | null;
  if (!res.ok || !data || data.error) {
    throw new Error(data?.error ?? `Extraction failed (${res.status})`);
  }

  // I09: the extractor magic-sniffs the bytes, so the category it returns can
  // DIFFER from the one the extension claimed (a PNG renamed .pdf becomes
  // "image"). `kind` was computed from the old category — recompute it from
  // the corrected one or the attachment renders with the wrong UI treatment.
  const category = data.category ?? att.category;
  return {
    ...att,
    category,
    kind: kindFor(category),
    text: data.text,
    truncated: data.truncated,
    pages: data.pages,
    transcript: data.transcript,
    dataUrl: data.dataUrl,
    frames: data.frames,
    durationSec: data.durationSec,
    // Knowledge-index markers: the full content lives on the server, and the
    // chat route retrieves passages per question from these.
    indexed: data.indexed,
    indexId: data.indexed ? att.id : undefined,
    chunkCount: data.chunkCount,
    spine: data.spine,
    status: "ready",
  };
}

/** Encode one region of the bitmap: alpha flattened, long side capped, JPEG. */
function encodeRegion(
  bitmap: ImageBitmap,
  y: number,
  h: number,
): { dataUrl: string; width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, h));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  ctx.fillStyle = "#ffffff"; // JPEG carries no alpha — composite onto white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, y, bitmap.width, h, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  if (dataUrl.length < 200) throw new Error("Image could not be encoded");
  return { dataUrl, width, height };
}

/**
 * Re-encode an image in-canvas: alpha flattened, long side capped, JPEG.
 *
 * I07: capping a 1080x19000 chat-log screenshot to one 72x1280 JPEG made its
 * text literally unreadable — the pixels survived, the legibility died. For
 * extreme portrait images the single image is kept as an OVERVIEW and full
 * detail rides along as overlapping strips (`frames`, `at` = 1-based strip
 * number — page semantics, matching multi-page server decodes, not seconds).
 * Strips overlap 10% so text split at a boundary still appears whole.
 */
const MAX_STRIP_FRAMES = 8; // matches the server-side multi-page decode cap

async function encodeImage(
  file: File,
): Promise<{ dataUrl: string; width: number; height: number; frames?: { dataUrl: string; at: number }[] }> {
  const bitmap = await createImageBitmap(file);
  try {
    const overview = encodeRegion(bitmap, 0, bitmap.height);

    let frames: { dataUrl: string; at: number }[] | undefined;
    if (bitmap.height > bitmap.width * 2.5 && bitmap.height > MAX_IMAGE_SIDE) {
      // Strips sized so their WIDTH stays the long side — each keeps close to
      // native horizontal resolution, which is what text legibility needs.
      const stripH = Math.max(1, Math.min(bitmap.height, Math.round(bitmap.width * 1.5)));
      const step = Math.max(1, Math.round(stripH * 0.9)); // 10% overlap
      frames = [];
      for (let y = 0; y < bitmap.height && frames.length < MAX_STRIP_FRAMES; y += step) {
        const h = Math.min(stripH, bitmap.height - y);
        if (h < 64 && frames.length > 1) break; // sliver remainder
        frames.push({ dataUrl: encodeRegion(bitmap, y, h).dataUrl, at: frames.length + 1 });
        if (y + h >= bitmap.height) break;
      }
      if (!frames.length) frames = undefined;
    }
    return { ...overview, ...(frames ? { frames } : {}) };
  } finally {
    bitmap.close?.();
  }
}
