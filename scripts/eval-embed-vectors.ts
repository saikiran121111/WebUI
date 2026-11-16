/**
 * Emits REAL vectors for the frozen retrieval holdout using the PRODUCTION
 * embedder, so a retriever comparison measures what Ruke actually runs instead of
 * a hand-written lookalike of it (F05/F09 law: a vector is only meaningful with
 * the pipeline stamp that made it).
 *
 * No inference endpoint is touched, no download happens on purpose: the weights
 * must already be cached under .data/models (they are, for the shipped baseline).
 *
 * Usage (offline; run from the repository root so .data/models resolves):
 *   python -m ruke_ml.eval --dump-corpus <corpus.json>
 *   npx esbuild scripts/eval-embed-vectors.ts --bundle --platform=node `
 *        --format=cjs --tsconfig tsconfig.json `
 *        --external:@huggingface/transformers --outfile=<bundle.cjs>
 *   node <bundle.cjs> <corpus.json> <vectors.json>
 *   python -m ruke_ml.eval --vectors <vectors.json> --out <report.json>
 */
import fs from "node:fs";
import {
  EMBED_MODEL_ID,
  EMBED_NORMALIZED,
  EMBED_POOLING,
  embedDisabled,
  embedFingerprint,
  embedRevision,
  embedTexts,
  embedderState,
  releaseEmbedder,
} from "@/lib/server/attachindex/embed";

interface CorpusFile {
  chunks: { chunk_id: string; source_id: string; text: string }[];
  queries: { qid: string; query: string; language?: string; family?: string }[];
}

/** Vectors stay readable but bounded: 6 decimals is far below any ranking effect. */
function round(vec: number[]): number[] {
  return vec.map((x) => Number(x.toFixed(6)));
}

async function main(): Promise<number> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: eval-embed-vectors <corpus.json> <vectors.json>");
    return 2;
  }
  if (embedDisabled()) {
    console.error("embeddings are disabled by ATTACH_EMBED - refusing to emit lexical " +
      "vectors into a file that declares a model");
    return 3;
  }
  const corpus = JSON.parse(fs.readFileSync(inPath, "utf8")) as CorpusFile;
  if (!corpus.chunks?.length || !corpus.queries?.length) {
    console.error("corpus file has no chunks or no queries");
    return 2;
  }
  const started = Date.now();
  const chunkVecs = await embedTexts(corpus.chunks.map((c) => c.text));
  const queryVecs = await embedTexts(corpus.queries.map((q) => q.query));
  const elapsedMs = Date.now() - started;

  const dim = chunkVecs[0]?.length ?? 0;
  if (!dim) {
    console.error("the embedder returned an empty vector");
    return 4;
  }
  const bad: string[] = [];
  chunkVecs.forEach((v, i) => { if (v.length !== dim) bad.push(`chunk[${i}]=${v.length}`); });
  queryVecs.forEach((v, i) => { if (v.length !== dim) bad.push(`query[${i}]=${v.length}`); });
  if (bad.length) {
    console.error(`inconsistent dimensions from the embedder: ${bad.slice(0, 5).join(", ")}`);
    return 4;
  }

  const payload = {
    model: {
      id: EMBED_MODEL_ID,
      revision: embedRevision(),
      provider: "local-onnxruntime",
      pooling: EMBED_POOLING,
      query_instruction: "",
    },
    dim,
    normalization: EMBED_NORMALIZED ? "l2" : "none",
    fingerprint: embedFingerprint(dim),
    produced_by: "scripts/eval-embed-vectors.ts via lib/server/attachindex/embed.ts",
    elapsed_ms: elapsedMs,
    embedder_state: embedderState(),
    vectors: {
      chunk: Object.fromEntries(corpus.chunks.map((c, i) => [c.chunk_id, round(chunkVecs[i])])),
      query: Object.fromEntries(corpus.queries.map((q, i) => [q.qid, round(queryVecs[i])])),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.log(`emitted ${Object.keys(payload.vectors.chunk).length} chunk vectors + ` +
    `${Object.keys(payload.vectors.query).length} query vectors, dim=${dim}, ` +
    `model=${EMBED_MODEL_ID}, ${elapsedMs} ms -> ${outPath}`);
  // F21: the weights belong to an owned resource; reclaim them, do not leak.
  await releaseEmbedder();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    if (code === 0) setTimeout(() => process.exit(0), 50).unref();
  })
  .catch((err) => {
    console.error(`embedding run failed: ${err instanceof Error ? err.stack || err.message : err}`);
    process.exitCode = 1;
  });
