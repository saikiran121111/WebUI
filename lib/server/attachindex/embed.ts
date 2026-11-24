import fs from "node:fs";
import path from "node:path";
import { OwnedResource, parseIdleTtl } from "@/lib/lifecycle/ownedResource";

/**
 * Local embedding model for the attachment index. Weights live under
 * `.data/models` — the app's project-local model store — held by the shared
 * OwnedResource singleton law below, so the weights load once per process.
 *
 * I26/F09: the id is EXPORTED because it becomes part of the durable index
 * format. A vector is only comparable with vectors from the same model +
 * pooling + normalization pipeline, so an index records which pipeline made
 * it; a reader that cannot match the stamp must not score those vectors.
 */
export const EMBED_MODEL_ID = process.env.EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";

/** What we actually control about the pipeline (nothing is invented). */
export const EMBED_POOLING = "mean";
export const EMBED_NORMALIZED = true;

/**
 * Pipeline fingerprint for cache/index compatibility. It names only the parts
 * the code fixes or varies, so a reader can tell "same pipeline" from "unknown
 * pipeline". `revision` stays "unpinned" because this model is fetched by id
 * without a pinned commit — reporting a fake revision would be a lie that
 * makes stale vectors look valid.
 */
export function embedFingerprint(dim: number): string {
  return `model=${EMBED_MODEL_ID};pool=${EMBED_POOLING};normalize=${EMBED_NORMALIZED};dim=${dim}`;
}

export function embedRevision(): string {
  return "unpinned";
}

/**
 * F21: the embedder is an OWNED resource, not a bare promise. Two defects in
 * the old singleton: the MiniLM session was resident for the whole life of the
 * process (a full-text-search box that indexed one PDF kept ~90 MB of weights
 * forever), and a session that died internally stayed "ready" forever. The
 * lease is held across the whole embedTexts loop, so the idle TTL can never
 * destroy a session that an indexing job is still using.
 *
 * ATTACH_EMBED_IDLE_MS=<ms> changes the TTL; 0 releases the moment indexing
 * finishes; `never` keeps it resident.
 */
export const ATTACH_EMBED_IDLE_MS = parseIdleTtl(process.env.ATTACH_EMBED_IDLE_MS, 60_000);

async function createEmbedder(): Promise<any> {
  const { pipeline, env } = await import("@huggingface/transformers");
  const cacheDir = path.join(process.cwd(), ".data", "models");
  fs.mkdirSync(cacheDir, { recursive: true });
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.cacheDir = cacheDir;
  return pipeline("feature-extraction", EMBED_MODEL_ID);
}

/**
 * Best-effort reclaim. transformers.js exposes dispose() on the pipeline (or on
 * its model). If neither exists this throws so the release is recorded as a
 * real destroy failure (`destroy_failed`) instead of pretending the bytes came
 * back; the slot is dropped either way, so a broken session is never reused.
 */
async function destroyEmbedder(pipe: any): Promise<void> {
  if (typeof pipe?.dispose === "function") {
    await pipe.dispose();
    return;
  }
  if (typeof pipe?.model?.dispose === "function") {
    await pipe.model.dispose();
    return;
  }
  throw new Error("feature-extraction pipeline exposes no dispose()");
}

export const embedderResource = new OwnedResource<any>({
  name: "attach-embedder",
  idleTtlMs: ATTACH_EMBED_IDLE_MS,
  create: createEmbedder,
  destroy: destroyEmbedder,
});

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
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) throw reason;
    const e = new Error("The user aborted this request.");
    e.name = "AbortError";
    throw e;
  };
  throwIfAborted();
  if (embedDisabled()) {
    // Explicit lexical mode (documented operator switch, e.g. an air-gapped box
    // or a memory-tight run). Callers must surface this as a NOTE, never pretend
    // the index is hybrid â€” build() stamps it and retrieve() reports the mode.
    throw new Error("embeddings disabled (ATTACH_EMBED=off)");
  }
  const out: number[][] = [];
  const BATCH = 16;
  // F21: one lease for the WHOLE embedding pass. Cancellation inside the loop
  // still releases it (finally), and the idle TTL cannot fire mid-batch.
  await embedderResource.use(async (fe) => {
    for (let i = 0; i < texts.length; i += BATCH) {
      throwIfAborted();
      const res = await fe(texts.slice(i, i + BATCH), { pooling: EMBED_POOLING, normalize: EMBED_NORMALIZED });
      const rows = res.tolist();
      // Single text comes back as a flat vector; batches as rows of vectors.
      const matrix: number[][] = Array.isArray(rows?.[0]) ? rows : [rows];
      for (const r of matrix) out.push(r as number[]);
      // F10: surface progress so the upload chip can show real work instead of a
      // frozen "processing" state. Purely advisory, never a percentage promise.
      onEmbedProgress?.(out.length, texts.length);
    }
  });
  return out;
}

/** Optional progress hook (set by the extract route for its status stream). */
let onEmbedProgress: ((done: number, total: number) => void) | null = null;
export function setEmbedProgressHook(hook: ((done: number, total: number) => void) | null): void {
  onEmbedProgress = hook;
}

export async function embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
  return (await embedTexts([text], signal))[0];
}

/** True once the weights are resident (capability reporting without loading). */
export function embedderLoaded(): boolean {
  return embedderResource.resident;
}

/** Full lifecycle state for capability reporting: resident, starting, holders. */
export function embedderState() {
  return embedderResource.state();
}

/**
 * Reclaim the weights now (memory pressure, tests). Never destroys a session
 * that an indexing job is still holding — that one is deferred, not forced.
 */
export function releaseEmbedder(): Promise<boolean> {
  return embedderResource.releaseIdle({ force: true });
}

/**
 * F10/F14: an explicit, honest lexical fallback. Read at CALL time (not module
 * load) so a test or an operator can flip it without a restart. Anything other
 * than "off"/"none"/"0" leaves the default hybrid path alone.
 */
export function embedDisabled(): boolean {
  const v = (process.env.ATTACH_EMBED ?? "").trim().toLowerCase();
  return v === "off" || v === "none" || v === "0";
}
