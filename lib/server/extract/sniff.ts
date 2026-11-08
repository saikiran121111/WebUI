import type { FileCategory } from "../../files/extensions";

/**
 * I09 — magic-byte sniffing for the identity contract.
 *
 * The extension is the source of truth (MIME is unreliable — see
 * lib/files/extensions.ts). Bytes are consulted for the deliberate-disagreement
 * cases only: a strong magic signature that contradicts the name wins over the
 * name, because the bytes ARE the file. Weak signatures (containers whose
 * audio/video/text meaning the name still has to disambiguate) never override
 * a known category; they only rescue an "unknown".
 */
export interface Sniffed {
  category: FileCategory;
  /** True = unambiguous container magic; strong sniffs override the extension. */
  strong: boolean;
}

export function sniffMagic(head: Buffer): Sniffed | null {
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { category: "pdf", strong: true };
  }
  if (head.length >= 4 && head.readUInt32LE(0) === 0xE011CFD0) {
    return { category: "legacy", strong: true }; // OLE2 (.doc/.xls/.ppt)
  }
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "{\\rtf") {
    return { category: "rtf", strong: true };
  }
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { category: "image", strong: true }; // PNG
  }
  if (head.length >= 6 && ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1"))) {
    return { category: "image", strong: true };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { category: "image", strong: true }; // JPEG
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" &&
      head.subarray(8, 12).toString("latin1") === "WEBP") {
    return { category: "image", strong: true };
  }
  if (head.length >= 4 && head.subarray(0, 2).toString("latin1") === "BM") {
    return { category: "image", strong: true }; // BMP
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b &&
      (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
      (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)) {
    // ZIP container: office vs plain-archive CANNOT be told apart from magic
    // alone — the extension still decides between them.
    return { category: "archive", strong: false };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    // MP4-family container: audio/video split needs the name (m4a vs mp4).
    return { category: "video", strong: false };
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "OggS") {
    return { category: "audio", strong: false }; // Ogg could be ogv video
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" &&
      head.subarray(8, 12).toString("latin1") === "WAVE") {
    return { category: "audio", strong: true };
  }
  if (head.length >= 4 && (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)) {
    return { category: "audio", strong: true }; // ID3-tagged MP3
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return { category: "audio", strong: true }; // untagged MP3 frame sync
  }
  return null;
}
