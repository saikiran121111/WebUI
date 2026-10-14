import fs from "node:fs";
import path from "node:path";

/**
 * Whisper speech-to-text. The model and its weights live under `.data/models`
 * inside this codebase — nothing is installed or cached outside the project.
 */
const MODEL_ID = process.env.WHISPER_MODEL ?? "Xenova/whisper-base.en";

let asrPromise: Promise<any> | null = null;

function getAsr(): Promise<any> {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      const cacheDir = path.join(process.cwd(), ".data", "models");
      fs.mkdirSync(cacheDir, { recursive: true });
      env.allowLocalModels = false;
      env.useBrowserCache = false;
      env.cacheDir = cacheDir;
      // Chunking options live on the ASR task, which the generic pipeline
      // signature does not model.
      return pipeline("automatic-speech-recognition", MODEL_ID, {
        chunk_length_s: 30,
        stride_length_s: 5,
      } as any);
    })().catch(err => {
      asrPromise = null; // let a later request retry the download
      throw err;
    });
  }
  return asrPromise;
}

/** Transcribe 16 kHz mono float PCM to text. */
export async function transcribePcm(pcm: Float32Array): Promise<string> {
  const asr = await getAsr();
  const out = await asr(pcm);
  const text = typeof out === "string" ? out : out?.text ?? "";
  return String(text).trim();
}
