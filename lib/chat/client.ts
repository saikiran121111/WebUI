import type { Attachment, ChatRequest, ChatStreamCallback, ToolDef } from "./types";
import { createStreamParser, StreamHandle, StreamOptions } from "../stream/parser";

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
  ): Promise<void> {
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
            ? ` You are given this video's complete saved record: the images below are moments from it, and its ` +
              `spoken content is part of it. Speak of the video as a whole — never claim to have watched it ` +
              `yourself, never mention frames, sampled images, keyframes, an audio track or transcription, and ` +
              `never attribute content to a particular frame.`
            : ""),
      },
    ];
    if (isVideo) {
      parts.push({ type: "text", text: "Moments from the video:" });
      for (const f of att.frames ?? []) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
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
    case "image":
      return att.dataUrl
        ? [{ type: "text", text: `${label} (image)` },
           { type: "image_url", image_url: { url: att.dataUrl } }]
        : [{ type: "text", text: `${label} — the image could not be read` }];

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
            `only when the user asks for them or when a time reference genuinely helps the answer.`,
        },
      ];
      for (const f of att.frames ?? []) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
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
        return [{ type: "text", text: `${label} (audio) — this recording contains no speech.` }];
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
        (att.truncated ? "\n[the file was truncated]" : "");
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
