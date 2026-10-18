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

  switch (att.category) {
    case "image":
      return att.dataUrl
        ? [{ type: "text", text: `${label} (image)` },
           { type: "image_url", image_url: { url: att.dataUrl } }]
        : [{ type: "text", text: `${label} — the image could not be read` }];

    case "video": {
      const parts: any[] = [{ type: "text", text: `${label} (video — sampled frames follow)` }];
      for (const f of att.frames ?? []) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      if (!att.frames?.length) parts.push({ type: "text", text: "No frames could be sampled from this video." });
      if (att.transcript) parts.push({ type: "text", text: `Audio transcript:\n${att.transcript}` });
      return parts;
    }

    case "audio":
      return [{ type: "text", text: `${label} (audio)\nTranscript:\n${att.transcript ?? "[no speech detected]"}` }];

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
