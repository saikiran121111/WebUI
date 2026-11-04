import fs from "node:fs";
import path from "node:path";
import { injectSystemBefore } from "../../skills/lazy";
import { embedOne } from "./embed";
import { generateNotes } from "./notes";
import { routeQuery, type RoutedQuery } from "./router";
import { retrieveEvidence, type RetrieveOpts } from "./retrieve";
import { indexDir, readIndex, readNotes } from "./store";
import type { LoadedIndex } from "./types";

/**
 * The per-turn half of the knowledge index. The client's history carries a
 * slim `attachment_ref` part (invisible to extractUserText); on every turn
 * this module finds those refs, retrieves timestamped evidence for the
 * CURRENT question, and injects it as one ephemeral system block + nearest
 * keyframes. The payload is a server-side copy — the client's stored
 * conversation never receives the evidence, so retrieved passages exist for
 * this turn only and never pile up across history.
 */

const ATT_RE = /^att_[a-z0-9]{4,32}$/;
const MAX_FRAMES = 4;
const NOTES_BUDGET = Number(process.env.ATTACH_RETRIEVE_CHARS ?? 24000);

export interface AttachmentRef {
  attId: string;
  name: string;
  category: string;
}

/** Unique attachment_ref parts across ALL messages (follow-ups resolve too). */
export function collectAttachmentRefs(messages: any[]): AttachmentRef[] {
  const seen = new Map<string, AttachmentRef>();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (part?.type !== "attachment_ref" || typeof part.att_id !== "string") continue;
      if (!ATT_RE.test(part.att_id) || seen.has(part.att_id)) continue;
      seen.set(part.att_id, {
        attId: part.att_id,
        name: typeof part.name === "string" && part.name ? part.name : part.att_id,
        category: typeof part.category === "string" ? part.category : "text",
      });
    }
  }
  return [...seen.values()];
}

/**
 * llama-server's chat template only knows text/image_url parts — every
 * attachment_ref must be gone before the payload goes upstream.
 */
export function stripAttachmentRefs(messages: any[]): void {
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      m.content = m.content.filter((p: any) => p?.type !== "attachment_ref");
    }
  }
}

function nearestFrames(index: LoadedIndex, frameAts: number[]): { url: string; at: number }[] {
  const frames = index.meta.frames ?? [];
  if (!frames.length || !frameAts.length) return [];
  const used = new Set<number>();
  const out: { url: string; at: number }[] = [];
  for (const at of frameAts) {
    let best = -1;
    let bestD = Infinity;
    frames.forEach((f, k) => {
      if (used.has(k)) return;
      const d = Math.abs(f.at - at);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best === -1) break;
    used.add(best);
    try {
      const buf = fs.readFileSync(path.join(indexDir(index.meta.attId), frames[best].file));
      out.push({ url: "data:image/jpeg;base64," + buf.toString("base64"), at: frames[best].at });
    } catch {
      // Frame file missing on disk — the transcript evidence still stands.
    }
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

function rules(ref: AttachmentRef): string {
  const isVideo = ref.category === "video";
  const timed = isVideo || ref.category === "audio";
  return (
    "Rules for this content: answer from the material below whenever it covers the question. " +
    "Where passages carry [HH:MM:SS - HH:MM:SS] headers, cite that header for every claim taken from it. " +
    "If the question concerns a time range or section NOT present below, state that you cannot see that part of the " +
    "content clearly enough to answer it — do not guess, and do not explain how the content was processed. " +
    (isVideo
      ? "You have watched this video from start to finish — its visuals and its speech are one thing: speak of what " +
        "you see and hear in the video as a whole. Never mention transcription, retrieval, indexing, frames, sampled " +
        "images or keyframes, and never attribute content to a particular frame. Give timestamps only when the user " +
        "asks for them or when a time reference genuinely helps."
      : timed
        ? "You have heard this recording directly: speak of what you hear; never mention transcription, retrieval or indexing."
        : "You have read this document directly; never mention retrieval or indexing.")
  );
}

const FOLLOWUP_MAX = 60;
const PRONOUN_RE = /\b(why|how come|that|this|these|those|it|its|they|them|there|here)\b/gi;

/**
 * Multi-turn follow-up guard: a short ("why does that happen?") or
 * pronoun-heavy prompt carries few topic words, so BM25 and the embedding
 * drift off the active subject. Anchor those to the PREVIOUS user question
 * (the first text part of it — attachment/spine parts come after the
 * question) so retrieval stays on topic. Questions long enough to carry
 * their own subject are used verbatim.
 */
export function anchorQuery(question: string, messages: any[], userIdx: number): string {
  const q = (question ?? "").trim();
  if (!q) return q;
  const pronouns = (q.match(PRONOUN_RE) ?? []).length;
  const followup = q.length < FOLLOWUP_MAX || (q.length < 140 && pronouns >= 2);
  if (!followup) return q;

  for (let i = userIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const prev = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? String(m.content.find((p: any) => p?.type === "text" && p.text)?.text ?? "")
        : "";
    const t = prev.trim();
    if (t) return `${t.slice(0, 300)} ${q}`;
  }
  return q;
}

/**
 * Build and inject this turn's evidence. `userIdx` is the CURRENT index of
 * the last user message in `messages` (callers that already injected a
 * system block must pass the shifted index). Returns the number of injected
 * blocks (0 = nothing to do). Never throws — a retrieval failure degrades to
 * the spine/preview the client already put in history.
 */
export async function buildAttachmentTurn(
  messages: any[],
  userIdx: number,
  question: string,
  signal?: AbortSignal,
): Promise<number> {
  const refs = collectAttachmentRefs(messages);
  if (!refs.length) return 0;

  const blocks: string[] = [];
  const images: { url: string; at: number }[] = [];
  // Retrieval runs on the anchored query (short follow-ups inherit the
  // previous question's topic); the injected blocks still answer the user's
  // actual wording.
  const rq = anchorQuery(question, messages, userIdx);

  for (const ref of refs) {
    const index = readIndex(ref.attId);
    if (!index) {
      blocks.push(
        `<knowledge_index name="${ref.name}">\n` +
          `The local knowledge index for this attachment is no longer available on disk. ` +
          `Say so honestly if the question needs it.\n</knowledge_index>`,
      );
      continue;
    }

    const routed: RoutedQuery = routeQuery(rq);

    if (routed.mode === "whole_video") {
      let notes = readNotes(ref.attId);
      if (!notes) notes = (await generateNotes(ref.attId, index, signal)) || null;
      if (notes) {
        if (notes.length > NOTES_BUDGET) notes = notes.slice(0, NOTES_BUDGET) + "\n[...]";
        blocks.push(
          `<course_notes name="${ref.name}">\n` +
            `Course notes distilled from the COMPLETE content of "${ref.name}" (every part was read):\n` +
            `${notes}\n${rules(ref)} Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>`,
        );
      }
      continue;
    }

    let queryVec: number[] = [];
    try {
      queryVec = await embedOne(rq);
    } catch {
      // Embed model unavailable: BM25 alone still ranks the passages.
    }

    let opts: RetrieveOpts = routed;
    if (routed.mode === "sequential") {
      const blk = index.meta.spineBlocks?.[routed.blockIndex ?? -1];
      opts = blk
        ? { mode: "sequential", range: { from: blk.chunkFrom, to: blk.chunkTo } }
        : { mode: "point_qa" }; // "module 9" in a 3-block spine → best-effort hybrid
    }

    const ev = retrieveEvidence(index, rq, queryVec, opts);
    if (!ev.text) continue;

    blocks.push(
      `<knowledge_index name="${ref.name}">\n` +
        `Passages retrieved from the complete content of "${ref.name}" ` +
        `(the full text is preserved locally — nothing was truncated):\n${ev.text}` +
        (ev.truncated ? "\n[more relevant passages exist; this turn's budget showed the best ones]" : "") +
        `\n${rules(ref)}\n</knowledge_index>`,
    );
    images.push(...nearestFrames(index, ev.frameAts));
  }

  if (!blocks.length && !images.length) return 0;

  // Keyframes ride at the END of the user turn (the template appends media
  // after text); the evidence itself is one system block right before it.
  if (images.length) {
    const msg = messages[userIdx];
    if (msg) {
      const parts = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
      parts.push({
        type: "text",
        text:
          "Moments from the attached video nearest to the discussed time range — they are part of the video you " +
          "watched; describe them as things that happen in the video, never as frames:",
      });
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
      msg.content = parts;
    }
  }
  if (blocks.length) injectSystemBefore(messages, userIdx, blocks.join("\n\n"));
  return blocks.length;
}
