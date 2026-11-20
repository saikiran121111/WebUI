/**
 * rerank.ts - the PRODUCTION CALLER for the pinned neural reranker (D-058).
 *
 * Until now the Python `rerank` capability had a working engine and nothing
 * that ran it: the Rust capability gate kept `rerank`/`embeddings` off its
 * allowlist, so the engine could only be reached by a hand-written probe.
 * This module is the caller half of that seam, and it is deliberately narrow:
 *
 *  - it asks the Rust job route (ml-job.ts) to run ONE `rerank` job; Rust
 *    owns the endpoint, the per-run token and the payload bounds;
 *  - it hands the engine only the candidates the candidate stage already
 *    ranked, capped to a window it can afford, and says so when it truncates;
 *  - every failure path is a REPORT, never a fallback lie: a typed
 *    `not_configured`, an unreachable backend, a timeout, a malformed score
 *    list or a skipped turn all leave the existing fused order in place and
 *    carry the reason into the turn's coverage line;
 *  - the engine name it reports is the one the ENGINE published
 *    (`mode_actually_used`), never the mode it asked for. Asking for a
 *    cross-encoder and getting a lexical answer is reported as such.
 *
 * What it does not do: re-embed, re-retrieve, recover evidence the candidate
 * stage dropped, or replace the TypeScript retrieval owner.
 */
import { mlJob } from "../ml-job";
import type { RerankCandidate, RerankStage } from "./retrieve";

export const RERANK_CAPABILITY = "rerank";
/**
 * D-068: the honest reason a turn reports when THIS retrieval owner has no
 * route to a neural reranker at all. It is deliberately runtime-neutral: the
 * Rust turn owner (`rust-backend/crates/ruke-attach/src/turn.rs`) mirrors the
 * `[ranking: ...]` line byte-for-byte, and "(the Rust backend is not
 * enabled)" is false in the deployment where the mirror runs. The sentence
 * has to be true on both sides of the wire contract, so it names the owner's
 * own route, not one runtime.
 */
export const RERANK_NO_ROUTE_REASON =
  "this retrieval owner has no neural rerank route in this deployment";
/**
 * The mode string the Python worker publishes for the pinned joint
 * cross-encoder (`retrieval/nn_rerank.py::MODE_NAME`). Matching it exactly is
 * what keeps registry, worker and caller naming one engine instead of three.
 */
export const RERANK_MODE = "neural_cross_encoder_minilm";

/** The Rust gate bounds each payload string at 4096 chars; leave headroom. */
export const RERANK_MAX_CAND_CHARS = 3000;
/** The cross-encoder scores a 256-token window; a longer passage is truncated
 *  by the engine and it reports that. We cap first so the count is ours. */
export const RERANK_DEFAULT_WINDOW = 24;
export const RERANK_DEADLINE_MS = 60_000;

export function rerankWindow(): number {
  const raw = Number(process.env.ATTACH_RERANK_CANDIDATES ?? RERANK_DEFAULT_WINDOW);
  if (!Number.isFinite(raw) || raw < 0) return RERANK_DEFAULT_WINDOW;
  return Math.min(64, Math.floor(raw));
}

/** Off switch for A/B comparison runs; ON by default. */
export function rerankEnabled(): boolean {
  return (process.env.ATTACH_RERANK ?? "on").trim().toLowerCase() !== "off";
}

function firstString(value: unknown, max = 400): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export interface RerankStageOptions {
  signal?: AbortSignal;
  /** Override for comparison runs only; defaults to the pinned cross-encoder. */
  mode?: string;
}

/**
 * Build the stage handed to `retrieveEvidenceWithRerank`. It never throws: a
 * capability failure becomes `{ order: [], reason }`, so the caller keeps the
 * order it already had and reports why.
 */
export function makeRerankStage(opts: RerankStageOptions = {}): RerankStage {
  const mode = opts.mode ?? RERANK_MODE;
  return async (query: string, candidates: RerankCandidate[]) => {
    if (!rerankEnabled()) {
      return { order: [], skipped: true, reason: "ATTACH_RERANK=off for this run" };
    }
    if (candidates.length < 2) {
      return { order: [], skipped: true, reason: "fewer than two candidates to reorder" };
    }
    if (!query.trim()) {
      return { order: [], skipped: true, reason: "the query carried no scorable text" };
    }

    let truncated = 0;
    const idToIdx = new Map<string, number>();
    const chunks = candidates.map(c => {
      const id = `c${idToIdx.size}`;
      idToIdx.set(id, c.idx);
      let text = c.text;
      if (text.length > RERANK_MAX_CAND_CHARS) {
        text = text.slice(0, RERANK_MAX_CAND_CHARS);
        truncated += 1;
      }
      return { chunk_id: id, text };
    });

    const envelope = await mlJob(
      RERANK_CAPABILITY,
      { query: query.slice(0, RERANK_MAX_CAND_CHARS), chunks, mode, top_k: chunks.length },
      { deadlineMs: RERANK_DEADLINE_MS, signal: opts.signal },
    );

    if (!envelope) {
      return {
        order: [],
        skipped: true,
        reason: RERANK_NO_ROUTE_REASON,
      };
    }
    if (envelope.state !== "ready" || !envelope.result || typeof envelope.result !== "object") {
      const err = envelope.error;
      return {
        order: [],
        skipped: err?.reason === "not_configured" || err?.reason === "model_unavailable",
        reason: err
          ? `${err.reason}: ${err.message}`
          : `the ${RERANK_CAPABILITY} job returned state=${envelope.state} with no result`,
      };
    }

    const payload = (envelope.result as { payload?: Record<string, unknown> }).payload ?? {};
    const scores = Array.isArray(payload.scores) ? payload.scores : [];
    const ordered: Array<{ idx: number; score: number }> = [];
    for (const raw of scores) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const idx = idToIdx.get(firstString(entry.chunk_id, 64));
      const score = Number(entry.score);
      if (idx === undefined || !Number.isFinite(score)) continue;
      ordered.push({ idx, score });
    }
    if (!ordered.length) {
      return {
        order: [],
        reason: `the reranker reported state=ready but no usable score list (${scores.length} entries)`,
      };
    }

    const used = firstString(payload.mode_actually_used, 120) || mode;
    const notes = [
      firstString(payload.quality_note, 300),
      firstString(payload.truncation_note, 200),
      truncated > 0
        ? `${truncated} candidate(s) were cut to ${RERANK_MAX_CAND_CHARS} characters before scoring`
        : "",
      Number(payload.returned) < Number(payload.candidate_count)
        ? `the engine returned ${String(payload.returned)} of ${String(payload.candidate_count)} scored candidates`
        : "",
    ].filter(Boolean);
    if (used !== mode) {
      notes.unshift(`asked for ${mode}, the engine reported it ran ${used}`);
    }

    return { order: ordered, engine: used, note: notes.join("; ") || undefined };
  };
}
