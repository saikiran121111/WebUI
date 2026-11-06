import { unzipSync } from "fflate";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Hard ceiling on a single member's INFLATED size. The declared central
 * directory sizes are not trusted (fflate does not verify CRCs and a patched
 * header can claim anything — measured on fflate 0.8.3), so the limit is
 * applied to what actually came out of the inflate. Oversize members are
 * dropped rather than fatal: one 300 MB log inside a workbook container must
 * not make the whole file unreadable.
 */
export const MAX_MEMBER_INFLATED_BYTES = 256 * 1024 * 1024;

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
 * Do not switch this to fflate's async API: readZip is sync by contract and
 * every caller (officeText, nested archives) relies on that.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let dict: Record<string, Uint8Array>;
  try {
    dict = unzipSync(view);
  } catch (err) {
    throw new Error(
      "Not a readable ZIP file: " + ((err as Error)?.message || String(err)),
    );
  }
  const entries: ZipEntry[] = [];
  for (const [name, data] of Object.entries(dict)) {
    if (name.endsWith("/")) continue; // directory entries carry no content
    if (data.length > MAX_MEMBER_INFLATED_BYTES) continue;
    // Views over fflate's buffers — never copies. Safe for the read-only text
    // paths downstream; do NOT mutate entry bytes in place.
    entries.push({ name, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  }
  return entries;
}
