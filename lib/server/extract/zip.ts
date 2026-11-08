import { unzipSync } from "fflate";

/**
 * Standard CRC-32 (zip polynomial, reflected). fflate does NOT export a
 * crc32 helper in 0.8.x (verified against the installed module — it runs its
 * own internal table), so the checksum used for the D27/I11 verification is
 * implemented here. Table built once at module load.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Set when the member fails its central-directory CRC-32 check. */
  corrupt?: string;
}

/**
 * Hard ceiling on a single member's INFLATED size. The declared central
 * directory sizes are not trusted (a patched header can claim anything), so
 * the limit is applied to what actually came out of the inflate. Oversize
 * members are dropped rather than fatal: one 300 MB log inside a workbook
 * container must not make the whole file unreadable.
 */
export const MAX_MEMBER_INFLATED_BYTES = 256 * 1024 * 1024;

export interface ZipLimits {
  /** Per-member inflated ceiling (default MAX_MEMBER_INFLATED_BYTES). */
  perMemberBytes?: number;
  /**
   * Pre-inflate member filter. fflate's `filter` runs against the central
   * directory BEFORE inflating, so excluded parts (a workbook's embedded
   * media, a pptx's unused layouts) never touch memory. Callers that only
   * need text parts use this instead of inflating the whole container.
   */
  include?: (name: string) => boolean;
}

export interface ZipRead {
  entries: ZipEntry[];
  /** Members whose inflated size exceeded the per-member limit. */
  dropped: { name: string; bytes: number }[];
  /** Members that failed their CRC check (also present with `corrupt` set). */
  corrupt: string[];
  /** Every member name in the container (from the central directory). */
  names: string[];
}

/**
 * Walk the End Of Central Directory + central directory to map member names
 * to their stored CRC-32 values. fflate never verifies checksums, and a
 * corrupted or deliberately tampered member used to flow through as if it
 * were intact (D27/I11). The CRC field is a fixed 4 bytes in the central
 * directory — unlike the size/offset fields it is never Zip64-expanded — so
 * a minimal name+CRC walk is Zip64-safe (verified against a 66,001-member
 * Zip64 archive). Returns null if the directories can't be located; then
 * verification is simply skipped rather than fatal.
 */
export function centralDirectoryCrcs(buf: Buffer): Map<string, number> | null {
  const MIN_EOCD = 22;
  if (buf.length < MIN_EOCD) return null;
  // EOCD sits at the end; the archive comment can pad it by up to 65,535 bytes.
  const scanFrom = Math.max(0, buf.length - (MIN_EOCD + 0xffff));
  let eocd = -1;
  for (let i = buf.length - MIN_EOCD; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const map = new Map<string, number>();

  // 0xFFFF/0xFFFFFFFF sentinel → Zip64 end-of-central-directory record.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    if (eocd - 20 < 0 || buf.readUInt32LE(eocd - 20) !== 0x08064b50) return null;
    const eocd64Pos = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (eocd64Pos + 56 > buf.length || buf.readUInt32LE(eocd64Pos) !== 0x07064b50) return null;
    count = Number(buf.readBigUInt64LE(eocd64Pos + 32));
    cdOffset = Number(buf.readBigUInt64LE(eocd64Pos + 48));
  }

  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return map.size ? map : null;
    const crc = buf.readUInt32LE(pos + 16);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const cmtLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    map.set(name, crc >>> 0);
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return map;
}

/**
 * ZIP container reader for Office/ODF/EPUB packages and plain .zip archives.
 * fflate (already a dependency — the Power BI writer uses it) replaced the
 * hand-rolled EOCD/central-directory parser; the fflate version:
 *   - reads real-world Zip64 archives in full (verified against a 66,001-member
 *     7za-built archive; the hand parser capped at the 16-bit count field),
 *   - throws on encrypted or exotic-method members (Zip64 AES, LZMA), which is
 *     what routes the archive path through the bundled 7za fallback
 *     (archives.ts → zipMembers) — this is the fallback the old header comment
 *     promised but never actually wired up,
 *   - keeps the same error contract: anything unparseable surfaces as
 *     "Not a readable ZIP file: …".
 *
 * D27/I11 bounds: `include` skips parts pre-inflation (media and unused
 * package parts never inflate), the per-member inflated ceiling drops oversized
 * parts with their names recorded, and every inflated member is checked
 * against the central-directory CRC — corrupted parts are FLAGGED, not silently
 * trusted. Note: this bounds per-member retention and output; the container
 * itself is held in memory (the sync-by-contract design), and the upstream
 * MAX_PARSED_BYTES cap bounds the raw file.
 *
 * Do not switch this to fflate's async API: readZip is sync by contract and
 * every caller (officeText, nested archives) relies on that.
 */
export function readZipDetailed(buf: Buffer, limits: ZipLimits = {}): ZipRead {
  const perMember = limits.perMemberBytes ?? MAX_MEMBER_INFLATED_BYTES;
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let dict: Record<string, Uint8Array>;
  try {
    dict = limits.include
      ? unzipSync(view, { filter: (f) => limits.include!(f.name) })
      : unzipSync(view);
  } catch (err) {
    throw new Error(
      "Not a readable ZIP file: " + ((err as Error)?.message || String(err)),
    );
  }
  const crcs = centralDirectoryCrcs(buf);
  const entries: ZipEntry[] = [];
  const dropped: { name: string; bytes: number }[] = [];
  const corrupt: string[] = [];
  for (const [name, data] of Object.entries(dict)) {
    if (name.endsWith("/")) continue; // directory entries carry no content
    if (data.length > perMember) {
      dropped.push({ name, bytes: data.length });
      continue;
    }
    let flag: string | undefined;
    const expected = crcs?.get(name);
    if (expected !== undefined && (crc32(data) >>> 0) !== expected) {
      flag = "checksum mismatch";
      corrupt.push(name);
    }
    // Views over fflate's buffers — never copies. Safe for the read-only text
    // paths downstream; do NOT mutate entry bytes in place.
    entries.push({
      name,
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      ...(flag ? { corrupt: flag } : {}),
    });
  }
  const names = crcs ? [...crcs.keys()] : Object.keys(dict);
  return { entries, dropped, corrupt, names };
}

export function readZip(buf: Buffer): ZipEntry[] {
  return readZipDetailed(buf).entries;
}
