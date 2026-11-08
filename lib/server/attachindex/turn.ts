import fs from "node:fs";
import path from "node:path";
import { injectSystemBefore } from "../../skills/lazy";
import { embedOne } from "./embed";
import { generateNotes, notesVersion } from "./notes";
import { routeQuery, type RoutedQuery } from "./router";
import { retrieveEvidence, type RetrieveOpts } from "./retrieve";
import { indexDir, readIndex, readNotes, readShown, writeShown } from "./store";
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
// I05: one attachment's retrieve pass had a budget; the TURN did not. With
// several attachments in one chat, every one of them could pour its full
// 24k of passages into the same prompt. The turn budget caps the combined
// evidence; the model's own context window must still fit the history, the
// blocks below, and room for the reply — retrieval never reserves output
// tokens, so keep this well under the window the user's model carries.
const PER_REF_BUDGET = Number(process.env.ATTACH_RETRIEVE_CHARS ?? 24000);
const TURN_BUDGET = Number(process.env.ATTACH_TURN_BUDGET_CHARS ?? 48000);

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

/**
 * I18b: a keyframe farther than this from the asked-about moment is NOT
 * served — showing what is on screen 20 minutes away as if it belonged to
 * the discussed time would mislead the model (and the user). Serving nothing
 * beats serving a wrong anchor. ⇔ FRAME_WINDOW in ruke-attach turn.rs.
 */
const FRAME_WINDOW_SEC = 180;

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
    // I18b: the closest surviving keyframe is still outside the honesty
    // window — skip this request entirely (the frame stays available for a
    // closer one instead of being burned on a far-off moment).
    if (bestD > FRAME_WINDOW_SEC) continue;
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

// Record-honesty law (P3a 2026-11-05): the model is handed the attachment's
// saved record, never the experience of watching or hearing it — so the rules
// forbid claiming a perception channel the model does not have, while keeping
// the internal machinery invisible to the user. ⇔ ruke-attach turn.rs rules()
// must stay byte-identical (golden attachment_replay forwards these bytes).
function rules(ref: AttachmentRef): string {
  const isVideo = ref.category === "video";
  const timed = isVideo || ref.category === "audio";
  return (
    "Rules for this content: answer from the material below whenever it covers the question. " +
    "Where passages carry [HH:MM:SS - HH:MM:SS] headers, cite that header for every claim taken from it. " +
    "If the question concerns a time range or section NOT present below, state that you cannot see that part of the " +
    "content clearly enough to answer it — do not guess, and do not explain how the content was processed. " +
    (isVideo
      ? "You are given this video's complete saved record — its visuals and its speech are one thing: speak of what " +
        "the record shows about the video as a whole, and never claim to have watched, seen or heard it yourself. " +
        "Never mention transcription, retrieval, indexing, frames, sampled images or keyframes, and never attribute " +
        "content to a particular frame. Give timestamps only when the user asks for them or when a time reference " +
        "genuinely helps."
      : timed
        ? "You are given this recording's complete saved record: speak of what the recording says; never claim to " +
          "have heard it yourself, and never mention transcription, retrieval or indexing."
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
  /** I24: the model this turn answers with — notes are distilled by it and cached under it. */
  model?: string,
): Promise<number> {
  const refs = collectAttachmentRefs(messages);
  if (!refs.length) return 0;

  const blocks: string[] = [];
  const images: { url: string; at: number }[] = [];
  // Retrieval runs on the anchored query (short follow-ups inherit the
  // previous question's topic); the injected blocks still answer the user's
  // actual wording.
  //
  // I22: anchoring is for questions that carry NO retrieval intent of their
  // own. If the raw question already routes somewhere specific — timestamps,
  // "last 10 minutes", "module 3", "every mention", "summarize" — prepending
  // the previous question dilutes the exact tokens that decide the route and
  // the time window. Those questions are used verbatim.
  const trimmedQ = (question ?? "").trim();
  const direct = routeQuery(trimmedQ);
  const rq =
    trimmedQ && direct.mode !== "point_qa" ? trimmedQ : anchorQuery(question, messages, userIdx);

  // I05: the whole turn shares ONE evidence budget across attachments.
  let turnUsed = 0;

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

    // I22: "the last N minutes" has no absolute anchor until the index's own
    // duration is known. Unknown duration → honest best-effort hybrid rather
    // than a fabricated window.
    if (routed.lastSec != null) {
      const dur = index.meta.durationSec;
      if (dur && dur > 0) {
        routed.fromSec = Math.max(0, dur - routed.lastSec);
        routed.toSec = dur;
      } else {
        routed.mode = "point_qa";
      }
    }

    if (routed.mode === "whole_video") {
      // I05: notes compete for the same turn budget as evidence blocks.
      const remaining = TURN_BUDGET - turnUsed;
      if (remaining <= 0) {
        blocks.push(
          `<knowledge_index name="${ref.name}">\n` +
            `This turn's evidence budget is already full, so no content from this ` +
            `attachment was retrieved for it. Ask the question again in a new turn.\n</knowledge_index>`,
        );
        continue;
      }
      // I24: the cache is only trusted when it was distilled from THIS index
      // by THIS model; a model switch or re-index invalidates it.
      const version = notesVersion(index, model ?? "default");
      let notes = readNotes(ref.attId, version);
      if (!notes) notes = (await generateNotes(ref.attId, index, signal, model)) || null;
      if (notes) {
        const cap = Math.min(NOTES_BUDGET, remaining);
        if (notes.length > cap) notes = notes.slice(0, cap) + "\n[...]";
        turnUsed += notes.length;
        blocks.push(
          `<course_notes name="${ref.name}">\n` +
            `Course notes distilled from the extracted content of "${ref.name}":\n` +
            `${notes}\n${rules(ref)} Cite the [HH:MM:SS] block headers of the notes.\n</course_notes>`,
        );
      }
      continue;
    }

    let queryVec: number[] = [];
    try {
      // I25: the browser walking away must release the shared model slot —
      // the signal gates the wait before load and between batches.
      queryVec = await embedOne(rq, signal);
    } catch {
      // Embed model unavailable: BM25 alone still ranks the passages.
    }

    // I20: passages an earlier turn already served for this attachment are
    // demoted, so "keep going" surfaces NEW content instead of the same hits.
    const shown = readShown(ref.attId);

    // I05: the attachment competes for the turn's REMAINING budget.
    const remaining = TURN_BUDGET - turnUsed;
    if (remaining <= 0) {
      blocks.push(
        `<knowledge_index name="${ref.name}">\n` +
          `This turn's evidence budget is already full, so no passages from this ` +
          `attachment were retrieved for it. Ask the question again in a new turn.\n</knowledge_index>`,
      );
      continue;
    }
    const budget = Math.min(PER_REF_BUDGET, remaining);

    let opts: RetrieveOpts = { ...routed, demote: shown, budget };
    if (routed.mode === "sequential") {
      const blk = index.meta.spineBlocks?.[routed.blockIndex ?? -1];
      opts = blk
        ? { mode: "sequential", range: { from: blk.chunkFrom, to: blk.chunkTo }, demote: shown, budget }
        : { mode: "point_qa", demote: shown, budget }; // "module 9" in a 3-block spine → best-effort hybrid
    }

    const ev = retrieveEvidence(index, rq, queryVec, opts);
    if (!ev.text) continue;

    blocks.push(
      `<knowledge_index name="${ref.name}">\n` +
        `Passages retrieved from the complete content of "${ref.name}" ` +
        `(the full text is preserved locally — nothing was truncated):\n${ev.text}` +
        // I20: an honest COUNT of what the budget left out, not a vague
        // "more exist". Ask-to-continue works because of the shown ledger.
        (ev.dropped > 0
          ? `\n[${ev.dropped} more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]`
          : ev.truncated
            ? "\n[more relevant passages exist; this turn's budget showed the best ones]"
            : "") +
        `\n${rules(ref)}\n</knowledge_index>`,
    );
    turnUsed += ev.text.length;
    if (ev.chunkIdxs.length) writeShown(ref.attId, [...new Set([...shown, ...ev.chunkIdxs])]);
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
          "Moments from the attached video nearest to the discussed time range — they come from the video's saved " +
          "record; describe them as things that happen in the video, never as frames:",
      });
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
      msg.content = parts;
    }
  }
  if (blocks.length) injectSystemBefore(messages, userIdx, blocks.join("\n\n"));
  return blocks.length;
}
