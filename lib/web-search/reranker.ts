/**
 * Pure-CPU BM25 lexical reranker (zero dependency).
 *
 * Splits extracted markdown into ~600-char semantic chunks (paragraph /
 * heading aware, 100-char overlap), scores every chunk against the user
 * prompt + the gate's query set with k1=1.5, b=0.75, and emits the top
 * 12–15 passages across diverse domains (max 3 per domain).
 *
 * Complexity: O(total tokens) — measured ~8–15ms for a typical
 * 10-URL evidence set. No neural model is ever loaded.
 *
 * NOTE: the per-source "verified state" multipliers and
 * `[VERIFIED SOURCE STATE]` banners that lived here until 2026-10-22 are
 * gone with the validation stage — ranking is pure BM25 + junk penalty
 * again. What a page says (including a "Currently unavailable" line) is
 * up to the main model to read out of the passages.
 */
import type {
  EvidencePacket,
  EvidencePassage,
} from "./types";

/* ── chunking ──────────────────────────────────────────────────────────── */

interface Chunk {
  text: string;
  startIndex: number;
}

/**
 * Split markdown into semantic chunks: break at blank lines / headings,
 * target ~2,000 chars with 300-char overlap so a fact spanning a boundary
 * still appears in at least one chunk.
 *
 * Atomic block protection: Markdown tables, fenced code blocks, and
 * [Structured Page Facts] headers are NEVER split across chunks — they
 * become their own atomic chunk even when they exceed 2,000 chars
 * (up to 8,000 chars, which covers full pricing matrices and code files).
 */
const ATOMIC_BLOCK_RE =
  /```[\s\S]*?```(?:\n|(?=$))|^\|.*\|(?:\n\|.*\|)*|^\[Structured Page Facts\][\s\S]+?(?=\n\n(?=#|\||```|$))/gm;

export function chunkMarkdown(md: string, target = 2000, overlap = 300): Chunk[] {
  const cleaned = md.replace(/\r\n/g, "\n");
  const chunks: Chunk[] = [];

  // Pass 1: extract atomic blocks (tables, code fences, structured page facts)
  // and replace them with placeholders in the main text.
  const atomicBlocks: { start: number; end: number; text: string }[] = [];
  let placeholderText = cleaned;
  let placeholder = 0;
  const ATOMIC_CAP = 8000; // Max size for a single atomic chunk

  const processAtomic = (regex: RegExp) => {
    for (const m of cleaned.matchAll(regex)) {
      const blockText = m[0].trim();
      if (blockText.length < 40) continue;
      const capped = blockText.length > ATOMIC_CAP ? blockText.slice(0, ATOMIC_CAP) : blockText;
      atomicBlocks.push({
        start: m.index ?? 0,
        end: (m.index ?? 0) + blockText.length,
        text: capped,
      });
      const ph = `[[ATOMIC_${placeholder++}]]`;
      placeholderText = placeholderText.replace(blockText, ph);
    }
  };

  // Fenced code blocks
  processAtomic(/```[\s\S]*?```/g);
  // Markdown tables (contiguous | rows)
  processAtomic(/^\|.*\|(?:\n\|.*\|)*/gm);
  // [Structured Page Facts] blocks (header + content up to blank line + new section)
  processAtomic(/^\[Structured Page Facts\][\s\S]+?(?=\n\n(?=#|\[Structured|$))/gm);

  // Pass 2: chunk the remaining prose (with placeholders that are
  // later resolved back to the atomic block text).
  const paragraphs = placeholderText.split(/\n{2,}|\n(?=#{1,4}\s)/);
  let buf = "";
  let bufStart = 0;

  const resolvePlaceholder = (s: string): string => {
    // Re-expand atomic placeholders back to their full text
    let result = s;
    for (let i = 0; i < atomicBlocks.length; i++) {
      result = result.replace(`[[ATOMIC_${i}]]`, atomicBlocks[i].text);
    }
    return result;
  };

  const flush = (end: number) => {
    let text = buf.trim();
    if (text.length >= 40) {
      text = resolvePlaceholder(text);
      chunks.push({ text, startIndex: bufStart });
    }
    buf = "";
    bufStart = end;
  };

  let pos = 0;
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    // If this paragraph is (or contains) an atomic placeholder,
    // emit it as its own chunk — never split it.
    const atomicMatch = p.match(/^\[\[ATOMIC_(\d+)\]\]$/);
    if (atomicMatch) {
      flush(pos);
      const atomicText = atomicBlocks[Number(atomicMatch[1])].text;
      if (atomicText.trim().length >= 40) {
        chunks.push({ text: atomicText.trim(), startIndex: pos });
      }
      pos += p.length + 2;
      continue;
    }
    if (p.length > target * 2) {
      // Very long paragraph: hard-slice with overlap
      for (let i = 0; i < p.length; i += target - overlap) {
        chunks.push({
          text: resolvePlaceholder(p.slice(i, i + target)),
          startIndex: pos + i,
        });
      }
      pos += p.length + 2;
      continue;
    }
    if (buf.length + p.length + 2 > target) {
      flush(pos);
      // carry overlap tail into the next chunk
      const tail = buf.slice(-overlap);
      buf = tail + "\n" + p;
      bufStart = pos + (tail.length ? 2 : 0);
    } else {
      buf = buf ? buf + "\n" + p : p;
    }
    pos += p.length + 2;
  }
  flush(pos);
  return chunks;
}

/* ── tokenization ─────────────────────────────────────────────────────── */

const STOPWORDS = new Set(
  `a an and are as at be but by can could did do does for from had have he her his i if in is it its me my no nor not of on or she should so that the their them they this to was we were what when which who will with you your
   how what why when where who whom whose it its i im dont don't
   the
   most much many more
  `.split(/\s+/).filter(Boolean),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/* ── Junk passage filter ─────────────────────────────────────────────── */
/**
 * Patterns that indicate a passage is pure boilerplate (cookie banners,
 * GDPR notices, login prompts, footer nav) rather than real content.
 * A chunk that is ENTIRELY one of these gets a strong score penalty in
 * BM25 so it never wins a top-N slot.
 */
const JUNK_PATTERNS: RegExp[] = [
  /cookie[sd]? (policy|notice|banner)|we use (cookies|local storage)|enable cookies to continue/i,
  /by continuing you (agree|acknowledge)|privacy policy|terms of (service|use)|gdpr|do not (sell|share) my (personal )?information/i,
  /^(sign in|log in|log-in|continue with|or sign in|create an account)/i,
  /follow us (on|:)|subscribe|newsletter|all rights reserved|\(c\) \d{4}/i,
  /ad (slot|space|zone)|sponsored (content|link)|related (articles|videos)|you may also (like|enjoy)|trending (now|topics)/i,
  /back to (top|main|home)|jump (to|to) (content|main)|accessibility (statement|menu)/i,
];

/**
 * Score a chunk's junk-ness: 0 = clean content, 1 = pure boilerplate.
 * Multiplied into the BM25 score as a penalty factor (1 - 0.8*jenky)
 * so a login form scoring 8.0 BM25 becomes 1.6 — demoted below any
 * real content chunk.
 */
export function junkPenalty(text: string): number {
  const t = text.toLowerCase();
  let hits = 0;
  for (const re of JUNK_PATTERNS) {
    if (re.test(t)) hits++;
  }
  return Math.min(1, hits / 2); // 2+ junk patterns = full penalty
}

/* ── BM25 ─────────────────────────────────────────────────────────────── */

export interface Bm25Index {
  df: Map<string, number>;
  docTf: Map<number, Map<string, number>>;
  docLen: number[];
  avgLen: number;
  docs: string[];
}

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

export function buildBm25(docs: string[]): Bm25Index {
  const n = docs.length;
  const tokenized = docs.map(tokenize);
  const df = new Map<string, number>();
  const docTf = new Map<number, Map<string, number>>();

  docs.forEach((doc, i) => {
    const tf = new Map<string, number>();
    for (const t of tokenized[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTf.set(i, tf);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  });

  const totalTokens = tokenized.reduce((s, t) => s + t.length, 0);
  return {
    df,
    docTf,
    docs,
    docLen: tokenized.map((t) => t.length),
    avgLen: n ? totalTokens / n : 0,
  };
}

/**
 * Score a query against a pre-built index. O(|query| * log N) —
 * returns [docIdx, score] pairs sorted desc.
 */
export function bm25Score(
  idx: Bm25Index,
  query: string,
  topK = 15,
): Array<[number, number]> {
  const qTerms = new Map<string, number>();
  for (const t of tokenize(query)) qTerms.set(t, (qTerms.get(t) ?? 0) + 1);
  const n = idx.docs.length;
  if (n === 0 || qTerms.size === 0) return [];

  const scores = new Array<number>(n).fill(0);
  for (const [term, qf] of qTerms) {
    const dfv = idx.df.get(term) ?? 0;
    if (dfv === 0) continue;
    const idf = Math.log(1 + (n - dfv + 0.5) / (dfv + 0.5));
    for (let i = 0; i < n; i++) {
      const tf = idx.docTf.get(i)?.get(term) ?? 0;
      if (tf === 0) continue;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (idx.docLen[i] / idx.avgLen));
      scores[i] += qf * idf * (tf * (BM25_K1 + 1)) / denom;
    }
  }

  return scores
    .map((s, i) => [i, s] as [number, number])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);
}

/* ── public rerank API ─────────────────────────────────────────────────── */

export interface RerankHit {
  packet: EvidencePacket;
  passage: EvidencePassage;
  score: number;
}

/**
 * Rank every extracted passage against the combined prompt + gate queries.
 *
 * - Larger semantic chunks (2,000 chars, 300-char overlap) so the LLM gets
 *   more context per passage.
 * - Atomic block protection: tables, code fences, [Structured Page Facts]
 *   are never split — up to 8,000 chars per atomic chunk.
 * - Neighbor expansion: when a chunk ranks top, its adjacent chunk in the
 *   same document is included for setup/conclusion context.
 * - topN default raised to 30; per-domain cap raised to 6.
 * - singleDomainUnlimited: pass true when the query targets one specific
 *   URL / repo / paper / website — allow unlimited chunks from that domain.
 */
export function rerank(
  packets: EvidencePacket[],
  userPrompt: string,
  gateQueries: string[],
  topN = 30,
  opts?: { singleDomainUnlimited?: boolean },
): EvidencePassage[] {
  interface ChunkRec {
    chunk: string;
    packet: EvidencePacket;
  }
  const recs: ChunkRec[] = [];
  for (const packet of packets) {
    for (const p of packet.passages) {
      const chunks = chunkMarkdown(p.passageText);
      for (const c of chunks) {
        // Filter out pure-junk chunks up front (cookie banners, login
        // prompts, footer nav). With 2,000-char chunks the threshold is
        // raised to 800 chars — a boilerplate chunk under 800 chars with
        // 0.8+ junk penalty is almost certainly a cookie banner.
        if (junkPenalty(c.text) >= 0.8 && c.text.length < 800) continue;
        recs.push({ chunk: c.text, packet });
      }
    }
  }
  if (recs.length === 0) {
    return packets.flatMap((p) => p.passages).slice(0, topN);
  }

  // Build the BM25 index over all chunks
  const idx = buildBm25(recs.map((r) => r.chunk));

  // Combined query: user prompt + all gate queries (deduped)
  const qSet = [userPrompt, ...gateQueries];
  const qText = qSet.filter(Boolean).join(" ");

  // Pull more candidates than the final topN so neighbor expansion has
  // material to work with.
  const rawHits = bm25Score(idx, qText, topN * 3);

  // Apply the junk penalty so boilerplate chunks never outrank real content.
  const hits: Array<[number, number]> = rawHits
    .map(([recIdx, rawScore]) => {
      const rec = recs[recIdx];
      if (!rec) return [recIdx, rawScore] as [number, number];
      const penalty = junkPenalty(rec.chunk);
      return [recIdx, rawScore * (1 - 0.8 * penalty)] as [number, number];
    })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);

  if (hits.length === 0) {
    return packets.flatMap((p) => p.passages).slice(0, topN);
  }

  // Per-domain cap: 6 (was 3). Unlimited when singleDomainUnlimited=true.
  const domainCount = new Map<string, number>();
  const singleDomainUnlimited = opts?.singleDomainUnlimited ?? false;
  const out: EvidencePassage[] = [];
  const topHitIdxs = new Set<number>();

  for (const [recIdx, score] of hits) {
    if (out.length >= topN) break;
    const rec = recs[recIdx];
    if (!rec) continue;
    const sourceId = rec.packet.sourceId;
    void sourceId;
    const domain = rec.packet.domain;
    if (!singleDomainUnlimited) {
      const dc = domainCount.get(domain) ?? 0;
      if (dc >= 6) continue;
      domainCount.set(domain, dc + 1);
    }
    topHitIdxs.add(recIdx);
    out.push({
      sourceId,
      url: rec.packet.url,
      title: rec.packet.title,
      domain,
      publishedAt: rec.packet.publishedAt,
      passageText: rec.chunk,
      bm25Score: Math.round(score * 1000) / 1000,
    });
  }

  // Neighbor expansion: for each top hit, include its adjacent chunk in
  // the same document (if it's meaningful) so the LLM gets the setup
  // and conclusion around key facts.
  if (!singleDomainUnlimited && out.length < 35) {
    const seenKeys = new Set(out.map((o) => o.sourceId + "|" + o.passageText.slice(0, 80)));
    let added = 0;
    for (const recIdx of topHitIdxs) {
      if (added >= 5) break;
      const rec = recs[recIdx];
      if (!rec) continue;
      for (const nIdx of [recIdx - 1, recIdx + 1]) {
        if (nIdx < 0 || nIdx >= recs.length) continue;
        const neighbor = recs[nIdx];
        if (neighbor.packet.sourceId !== rec.packet.sourceId) continue;
        const key = neighbor.packet.sourceId + "|" + neighbor.chunk.slice(0, 80);
        if (seenKeys.has(key)) continue;
        if (neighbor.chunk.length < 150) continue;
        out.push({
          sourceId: neighbor.packet.sourceId,
          url: neighbor.packet.url,
          title: neighbor.packet.title,
          domain: neighbor.packet.domain,
          publishedAt: neighbor.packet.publishedAt,
          passageText: "[Context] " + neighbor.chunk,
          bm25Score: 0,
        });
        seenKeys.add(key);
        added++;
        if (out.length >= 35) break;
      }
    }
  }

  return out.slice(0, Math.max(topN, 35));
}
