import fs from "node:fs";
import path from "node:path";
import { injectSystemBefore } from "../../skills/lazy";
import { embedOne } from "./embed";
import type { FreshAsrOutcome, FreshAsrReader } from "./audio-reread";
import type { FrameSeekOutcome, SeekFramesReader } from "./frame-seek";
import type { RegionReader, RereadOutcome } from "./reread";
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
import { fmtStamp } from "./format";
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

/**
 * The asked moments behind a routed time_range question. The router builds
 * each cue window as [c-180, c+180] CLIPPED to the recording's length; the
 * midpoint of a clipped window is NOT the asked instant (a cue at 00:00:45 →
 * window [0, 225] → midpoint 00:01:53 would mislabel what the user asked).
 * Un-clip from the edge that was clipped; midpoint only when the window is
 * full width. ⇔ cue_moments in ruke-attach turn.rs (F78 law, F153 shared).
 */
function cueMoments(routed: RoutedQuery, dur: number): number[] {
  const cueAt = (w: { fromSec: number; toSec: number }): number => {
    const mid = (w.fromSec + w.toSec) / 2;
    if (w.toSec - w.fromSec >= 2 * FRAME_WINDOW_SEC) return mid;
    if (w.fromSec <= 0.5) return Math.max(0, w.toSec - FRAME_WINDOW_SEC);
    if (dur > 0 && w.toSec >= dur - 0.5) return w.fromSec + FRAME_WINDOW_SEC;
    return mid;
  };
  return (
    routed.windows?.length
      ? routed.windows.map(cueAt)
      : [cueAt({ fromSec: routed.fromSec ?? 0, toSec: routed.toSec ?? 0 })]
  ).slice(0, MAX_FRAMES);
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
    // I18b: the closest surviving keyframe is still outside the honesty
    // window — skip this request entirely (the frame stays available for a
    // closer one instead of being burned on a far-off moment).
    if (bestD > FRAME_WINDOW_SEC) continue;
    used.add(best);
    try {
      const buf = fs.readFileSync(path.join(indexDir(index.meta.attId), frames[best].file));
      // Mime by extension, the nearest_unit_frames law: video keyframes are
      // JPEG, renderer/seek frames are PNG. A PNG served under a jpeg prefix
      // is a broken picture in the model's eyes.
      const mime = frames[best].file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      out.push({ url: `data:${mime};base64,` + buf.toString("base64"), at: frames[best].at });
    } catch {
      // Frame file missing on disk — the transcript evidence still stands.
    }
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/**
 * F152: labelled document frames ride with the retrieval ONLY for the units
 * the winning passages themselves name — a chart page's picture is served
 * exactly when a retrieved passage carries that page's header, never as some
 * neighbour's picture. Document frames sit on the UNIT-ordinal axis (pages/
 * slides/sheets), not seconds, so the honesty window is an exact match: a
 * frame no passage names is not shown at all. ⇔ nearest_unit_frames in
 * ruke-attach turn.rs.
 */
function unitFrames(
  index: LoadedIndex,
  cues: number[],
): { url: string; at: number; label: string }[] {
  const frames = index.meta.frames ?? [];
  if (!frames.length || !cues.length) return [];
  const used = new Set<number>();
  const out: { url: string; at: number; label: string }[] = [];
  for (const cue of cues) {
    frames.forEach((f, k) => {
      if (out.length >= MAX_FRAMES) return;
      if (used.has(k) || !f.label || f.at !== cue) return;
      used.add(k);
      try {
        const buf = fs.readFileSync(path.join(indexDir(index.meta.attId), f.file));
        // Document frames are PNG (renderer output); video keyframes are JPEG.
        const mime = /\.png$/i.test(f.file) ? "image/png" : "image/jpeg";
        out.push({ url: `data:${mime};base64,` + buf.toString("base64"), at: f.at, label: f.label });
      } catch {
        // Frame file missing on disk — the text evidence still stands.
      }
    });
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

/**
 * F153 §3: the crops a targeted reread JUST refreshed, selected by region id
 * (the outcome's invocation proof), paired to their labels. The missing-
 * passage turn answers from these refreshed pictures, so they ride exactly
 * as unitFrames pairs a retrieved passage's picture — never a neighbour's.
 * ⇔ region_frames in ruke-attach turn.rs.
 */
function regionFrames(
  index: LoadedIndex,
  regions: string[],
): { url: string; at: number; label: string }[] {
  const frames = index.meta.frames ?? [];
  const out: { url: string; at: number; label: string }[] = [];
  for (const f of frames) {
    if (out.length >= MAX_FRAMES) break;
    if (!f.region || !f.label || !regions.includes(f.region)) continue;
    try {
      const buf = fs.readFileSync(path.join(indexDir(index.meta.attId), f.file));
      const mime = /\.png$/i.test(f.file) ? "image/png" : "image/jpeg";
      out.push({ url: `data:${mime};base64,` + buf.toString("base64"), at: f.at, label: f.label });
    } catch {
      // Frame file missing on disk — the text evidence still stands.
    }
  }
  return out;
}

/**
 * F152: lead-in for document pictures, kept separate from the video moments
 * law (video bytes stay golden-frozen). Byte-identical to DOC_FRAMES_LEAD_IN
 * in ruke-attach/src/turn.rs; the per-frame label format matches
 * lib/chat/client.ts ("<label> — drawn content:").
 */
const DOC_FRAMES_LEAD_IN =
  "Each picture below is labelled with where it sits in the attached document — the file's own drawn content (chart pages, embedded images), kept separate from the retrieved text passages. Answer questions about appearance from the labelled picture and say which one you read it from:";

/**
 * F14: machine-readable COVERAGE, inside the block the model actually
 * reads. Every number is read off THIS turn's retrieval (never inferred),
 * and the ranking mode is reported honestly: a lexical-only pass must not
 * be dressed up as semantic retrieval. The selection law stays intact --
 * a file that exists locally is not evidence that any given part of it was
 * READ. New text is ASCII-only so the Rust mirror can be byte-identical.
 * F78: a builder so the frames-only time_range path reports the same
 * numbers as the passage path; the template bytes are unchanged.
 */
function coverageMarker(
  ev: RankedEvidence,
  framesShown: number,
  name: string,
  totalChunks: number,
  totalFrames: number,
): string {
  return (
    `\n[coverage: ${ev.chunkIdxs.length} of ${totalChunks} indexed passages of "${name}" were shown this turn` +
    (ev.dropped > 0
      ? `; ${ev.dropped} further matched passages were withheld by this turn's budget (ask to continue and a different set is served)`
      : ev.truncated
        ? "; more passages matched than this turn's budget could show"
        : "; no matched passage was withheld from this turn") +
    `; ranking mode: ${ev.vectorMode === "hybrid" ? "semantic + lexical" : "lexical only"}` +
    (ev.vectorReason ? ` (${ev.vectorReason})` : "") +
    (totalFrames > 0 ? `; ${framesShown} of ${totalFrames} saved keyframes shown` : "") +
    " -- anything outside this selection was NOT read this turn]"
  );
}

/**
 * D-058: the reranker's own honesty line, kept OUT of the mirrored
 * [coverage: ...] marker so the Rust mirror of that marker stays
 * byte-identical. ASCII-only. It names the ranker the ENGINE reported,
 * how many passages it actually scored, and never implies a ranker ran
 * when the stage was skipped, refused or unreachable.
 */
function rankingMarker(ev: RankedEvidence): string {
  const rk = ev.rerank;
  return (
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
    " -- passages the retrieval did not rank were never seen by the reranker]"
  );
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
    // F152 Part 4 wording law: the answer's voice must depend on what the reader
    // ACTUALLY read — direct format, a narrow plain statement of what could not
    // be read (after the closer read was attempted), no blame for how the file
    // was made, no "you were not given the content", engine errors stay in
    // diagnostics. ⇔ ruke-attach turn.rs rules() segment 1, byte-identical.
    "Answer directly in the form the question asked for. When a closer read of part of the " +
    "content has been attempted and it is still unreadable, say plainly and narrowly which part " +
    "you could not read and where it sits (for example: I couldn't read the small label on page 1); " +
    "never blame the user for how the file was made, never say the file's content was not given to " +
    "you, and keep engine and decoding errors out of the answer — they are diagnostics, not the " +
    "conversation. " +
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
  /**
   * F152 targeted reread: called with (attId, raw question, index, the units
   * the retrieved passages name, whether THIS attachment's retrieval came up
   * empty) when the attachment carries region-labelled frames; returns the
   * outcome — evidence lines + the regions actually re-inspected — from a
   * CLOSER read of the requested region(s) ONLY. Absent (the golden path) =
   * the assembly is byte-identical.
   */
  reread?: RegionReader,
  /**
   * F153 item 3: called with (attId, index, the asked moments) when a routed
   * time_range question on an AUDIO index found no timed passage — it returns
   * what the record knows about the asked window(s): the measured verdict, the
   * durable fresh decode's lines, or the honest failure (attachindex/
   * audio-reread.ts). Absent = the golden path is byte-identical.
   */
  freshAsr?: FreshAsrReader,
  /**
   * F153 item 4: called with (attId, index, the asked moments that NO saved
   * frame covers) on a routed time_range question over an attachment with no
   * readable speech — it decodes the ORIGINAL at those instants on demand and
   * returns the delivered pixels, the on-screen words, and the named failures
   * (attachindex/frame-seek.ts). Absent = the golden path is byte-identical.
   */
  seekFrames?: SeekFramesReader,
): Promise<number> {
  const refs = collectAttachmentRefs(messages);
  if (!refs.length) return 0;

  const blocks: string[] = [];
  const images: { url: string; at: number }[] = [];
  // F152: labelled document frames are kept apart from video keyframes so
  // each kind gets its own lead-in law.
  const docImages: { url: string; at: number; label: string }[] = [];
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
    let index = readIndex(ref.attId);
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

    // F152 targeted reread: an explicit closer-read request about a picture
    // the retrieved passages name re-inspects EXACTLY that region — the
    // reader runs with the region ids as scope, refreshes only that region's
    // pixels/state/passage (see attachindex/reread.ts), and the recovered
    // lines answer THIS turn. F153 §3: a MISSING retrieved passage is also a
    // targeted-read reason (the reader enforces the named-unit targeting).
    // Ordinary follow-ups that retrieve material never reach work here: the
    // cached evidence (index passages + frames) is what they reuse. The
    // reader must never throw into the turn — a failed reread leaves the
    // cached evidence standing.
    let rereadOut: RereadOutcome = { lines: [], regions: [] };
    if (reread && (index.meta.frames ?? []).some(f => f.region && f.label)) {
      try {
        rereadOut = await reread(ref.attId, rawQ, index, ev.pageCues, !ev.text);
      } catch {
        rereadOut = { lines: [], regions: [] };
      }
      if (rereadOut.lines.length) {
        const fresh = readIndex(ref.attId);
        if (fresh) index = fresh; // refreshed state/pixels visible to the pairing below
      }
    }
    const rereadLines = rereadOut.lines;

    // F78 (2026-11-22): a video whose speech could not be read indexes its
    // keyframes + one coverage note — there is NO timed passage for a routed
    // time_range question to retrieve, so `!ev.text` below fires and the
    // model receives NOTHING for the exact-time question the router aimed at
    // the frames (reproduced: "What is on screen at 01:31:00?" over a
    // frames-only index → zero evidence delivered). The saved frames ARE
    // this record's only evidence for the asked moment: serve the nearest
    // ones with the requested-vs-sampled attribution law (FRAME_WINDOW_SEC
    // honesty intact — nearestFrames already refuses a far moment) and the
    // unconfirmable-between law. Generic: routed window + index meta only,
    // never content inspection.
    if (!ev.text && routed.mode === "time_range" && ((index.meta.frames?.length ?? 0) > 0 || seekFrames)) {
      // The router builds each cue window as [c-180, c+180] CLIPPED to the
      // video's length; midpoint of a clipped window is NOT the asked instant
      // (a cue at 00:00:45 → window [0, 225] → midpoint 00:01:53 would
      // mislabel what the user asked). Un-clip from the edge that was
      // clipped; midpoint only when the window is full width.
      const dur = index.meta.durationSec ?? 0;
      const cues = cueMoments(routed, dur);
      const perCue = cues.map(cue => ({ cue, frames: nearestFrames(index, [cue]) }));
      // F153 item 4 (2026-11-25): a moment no saved frame covers is NOT
      // "never captured" while the original sits on disk — those instants get
      // ONE bounded on-demand decode (attachindex/frame-seek.ts): the
      // picture rides THIS turn, and the frame + any on-screen words become
      // part of the record so the next follow-up answers from it. Absent seam
      // = the golden path is byte-identical.
      const missingCues = perCue.filter(pc => !pc.frames.length).map(pc => pc.cue);
      let seek: FrameSeekOutcome | null = null;
      if (seekFrames && missingCues.length) {
        try {
          seek = await seekFrames(ref.attId, index, missingCues, signal);
        } catch {
          seek = null; // never throws into the turn (buildAttachmentTurn law)
        }
      }
      if (seek) {
        for (const pc of perCue) {
          for (const im of seek.images) {
            // Same honesty window as saved frames: a seeked pixel answers
            // only for the instant it decoded.
            if (Math.abs(im.at - pc.cue) <= FRAME_WINDOW_SEC && !pc.frames.some(f => f.at === im.at)) {
              pc.frames.push(im);
            }
          }
        }
      }
      const shownFrames: { url: string; at: number }[] = [];
      for (const pc of perCue) {
        for (const f of pc.frames) {
          if (!shownFrames.some(x => x.at === f.at && x.url === f.url)) shownFrames.push(f);
        }
      }
      const cueLines = perCue
        .map(({ cue, frames }) =>
          frames.length
            ? `Asked time ${fmtStamp(cue)}: the saved moment${frames.length > 1 ? "s" : ""} nearest ${fmtStamp(cue)} ${frames.length > 1 ? "are" : "is"} at ${frames.map(f => fmtStamp(f.at)).join(", ")} (the record holds no saved moment closer).`
            : `Asked time ${fmtStamp(cue)}: NO saved moment lies within this turn's time window, so what is on screen at that time was never captured.`,
        )
        .join("\n");
      const seekLines = seek && seek.lines.length ? "\n" + seek.lines.join("\n") : "";
      if (shownFrames.length) {
        const totalChunks = index.meta.chunkCount || index.chunks.length;
        const totalFrames = index.meta.frames.length + (seek?.durable ?? 0);
        const lines = cueLines + seekLines;
        const block =
          `<knowledge_index name="${ref.name}">\n` +
          `The question asks about a moment on this video's timeline. Its saved record carries no readable speech, so the visual record is the evidence served for the asked time.\n` +
          lines +
          "\n" +
          `The saved moments are isolated points: the record holds NO evidence about the time between, before or after them. Answer about the asked moment from the saved moment nearest it, give its time, and state that what happens between saved moments cannot be confirmed.\n` +
          coverageMarker(ev, shownFrames.length, ref.name, totalChunks, totalFrames) +
          rankingMarker(ev) +
          `\n${rules(ref)}\n</knowledge_index>`;
        blocks.push(block);
        turnUsed += block.length;
        images.push(...shownFrames);
        continue;
      }
      // Nothing saved AND the seek delivered nothing: the golden "never
      // captured" sentence rides WITH the seek's named failures, so the
      // answer distinguishes "the record never held this moment" from "the
      // on-demand decode failed for reason X and is retryable" — and the
      // moment is no longer silently unreachable while the original is on disk.
      if (seek && seek.lines.length) {
        const totalChunks = index.meta.chunkCount || index.chunks.length;
        const block =
          `<knowledge_index name="${ref.name}">\n` +
          `The question asks about a moment on this video's timeline. Its saved record carries no readable speech, so the visual record is the evidence served for the asked time.\n` +
          cueLines + seekLines +
          "\n" +
          `The saved moments are isolated points: the record holds NO evidence about the time between, before or after them. Answer about the asked moment from the saved moment nearest it, give its time, and state that what happens between saved moments cannot be confirmed.\n` +
          coverageMarker(ev, 0, ref.name, totalChunks, 0) +
          rankingMarker(ev) +
          `\n${rules(ref)}\n</knowledge_index>`;
        blocks.push(block);
        turnUsed += block.length;
        continue;
      }
    }
    // F153 item 3 (2026-11-25) — the UNCOVERED-TIME fresh-read law: an audio
    // index whose routed time_range question retrieved NO passage had nothing
    // to answer from (reproduced: "what did she say around 58:40?" over an
    // hour whose decode stopped early → zero evidence for the asked time).
    // audio-reread.ts decides honestly from the durable record: a window the
    // record covers is never re-decoded; a fully-decoded recording states the
    // measured absence; an unexamined window gets ONE bounded fresh decode of
    // the ORIGINAL, persisted so follow-ups continue across the boundary.
    // Never throws into the turn: a failed read leaves the block reporting the
    // failure plainly. Generic: routed window + index meta only.
    if (
      !ev.text
      && routed.mode === "time_range"
      && freshAsr
      && index.meta.category === "audio"
      && (index.meta.durationSec ?? 0) > 0
    ) {
      let fresh: FreshAsrOutcome = { lines: [], spans: [] };
      try {
        fresh = await freshAsr(ref.attId, index, cueMoments(routed, index.meta.durationSec ?? 0), signal);
      } catch {
        fresh = { lines: [], spans: [] };
      }
      if (fresh.lines.length) {
        const totalChunks = index.meta.chunkCount || index.chunks.length;
        const block =
          `<knowledge_index name="${ref.name}">\n` +
          `The question asks about a moment on this recording's timeline. The saved transcript carried no passage for the asked window(s), so this turn consulted the record and, where the window had never been listened to, ran ONE bounded decode of the original. What it found:\n` +
          fresh.lines.join("\n") + "\n" +
          coverageMarker(ev, 0, ref.name, totalChunks, 0) +
          rankingMarker(ev) +
          `\n${rules(ref)}\n</knowledge_index>`;
        blocks.push(block);
        turnUsed += block.length;
        continue;
      }
    }
    // F153 §3 — the MISSING-PASSAGE targeted-read law: a missing retrieved
    // passage is a reason to TRY a targeted read when the original is
    // available. If the read recovered text, THAT text is this turn's
    // evidence — the user uploaded the document and the answer speaks about
    // it; if the read still failed, the reread line names the exact
    // unreadable part plainly (reread.ts law). The refreshed crops ride
    // paired to their labels. The block states the attempt and its real
    // outcome — no wording change hides missing evidence, no canned reply.
    if (!ev.text && rereadLines.length) {
      const crops = regionFrames(index, rereadOut.regions);
      const totalChunks = index.meta.chunkCount || index.chunks.length;
      const totalFrames = index.meta.frames?.length ?? 0;
      const block =
        `<knowledge_index name="${ref.name}">\n` +
        `No passage in this attachment's saved record matched the question, so this turn attempted a targeted closer read of the picture(s) the question names. Its result:\n` +
        rereadLines.join("\n") + "\n" +
        coverageMarker(ev, crops.length, ref.name, totalChunks, totalFrames) +
        rankingMarker(ev) +
        `\n${rules(ref)}\n</knowledge_index>`;
      blocks.push(block);
      turnUsed += block.length;
      docImages.push(...crops);
      continue;
    }
    if (!ev.text) continue;

    // F14: machine-readable COVERAGE + D-058 ranking line (see the builders
    // below — the byte templates live there so the frames-only path can
    // report the same honest numbers).
    const frames = nearestFrames(index, ev.frameAts);
    const docFrames = unitFrames(index, ev.pageCues);
    const totalChunks = index.meta.chunkCount || index.chunks.length;
    const totalFrames = index.meta.frames?.length ?? 0;
    const covered = coverageMarker(ev, frames.length + docFrames.length, ref.name, totalChunks, totalFrames);
    const rankLine = rankingMarker(ev);

    blocks.push(
      `<knowledge_index name="${ref.name}">\n` +
        `Passages relevant to this question, retrieved from "${ref.name}" ` +
        `(its complete text is preserved locally — the passages below are the parts the retrieval matched):\n${ev.text}` +
        // F152: lines recovered by THIS turn's targeted reread — labelled,
        // region-keyed, kept separate from the retrieved passages (native and
        // re-read text stay distinguishable; the section header states scope).
        (rereadLines.length
          ? `\n[close re-read this turn: only the requested picture(s) were inspected again; each entry names its region and engine]\n${rereadLines.join("\n")}`
          : "") +
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
    docImages.push(...docFrames);
  }

  if (!blocks.length && !images.length && !docImages.length) return 0;

  // Keyframes ride at the END of the user turn (the template appends media
  // after text); the evidence itself is one system block right before it.
  if (images.length || docImages.length) {
    const msg = messages[userIdx];
    if (msg) {
      const parts = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
      if (images.length) {
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
      }
      if (docImages.length) {
        // F152: the indexed document's drawn content, paired to the passages
        // that name its unit (see unitFrames). Video lead-in bytes untouched.
        parts.push({ type: "text", text: DOC_FRAMES_LEAD_IN });
        for (const img of docImages) {
          parts.push({ type: "text", text: `${img.label} — drawn content:` });
          parts.push({ type: "image_url", image_url: { url: img.url } });
        }
      }
      msg.content = parts;
    }
  }
  if (blocks.length) injectSystemBefore(messages, userIdx, blocks.join("\n\n"));
  return blocks.length;
}
