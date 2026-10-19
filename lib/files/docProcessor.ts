import type { Attachment } from "../types";
import {
  classifyFile,
  TEXT_CHAR_LIMIT,
  type FileCategory,
} from "./extensions";

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
  error?: string;
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
 */
export async function processAttachment(file: File, base: Attachment): Promise<Attachment> {
  const att: Attachment = { ...base, status: "processing" };

  try {
    switch (att.category) {
      case "text":
        return { ...att, ...cap(await file.text()), status: "ready" };

      case "image":
        try {
          const { dataUrl, width, height } = await encodeImage(file);
          return { ...att, dataUrl, width, height, status: "ready" };
        } catch {
          // Browser can't decode it (tif/heic/ico/…) — let ffmpeg try instead.
          return await extractOnServer(file, att);
        }

      default:
        return await extractOnServer(file, att);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not read this file";
    console.warn("[attachment]", att.name, "-", message);
    return { ...att, status: "error", error: message };
  }
}

async function extractOnServer(file: File, att: Attachment): Promise<Attachment> {
  // Raw bytes, not multipart: the browser streams the File straight off disk
  // and the server streams it straight to its scratch file — multi-GB media
  // never sit whole in memory on either side.
  const res = await fetch(
    `/api/files/extract?name=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    },
  );
  const data = (await res.json().catch(() => null)) as ExtractResponse | null;
  if (!res.ok || !data || data.error) {
    throw new Error(data?.error ?? `Extraction failed (${res.status})`);
  }

  return {
    ...att,
    category: data.category ?? att.category,
    text: data.text,
    truncated: data.truncated,
    pages: data.pages,
    transcript: data.transcript,
    dataUrl: data.dataUrl,
    frames: data.frames,
    durationSec: data.durationSec,
    status: "ready",
  };
}

/** Re-encode an image in-canvas: alpha flattened, long side capped, JPEG. */
async function encodeImage(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  ctx.fillStyle = "#ffffff"; // JPEG carries no alpha — composite onto white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  if (dataUrl.length < 200) throw new Error("Image could not be encoded");
  return { dataUrl, width, height };
}
