import type { ChatRequest, ChatStreamCallback, ToolDef } from "./types";
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
  ): Promise<void> {
    const body = this.buildBody(req);
    const handle = createStreamParser({
      url: this.url,
      apiKey: this.apiKey,
      body,
      signal,
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
    for (const m of req.messages) {
      const entry: any = { role: m.role, content: m.content };
      if (m.reasoning_content) entry.reasoning_content = m.reasoning_content;
      if (m.tool_calls) entry.tool_calls = m.tool_calls;
      if (m.role === "tool") entry.tool_call_id = m.tool_call_id;
      messages.push(entry);
    }

    // Inject attachments into the last user message content array.
    if (req.attachments?.length) {
      const lastUserIdx = messages.map((m, i) => m.role === "user" ? i : -1).filter(i => i >= 0).pop();
      if (lastUserIdx !== undefined) {
        const parts: any[] = [{ type: "text", text: messages[lastUserIdx].content }];
        for (const att of req.attachments) {
          if (att.kind === "image" && att.previewUrl) {
            parts.push({ type: "image_url", image_url: { url: att.previewUrl } });
          }
        }
        messages[lastUserIdx].content = parts;
      }
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
    if (body.stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }
}

async function* iterate<T>(handle: StreamHandle): AsyncGenerator<T, void, void> {
  while (true) {
    const result = await handle.next();
    if (result.done) break;
    yield result.value as T;
  }
}
