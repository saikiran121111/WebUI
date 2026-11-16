import fs from "node:fs";
import path from "node:path";
import {
  PublishError,
  discardStaged,
  durableWrite,
  publishIndex,
  recoverIndexDir,
} from "./publish";
import type { PublishPaths } from "./publish";
import type { IndexChunk, IndexMeta, LoadedIndex } from "./types";
import { assessVectors } from "./vectors";

/**
 * On-disk layout per indexed attachment (gitignored, like the model cache):
 *   .data/attach-index/<attId>/full.txt        complete text — nothing lost
 *                              /chunks.jsonl   one IndexChunk per line
 *                              /meta.json      IndexMeta (spine, frames, …)
 *                              /frames/        scene-change keyframes
 *                              /notes.json     lazy course notes (on demand)
 */
const ROOT = path.join(process.cwd(), ".data", "attach-index");
/** Staging + journals live OUTSIDE every attachment dir, so a reader can never
 *  observe a half-written generation (F09, see publish.ts). */
const GEN_ROOT = path.join(ROOT, ".gen");
const TX_ROOT = path.join(ROOT, ".tx");
/** Client-generated ids (lib/files/docProcessor.ts) — never trust them raw. */
const ATT_RE = /^att_[a-z0-9]{4,32}$/;

/** Staging/journal locations for one attachment (never inside its own index dir). */
export function publishPaths(attId: string): PublishPaths {
  return { attDir: indexDir(attId), genRoot: GEN_ROOT, txRoot: TX_ROOT };
}

export function indexDir(attId: string): string {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  return path.join(ROOT, attId);
}

export function framesDir(attId: string): string {
  return path.join(indexDir(attId), "frames");
}

export function hasIndex(attId: string): boolean {
  try {
    const dir = indexDir(attId);
    if (fs.existsSync(path.join(dir, "meta.json"))) return true;
    // A publish that died between the aside rename and the switch leaves no
    // meta.json; recovering puts the previous generation back under its name.
    return recoverIndexDir(publishPaths(attId), attId)
      && fs.existsSync(path.join(dir, "meta.json"));
  } catch {
    return false;
  }
}

function atomicWrite(file: string, data: string): void {
  durableWrite(file, data);
}

export function writeIndex(
  attId: string,
  meta: IndexMeta,
  chunks: IndexChunk[],
  fullText: string,
  signal?: AbortSignal,
): void {
  const paths = publishPaths(attId);
  try {
    publishIndex({
      attId,
      meta: meta as unknown as Record<string, unknown>,
      chunks,
      fullText,
      frames: meta.frames ?? [],
      paths,
      signal,
    });
  } catch (err) {
    // A missing keyframe is a build-input error (the extractor failed), not a
    // torn store — the previously published generation is still intact.
    if (err instanceof PublishError) throw new Error(String(err.message));
    throw err;
  }
  // Stale keyframes from a previous build are cleared unless THIS build lists
  // frames (I26): meta.json would no longer reference them, and orphan JPEGs of
  // an old version of the file just eat disk. The OLD generation's frames died
  // with its directory rename; this sweep only removes debris the extractor
  // left behind in an attachment dir that never published.
  if (!meta.frames?.length) {
    try { fs.rmSync(path.join(indexDir(attId), "frames"), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  cacheDelete(attId);
  // I20: a rebuilt index has new chunk ids — the old shown ledger is moot.
  shownDelete(attId);
}

/* --------------------------------------------------------------------------
 * Per-index write ownership (F09)
 *
 * The publish itself is atomic, but two CONCURRENT builds of the same
 * attachment (a retried upload while the first is still embedding) each move
 * the shared keyframe files and each rename the live dir aside. Serialized
 * per attachment id, the second build publishes against the first's output
 * instead of racing it. The map entry is dropped as soon as it drains, so it
 * never grows with the number of chat sessions.
 * ------------------------------------------------------------------------ */
const indexLocks = new Map<string, Promise<void>>();

export async function withIndexWriteLock<T>(attId: string, fn: () => Promise<T>): Promise<T> {
  if (!ATT_RE.test(attId)) throw new Error(`invalid attachment id: ${attId}`);
  const prev = indexLocks.get(attId);
  const run = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  indexLocks.set(attId, tail);
  try {
    return await run;
  } finally {
    if (indexLocks.get(attId) === tail) indexLocks.delete(attId);
  }
}

/** Test/diagnostic view: is a build currently publishing this attachment? */
export function indexWriteInFlight(attId: string): boolean {
  return indexLocks.has(attId);
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
    if (!fs.existsSync(metaPath) && !recoverIndexDir(publishPaths(attId), attId)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as IndexMeta;
    const chunks: IndexChunk[] = fs
      .readFileSync(path.join(dir, "chunks.jsonl"), "utf8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as IndexChunk);
    const loaded: LoadedIndex = { meta, chunks, vectors: assessVectors(meta, chunks) };
    cache.set(attId, loaded);
    while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value as string);
    return loaded;
  } catch {
    return null;
  }
}


export function removeIndex(attId: string): void {
  try {
    if (!ATT_RE.test(attId)) return;
    cacheDelete(attId);
    removeUpload(attId);
    shownDelete(attId); // I20
    discardStaged(publishPaths(attId), attId); // staged attempts die with the index
    try {
      fs.rmSync(indexDir(attId), { recursive: true, force: true });
      for (const stale of fs.readdirSync(ROOT).filter(n => n.startsWith(`${attId}.stale-`))) {
        fs.rmSync(path.join(ROOT, stale), { recursive: true, force: true });
      }
    } catch {
      // GC paths must never throw — a bad id just means nothing to clean.
    }
  } catch {
    /* nothing to clean */
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
 *
 * F07 v2 (2026-11-15): the ledger was keyed by attachment ALONE, so one
 * chat's shown list demoted evidence in a DIFFERENT chat, and an unanswered
 * REPEAT of a question lost its own answer (its top passages had been shown
 * once, so they were demoted from then on). Keys are now conversation-scoped
 * ("attId|conversationId", bare attId when no conversation is known) and
 * values are { q, ids } where q is fingerprintQuery() of the query that
 * produced those ids -- identity, not meaning. v1 values (bare number arrays)
 * are still readable.
 * ---------------------------------------------------------------------- */
const SHOWN_FILE = path.join(ROOT, ".shown.json");

/**
 * F07 (session 31): the ledger is ONE root aggregate that every turn rewrites,
 * so a plain read-modify-write silently loses keys another writer added during
 * the same window -- a rebuild's delete could be resurrected, or another
 * attachment's shown list dropped. Writers now take a cross-process mutex and
 * re-read the file INSIDE it, so each mutation rebases on the latest map.
 *
 * The lock is a directory: creating an existing directory fails atomically on
 * every platform, so it works across processes without O_EXCL subtleties. The
 * holder writes an owner token inside it and only the owner releases. A lock
 * older than STALE_MS is provably abandoned -- every critical section here is a
 * couple of synchronous fs calls -- so it is broken instead of wedging a turn.
 *
 * Readers stay lock-free: durableWrite() is temp-file + rename, so a reader
 * observes the whole old map or the whole new map, never a mixture.
 */
const SHOWN_LOCK = `${SHOWN_FILE}.lock`;
const SHOWN_LOCK_WAIT_MS = 500;
/** Far longer than any real critical section, so an old lock = a dead holder. */
const SHOWN_LOCK_STALE_MS = 2000;

interface ShownLock {
  readonly token: string;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* bounded spin if Atomics.wait is unavailable */
    }
  }
}

function shownLockOwnerFile(): string {
  return path.join(SHOWN_LOCK, "owner");
}

function acquireShownLock(): ShownLock | null {
  const token = `${process.pid.toString(16)}-${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + SHOWN_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      fs.mkdirSync(SHOWN_LOCK);
      try {
        fs.writeFileSync(shownLockOwnerFile(), token, "utf8");
      } catch {
        /* owner proof is best effort; release still checks it */
      }
      return { token };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") return null;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(SHOWN_LOCK).mtimeMs;
      } catch {
        continue; // the lock vanished between attempts -- retry the create
      }
      if (Date.now() - mtimeMs > SHOWN_LOCK_STALE_MS) {
        try {
          fs.rmSync(SHOWN_LOCK, { recursive: true, force: true });
        } catch {
          return null;
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(5);
    }
  }
}

function releaseShownLock(lock: ShownLock): void {
  try {
    let owner = "";
    try {
      owner = fs.readFileSync(shownLockOwnerFile(), "utf8").trim();
    } catch {
      owner = "";
    }
    if (owner && owner !== lock.token) return; // someone else broke and re-took it
    fs.rmSync(SHOWN_LOCK, { recursive: true, force: true });
  } catch {
    /* best effort: the stale-break rule cleans up after a crash */
  }
}

/** Serialized read-modify-write; `mutate` returns false to skip the write. */
function withShownLock(mutate: (map: Record<string, unknown>) => boolean): void {
  const lock = acquireShownLock();
  if (lock) {
    try {
      const map = readShownMap();
      if (mutate(map)) atomicWrite(SHOWN_FILE, JSON.stringify(map));
    } finally {
      releaseShownLock(lock);
    }
    return;
  }
  // Contended or wedged: rebasing without the mutex is strictly better than
  // dropping the update, and the ledger is only an optimization -- never throw.
  const map = readShownMap();
  if (mutate(map)) atomicWrite(SHOWN_FILE, JSON.stringify(map));
}

/** F07: what a shown entry belongs to (conversation + the query that served it). */
export interface ShownScope {
  conversationId?: string;
  queryFp?: string;
}

interface ShownEntry {
  /** fingerprintQuery() of the query that produced `ids`; "" for v1 entries. */
  q: string;
  ids: number[];
}

/**
 * F07: the ledger is scoped to conversation + attachment. With no conversation
 * the bare attachment key is used, which keeps single-shot callers and v1 data
 * working.
 */
export function shownKey(attId: string, conversationId?: string): string {
  const c = (conversationId ?? "").trim();
  return c ? `${attId}|${c}` : attId;
}

function shownEntry(v: unknown): ShownEntry | null {
  if (Array.isArray(v)) return { q: "", ids: v.filter(n => Number.isInteger(n)) };
  if (v && typeof v === "object") {
    const o = v as { q?: unknown; ids?: unknown };
    const ids = Array.isArray(o.ids) ? o.ids.filter(n => Number.isInteger(n)) : [];
    return { q: typeof o.q === "string" ? o.q : "", ids };
  }
  return null;
}

function readShownMap(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWN_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * F07: the entry for this attachment + conversation. A conversation-qualified
 * read also falls back to the legacy bare key, so an upgrade does not lose the
 * ledger it already had.
 */
export function readShownEntry(attId: string, conversationId?: string): ShownEntry | null {
  try {
    if (!ATT_RE.test(attId)) return null;
    const map = readShownMap();
    const key = shownKey(attId, conversationId);
    const entry = shownEntry(map[key]);
    if (entry) return entry;
    return key === attId ? null : shownEntry(map[attId]);
  } catch {
    return null;
  }
}

/** v1-compatible read: ids already shown for this attachment + conversation. */
export function readShown(attId: string, conversationId?: string): number[] {
  return readShownEntry(attId, conversationId)?.ids ?? [];
}

/** Read-modify-write: one attachment's turn never clobbers another's. */
export function writeShown(attId: string, ids: number[], scope: ShownScope = {}): void {
  try {
    if (!ATT_RE.test(attId)) return;
    const key = shownKey(attId, scope.conversationId);
    const value = { q: scope.queryFp ?? "", ids: ids.filter(n => Number.isInteger(n)) };
    withShownLock((map) => {
      map[key] = value;
      return true;
    });
  } catch {
    // Ledger is an optimization: losing it must never break a turn.
  }
}

function shownDelete(attId: string): void {
  try {
    // F07: a rebuilt index invalidates EVERY conversation-scoped key for it.
    const prefix = `${attId}|`;
    withShownLock((map) => {
      const hit = attId in map || Object.keys(map).some(k => k.startsWith(prefix));
      if (!hit) return false;
      delete map[attId];
      for (const k of Object.keys(map)) {
        if (k.startsWith(prefix)) delete map[k];
      }
      return true;
    });
  } catch {
    // GC path never throws.
  }
}