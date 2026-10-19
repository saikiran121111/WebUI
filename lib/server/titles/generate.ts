/**
 * Title generation through the SAME main conversation model as chat
 * (LLM_API_URL — never the LFM2.5 decision router; JEV keeps routing only).
 *
 * Tiny budget by design: one non-streaming call with ~24 output tokens for a
 * short conversation; a long one goes through chronological chunk summaries
 * (map) and a final title pass over the summaries (reduce) — the whole
 * conversation always informs the title, never just its first or last part.
 *
 * callModel is injectable so unit tests never touch real inference.
 */

import { childLogger } from "../logger";
import {
  buildTranscript,
  chunkTurns,
  formatTranscript,
  transcriptChars,
} from "./transcript";

const LLM_URL = process.env.LLM_API_URL ?? "http://127.0.0.1:8080/v1/chat/completions";
const API_KEY = process.env.LLM_API_KEY ?? "no-key";

const log = childLogger("titles");

/** Whole-conversation single-pass budget (~3k tokens for the local model). */
export const TITLE_TRANSCRIPT_CHARS = 12000;
/** Chronological chunk budget for the map-reduce path. */
export const TITLE_CHUNK_CHARS = 5000;

export const TITLE_SYSTEM =
  "You write the single best sidebar title for one past conversation. " +
  "Read the whole conversation in order and name its central, recurring subject — " +
  "not the first message, not the latest message, not the longest reply. " +
  "Title rules: 3 to 7 words; at most 60 characters; specific (name the actual " +
  "subject or task); natural and human-readable; never copy a prompt sentence; " +
  "one topic only, no subtopic lists; factual, invent nothing; no quotes, no " +
  '"Title:" prefix, no trailing punctuation, no explanation. ' +
  "Reply with ONLY the title text on a single line.";

export const SUMMARY_SYSTEM =
  "These are consecutive messages from one part of a longer conversation. " +
  "In ONE line of at most 15 words, state what this part is about, including " +
  "any topic shift. Reply with the line only — no preamble, no quotes.";

export type CallModel = (
  system: string,
  user: string,
  opts: { model: string; maxTokens: number; signal?: AbortSignal },
) => Promise<string | null>;

/**
 * Hard ceiling on one title model call. A background job must never hold the
 * single shared inference slot indefinitely — observed in Playwright: an
 * unbounded non-streaming title fetch (cold model load) ran past the test
 * timeout and starved the NEXT test's user stream.
 */
export const TITLE_CALL_TIMEOUT_MS = 150_000;

/** Default transport: non-streaming call to the main model (same pattern as
 * lib/server/attachindex/notes.ts). Returns null on any upstream failure;
 * throws only on abort (the queue turns that into a graceful yield). */
export const callMainModel: CallModel = async (system, user, { model, maxTokens, signal }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TITLE_CALL_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API_KEY,
      },
      body: JSON.stringify({
        model: model || "default",
        stream: false,
        temperature: 0.2,
        max_tokens: maxTokens,
        // The main model is a thinking model: without this the whole tiny
        // output budget goes to reasoning_content and message.content comes
        // back null (verified against llama.cpp) — no title would ever land.
        // Chat turns keep thinking ON (product behaviour); only these
        // background title/summary calls disable it.
        reasoning_effort: "none",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Coerce whatever the model produced into a safe sidebar title (or null).
 * Handles the common misbehaviours: quoted titles, "Title:" prefixes,
 * numbered candidate lists, multi-line replies, intro sentences, and
 * over-long output (truncated on a word boundary at the 60-char limit).
 */
export function normalizeTitle(raw: string | null): string | null {
  if (!raw) return null;
  let t = raw.split(/\r?\n/)[0] ?? "";
  t = t.replace(/^\s*(?:suggested\s+)?(?:conversation\s+)?title\s*[:\-–—]\s*/i, "");
  t = t.replace(/^\s*[-*•]\s+/, "").replace(/^\s*\d+[.)]\s+/, "");
  t = t.replace(
    /^\s*(?:this|the)\s+conversation\s+(?:is\s+about|covers|discusses|deals\s+with|is\s+regarding|revolves\s+around)\s+/i,
    "",
  );
  // Punctuation and quotes interleave ("Title".) — peel them in rounds.
  t = t.replace(/[.!?;:]+$/, "").replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").replace(/[.!?;:]+$/, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length < 2) return null;
  // Prose/refusal guard: a real sidebar title never contains an internal
  // sentence break or a first-person refusal — that is the model explaining
  // itself, and an explanation must never reach the sidebar.
  if (/\.\s+\S/.test(t)) return null;
  if (/\b(?:I|we)\s+(?:can(?:not|'t)|will\s+not|am\s+unable|don'?t\s+know)\b/i.test(t)) return null;
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const sp = cut.lastIndexOf(" ");
    t = (sp >= 40 ? cut.slice(0, sp) : cut).replace(/[.!?;:,\s]+$/, "").trim();
  }
  // A >12-word "title" after truncation is a sentence, not a title.
  if (t.split(/\s+/).length > 12) return null;
  return t.length >= 2 ? t : null;
}

/**
 * Produce a title for the conversation, or null (never throws).
 * Requires at least one non-empty assistant turn — an initial title is only
 * worth making once a meaningful reply exists.
 */
export async function planTitle(
  messages: unknown[],
  opts: { model?: string; callModel?: CallModel; signal?: AbortSignal } = {},
): Promise<string | null> {
  const call = opts.callModel ?? callMainModel;
  const model = opts.model || "default";
  const signal = opts.signal;
  const turns = buildTranscript(messages);
  if (!turns.some((t) => t.role === "assistant")) return null;

  try {
    if (transcriptChars(turns) <= TITLE_TRANSCRIPT_CHARS) {
      const raw = await call(TITLE_SYSTEM, formatTranscript(turns), { model, maxTokens: 24, signal });
      return normalizeTitle(raw);
    }

    // Long conversation: chronological chunk summaries, then the title from
    // the summaries — every part contributes, nothing is silently dropped.
    const chunks = chunkTurns(turns, TITLE_CHUNK_CHARS);
    const summaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const s = await call(SUMMARY_SYSTEM, `Part ${i + 1} of ${chunks.length}:\n${formatTranscript(chunks[i])}`, {
        model,
        maxTokens: 48,
        signal,
      });
      const line = s?.replace(/\s+/g, " ").trim();
      if (line) summaries.push(line);
    }
    if (!summaries.length) return null;
    const raw = await call(TITLE_SYSTEM, summaries.join("\n"), { model, maxTokens: 24, signal });
    return normalizeTitle(raw);
  } catch (err: unknown) {
    // Model down / timeout / bad JSON: the caller keeps the last valid title.
    log.warn({ err: (err as Error)?.message }, "title model call failed");
    return null;
  }
}
