import fs from "node:fs";
import path from "node:path";

/**
 * Local embedding model for the attachment index. Weights live under
 * `.data/models` — same cache dir and singleton pattern as Whisper
 * (lib/server/extract/audio.ts), so nothing is downloaded twice.
 */
const MODEL_ID = process.env.EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";

let fePromise: Promise<any> | null = null;

function getEmbedder(): Promise<any> {
  if (!fePromise) {
    fePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      const cacheDir = path.join(process.cwd(), ".data", "models");
      fs.mkdirSync(cacheDir, { recursive: true });
      env.allowLocalModels = false;
      env.useBrowserCache = false;
      env.cacheDir = cacheDir;
      return pipeline("feature-extraction", MODEL_ID);
    })().catch(err => {
      fePromise = null; // let a later request retry the download
      throw err;
    });
  }
  return fePromise;
}

/**
 * Embed texts into L2-normalized vectors (mean pooling + normalize inside
 * the model), so a plain dot product IS cosine similarity downstream.
 * Batched: a 3-hour transcript is only a few hundred chunks.
 *
 * I25 (cancellation): the ONNX forward pass itself is not interruptible —
 * cancellation lands BEFORE the model is loaded and BETWEEN batches, which
 * is where the wait actually lives (lazy download/load, then a few hundred
 * chunks × many turns). A pre-aborted signal never touches the model.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const reason = (signal as any).reason;
    if (reason instanceof Error) throw reason;
    const e = new Error("The user aborted this request.");
    e.name = "AbortError";
    throw e;
  };
  throwIfAborted();
  const fe = await getEmbedder();
  const out: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    throwIfAborted();
    const res = await fe(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
    const rows = res.tolist();
    // Single text comes back as a flat vector; batches as rows of vectors.
    const matrix: number[][] = Array.isArray(rows?.[0]) ? rows : [rows];
    for (const r of matrix) out.push(r as number[]);
  }
  return out;
}

export async function embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
  return (await embedTexts([text], signal))[0];
}
