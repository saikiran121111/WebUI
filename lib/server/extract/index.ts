import { classifyFile, fileExtension, TEXT_CHAR_LIMIT, type FileCategory } from "../../files/extensions";
import { officeText } from "./office";
import { rtfToText } from "./rtf";
import { notebookText } from "./notebook";
import { archiveText } from "./archives";
import { extractStrings } from "./strings";
import { pdfText } from "./pdf";
import { audioPcm, imageToDataUrl, videoFrames } from "./ffmpeg";
import { transcribePcm } from "./audio";

export interface ExtractResult {
  name: string;
  category: FileCategory;
  /** Plain-text body for text-like formats (documents, code, archives…). */
  text?: string;
  truncated?: boolean;
  pages?: number;
  /** Whisper transcript for audio (and audio tracks we could read). */
  transcript?: string;
  /** Image as a PNG data URL — only when the browser could not decode it. */
  dataUrl?: string;
  /** Sampled video frames as PNG data URLs. */
  frames?: { dataUrl: string; at: number }[];
  durationSec?: number;
  error?: string;
}

function cap(text: string, limit = TEXT_CHAR_LIMIT): { text: string; truncated: boolean } {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= limit) return { text: clean, truncated: false };
  return { text: clean.slice(0, limit), truncated: true };
}

/**
 * Server-side extraction for every attachment category the browser cannot
 * handle on its own (documents, archives, audio, video, exotic images).
 */
export async function extractFile(name: string, buf: Buffer): Promise<ExtractResult> {
  const category = classifyFile(name);
  const ext = fileExtension(name).toLowerCase();
  const utf8 = () => buf.toString("utf8");

  switch (category) {
    case "text":
      return { name, category, ...cap(utf8()) };

    case "rtf":
      return { name, category, ...cap(rtfToText(utf8())) };

    case "notebook":
      return { name, category, ...cap(notebookText(utf8())) };

    case "pdf": {
      const { text, pages } = await pdfText(buf);
      return { name, category, pages, ...cap(text) };
    }

    case "office": {
      const text = officeText(buf, ext);
      if (!text.trim()) throw new Error("No readable text found in this document");
      return { name, category, ...cap(text) };
    }

    case "archive":
      // The uploaded name is passed along because bare .bz2/.xz streams store
      // no filenames — the inner name only exists in the file name itself.
      return { name, category, ...cap(await archiveText(buf, ext, name)) };

    case "legacy": {
      // Legacy .doc/.xls/.ppt/.mat have no public parser here — recover the
      // printable runs, which is what those formats store text as anyway.
      const text = extractStrings(buf);
      if (!text.trim()) throw new Error("No readable text found in this file");
      return { name, category, ...cap(text) };
    }

    case "image":
      return { name, category, dataUrl: await imageToDataUrl(buf, ext || "png") };

    case "audio": {
      const pcm = await audioPcm(buf, ext || "bin");
      const transcript = await transcribePcm(pcm);
      if (!transcript) throw new Error("No speech detected in this audio file");
      return { name, category, transcript, ...cap(transcript) };
    }

    case "video": {
      const { frames, durationSec } = await videoFrames(buf, ext || "mp4");
      return { name, category, frames, durationSec };
    }

    default:
      throw new Error("Unsupported file type: " + (ext ? "." + ext : name));
  }
}
