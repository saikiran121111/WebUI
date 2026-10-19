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
  fs.writeFileSync(path.join(dir, "full.txt"), fullText, "utf8");
  atomicWrite(
    path.join(dir, "chunks.jsonl"),
    chunks.map(c => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""),
  );
  atomicWrite(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  cacheDelete(attId);
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
  try {
    fs.rmSync(indexDir(attId), { recursive: true, force: true });
  } catch {
    // GC paths must never throw — a bad id just means nothing to clean.
  }
}

export function readNotes(attId: string): string | null {
  try {
    const f = path.join(indexDir(attId), "notes.json");
    if (!fs.existsSync(f)) return null;
    return (JSON.parse(fs.readFileSync(f, "utf8")) as { notes: string }).notes ?? null;
  } catch {
    return null;
  }
}

export function writeNotes(attId: string, notes: string): void {
  atomicWrite(path.join(indexDir(attId), "notes.json"), JSON.stringify({ notes, createdAt: Date.now() }));
}
