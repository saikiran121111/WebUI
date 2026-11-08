import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readZip, readZipDetailed } from "./zip";
import { classifyFile, fileExtension } from "../../files/extensions";
import { decodeText } from "../../files/encoding";
import { rtfToText } from "./rtf";
import { notebookText } from "./notebook";
import { pdfText } from "./pdf";
import { officeText } from "./office";
import { extractStrings } from "./strings";

const execFileP = promisify(execFile);

const TMP_DIR = path.join(process.cwd(), ".data", "tmp");

function tmpName(ext: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, "x_" + randomBytes(6).toString("hex") + ext);
}

/** tar (ustar) member reader — enough for plain .tar and tar inside .gz. */
function tarMembers(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break; // end-of-archive
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    off += 512;
    if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
      out.push({ name, data: buf.subarray(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

function looksLikeTar(buf: Buffer): boolean {
  return buf.length >= 512 && buf.subarray(257, 262).toString("utf8") === "ustar";
}

type Member = { name: string; data: Buffer; corrupt?: string };

/**
 * Archives nest: a .7z holding a .tar, a .zip holding a .gz. Those wrappers
 * have to be expanded, or a member named inner.tar is classified as an archive
 * and skipped for carrying no text of its own. Depth-capped; members that
 * could NOT be expanded (nesting deeper than the cap, or 7z/rar nested inside)
 * are REPORTED, not silently dropped (I11).
 */
function flattenMembers(
  members: Member[],
  depth = 0,
  notExpanded: string[] = [],
): Member[] {
  const out: Member[] = [];
  for (const m of members) {
    // Checksum-failed members are KEPT flagged (never parsed further); the
    // coverage ledger reports them under CORRUPT, which is what actually
    // happened — they WERE expanded, their bytes just failed the check.
    if (m.corrupt) { out.push(m); continue; }
    const ext = fileExtension(m.name);
    const nested = ext === "tar" || ext === "gz" || ext === "tgz" || ext === "zip";
    if (nested) {
      if (depth > 2) { notExpanded.push(`${m.name} (nesting limit)`); continue; }
      try {
        if (ext === "tar") {
          out.push(...flattenMembers(tarMembers(m.data), depth + 1, notExpanded));
          continue;
        }
        if (ext === "gz" || ext === "tgz") {
          const raw = zlib.gunzipSync(m.data);
          const inner = looksLikeTar(raw)
            ? tarMembers(raw)
            : [{ name: m.name.replace(/\.(gz|tgz)$/i, ""), data: raw }];
          out.push(...flattenMembers(inner, depth + 1, notExpanded));
          continue;
        }
        // zip: checksum-corrupt members are reported, the rest re-flattened.
        const zip = readZipDetailed(m.data);
        const inner: Member[] = [];
        for (const e of zip.entries) {
          inner.push({ name: e.name, data: e.data, ...(e.corrupt ? { corrupt: e.corrupt } : {}) });
        }
        out.push(...flattenMembers(inner, depth + 1, notExpanded));
        continue;
      } catch { /* not really a nested archive — keep the bytes, but SAY so */ }
      notExpanded.push(`${m.name} (nested ${ext} could not be opened)`);
      out.push(m);
      continue;
    }
    if (ext === "7z" || ext === "rar") notExpanded.push(`${m.name} (nested ${ext} not expanded here)`);
    out.push(m);
  }
  return out;
}

/** Budget for the JOINED archive text. The old 60k silent cap ran out long
 *  before the index pipeline could see the real size; extraction must hand the
 *  index path a complete-enough picture, so the budget is generous while still
 *  bounded, and hitting it is announced in the coverage footer. */
const ARCHIVE_TEXT_BUDGET = 8_000_000; // characters
/** Decode window per text-ish member; larger members are head-truncated with a note. */
const MEMBER_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * I11: members are PARSED BY TYPE, not just raw text: PDF and Office parts
 * inside an archive used to be invisible. Per-member outcomes (parsed /
 * binary-skipped / truncated / corrupt) are aggregated into a coverage footer
 * so "the archive was read" never overstates what actually was.
 */
async function memberBody(m: Member): Promise<{ body: string; note?: string }> {
  const ext = fileExtension(m.name);
  const cat = classifyFile(m.name);
  if (cat === "text") {
    const slice = m.data.length > MEMBER_TEXT_BYTES ? m.data.subarray(0, MEMBER_TEXT_BYTES) : m.data;
    const dec = decodeText(slice);
    const note =
      (m.data.length > MEMBER_TEXT_BYTES
        ? `${m.data.length} bytes — first ${MEMBER_TEXT_BYTES} decoded`
        : "") +
      (dec.lossy ? `${dec.encoding === "windows-1252 (best guess)" ? "decoded as windows-1252 (not valid UTF-8) — characters may be off" : ""}` : "");
    return { body: dec.text, note: note || undefined };
  }
  if (cat === "rtf") return { body: rtfToText(decodeText(m.data).text) };
  if (cat === "notebook") return { body: notebookText(decodeText(m.data).text) };
  if (cat === "pdf") {
    const r = await pdfText(m.data);
    const cov = r.pages > r.pagesWithoutText.length && r.pagesWithoutText.length
      ? ` [${r.pages - r.pagesWithoutText.length} of ${r.pages} pages have a text layer]`
      : "";
    return { body: r.text, note: cov.trim() || undefined };
  }
  if (cat === "office") {
    if (ext === "epub" || ["docx", "xlsx", "xlsm", "pptx", "odt", "ods", "odp"].includes(ext)) {
      return { body: officeText(m.data, ext) };
    }
    return { body: "", note: "office part with unhandled subtype" };
  }
  if (cat === "legacy") {
    return {
      body: extractStrings(m.data),
      note: "legacy binary format — strings recovered by byte scan (lossy)",
    };
  }
  if (cat === "image" || cat === "audio" || cat === "video") {
    return { body: "", note: `${cat} content (binary — not text-extracted)` };
  }
  return { body: "", note: "unrecognised content type" };
}

/** Join the parsed members of an archive into one readable string + coverage footer. */
async function membersToText(members: Member[]): Promise<string> {
  const notExpanded: string[] = [];
  const flat = flattenMembers(members, 0, notExpanded);
  const parts: string[] = [];
  const parsed: string[] = [];
  const skipped: string[] = [];
  const truncated: string[] = [];
  const corrupt: string[] = [];
  let total = 0;
  let budgetHit = false;
  for (const m of flat) {
    if (m.corrupt) { corrupt.push(m.name); continue; }
    if (total >= ARCHIVE_TEXT_BUDGET) { budgetHit = true; skipped.push(`${m.name} (joined-text budget reached)`); continue; }
    let r: { body: string; note?: string };
    try {
      r = await memberBody(m);
    } catch (err) {
      skipped.push(`${m.name} (parse failed: ${(err as Error)?.message || "error"})`);
      continue;
    }
    if (!r.body.trim()) {
      skipped.push(`${m.name}${r.note ? ` — ${r.note}` : " (no readable text)"}`);
      continue;
    }
    const suffix = r.note ? ` [${r.note}]` : "";
    if (r.note && /bytes — first/.test(r.note)) truncated.push(`${m.name} (${r.note})`);
    const block = `--- member: ${m.name}${suffix} ---\n${r.body}\n`;
    const room = ARCHIVE_TEXT_BUDGET - total;
    if (block.length > room) {
      parts.push(block.slice(0, room) + `\n[…truncated at ${ARCHIVE_TEXT_BUDGET} chars…]`);
      total = ARCHIVE_TEXT_BUDGET;
      budgetHit = true;
    } else {
      parts.push(block);
      total += block.length;
    }
    parsed.push(m.name + suffix);
  }

  const footer: string[] = [];
  footer.push(`--- archive coverage --- ${flat.length} member(s) flattened, ${parsed.length} parsed for text`);
  if (corrupt.length) footer.push(`CORRUPT (checksum failed, skipped): ${corrupt.join(", ")}`);
  if (notExpanded.length) footer.push(`NOT EXPANDED: ${notExpanded.join("; ")}`);
  if (truncated.length) footer.push(`TRUNCATED: ${truncated.join("; ")}`);
  if (budgetHit) footer.push(`joined text hit the ${ARCHIVE_TEXT_BUDGET} character budget — later members are listed but their content is not included`);
  if (skipped.length) footer.push(`no text content: ${skipped.slice(0, 200).join("; ")}${skipped.length > 200 ? ` (+${skipped.length - 200} more)` : ""}`);

  return [...parts, footer.join("\n")].join("\n").trim();
}

/** Extract a 7z/bz2/xz archive with the bundled 7za binary. */
async function extractWith7za(buf: Buffer, ext: string): Promise<{ name: string; data: Buffer }[]> {
  const seven: any = await import("7zip-bin");
  const exe: string = seven.path7za ?? seven.default?.path7za;
  if (!exe || !fs.existsSync(exe)) throw new Error("Bundled 7za binary is missing — run `npm install`");
  const src = tmpName(ext);
  const dir = tmpName("");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(src, buf);
    // 7za prints one progress line per member — a 66k-member archive floods
    // the default 1 MiB stdout buffer, so give it real headroom.
    await execFileP(exe, ["x", "-y", `-o${dir}`, src], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const members: { name: string; data: Buffer }[] = [];
    const walk = (d: string, rel: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        const r = rel ? rel + "/" + ent.name : ent.name;
        if (ent.isDirectory()) walk(p, r);
        else if (ent.isFile()) members.push({ name: r, data: fs.readFileSync(p) });
      }
    };
    walk(dir, "");
    return members;
  } finally {
    try { fs.rmSync(src, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Extract a .rar with the bundled unrar WASM. */
async function extractRar(buf: Buffer): Promise<{ name: string; data: Buffer }[]> {
  // The WASM bindings' generated typings lag the runtime shape, so the
  // extractor is handled loosely.
  const mod: any = await import("node-unrar-js");
  const extractor = await mod.createExtractorFromData({ data: new Uint8Array(buf) });
  const members: { name: string; data: Buffer }[] = [];
  const list = extractor.getFileList();
  for (const f of list.fileHeaders as any[]) {
    if (f.directory) continue;
    const extracted = extractor.extract({ files: [f.fileName] });
    for (const file of extracted.files as any[]) {
      if (file.extraction?.data) {
        members.push({ name: file.fileName, data: Buffer.from(file.extraction.data) });
      }
    }
  }
  return members;
}

/**
 * A bare .bz2/.xz stream carries no filenames at all, so 7za hands back a member
 * named after the archive. The real inner name lives in the uploaded file name
 * (data.csv.bz2 → data.csv), which is what the members need to be called for
 * their type to be recognised.
 */
function nameBareStream(members: Member[], originalName: string, ext: string): Member[] {
  if (members.length !== 1 || fileExtension(members[0].name)) return members;
  const inner = originalName.replace(new RegExp(`\\.${ext}$`, "i"), "");
  return inner && inner !== originalName ? [{ ...members[0], name: inner }] : members;
}

/**
 * ZIP member reader: native fflate (readZip) first — corrupted parts stay in
 * the set FLAGGED so coverage reports them — and only containers fflate
 * refuses outright (password-protected, LZMA) fall back to the bundled 7za.
 * Genuine Zip64 archives do NOT need the fallback: fflate reads them in full
 * (verified on 0.8.3 against a 66,001-member 7za-built archive). Nested zips
 * inside another archive stay on the sync native path — readZip is sync by
 * contract.
 */
async function zipMembers(buf: Buffer): Promise<Member[]> {
  try {
    return readZip(buf);
  } catch {
    try {
      return await extractWith7za(buf, ".zip");
    } catch {
      throw new Error(
        "Unreadable ZIP archive (it may be password-protected, or use a compression method that 7za cannot open without a password)",
      );
    }
  }
}

/**
 * Extract readable text from any supported archive format.
 * zip/tar/gz/tgz are parsed natively (zip falls back to 7za when fflate
 * refuses); bz2/xz/7z go through 7za; rar through unrar WASM.
 */
export async function archiveText(buf: Buffer, ext: string, originalName = ""): Promise<string> {
  switch (ext) {
    case "zip":
      return membersToText(await zipMembers(buf));
    case "tar":
      return membersToText(tarMembers(buf));
    case "gz": {
      const raw = zlib.gunzipSync(buf);
      if (looksLikeTar(raw)) return membersToText(tarMembers(raw));
      const dec = decodeText(raw.subarray(0, ARCHIVE_TEXT_BUDGET));
      const label = dec.lossy ? `[decoded as ${dec.encoding} — not valid UTF-8] ` : "";
      const trunc = raw.length > ARCHIVE_TEXT_BUDGET ? `\n[…single-stream gzip: ${raw.length} bytes decoded to ${ARCHIVE_TEXT_BUDGET} chars…]` : "";
      return label + dec.text + trunc;
    }
    case "tgz":
      return membersToText(tarMembers(zlib.gunzipSync(buf)));
    case "bz2":
    case "xz": {
      // Whatever 7za hands back — a lone file, a tar, a directory tree — gets a
      // sensible name, is flattened, and then its members are parsed by type.
      const members = await extractWith7za(buf, "." + ext);
      return membersToText(nameBareStream(members, originalName, ext));
    }
    case "7z":
      return membersToText(await extractWith7za(buf, ".7z"));
    case "rar":
      return membersToText(await extractRar(buf));
    default:
      throw new Error("Unsupported archive format: " + ext);
  }
}
