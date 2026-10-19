import { tokenize } from "./bm25";
import { firstSentence, fmtStamp, lastSentence } from "./format";
import type { IndexChunk, SpineBlock } from "./types";

const MAX_BLOCKS = Number(process.env.ATTACH_SPINE_BLOCKS ?? 40);
/** Media spine granularity: one block per 10 minutes of recording. */
const BLOCK_SEC = 600;

/**
 * Zero-LLM structural spine: a compact table of contents built from the
 * chunks themselves (TF-IDF keywords + opening/closing sentences). Always
 * injected for indexed attachments so the model knows what exists and where,
 * without spending a single inference call.
 */
export function buildSpine(chunks: IndexChunk[]): { blocks: SpineBlock[]; text: string } {
  if (!chunks.length) return { blocks: [], text: "" };

  let groups: IndexChunk[][] = [];
  const timed = chunks.some(c => c.startSec != null);
  if (timed) {
    const byBucket = new Map<number, IndexChunk[]>();
    for (const c of chunks) {
      const key = Math.floor((c.startSec ?? 0) / BLOCK_SEC);
      const g = byBucket.get(key);
      if (g) g.push(c);
      else byBucket.set(key, [c]);
    }
    groups = [...byBucket.keys()].sort((a, b) => a - b).map(k => byBucket.get(k)!);
    // Absurdly long recordings: merge adjacent blocks until under the cap.
    while (groups.length > MAX_BLOCKS) {
      const merged: IndexChunk[][] = [];
      for (let i = 0; i < groups.length; i += 2) merged.push(groups[i].concat(groups[i + 1] ?? []));
      groups = merged;
    }
  } else {
    const per = Math.max(1, Math.ceil(chunks.length / MAX_BLOCKS));
    for (let i = 0; i < chunks.length; i += per) groups.push(chunks.slice(i, i + per));
  }

  const toks = groups.map(g => tokenize(g.map(c => c.text).join(" ")));
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = groups.length;

  const blocks: SpineBlock[] = groups.map((g, gi) => {
    const tf = new Map<string, number>();
    for (const w of toks[gi]) tf.set(w, (tf.get(w) ?? 0) + 1);
    const keywords = [...tf.entries()]
      .filter(([w]) => w.length >= 3)
      .map(([w, f]) => {
        const d = df.get(w) ?? 0;
        return [w, f * Math.log(1 + (n - d + 0.5) / (d + 0.5))] as const;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(e => e[0]);
    return {
      startSec: g[0].startSec ?? null,
      endSec: g[g.length - 1].endSec ?? null,
      chunkFrom: g[0].i,
      chunkTo: g[g.length - 1].i,
      keywords,
      opening: firstSentence(g[0].text),
      closing: lastSentence(g[g.length - 1].text),
    };
  });

  const text = blocks
    .map(b => {
      const span =
        b.startSec != null
          ? `[${fmtStamp(b.startSec)} - ${fmtStamp(b.endSec ?? b.startSec)}]`
          : `[chunks ${b.chunkFrom}-${b.chunkTo}]`;
      return `${span} ${b.keywords.join(", ")} — opens: "${b.opening}"; closes: "${b.closing}"`;
    })
    .join("\n");

  return { blocks, text };
}
