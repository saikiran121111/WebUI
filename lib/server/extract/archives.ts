import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readZip } from "./zip";
import { classifyFile, fileExtension } from "../../files/extensions";

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

type Member = { name: string; data: Buffer };

/**
 * Archives nest: a .7z holding a .tar, a .zip holding a .gz. Those wrappers
 * have to be expanded, or a member named inner.tar is classified as an archive
 * and skipped for carrying no text of its own.
 */
function flattenMembers(members: Member[], depth = 0): Member[] {
  if (depth > 2) return members;
  const out: Member[] = [];
  for (const m of members) {
    const ext = fileExtension(m.name);
    try {
      if (ext === "tar") {
        out.push(...flattenMembers(tarMembers(m.data), depth + 1));
        continue;
      }
      if (ext === "gz" || ext === "tgz") {
        const raw = zlib.gunzipSync(m.data);
        const inner = looksLikeTar(raw)
          ? tarMembers(raw)
          : [{ name: m.name.replace(/\.(gz|tgz)$/i, ""), data: raw }];
        out.push(...flattenMembers(inner, depth + 1));
        continue;
      }
      if (ext === "zip") {
        out.push(...flattenMembers(readZip(m.data), depth + 1));
        continue;
      }
    } catch { /* not really a nested archive — keep the bytes as they are */ }
    out.push(m);
  }
  return out;
}

/** Join the text-like members of an archive into one readable string. */
function membersToText(members: Member[], cap = 60000): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of flattenMembers(members)) {
    const cat = classifyFile(m.name);
    if (cat !== "text" && cat !== "notebook" && cat !== "rtf") continue;
    if (m.data.length > 1024 * 1024) continue;
    const body = m.data.toString("utf8");
    const block = `--- member: ${m.name} ---\n${body}\n`;
    parts.push(block.slice(0, Math.max(0, cap - total)));
    total += block.length;
    if (total >= cap) break;
  }
  return parts.join("\n").trim();
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
    await execFileP(exe, ["x", "-y", `-o${dir}`, src], { timeout: 60000 });
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
 * Extract readable text from any supported archive format.
 * zip/tar/gz/tgz are parsed natively; bz2/xz/7z go through 7za; rar through unrar WASM.
 */
export async function archiveText(buf: Buffer, ext: string, originalName = ""): Promise<string> {
  switch (ext) {
    case "zip":
      return membersToText(readZip(buf));
    case "tar":
      return membersToText(tarMembers(buf));
    case "gz": {
      const raw = zlib.gunzipSync(buf);
      if (looksLikeTar(raw)) return membersToText(tarMembers(raw));
      return raw.toString("utf8").slice(0, 60000);
    }
    case "tgz":
      return membersToText(tarMembers(zlib.gunzipSync(buf)));
    case "bz2":
    case "xz": {
      // Whatever 7za hands back — a lone file, a tar, a directory tree — gets a
      // sensible name, is flattened, and then its text members are joined.
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
