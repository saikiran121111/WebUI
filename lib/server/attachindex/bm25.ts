/** Lowercase word tokens — letters/digits/apostrophes, Unicode-aware. */
export function tokenize(t: string): string[] {
  return t.toLowerCase().match(/[\p{L}\p{N}]+(?:'[a-z]+)*/gu) ?? [];
}

/**
 * Okapi BM25 over a small in-memory corpus (≤ a few thousand chunks), built
 * per query — no persisted postings needed at this scale. `docs` arrive
 * pre-tokenized so callers can reuse tokenization across queries.
 */
export function bm25Scores(query: string, docs: string[][]): number[] {
  const k1 = 1.5;
  const b = 0.75;
  const N = docs.length;
  if (!N) return [];

  const dl = docs.map(d => d.length);
  const avgdl = dl.reduce((a, x) => a + x, 0) / N || 1;

  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const terms = [...new Set(tokenize(query))];
  return docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      const n = df.get(term);
      if (!f || !n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl[i]) / avgdl));
    }
    return score;
  });
}
