import fs from "node:fs";
import path from "node:path";
import { injectSystemBefore } from "../../skills/lazy";
import { embedOne } from "./embed";
import { generateNotes, notesVersion } from "./notes";
import {
  fingerprintQuery,
  isContinuationAsk,
  routeQuery,
  type RouteAxis,
  type RoutedQuery,
} from "./router";
import {
  retrieveEvidenceWithRerank,
  type RankedEvidence,
  type RetrieveOpts,
} from "./retrieve";
import { makeRerankStage, rerankWindow } from "./rerank";
import { indexDir, readIndex, readNotes, readShownEntry, writeShown } from "./store";
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
    // F76 numeric-fidelity law ⇔ ruke-attach rules() base; rides EVERY
    // indexed category (figures live in documents, slides and speech alike).
    "When quoting a figure from the material, keep its exact digits and digit grouping. When restating " +
    "a figure in different units or a different grouping convention, state the exact conversion being " +
    "applied and verify the restated figure has the same value; never give two versions of one figure " +
    "that have different values. This applies to every restated version anywhere in the answer, " +
    "including brief asides. " +
    (isVideo
      ? "This video's complete saved record is kept locally and you are shown the parts of it that matter to this " +
        "question — its visuals and its speech are one thing: speak of what " +
        "the record shows about the video as a whole, and never claim to have watched, seen or heard it yourself. " +
        "Never mention transcription, retrieval, indexing, frames, sampled images or keyframes, and never attribute " +
        "content to a particular frame. Give timestamps only when the user asks for them or when a time reference " +
        "genuinely helps."
      : timed
        ? "This recording's complete saved record is kept locally and you are shown the parts that matter to this " +
          "question: speak of what the recording says; never claim to " +
          "have heard it yourself, and never mention transcription, retrieval or indexing."
        : "You have read this document directly; never mention retrieval or indexing.")
  );
}

const FOLLOWUP_MAX = 60;
// §6: same Unicode word class as the router (⇔ ruke-attach router.rs
// `pronoun_re` + `is_word_char`), so pronouns glued inside non-ASCII words
// ("caféit") are never counted; JS `\b` counted them because é was not an
// ASCII word byte. Variable-width lookbehind + \p classes need the `u` flag.
const wordBoundaryRe = (body: string, flags: string) =>
  new RegExp(
    `${String.raw`(?<![\p{L}\p{N}\p{M}_])(?:${body})(?![\p{L}\p{N}\p{M}_])`}`,
    `${flags}u`,
  );
const PRONOUN_RE = wordBoundaryRe(
  "why|how come|that|this|these|those|it|its|they|them|there|here",
  "gi",
);

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
  /** F07: the conversation this turn belongs to; the shown ledger is scoped to it. */
  conversationId?: string,
): Promise<number> {
  const refs = collectAttachmentRefs(messages);
  if (!refs.length) return 0;

  const blocks: string[] = [];
  const images: { url: string; at: number }[] = [];
  // Which query the retrieval runs on (F07, 2026-11-15): RAW FIRST. The raw
  // question keeps its own tokens, so an explicit phrase ("every mention",
  // "summarize", "at 1:45") still decides the route and the time window, and
  // an unrelated short follow-up is no longer glued onto the previous topic.
  // anchorQuery stays available as a BOUNDED FALLBACK, consulted only when
  // the raw question retrieved nothing at all for an attachment.
  const trimmedQ = (question ?? "").trim();
  // F07 (2026-11-15) RAW-FIRST. The previous question used to be prepended
  // eagerly for any short follow-up, so an UNRELATED short question ("what
  // about the CPU fan?") inherited the previous whale question and retrieved
  // whale passages for it. The raw question is now the retrieval query; the
  // antecedent is consulted only if the raw question found NOTHING at all
  // (bounded to one extra attempt per attachment, below). Routing decisions
  // are never diluted by an antecedent either.
  const anchored = anchorQuery(question, messages, userIdx);
  const rawQ = trimmedQ || anchored;

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

    // F07: the time axis comes from the INDEX, never from the attachment's
    // name or a guess about its category. No duration and no timed chunk means
    // this content has no timeline, so a "1:20" ratio inside a document must
    // not invent a video window.
    const axis: RouteAxis =
      (index.meta.durationSec ?? 0) > 0 || index.chunks.some(c => c.startSec != null)
        ? "time"
        : "text";
    const routed: RoutedQuery = routeQuery(rawQ, { axis });

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
      queryVec = await embedOne(rawQ, signal);
    } catch {
      // Embed model unavailable: BM25 alone still ranks the passages.
    }

    // I20 + F07: the "already shown" ledger is scoped to THIS conversation and
    // records WHICH query produced it. An exact repeat of a question this
    // conversation already answered from this attachment gets its own top
    // passages BACK (reproduced: a repeated exact question lost its answer
    // because the passages it had been shown were demoted below unrelated
    // text). Exhaustive scans and explicit continuation asks rotate instead,
    // so "keep going" still surfaces fresh material.
    const queryFp = fingerprintQuery(rawQ);
    const entry = readShownEntry(ref.attId, conversationId);
    const shownFor = entry?.ids ?? [];
    const repeatAsk = !!entry && entry.q !== "" && entry.q === queryFp;
    const scanMode = routed.mode === "exhaustive";
    const demote = repeatAsk && !scanMode && !isContinuationAsk(rawQ) ? [] : shownFor;

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

    let opts: RetrieveOpts = { ...routed, demote, budget };
    if (routed.mode === "sequential") {
      const blk = index.meta.spineBlocks?.[routed.blockIndex ?? -1];
      opts = blk
        ? { mode: "sequential", range: { from: blk.chunkFrom, to: blk.chunkTo }, demote, budget }
        : { mode: "point_qa", demote, budget }; // "module 9" in a 3-block spine → best-effort hybrid
    }

    // D-058: one neural rerank stage per attachment turn, shared by the raw
    // question and the anchored fallback. It is additive: when it cannot run,
    // the fused order stands and `ev.rerank` says exactly why.
    const rerankStage = makeRerankStage({ signal });
    const window = rerankWindow();
    let ev: RankedEvidence = await retrieveEvidenceWithRerank(
      index,
      rawQ,
      queryVec,
      opts,
      rerankStage,
      window,
    );

    // F07: anchored fallback, LAZILY and at most once more. Only when the raw
    // question found nothing at all does the previous question's topic get
    // prepended; the routing decision stays the raw question's own.
    if (!ev.text && anchored && anchored !== rawQ) {
      let fallbackVec: number[] = [];
      try {
        fallbackVec = await embedOne(anchored, signal);
      } catch {
        // Same seam: BM25 alone still ranks the passages.
      }
      ev = await retrieveEvidenceWithRerank(
        index,
        anchored,
        fallbackVec,
        opts,
        rerankStage,
        window,
      );
    }
    if (!ev.text) continue;

    // F14: machine-readable COVERAGE, inside the block the model actually
    // reads. Every number is read off THIS turn's retrieval (never inferred),
    // and the ranking mode is reported honestly: a lexical-only pass must not
    // be dressed up as semantic retrieval. The selection law stays intact --
    // a file that exists locally is not evidence that any given part of it was
    // READ. New text is ASCII-only so the Rust mirror can be byte-identical.
    const frames = nearestFrames(index, ev.frameAts);
    const totalChunks = index.meta.chunkCount || index.chunks.length;
    const totalFrames = index.meta.frames?.length ?? 0;
    const covered =
      `\n[coverage: ${ev.chunkIdxs.length} of ${totalChunks} indexed passages of "${ref.name}" were shown this turn` +
      (ev.dropped > 0
        ? `; ${ev.dropped} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)`
        : ev.truncated
          ? "; more passages matched than this turn's budget could show"
          : "; no matched passage was withheld from this turn") +
      `; ranking mode: ${ev.vectorMode === "hybrid" ? "semantic + lexical" : "lexical only"}` +
      (ev.vectorReason ? ` (${ev.vectorReason})` : "") +
      (totalFrames > 0 ? `; ${frames.length} of ${totalFrames} saved keyframes shown` : "") +
      " -- anything outside this selection was NOT read this turn]";

    // D-058: the reranker's own honesty line, kept OUT of the mirrored
    // [coverage: ...] marker so the Rust mirror of that marker stays
    // byte-identical. ASCII-only. It names the ranker the ENGINE reported,
    // how many passages it actually scored, and never implies a ranker ran
    // when the stage was skipped, refused or unreachable.
    const rk = ev.rerank;
    const rankLine =
      `\n[ranking: ` +
      (rk.mode === "neural"
        ? `${rk.engine ?? "neural reranker"} re-ordered ${rk.scored} of the ${rk.candidates} passages the retrieval ranked for it; ${rk.changed} position(s) changed`
        : rk.mode === "structural_selection"
          ? `no neural rerank (${rk.reason ?? "this selection is ordered by the source's own structure"})`
          : `the fused ${ev.vectorMode === "hybrid" ? "semantic + lexical" : "lexical"} order stands; no neural rerank ran (${rk.reason ?? "not attempted"})`) +
      (rk.mode === "neural" && rk.unscored > 0
        ? `; ${rk.unscored} passage(s) in the window were never scored and kept their fused position below the scored ones`
        : "") +
      (rk.note ? `; ${rk.note}` : "") +
      " -- passages the retrieval did not rank were never seen by the reranker]";

    blocks.push(
      `<knowledge_index name="${ref.name}">\n` +
        `Passages relevant to this question, retrieved from "${ref.name}" ` +
        `(its complete text is preserved locally — the passages below are the parts the retrieval matched):\n${ev.text}` +
        // I20: an honest COUNT of what the budget left out, not a vague
        // "more exist". Ask-to-continue works because of the shown ledger.
        (ev.dropped > 0
          ? `\n[${ev.dropped} more relevant passages exist in this document that this turn's budget did not show — ask to continue and a different set is served]`
          : ev.truncated
            ? "\n[more relevant passages exist; this turn's budget showed the best ones]"
            : "") +
        covered +
        rankLine +
        `\n${rules(ref)}\n</knowledge_index>`,
    );
    turnUsed += ev.text.length;
    if (ev.chunkIdxs.length)
      writeShown(ref.attId, [...new Set([...shownFor, ...ev.chunkIdxs])], {
        conversationId,
        queryFp,
      });
    images.push(...frames);
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
          // F76 (2026-11-21): the sampling law. Two delivered instants say nothing
          // about the time BETWEEN them, and without this line the model fills that
          // gap ("visible throughout the clip"). Byte-identical to FRAME_LEAD_IN in
          // ruke-attach/src/turn.rs (the attachment goldens replay these bytes) and
          // to VIDEO_MOMENTS_LAW in lib/chat/client.ts.
          "Moments from the attached video nearest to the discussed time range — they come from the video's saved " +
          "record; describe them as things that happen in the video, never as frames:" +
          " The images are isolated moments: the record holds no evidence about the time between, before or after them. " +
          "Never claim that something is visible throughout a video, always or never shown, or unchanged across any " +
          "stretch between two shown moments; when asked about such a stretch, answer from the shown moments and say " +
          "the rest cannot be confirmed.",
      });
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
      msg.content = parts;
    }
  }
  if (blocks.length) injectSystemBefore(messages, userIdx, blocks.join("\n\n"));
  return blocks.length;
}
