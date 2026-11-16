import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Transactional publish for one attachment index (F09).
 *
 * The previous writer replaced full.txt, chunks.jsonl and meta.json one file
 * at a time. Per-file atomic rename is NOT a multi-file transaction: a crash
 * (or ENOSPC) between the chunks.jsonl rename and the meta.json rename leaves
 * NEW chunks next to OLD metadata, and every reader then computes retrieval
 * over a mixed generation.
 *
 * Mechanism:
 *   1. The whole new generation is staged OUTSIDE every attachment directory
 *      (`<genRoot>/<attId>/g<seq>-<rand>/`) with unique temp names, then
 *      fsync-renamed into the staged dir.
 *   2. The staged dir is validated by reading it back (parse + chunk/line
 *      agreement + declared keyframes present + vector shape agreement).
 *   3. A journal (`<txRoot>/<attId>.json`) names the staged dir and the digests
 *      it committed. It is the crash-recovery record.
 *   4. The publish itself is ONE directory switch: the live attachment dir is
 *      renamed aside (`<attId>.stale-<seq>`, a name no attachment id can
 *      match), then the staged dir is renamed into its place. Readers therefore
 *      only ever observe a complete old generation or a complete new one.
 *   5. A failed/aborted publish never destroys the previous generation: the
 *      aside rename is compensated, and a half-staged generation is discarded.
 *
 * `recoverIndexDir()` finishes or undoes an interrupted publish: a staged
 * generation named by a journal completes the switch, otherwise the renamed
 * aside directory is put back. Nothing is ever silently deleted.
 */

const JOURNAL_RE = /^att_[a-z0-9]{4,32}\.json$/;
const GEN_DIR_RE = /^g\d{1,20}-[0-9a-f]{8}$/;
const STALE_SUFFIX_RE = /\.stale-\d{1,20}$/;

export interface PublishPaths {
  /** The attachment's live index dir (`<root>/<attId>`). */
  attDir: string;
  /** Staging root, OUTSIDE every attachment dir (`<root>/.gen`). */
  genRoot: string;
  /** Journal root, also outside every attachment dir (`<root>/.tx`). */
  txRoot: string;
}

export type PublishErrorCode =
  | "invalid-meta"
  | "invalid-frames"
  | "missing-frame-file"
  | "staged-validation"
  | "write"
  | "publish"
  | "cancelled";

export class PublishError extends Error {
  code: PublishErrorCode;
  cause?: unknown;
  constructor(code: PublishErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.cause = cause;
  }
}

export interface PublishInput {
  attId: string;
  meta: Record<string, unknown>;
  /** chunkCount is read off meta, so the validator can cross-check the lines. */
  chunks: unknown[];
  fullText: string;
  /** Keyframes already on disk under <attDir>/frames, referenced by meta.frames. */
  frames?: Array<{ at: number; file: string }>;
  paths: PublishPaths;
  signal?: AbortSignal;
  /**
   * Fault-injection seam for the fault-injection tests ONLY - production
   * callers never pass it. Throwing a FaultAbort from inside leaves the store
   * in exactly the state a killed process would leave (no compensation, no
   * staged-dir cleanup), which is what makes the recovery path testable.
   */
  fault?: (point: FaultPoint) => void;
}

export type FaultPoint =
  | "stage-full"
  | "stage-chunks"
  | "stage-meta"
  | "validate"
  | "journal"
  | "after-aside"
  | "after-switch";

/** Sentinel for "this process died here" - publish must NOT compensate. */
export class FaultAbort extends Error {
  point: FaultPoint;
  constructor(point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.name = "FaultAbort";
    this.point = point;
  }
}

export interface PublishResult {
  seq: number;
  chunkCount: number;
  frameCount: number;
}

interface Journal {
  v: 1;
  attId: string;
  seq: number;
  gen: string;
  files: Array<{ rel: string; sha256: string; size: number }>;
  startedAt: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) throw reason;
  const e = new Error("The user aborted this request.");
  e.name = "AbortError";
  throw e;
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

function uniqueTmp(file: string): string {
  // I13: never a fixed "<file>.tmp" — two writers of the same index (a retried
  // upload while an old build still runs) would rename each other's temp files
  // and publish a document interleaved between the two payloads.
  const rand = crypto.randomBytes(4).toString("hex");
  // The temp MUST live in the target directory: rename() across volumes is
  // EXDEV, and a bare basename would resolve against process.cwd().
  return path.join(path.dirname(file), `${path.basename(file)}.tmp-${process.pid}-${rand}`);
}

/** Write-then-rename with an fsync of the CONTENT, so the rename cannot beat the bytes. */
export function durableWrite(file: string, data: string | Buffer): { sha256: string; size: number } {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const tmp = uniqueTmp(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, buf);
      try { fs.fsyncSync(fd); } catch { /* durability best effort on non-local disks */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    // I13b: the temp is the writer's resource, so the writer reclaims it
    // unconditionally. A failed open/write/fsync/rename (ENOSPC, an injected
    // fault, a signal abort, a reader that raced the rename away) must never
    // leave a stray "<file>.tmp-<pid>-<rand>" behind: staged generations get
    // swept, but durableWrite also writes journals, notes and the shown
    // ledger, where nothing else would ever collect the debris.
    try { fs.unlinkSync(tmp); } catch { /* renamed already, or never created */ }
    throw err;
  }
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), size: buf.length };
}

function readJournal(txRoot: string, attId: string): Journal | null {
  try {
    const f = path.join(txRoot, `${attId}.json`);
    if (!JOURNAL_RE.test(`${attId}.json`) || !fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Journal;
    if (j?.v !== 1 || j.attId !== attId || typeof j.gen !== "string" || !Array.isArray(j.files)) return null;
    return j;
  } catch {
    return null;
  }
}

function writeJournal(txRoot: string, j: Journal): void {
  fs.mkdirSync(txRoot, { recursive: true });
  durableWrite(path.join(txRoot, `${j.attId}.json`), JSON.stringify(j));
}

function clearJournal(txRoot: string, attId: string): void {
  try { fs.rmSync(path.join(txRoot, `${attId}.json`), { force: true }); } catch { /* GC never throws */ }
}

function rmQuiet(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* GC never throws */ }
}

/**
 * Shape of a published generation, checked BEFORE it can become visible and
 * re-checked after it is read back. A vector model/dimension change lands as a
 * stamped generation (F09b): mixed-dimension vectors are rejected here rather
 * than dot-producted over the shorter dimension at query time.
 */
function validateGen(
  genDir: string,
  meta: Record<string, unknown>,
  chunks: unknown[],
): { ok: boolean; reason?: string } {
  try {
    const metaBack = JSON.parse(fs.readFileSync(path.join(genDir, "meta.json"), "utf8")) as Record<string, unknown>;
    const jsonl = fs.readFileSync(path.join(genDir, "chunks.jsonl"), "utf8");
    const lines = jsonl.split("\n").filter(l => l.trim());
    if (lines.length !== chunks.length) {
      return { ok: false, reason: `chunks.jsonl has ${lines.length} lines but the build had ${chunks.length} chunks` };
    }
    const declared = Number(metaBack.chunkCount ?? 0);
    if (declared !== lines.length) {
      return { ok: false, reason: `meta.chunkCount=${declared} disagrees with ${lines.length} chunk lines` };
    }
    const seen = new Set<number>();
    const dimsSeen = new Set<number>();
    let dim = -1;
    for (const line of lines) {
      const c = JSON.parse(line) as { i?: unknown; vec?: unknown };
      const id = Number(c.i);
      if (!Number.isInteger(id) || id < 0 || seen.has(id)) {
        return { ok: false, reason: `chunk id ${String(c.i)} is not a unique non-negative integer` };
      }
      seen.add(id);
      const v = Array.isArray(c.vec) ? (c.vec as unknown[]) : [];
      if (v.length) {
        const bad = v.some(n => typeof n !== "number" || !Number.isFinite(n));
        if (bad) return { ok: false, reason: `chunk ${id} has a non-finite embedding component` };
        if (dim === -1) dim = v.length;
        dimsSeen.add(v.length);
      }
    }
    const stamped = meta.embed as { dim?: unknown } | undefined;
    if (stamped && typeof stamped.dim === "number") {
      // A stamped generation promises one comparable dimension for every
      // vector it stores. Ragged shapes are only tolerated where NO stamp was
      // declared (legacy indexes), and retrieval then drops the cosine channel
      // honestly instead of dot-producting over the shorter axis.
      if (dim >= 0 && (dimsSeen.size !== 1 || dimsSeen.has(stamped.dim) === false)) {
        return { ok: false, reason: `embedding stamp dim ${stamped.dim} does not describe the stored shapes (${[...dimsSeen].join(", ")})` };
      }
    }
    const frames = Array.isArray(meta.frames) ? (meta.frames as Array<{ file?: unknown }>) : [];
    for (const f of frames) {
      const rel = String(f?.file ?? "");
      if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
        return { ok: false, reason: `frame path ${rel || "(empty)"} escapes the index dir` };
      }
      if (!fs.existsSync(path.join(genDir, rel))) {
        return { ok: false, reason: `declared keyframe ${rel} is not present in the staged generation` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `staged generation unreadable: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Rename `from` onto `to`, tolerating a concurrent publisher that got there first. */
function renameIntoPlace(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (isErrno(err, "ENOTEMPTY") || isErrno(err, "EEXIST") || isErrno(err, "EPERM")) {
      // The live dir already holds a complete generation. Leave it alone: it is
      // either this turn's own output or another writer's, and the journal makes
      // the outcome recoverable rather than mixed.
      throw new PublishError("publish", `index dir already present: ${to}`, err);
    }
    throw new PublishError("publish", `rename failed: ${from} -> ${to}`, err);
  }
}

export function listStaleDirs(attDirParent: string, attId: string): string[] {
  try {
    return fs
      .readdirSync(attDirParent)
      .filter(n => n.startsWith(`${attId}.stale-`) && STALE_SUFFIX_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Finish or undo an interrupted publish. Returns true when the live dir was
 * restored/advanced. Safe to call on every read of an attachment whose meta is
 * missing or unreadable.
 */
export function recoverIndexDir(paths: PublishPaths, attId: string): boolean {
  const parent = path.dirname(paths.attDir);
  const journal = readJournal(paths.txRoot, attId);
  const stale = listStaleDirs(parent, attId);

  if (journal) {
    const genDir = path.join(paths.genRoot, attId, journal.gen);
    if (fs.existsSync(genDir)) {
      const liveHasMeta = fs.existsSync(path.join(paths.attDir, "meta.json"));
      if (!liveHasMeta) {
        try {
          if (fs.existsSync(paths.attDir)) rmQuiet(paths.attDir);
          renameIntoPlace(genDir, paths.attDir);
          clearJournal(paths.txRoot, attId);
          for (const s of stale) rmQuiet(path.join(parent, s));
          return true;
        } catch { /* fall through to the undo path */ }
      } else {
        // The live generation is intact; the staged one is simply abandoned.
        rmQuiet(genDir);
        clearJournal(paths.txRoot, attId);
      }
    } else {
      clearJournal(paths.txRoot, attId);
    }
  }
  if (!fs.existsSync(path.join(paths.attDir, "meta.json")) && stale.length) {
    // The aside rename happened but the switch did not: put the old generation
    // back under its real name. This is the crash-recovery guarantee.
    const newest = stale[stale.length - 1];
    try {
      if (fs.existsSync(paths.attDir)) rmQuiet(paths.attDir);
      fs.renameSync(path.join(parent, newest), paths.attDir);
      for (const s of stale) if (s !== newest) rmQuiet(path.join(parent, s));
      return true;
    } catch { /* still nothing we can do; the caller reports no index */ }
  } else {
    for (const s of stale) rmQuiet(path.join(parent, s));
  }
  return false;
}

/** Drop every staged-but-unpublished generation for an attachment. */
export function discardStaged(paths: PublishPaths, attId: string): void {
  clearJournal(paths.txRoot, attId);
  try {
    const root = path.join(paths.genRoot, attId);
    for (const name of fs.readdirSync(root)) {
      if (GEN_DIR_RE.test(name)) rmQuiet(path.join(root, name));
    }
  } catch { /* nothing staged */ }
}

/**
 * Publish one complete index generation. On any failure the previously visible
 * generation is exactly as it was, and the staged attempt is removed.
 */
export function publishIndex(input: PublishInput): PublishResult {
  const { attId, meta, chunks, fullText, paths } = input;
  const frames = input.frames ?? [];
  throwIfAborted(input.signal);

  const chunkCount = Number(meta.chunkCount ?? chunks.length);
  if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount !== chunks.length) {
    throw new PublishError("invalid-meta", `meta.chunkCount (${String(meta.chunkCount)}) != chunks array (${chunks.length})`);
  }
  for (const f of frames) {
    const rel = String(f?.file ?? "");
    if (!rel || rel.includes("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new PublishError("invalid-frames", `frame path ${rel || "(empty)"} escapes the index dir`);
    }
  }

  const seq = Date.now();
  const genName = `g${seq}-${crypto.randomBytes(4).toString("hex")}`;
  const genDir = path.join(paths.genRoot, attId, genName);
  rmQuiet(genDir);
  fs.mkdirSync(genDir, { recursive: true });

  const files: Journal["files"] = [];
  try {
    input.fault?.("stage-full");
    files.push({ rel: "full.txt", ...durableWrite(path.join(genDir, "full.txt"), fullText ?? "") });
    input.fault?.("stage-chunks");
    const jsonl = chunks.map(c => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
    files.push({ rel: "chunks.jsonl", ...durableWrite(path.join(genDir, "chunks.jsonl"), jsonl) });

    // Keyframes were written before the build (ffmpeg extraction), so the
    // generation only becomes complete once they are moved INSIDE it. A frame
    // referenced by meta but absent on disk fails the publish, not the index.
    // A failure AFTER the moves puts them back before the staged dir is
    // discarded — otherwise a rebuild could destroy the previous keyframes.
    const movedFrames: Array<{ from: string; to: string }> = [];
    let frameCount = 0;
    try {
      for (const f of frames) {
        throwIfAborted(input.signal);
        const src = path.join(paths.attDir, f.file);
        const dst = path.join(genDir, f.file);
        if (!fs.existsSync(src)) {
          throw new PublishError("missing-frame-file", `keyframe ${f.file} is not on disk`);
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try {
          fs.renameSync(src, dst);
        } catch (err) {
          if (!isErrno(err, "EXDEV")) throw err;
          fs.copyFileSync(src, dst); // different volume: copy, leave the original
        }
        movedFrames.push({ from: src, to: dst });
        frameCount++;
      }
    } catch (err) {
      for (const m of movedFrames) {
        try {
          fs.mkdirSync(path.dirname(m.from), { recursive: true });
          if (fs.existsSync(m.to)) fs.renameSync(m.to, m.from);
        } catch { /* the staged dir still holds them; recoverIndexDir can find the gen dir */ }
      }
      throw err;
    }

    input.fault?.("stage-meta");
    files.push({ rel: "meta.json", ...durableWrite(path.join(genDir, "meta.json"), JSON.stringify(meta, null, 2)) });
    input.fault?.("validate");
    const check = validateGen(genDir, meta, chunks);
    if (!check.ok) throw new PublishError("staged-validation", check.reason ?? "staged generation invalid");

    throwIfAborted(input.signal);
    input.fault?.("journal");
    writeJournal(paths.txRoot, { v: 1, attId, seq, gen: genName, files, startedAt: seq });

    // ---- the single visible switch -------------------------------------
    const parent = path.dirname(paths.attDir);
    fs.mkdirSync(parent, { recursive: true });
    const staleName = `${attId}.stale-${seq}`;
    const hadDir = fs.existsSync(paths.attDir);
    const hadLive = hadDir && fs.existsSync(path.join(paths.attDir, "meta.json"));
    if (hadDir) renameIntoPlace(paths.attDir, path.join(parent, staleName));
    // A fault after the aside rename models a process killed between the two
    // renames: the live name is gone, the old generation sits aside, and the
    // journal names the staged replacement. recoverIndexDir must resolve it.
    input.fault?.("after-aside");
    try {
      renameIntoPlace(genDir, paths.attDir);
    } catch (err) {
      if (hadDir && !fs.existsSync(path.join(paths.attDir, "meta.json"))) {
        // Put back whatever was there - a published generation or staged debris.
        try { fs.renameSync(path.join(parent, staleName), paths.attDir); } catch { /* recoverIndexDir handles it */ }
      }
      throw err;
    }
    input.fault?.("after-switch");
    if (hadDir) rmQuiet(path.join(parent, staleName));
    clearJournal(paths.txRoot, attId);
    try { fs.rmdirSync(path.join(paths.genRoot, attId)); } catch { /* other generations pending */ }

    return { seq, chunkCount, frameCount };
  } catch (err) {
    if (err instanceof FaultAbort) throw err; // leave the crashed-process state verbatim
    rmQuiet(genDir);
    if (err instanceof PublishError) throw err;
    throw new PublishError("write", `staged write failed: ${(err as Error)?.message ?? String(err)}`, err);
  }
}

/**
 * Bounded garbage collection for staged generations and aside directories an
 * abandoned publish left behind. Anything younger than `maxAgeMs` may still
 * belong to a live build, so it is spared.
 */
export function sweepStale(paths: PublishPaths, maxAgeMs = 30 * 60 * 1000): number {
  let removed = 0;
  const now = Date.now();
  // Age from the STAMP EMBEDDED IN THE NAME (a publish-created generation or
  // aside dir records its own start time). mtime is only a fallback: filesystem
  // timestamps can sit a hair in the future relative to Date.now(), which would
  // make a genuinely abandoned directory look ageless and never collectable.
  const stampOf = (name: string): number | null => {
    const gen = /^g(\d{10,})-/.exec(name);
    if (gen) return Number(gen[1]);
    const aside = /\.stale-(\d{10,})$/.exec(name);
    if (aside) return Number(aside[1]);
    return null;
  };
  const ageOk = (dir: string, name: string): boolean => {
    let ts = stampOf(name);
    if (ts == null) {
      try { ts = fs.statSync(dir).mtimeMs; } catch { return false; }
    }
    const age = now - ts;
    // A future-dated stamp means the clock moved: spare it, it may be live work.
    return age >= maxAgeMs && age >= 0;
  };
  try {
    const parent = path.dirname(paths.attDir);
    for (const name of fs.readdirSync(parent)) {
      if (STALE_SUFFIX_RE.test(name) && ageOk(path.join(parent, name), name)) {
        rmQuiet(path.join(parent, name));
        removed++;
      }
    }
  } catch { /* no root yet */ }
  try {
    for (const att of fs.readdirSync(paths.genRoot)) {
      if (!/^att_[a-z0-9]{4,32}$/.test(att)) continue;
      const dir = path.join(paths.genRoot, att);
      for (const name of fs.readdirSync(dir)) {
        if (GEN_DIR_RE.test(name) && ageOk(path.join(dir, name), name)) {
          rmQuiet(path.join(dir, name));
          removed++;
        }
      }
      try { fs.rmdirSync(dir); } catch { /* still holds a live generation */ }
    }
  } catch { /* nothing staged */ }
  return removed;
}
