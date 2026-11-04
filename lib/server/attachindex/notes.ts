import { childLogger } from "../logger";
import { llmApiUrl, llmApiKey } from "../settings";
import { fmtStamp } from "./format";
import { writeNotes } from "./store";
import type { LoadedIndex } from "./types";

/**
 * Lazy course notes: one non-streaming pass per spine block through the
 * shared local model, cached to notes.json. Only generated when the user
 * actually asks for a whole-content summary — zero LLM cost otherwise.
 */

const log = childLogger("attachindex/notes");

async function noteForBlock(
  header: string,
  body: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(llmApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + llmApiKey(),
    },
    body: JSON.stringify({
      model: "default",
      stream: false,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You are given consecutive passages from one lecture recording, in order. " +
            "Write dense hierarchical notes (short heading + bullets) that capture every " +
            "fact, definition, number, step and example in these passages. Do not invent " +
            "anything not said. Output the notes only — no preamble.",
        },
        { role: "user", content: `${header}\n${body}` },
      ],
    }),
    // Same zombie-generation lesson as the chat route: if the browser walks
    // away, the shared inference slot must be released immediately.
    signal,
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

/** Generate + cache course notes for every spine block. Never throws. */
export async function generateNotes(
  attId: string,
  index: LoadedIndex,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  for (const blk of index.meta.spineBlocks ?? []) {
    const body = index.chunks
      .filter((c) => c.i >= blk.chunkFrom && c.i <= blk.chunkTo)
      .map((c) => c.text)
      .join(" ");
    if (!body.trim()) continue;

    const header =
      blk.startSec != null
        ? `[${fmtStamp(blk.startSec)} - ${fmtStamp(blk.endSec ?? blk.startSec)}]`
        : `[${blk.keywords.join(", ") || "notes"}]`;

    let note: string | null = null;
    try {
      note = await noteForBlock(header, body, signal);
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") throw err;
      log.warn({ attId, err: (err as Error).message }, "note block generation failed");
    }
    // Model unavailable / failed: degrade to the block's own spine summary.
    parts.push(note ? `${header}\n${note}` : `${header}\n${blk.opening} ... ${blk.closing}`);
  }

  const notes = parts.join("\n\n").trim();
  if (notes) {
    try {
      writeNotes(attId, notes);
    } catch {
      // Cache write failure must not lose the notes we just made.
    }
  }
  return notes;
}
