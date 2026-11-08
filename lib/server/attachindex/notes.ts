import { childLogger } from "../logger";
import { llmApiUrl, llmApiKey } from "../settings";
import { fmtStamp } from "./format";
import { writeNotes } from "./store";
import type { LoadedIndex } from "./types";

/**
 * I24: fingerprint of everything the cached notes were distilled from — the
 * answering model, the chunk set, and the spine-block boundaries. Stored in
 * notes.json and re-checked on every whole-content request, so switching
 * models or re-indexing the attachment invalidates the cache INSTEAD of
 * serving notes some other pipeline wrote. Deliberately integer-only fields:
 * float timestamps would format differently across the TS/Rust boundary.
 */
export function notesVersion(index: LoadedIndex, model: string): string {
  const blocks = index.meta.spineBlocks ?? [];
  const totalChars = index.chunks.reduce((n, c) => n + c.text.length, 0);
  return `v1|${model}|${index.chunks.length}|${totalChars}|${blocks.length}:${blocks
    .map(b => `${b.chunkFrom}-${b.chunkTo}`)
    .join(",")}`;
}

/**
 * Lazy course notes: one non-streaming pass per spine block through the
 * shared local model, cached to notes.json. Only generated when the user
 * actually asks for a whole-content summary — zero LLM cost otherwise.
 */

const log = childLogger("attachindex/notes");

async function noteForBlock(
  header: string,
  body: string,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(llmApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + llmApiKey(),
    },
    body: JSON.stringify({
      model,
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

/**
 * Generate + cache course notes for every spine block. Never throws.
 *
 * I24: `model` is the real model id the chat turn uses (previously hardcoded
 * "default"), and the notes cache is only written when EVERY emitted block
 * came from the model. A degraded run — any block falling back to the
 * spine's own opening/closing line — returns that text for THIS turn but is
 * NEVER cached: the fallback summary masquerading as "distilled notes" would
 * otherwise stick around forever, and the next turn would never retry.
 */
export async function generateNotes(
  attId: string,
  index: LoadedIndex,
  signal?: AbortSignal,
  model = "default",
): Promise<string> {
  const parts: string[] = [];
  let allModelProduced = true;
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
      note = await noteForBlock(header, body, model, signal);
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") throw err;
      log.warn({ attId, err: (err as Error).message }, "note block generation failed");
    }
    // Model unavailable / failed: degrade to the block's own spine summary.
    if (note) parts.push(`${header}\n${note}`);
    else {
      allModelProduced = false;
      parts.push(`${header}\n${blk.opening} ... ${blk.closing}`);
    }
  }

  const notes = parts.join("\n\n").trim();
  if (notes && allModelProduced) {
    try {
      writeNotes(attId, notes, notesVersion(index, model));
    } catch {
      // Cache write failure must not lose the notes we just made.
    }
  }
  return notes;
}
