import { bm25Scores, tokenize } from "./bm25";
import { fmtStamp } from "./format";
import type { RoutedQuery } from "./router";
import type { IndexChunk, LoadedIndex } from "./types";
import { assessVectors, comparableWith } from "./vectors";

const BUDGET = Number(process.env.ATTACH_RETRIEVE_CHARS ?? 24000);
const TOP_K = Number(process.env.ATTACH_TOP_K ?? 8);
const RRF_K = 60;

export interface Evidence {
  /** Formatted passages, chronological, each with a [HH:MM:SS] header when timed. */
  text: string;
  chunkIdxs: number[];
  /** Timestamps of winning chunks — the chat route picks nearest keyframes. */
  frameAts: number[];
  truncated: boolean;
  /**
   * I20: how many ranked candidates this turn's budget (or the demote list)
   * left unserved. The turn layer turns that number into an honest marker
   * instead of letting "more exists, count unknown" stand.
   */
  dropped: number;
  /**
   * F09b/F14: what actually ranked this evidence. "lexical_only" means the
   * stored embeddings were unusable (no stamp match, ragged dimensions, no
   * vectors), so the turn can say so instead of implying semantic retrieval
   * ran. Never inferred from a guess — read off the index's own assessment.
   */
  vectorMode: "hybrid" | "lexical_only";
  vectorReason?: string;
}

/**
 * F09b: a partial dot product over the SHORTER of two vectors is not a
 * similarity — it is a truncated projection of two unrelated bases, and it
 * silently ranks evidence. Mismatched lengths contribute nothing instead.
 */
function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function header(c: IndexChunk): string {
  return c.startSec == null ? "" : `[${fmtStamp(c.startSec)} - ${fmtStamp(c.endSec ?? c.startSec)}]`;
}

/** Fuse two ranked id lists into Reciprocal Rank Fusion scores. */
function rrfFuse(lists: number[][]): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      out.set(id, (out.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    }
  }
  return out;
}

/**
 * Pack chunk ids by descending priority within the char budget, then emit
 * them chronologically so the model reads the course in order.
 *
 * I20: ids in `demote` (passages an earlier turn already served for this
 * attachment) are held back so a follow-up turn sees FRESH passages instead
 * of the same top hits. They are only used when nothing else was picked at
 * all — an honest repeat beats an empty answer. Every unserved candidate is
 * counted in `dropped` for the turn's honest marker.
 */
function pack(
  index: LoadedIndex,
  priority: Map<number, number>,
  budget: number,
  demote?: number[],
  vectors?: { mode: "hybrid" | "lexical_only"; reason?: string },
): Evidence {
  const chunks = index.chunks;
  const ordered = [...priority.entries()]
    .filter(([i]) => i >= 0 && i < chunks.length)
    .sort((a, b) => b[1] - a[1]);

  const demoteSet = demote?.length ? new Set(demote) : null;
  const fresh = demoteSet ? ordered.filter(([i]) => !demoteSet.has(i)) : ordered;
  const held = demoteSet ? ordered.filter(([i]) => demoteSet.has(i)) : [];

  const picked: number[] = [];
  let used = 0;
  let truncated = false;
  const fill = (list: Array<[number, number]>) => {
    for (const [i] of list) {
      const c = chunks[i];
      const h = header(c);
      const cost = c.text.length + (h ? h.length + 1 : 0) + (picked.length ? 2 : 0);
      if (used + cost > budget) {
        truncated = true;
        continue; // keep scanning — a smaller chunk may still fit
      }
      picked.push(i);
      used += cost;
    }
  };
  fill(fresh);
  if (!picked.length) fill(held);

  const dropped = ordered.length - picked.length;
  picked.sort((a, b) => a - b);

  const text = picked
    .map(i => {
      const c = chunks[i];
      const h = header(c);
      return h ? `${h}\n${c.text}` : c.text;
    })
    .join("\n\n");
  const frameAts = picked
    .map(i => chunks[i].startSec)
    .filter((n): n is number => n != null);
  return {
    text,
    chunkIdxs: picked,
    frameAts,
    truncated,
    dropped,
    vectorMode: vectors?.mode ?? "lexical_only",
    vectorReason: vectors?.reason,
  };
}

export interface RetrieveOpts extends RoutedQuery {
  /** Inclusive chunk range override (sequential mode via a spine block). */
  range?: { from: number; to: number };
  /** Chunk ids already shown to this conversation this turn (I20 demote). */
  demote?: number[];
  /** Char budget override; defaults to ATTACH_RETRIEVE_CHARS (I05 turn budget). */
  budget?: number;
}

/**
 * Hybrid retrieval over a loaded index. `queryVec` is embedded by the caller
 * (keeps this function pure/synchronous for tests). Modes:
 *  - point_qa:   cosine top-20 + BM25 top-20 → RRF → top-K seeds → ±1 neighbors
 *  - exhaustive: same fusion, no top-K cutoff (budget caps output instead)
 *  - time_range: chunks overlapping [fromSec, toSec] (or any of `windows`), chronological
 *  - sequential: chunks in `range`, chronological
 */
export function retrieveEvidence(
  index: LoadedIndex,
  query: string,
  queryVec: number[],
  opts: RetrieveOpts,
): Evidence {
  const chunks = index.chunks;
  const budget = opts.budget ?? BUDGET;
  // F09b: the index decides whether its own vectors may be scored at all.
  // An unstamped legacy index is assessed from the shapes actually stored.
  const assess = index.vectors ?? assessVectors(index.meta, chunks);


  if (opts.mode === "sequential" && opts.range) {
    const priority = new Map<number, number>();
    for (let i = opts.range.from; i <= opts.range.to && i < chunks.length; i++) {
      if (i >= 0) priority.set(i, 1);
    }
    return pack(index, priority, budget, opts.demote, assess);
  }

  // F07: comparative asks carry SEPARATE cue windows. Matching each chunk
  // against every window (once) keeps the selection anchored to the cues
  // themselves instead of to everything in between them; insertion order is
  // still chronological, exactly like the single-window branch below.
  if (opts.mode === "time_range" && opts.windows?.length) {
    const priority = new Map<number, number>();
    for (const c of chunks) {
      if (c.startSec == null) continue;
      for (const w of opts.windows) {
        if ((c.endSec ?? c.startSec) >= w.fromSec && c.startSec <= w.toSec) {
          priority.set(c.i, 1);
          break;
        }
      }
    }
    return pack(index, priority, budget, opts.demote, assess);
  }

  if (opts.mode === "time_range" && opts.fromSec != null) {
    const to = opts.toSec ?? opts.fromSec + 300;
    const priority = new Map<number, number>();
    for (const c of chunks) {
      if (c.startSec == null) continue;
      if ((c.endSec ?? c.startSec) >= opts.fromSec && c.startSec <= to) priority.set(c.i, 1);
    }
    return pack(index, priority, budget, opts.demote, assess);
  }

  // Hybrid: vector + BM25 fused with RRF.
  const cos = chunks.map(c => dot(queryVec, c.vec ?? []));
  const bm = bm25Scores(query, chunks.map(c => tokenize(c.text)));
  const ids = chunks.map(c => c.i);
  // I20: an exhaustive sweep considers EVERY chunk, not the head of each
  // channel — the budget (not a 20-candidate lens) is what caps the output.
  const cap = opts.mode === "exhaustive" ? ids.length : 20;
  // I21: an unavailable embedder leaves queryVec empty, and an all-zero
  // cosine channel would vote arbitrary chunk order into the fusion. With
  // no vector there is no cosine channel: BM25 ranks on its own.
  // F09b: the same honest rule covers an index whose stored vectors cannot be
  // compared with this query vector (ragged, untagged or from another model).
  const scored =
    queryVec.length > 0 &&
    chunks.some(c => (c.vec?.length ?? 0) === queryVec.length) &&
    comparableWith({ ...assess, mode: "hybrid" as const }, queryVec);
  const hasVec = assess.mode === "hybrid" && scored;
  // Only comparable chunks enter the cosine channel; a NEGATIVE_INFINITY from a
  // length mismatch must never reach the comparator (NaN order == arbitrary).
  const comparable = ids.filter((_, pos) => Number.isFinite(cos[pos]));
  const byCos = hasVec ? [...comparable].sort((a, b) => cos[b] - cos[a]).slice(0, cap) : [];
  const byBm = [...ids]
    .sort((a, b) => bm[b] - bm[a])
    .filter(i => bm[i] > 0)
    .slice(0, cap);

  const fused = rrfFuse(hasVec ? [byCos, byBm] : [byBm]);
  const vectorMode: "hybrid" | "lexical_only" = hasVec ? "hybrid" : "lexical_only";
  const vectorReason = hasVec
    ? undefined
    : assess.mode === "hybrid"
      ? queryVec.length === 0
        ? "no query embedding available"
        : "query vector could not be compared with the stored vectors"
      : assess.reason;
  let seeds = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  if (opts.mode !== "exhaustive") seeds = seeds.slice(0, TOP_K);

  const priority = new Map<number, number>();
  for (const [i, s] of seeds) {
    priority.set(i, Math.max(priority.get(i) ?? 0, s));
    if (opts.mode === "point_qa") {
      // Neighbor expansion so a passage is never cut mid-thought; neighbors
      // rank below their seed so budget pressure drops them first.
      for (const nb of [i - 1, i + 1]) {
        if (nb >= 0 && nb < chunks.length && !priority.has(nb)) priority.set(nb, s * 0.5);
      }
    }
  }
  return pack(index, priority, budget, opts.demote, { mode: vectorMode, reason: vectorReason });
}
