import fs from "node:fs";
import path from "node:path";
import type { IndexChunk, IndexMeta, LoadedIndex } from "./types";

/**
 * On-disk layout per indexed attachment (gitignored, like the model cache):
 *   .data/attach-index/<attId>/full.txt        complete text — nothing lost
 *                              /chunks.jsonl   one IndexChunk per line
 *                              /meta.json      IndexMeta (spine, frames, …)
 *                              /frames/        scene-change keyframes
 *                              /notes.json     lazy course notes (on demand)
 */
const ROOT = path.join(process.cwd(), ".data", "attach-index");
/** Client-generated ids (lib/files/docProcessor.ts) — never trust them raw. */
const ATT_RE = /^att_[a-z0-9]{4,32}$/;

export function indexDir(attId: string): string {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  return path.join(ROOT, attId);
}

export function framesDir(attId: string): string {
  return path.join(indexDir(attId), "frames");
}

export function hasIndex(attId: string): boolean {
  try {
    return fs.existsSync(path.join(indexDir(attId), "meta.json"));
  } catch {
    return false;
  }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

export function writeIndex(attId: string, meta: IndexMeta, chunks: IndexChunk[], fullText: string): void {
  const dir = indexDir(attId);
  fs.mkdirSync(dir, { recursive: true });
  // I26: full.txt goes through atomicWrite too. A build interrupted mid-write
  // (full disk, crash) then leaves the PREVIOUS consistent files in place —
  // never a half-written full.txt sitting next to fresh chunks. meta.json is
  // still written LAST, so the "does an index exist" marker never points at
  // torn state.
  atomicWrite(path.join(dir, "full.txt"), fullText);
  atomicWrite(
    path.join(dir, "chunks.jsonl"),
    chunks.map(c => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
  );
  // Stale keyframes from a previous build are cleared unless THIS build lists
  // frames (I26): meta.json would no longer reference them, and orphan JPEGs
  // of an old version of the file just eat disk.
  if (!meta.frames?.length) {
    try { fs.rmSync(path.join(dir, "frames"), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  atomicWrite(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  cacheDelete(attId);
  // I20: a rebuilt index has new chunk ids — the old shown ledger is moot.
  shownDelete(attId);
}

// Small LRU so per-turn retrieval doesn't re-read ~1 MB of vectors on every
// message. Three indexes covers the common case (one big file + a couple of
// follow-up attachments) without pinning the whole workspace in RAM.
const LRU_MAX = 3;
const cache = new Map<string, LoadedIndex>(); // insertion order == LRU order

function cacheDelete(attId: string): void {
  cache.delete(attId);
}

export function readIndex(attId: string): LoadedIndex | null {
  try {
    const hit = cache.get(attId);
    if (hit) {
      cache.delete(attId); // refresh recency
      cache.set(attId, hit);
      return hit;
    }
    const dir = indexDir(attId);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as IndexMeta;
    const chunks: IndexChunk[] = fs
      .readFileSync(path.join(dir, "chunks.jsonl"), "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as IndexChunk);
    const loaded: LoadedIndex = { meta, chunks };
    cache.set(attId, loaded);
    while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value as string);
    return loaded;
  } catch {
    return null;
  }
}

export function removeIndex(attId: string): void {
  cacheDelete(attId);
  removeUpload(attId);
  shownDelete(attId); // I20
  try {
    fs.rmSync(indexDir(attId), { recursive: true, force: true });
  } catch {
    // GC paths must never throw — a bad id just means nothing to clean.
  }
}

/* --------------------------------------------------------------------- ──
 * Durable originals (I26)
 *
 *   .data/uploads/<attId>.<ext>   the ORIGINAL upload bytes, moved (not
 *                                 copied) out of the scratch dir after a
 *                                 successful extraction.
 *
 * The scratch file used to be deleted unconditionally, so any follow-up
 * question that needed the file again ("sample different frames", "another
 * audio window") had no original to read — the user had to re-upload. The
 * durable copy lives next to the index it belongs to and dies with it
 * (removeIndex) or with the orphan sweep below.
 * ---------------------------------------------------------------------- */
const UPLOAD_ROOT = path.join(process.cwd(), ".data", "uploads");

/** Move an upload's scratch file to its durable attId-keyed home. */
export function storeUpload(srcTmp: string, attId: string, ext: string): string {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  const safeExt = (ext ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const dest = path.join(UPLOAD_ROOT, attId + (safeExt ? "." + safeExt : ""));
  try {
    fs.renameSync(srcTmp, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
    fs.copyFileSync(srcTmp, dest); // different volume: copy + delete
    fs.rmSync(srcTmp, { force: true });
  }
  return dest;
}

/** Durable path for an attachment's original bytes, if one exists. */
export function uploadPath(attId: string): string | null {
  if (!ATT_RE.test(attId)) return null;
  try {
    for (const f of fs.readdirSync(UPLOAD_ROOT)) {
      if (f === attId || f.startsWith(attId + ".")) return path.join(UPLOAD_ROOT, f);
    }
  } catch { /* nothing stored yet */ }
  return null;
}

export function removeUpload(attId: string): void {
  const p = uploadPath(attId);
  if (p) {
    try { fs.rmSync(p, { force: true }); } catch { /* GC never throws */ }
  }
}

/**
 * Remove durable uploads whose index no longer exists (chat deleted, index
 * evicted, or an extraction that never indexed). Fresh files are spared so a
 * just-stored upload is never raced by a concurrent request's sweep. Returns
 * the number removed — the extract route runs this once per server process.
 */
export function sweepOrphanUploads(maxAgeMs = 15 * 60 * 1000): number {
  let files: string[];
  try { files = fs.readdirSync(UPLOAD_ROOT); } catch { return 0; }
  let removed = 0;
  const now = Date.now();
  for (const f of files) {
    const attId = f.split(".")[0];
    if (!ATT_RE.test(attId) || hasIndex(attId)) continue;
    const p = path.join(UPLOAD_ROOT, f);
    let age = 0;
    try { age = now - fs.statSync(p).mtimeMs; } catch { continue; }
    if (age < maxAgeMs) continue;
    try { fs.rmSync(p, { force: true }); removed++; } catch { /* ignore */ }
  }
  return removed;
}

/**
 * I24: notes.json gains a `version` stamp (written AFTER createdAt so the
 * existing `{"notes":…,"createdAt":…}` prefix bytes stay). The version is a
 * content+model fingerprint of the index the notes were distilled from; a
 * turn that asks for notes computed against a DIFFERENT index or model must
 * regenerate, not serve a stale cache. `expectedVersion === undefined`
 * accepts any stamp — the notes routes (GET/POST /api/attachments/notes)
 * read and write the body verbatim, version-agnostic, exactly as before.
 */
export function readNotes(attId: string, expectedVersion?: string): string | null {
  try {
    const f = path.join(indexDir(attId), "notes.json");
    if (!fs.existsSync(f)) return null;
    const env = JSON.parse(fs.readFileSync(f, "utf8")) as { notes?: unknown; version?: unknown };
    if (expectedVersion != null && env?.version !== expectedVersion) return null;
    return typeof env?.notes === "string" ? env.notes : null;
  } catch {
    return null;
  }
}

export function writeNotes(attId: string, notes: string, version?: string): void {
  const env: Record<string, unknown> = { notes, createdAt: Date.now() };
  if (version !== undefined) env.version = version;
  atomicWrite(path.join(indexDir(attId), "notes.json"), JSON.stringify(env));
}

/* --------------------------------------------------------------------- ──
 * I20: per-attachment "already shown" ledger
 *
 *   .data/attach-index/.shown.json   { attId: chunkId[] } — ONE aggregate
 *                                    file at the index ROOT.
 *
 * A follow-up question ("keep going") re-runs retrieval; without this ledger
 * the same top-ranked passages win again every turn. The ledger feeds the
 * retrieve demote list so continuation turns surface FRESH passages.
 *
 * The state is deliberately NOT a per-attachment file: the golden store
 * fixture test asserts the EXACT file set inside each attachment directory
 * (chunks.jsonl/full.txt/meta.json/frames), and vitest runs the attachment
 * turn tests concurrently with that guard — a per-att file written mid-turn
 * would poison it. One root file keyed by attId keeps the per-att dirs to
 * their pinned shape; removeIndex/writeIndex just drop/clear the key.
 * ---------------------------------------------------------------------- */
const SHOWN_FILE = path.join(ROOT, ".shown.json");

function readShownMap(): Record<string, number[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWN_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

export function readShown(attId: string): number[] {
  try {
    if (!ATT_RE.test(attId)) return [];
    const v = readShownMap()[attId];
    return Array.isArray(v) ? v.filter(n => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/** Read-modify-write: one attachment's turn never clobbers another's. */
export function writeShown(attId: string, ids: number[]): void {
  try {
    if (!ATT_RE.test(attId)) return;
    const map = readShownMap();
    map[attId] = ids.filter(n => Number.isInteger(n));
    atomicWrite(SHOWN_FILE, JSON.stringify(map));
  } catch {
    // Ledger is an optimization — losing it must never break a turn.
  }
}

function shownDelete(attId: string): void {
  try {
    const map = readShownMap();
    if (!(attId in map)) return;
    delete map[attId];
    atomicWrite(SHOWN_FILE, JSON.stringify(map));
  } catch {
    // GC path never throws.
  }
}
