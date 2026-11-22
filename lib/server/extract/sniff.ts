import type { FileCategory } from "../../files/extensions";
import { detectBom } from "../../files/encoding";

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
  // F78-A: UTF-16LE/UTF-32LE text begins FF FE — byte-identical to an MP3
  // frame-sync pair — and large BOM'd text (> the browser's inline limit) was
  // "strong audio", fed to ffmpeg and lost. The BOM table is SHARED with
  // decodeText so detection and decoding can never disagree. Text BOMs are
  // never media; the text branch decodes them correctly.
  if (detectBom(head)) return null;
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // Untagged MP3 frame sync. A 4-byte header check is NOT enough: FF FE 69 00
    // (BOM + text) decodes as a legal MPEG-1 Layer I header. Require the whole
    // header to be self-consistent AND the NEXT frame's sync to sit at the
    // computed frame stride — real encoders emit back-to-back frames; text
    // landing on that offset does not start with 0xFF sync.
    return mp3FrameSync(head) ? { category: "audio", strong: true } : null;
  }
  return null;
}

/** Bitrate tables in kbps, indexed by header bitrate index 1..14. */
const MPEG_BITRATES = {
  m1l1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  m1l2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448],
  m1l3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 448],
  m2l1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  m2l23: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_FREQS = {
  m1: [44100, 48000, 32000],
  m2: [22050, 24000, 16000],
  m25: [11025, 12000, 8000],
};

/**
 * True when `head` starts with a valid MPEG audio frame whose successor frame
 * header sits at the computed stride. Needs a head larger than one frame
 * (~1 KB covers every legal CBR frame), which is why the sniff head is 2 KB.
 */
export function mp3FrameSync(head: Buffer): boolean {
  if (head.length < 4) return false;
  const version = (head[1] >> 3) & 3; // 0 MPEG-2.5, 1 reserved, 2 MPEG-2, 3 MPEG-1
  const layer = (head[1] >> 1) & 3; // 3 L1, 2 L2, 1 L3, 0 invalid
  const bitrateIdx = (head[2] >> 4) & 0x0f;
  const freqIdx = (head[2] >> 2) & 3;
  const padding = (head[2] >> 1) & 1;
  if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || freqIdx === 3) {
    return false;
  }
  const m1 = version === 3;
  const kbps = (layer === 3
    ? (m1 ? MPEG_BITRATES.m1l1 : MPEG_BITRATES.m2l1)
    : layer === 2
      ? (m1 ? MPEG_BITRATES.m1l2 : MPEG_BITRATES.m2l23)
      : (m1 ? MPEG_BITRATES.m1l3 : MPEG_BITRATES.m2l23))[bitrateIdx - 1];
  const freq = (m1 ? MPEG_FREQS.m1 : version === 2 ? MPEG_FREQS.m2 : MPEG_FREQS.m25)[freqIdx];
  const bps = kbps * 1000;
  const core = layer === 3
    ? (m1 ? 48 : 24) * 4 * bps / freq // Layer I (MPEG-2 halves the samples)
    : layer === 2
      ? 144 * bps / freq // Layer II, both versions
      : (m1 ? 144 : 72) * bps / freq; // Layer III
  for (const pad of [0, 1]) {
    const stride = Math.floor(core) + pad;
    if (stride >= 24 && stride + 1 < head.length &&
        head[stride] === 0xff && (head[stride + 1] & 0xe0) === 0xe0) {
      return true;
    }
  }
  return false;
}
