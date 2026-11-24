import type { IndexChunk, IndexMeta, VectorAssessment } from "./types";

/**
 * F09b: decide, from what an index ACTUALLY stores, whether its dense vectors
 * may be scored at all.
 *
 * A cosine product between two different-length vectors is not a weaker score,
 * it is a meaningless one, and a mixed-length index silently produces one
 * partial product per chunk. So the index itself declares the quality mode:
 *   hybrid        - a single consistent dimension, usable for ranking
 *   lexical_only  - no usable dense channel (with the reason, for honest reporting)
 *
 * Provenance (model/revision/fingerprint/dim) is only ever trusted when the
 * index stamped it; an unstamped legacy index is judged from stored shapes.
 */
export function assessVectors(meta: IndexMeta, chunks: IndexChunk[]): VectorAssessment {
  const dims = new Map<number, number>();
  let withVec = 0;
  for (const c of chunks) {
    if (c.vec?.length) {
      withVec++;
      dims.set(c.vec.length, (dims.get(c.vec.length) ?? 0) + 1);
    }
  }
  const declared = meta.embed?.dim ?? null;
  const observed = [...dims.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ragged = dims.size > 1;
  const mismatched = declared != null ? (dims.get(declared) ?? 0) !== withVec : false;

  let mode: "hybrid" | "lexical_only" = "hybrid";
  let reason: string | undefined;
  if (!withVec) {
    mode = "lexical_only";
    // F79: quote the build's own persisted reason when there is one — the real
    // cause of the degradation, not a generic phrase.
    reason = meta.embedNote || "no vectors stored";
  } else if (ragged) {
    mode = "lexical_only";
    reason = `ragged vector dimensions (${[...dims.keys()].sort((a, b) => a - b).join(", ")})`;
  } else if (mismatched) {
    mode = "lexical_only";
    reason = `stored dimension != declared dimension ${declared}`;
  }

  return {
    mode,
    reason,
    count: withVec,
    dim: declared ?? observed,
    declaredDim: declared,
    model: meta.embed?.model ?? null,
    fingerprint: meta.embed?.fingerprint ?? null,
  };
}

/** True when a query embedding may be compared against this assessment at all. */
export function comparableWith(assessment: VectorAssessment, queryVec: number[]): boolean {
  return (
    assessment.mode === "hybrid" &&
    queryVec.length > 0 &&
    queryVec.every(Number.isFinite) &&
    (assessment.dim == null || queryVec.length === assessment.dim)
  );
}