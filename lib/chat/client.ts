import type { Attachment, ChatRequest, ChatStreamCallback, ToolDef } from "./types";
import {
  createStreamParser,
  StreamHandle,
  StreamOptions,
  type StreamSettlement,
} from "../stream/parser";

const DEFAULT_URL = "/api/chat";

export class ChatClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ChatClientError";
  }
}

export class ChatClient {
  constructor(
    private url: string = DEFAULT_URL,
    private apiKey: string = "no-key",
    private model: string = "",
  ) {}

  async chat(
    req: ChatRequest,
    onEvent: ChatStreamCallback,
    signal?: AbortSignal,
    onMeta?: (headers: Headers) => void,
  ): Promise<StreamSettlement> {
    const body = this.buildBody(req);
    const handle = createStreamParser({
      url: this.url,
      apiKey: this.apiKey,
      body,
      signal,
      onMeta,
    });

    for await (const ev of iterate(handle)) {
      onEvent(ev);
    }
    // F16 (2026-11-15): a resolved `chat()` is NOT proof the turn succeeded.
    // The parser settles exactly once, after its single terminal, and carries
    // the real outcome (success / error / cancelled / truncated / incomplete
    // tool round) up to the caller that owns persistence and repair.
    return handle.settled() ?? { outcome: "truncated", finishReason: null };
  }

  abort(handle: StreamHandle) {
    handle.abort();
  }

  private buildBody(req: ChatRequest) {
    const messages: any[] = [];
    // No standing system prompt: the Decision Engine injects the ONE matched
    // skill + output contract per turn server-side (app/api/chat/route.ts).
    for (const m of req.messages) {
      // Attachments ride on the message they belong to, so a follow-up
      // question still has the file content in front of the model.
      const atts = (m as any).attachments as Attachment[] | undefined;
      const entry: any = { role: m.role, content: messageContent(m.content, atts) };
      if (m.reasoning_content) entry.reasoning_content = m.reasoning_content;
      if (m.tool_calls) entry.tool_calls = m.tool_calls;
      if (m.role === "tool") entry.tool_call_id = m.tool_call_id;
      messages.push(entry);
    }

    const body: any = {
      model: req.model ?? this.model,
      messages,
      stream: req.stream ?? true,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.reasoning_effort && req.reasoning_effort !== "off") {
      body.reasoning_effort = req.reasoning_effort;
    }
    if (req.tools?.length) body.tools = req.tools;
    // Fence-repair follow-ups pin their mode so the chat route skips the
    // Decision Engine for that round (mode is already known).
    if (req.decision_mode) body.decision_mode = req.decision_mode;
    // Compaction's own call bypasses the per-turn pipeline entirely.
    if (req.purpose) body.purpose = req.purpose;
    // Browser markers (Phase 10 + user rescope 2026-11-07): only the Rust
    // chat route acts on them, and it strips BOTH keys before anything is
    // forwarded. `browser_session` rides every send as conversation
    // identity; `browser_armed` rides ONLY while the Browser Panel is
    // open (the human's explicit "open browser" action).
    if (req.browser_session) body.browser_session = req.browser_session;
    if (req.browser_armed === true) body.browser_armed = true;
    // P1 clock grounding: the route consumes it for the <runtime_clock>
    // block and strips it before upstream (same law as browser_session).
    if (req.timezone) body.timezone = req.timezone;
    if (body.stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }
}

/**
 * Content in the shape the local chat template expects: a plain string when no
 * files are attached, otherwise a parts array mixing text and image_url.
 */
function messageContent(text: string | null, atts?: Attachment[]): unknown {
  if (!atts?.length) return text ?? "";
  const parts: any[] = [];
  if (text) parts.push({ type: "text", text });
  for (const att of atts) parts.push(...attachmentParts(att));
  return parts;
}

/** Clock label for video timestamps: H:MM:SS (hours omitted under 1 h) or M:SS. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(r).padStart(2, "0")}`;
}

/**
 * F76 sampling law (universal, kept identical to the record-side "point
 * evidence" law the timeline layer states for frame OCR): delivered images are
 * isolated instants, so nothing in the record speaks for the time BETWEEN
 * them. Without this line the model fills unexamined spans - it read a marker
 * correctly at the two sampled moments and then claimed it was visible
 * "throughout" the clip (and, across the very stretch between the two
 * moments, unchanged). Both video delivery shapes must carry it verbatim.
 */
const VIDEO_MOMENTS_LAW =
  " The images are isolated moments: the record holds no evidence about the time between, before or after them. " +
  "Never claim that something is visible throughout a video, always or never shown, or unchanged across any " +
  "stretch between two shown moments; when asked about such a stretch, answer from the shown moments and say " +
  "the rest cannot be confirmed.";

/**
 * F76 numeric-fidelity law (universal delivery contract, kept byte-identical
 * to the rules() base in lib/server/attachindex/turn.ts ⇔ ruke-attach
 * turn.rs): extraction delivers printed figures verbatim, so re-grouping or
 * scale errors like the live one (4,18,25,000 rendered as ₹418,250,000 /
 * ₹41.825 crore — a 10x restatement defect at the ANSWER stage) are the
 * model's doing. The law requires digit-exact quoting and a verified
 * conversion for any restatement; it names no currency, unit or value. The final
 * sentence is incident-driven: twice live, the model verified its primary
 * restatement carefully and then slipped an unverified 10x figure into an
 * offhand "for reference" aside — asides restate too.
 */
const NUMERIC_FIDELITY_LAW =
  "When quoting a figure from the material, keep its exact digits and digit grouping. When restating " +
  "a figure in different units or a different grouping convention, state the exact conversion being " +
  "applied and verify the restated figure has the same value; never give two versions of one figure " +
  "that have different values. This applies to every restated version anywhere in the answer, " +
  "including brief asides.";

/** One attachment rendered into whatever the model can actually perceive. */
export function attachmentParts(att: Attachment): any[] {
  const label = `Attached file: ${att.name}`;

  // Indexed content: the full text lives in the server-side knowledge index,
  // never truncated away. History carries only the structural map + opening
  // preview + a reference part the chat route uses to retrieve timestamped
  // evidence for the current turn (ephemeral — never persisted into history).
  if (att.indexed) {
    const timed = att.category === "audio" || att.category === "video";
    const isVideo = att.category === "video";
    const preview = att.transcript ?? att.text;
    const parts: any[] = [
      {
        type: "text",
        text:
          `${label} — this ${isVideo ? "video" : timed ? "recording" : "document"} is long, so its complete content is kept in a local knowledge index ` +
          `(nothing was discarded). You are shown its structural map and its opening; passages relevant to each question ` +
          `are supplied as timestamped evidence when needed.` +
          (isVideo
            ? ` This video's complete saved record is kept whole in the index; you are shown parts of it: the ` +
              `images below are moments from it, and its spoken content is part of the record. Speak of the video ` +
              `as a whole — never claim to have watched it ` +
              `yourself, never mention frames, sampled images, keyframes, an audio track or transcription, and ` +
              `never attribute content to a particular frame.` + VIDEO_MOMENTS_LAW
            : ""),
      },
    ];
    if (isVideo) {
      // I18a: the images used to be anonymous — nothing told the model WHEN
      // in the video each moment sits, so time-scoped answers had no anchor.
      // Every frame now rides behind its video timestamp, phrased as the
      // video's own timeline (never "a frame at …"), keeping the record
      // honesty law intact.
      if (att.durationSec && att.durationSec > 0) {
        parts.push({ type: "text", text: `Video length: ${fmtClock(att.durationSec)}.` });
      }
      parts.push({ type: "text", text: "Moments from the video:" });
      for (const f of att.frames ?? []) {
        parts.push({
          type: "text",
          text:
            `At ${fmtClock(f.at)} in the video this is what is happening on screen — ` +
            `speak of it as the video at that time, never as an image or a still:`,
        });
        parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      }
    }
    if (att.spine) parts.push({ type: "text", text: `Structural map of ${label}:\n${att.spine}` });
    if (preview) {
      parts.push({
        type: "text",
        text: `Opening of the content:\n[content begins]\n${preview}\n[content continues — the remainder is indexed, not shown]`,
      });
    }
    parts.push({
      type: "attachment_ref",
      att_id: att.indexId ?? att.id,
      name: att.name,
      category: att.category ?? "text",
    });
    return parts;
  }

  switch (att.category) {
    case "image": {
      // F66/F67: the decoder hands over EVERY page of a multi-page TIFF and
      // every frame of an animated GIF in `att.frames` (browser tall images
      // ride as labelled detail strips) — the old shape dropped them silently,
      // so the model only ever saw the first page and said so.
      if (!att.dataUrl)
        return [{ type: "text", text: `${label} — the image could not be read` }];
      // F68: when the pipeline verified the file's pixel dimensions, state
      // them — answering "what are the pixel dimensions?" from a vision
      // estimate of the raster (1250×612 for a 1280×720 HEIC, fr-I4) is a
      // fidelity defect, not a model failure. No verified size ⇒ no claim.
      const dims = att.width && att.height ? ` — ${att.width} × ${att.height} pixels` : "";
      const frames = att.frames ?? [];
      if (!frames.length)
        return [{ type: "text", text: `${label} (image${dims})` },
                { type: "image_url", image_url: { url: att.dataUrl } }];
      const parts: any[] = [];
      if (att.pages && att.pages > 1) {
        const shown = 1 + frames.length;
        parts.push({
          type: "text",
          text:
            `${label}${dims} — this file is ${att.pages} images in sequence (a multipage document ` +
            `or an animation). ` +
            (shown < att.pages
              ? `Showing ${shown} of them IN ORDER, including the first and the LAST; the others are not shown — never answer from a position that is not shown. `
              : `Every image is shown below IN ORDER, never just the first. `) +
            `Answer from the position the question asks about — when it says page N or frame N, ` +
            `that is Image N below.`,
        });
        parts.push({ type: "text", text: `Image 1 of ${att.pages}:` });
        parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
        for (const f of frames) {
          parts.push({ type: "text", text: `Image ${f.at} of ${att.pages}:` });
          parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
        }
      } else {
        parts.push({ type: "text", text: `${label} (image${dims})` });
        parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
        parts.push({
          type: "text",
          text: "Detail views of the same image, top to bottom (the whole image, in overlapping strips):",
        });
        for (const f of frames) {
          parts.push({ type: "text", text: `Detail ${f.at} of ${frames.length}:` });
          parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
        }
      }
      return parts;
    }

    case "video": {
      const parts: any[] = [
        {
          type: "text",
          text:
            `${label} — you are given its complete saved record. The images below are moments from it` +
            (att.transcript ? ", and after them is what is spoken in it" : "") +
            `.\nDescribe the video from this record: what happens, what appears on screen, what is said. ` +
            `Never claim to have watched it yourself; never mention frames, sampled images, keyframes, an audio ` +
            `track, transcription or speech recognition, and never attribute content to "the first frame" or ` +
            `"this frame" — the visuals and the speech belong to the video as one whole. Give video timestamps ` +
            `only when the user asks for them or when a time reference genuinely helps the answer.` + VIDEO_MOMENTS_LAW,
        },
      ];
      // I18a: each moment is anchored to its video timestamp (see above).
      if (att.durationSec && att.durationSec > 0) {
        parts.push({ type: "text", text: `Video length: ${fmtClock(att.durationSec)}.` });
      }
      for (const f of att.frames ?? []) {
        parts.push({
          type: "text",
          text:
            `At ${fmtClock(f.at)} in the video this is what is happening on screen — ` +
            `speak of it as the video at that time, never as an image or a still:`,
        });
        parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      }
      if (!att.frames?.length) parts.push({ type: "text", text: "No visuals could be read from this video." });
      if (att.transcript)
        parts.push({
          type: "text",
          text: `What is spoken in this video:\n[spoken content begins]\n${att.transcript}\n[spoken content ends]`,
        });
      return parts;
    }

    case "audio":
      if (!att.transcript)
        return [
          {
            type: "text",
            text:
              `${label} (audio) — no spoken words could be read from this recording. ` +
              `Do NOT state that it is silent or that it contains no speech: an unreadable ` +
              `speech track and an absent one are different claims, and this one is unknown. ` +
              `Answer from what the user says about it, or say plainly that its speech could ` +
              `not be read.`,
          },
        ];
      return [
        {
          type: "text",
          text:
            `${label} (audio recording — its complete spoken content, taken directly from the recording, follows)\n` +
            `[spoken content begins]\n${att.transcript}\n[spoken content ends]\n` +
            `Answer in terms of what the recording says and what the speakers say. Never claim to have listened to ` +
            `it yourself, never mention a transcript or speech recognition, and never tell the user you cannot ` +
            `access its spoken content.`,
        },
      ];

    default: {
      if (!att.text) return [{ type: "text", text: `${label} — no readable text was found` }];
      const body =
        `${label}\n[file content begins]\n${att.text}\n[file content ends]` +
        (att.truncated ? "\n[the file was truncated]" : "") +
        `\n${NUMERIC_FIDELITY_LAW}`;
      return [{ type: "text", text: body }];
    }
  }
}

async function* iterate<T>(handle: StreamHandle): AsyncGenerator<T, void, void> {
  while (true) {
    const result = await handle.next();
    if (result.done) break;
    yield result.value as T;
  }
}
