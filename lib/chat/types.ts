import type { Attachment } from "../types";

export interface ChatRequest {
  messages: OpenAIMessage[];
  model?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  tools?: any[];
  attachments?: Attachment[];
}

/**
 * The wire format reuses the app's attachment model — one definition, so a
 * field added for extraction can never drift between client and request body.
 */
export type { Attachment };

export interface ToolDef {
  name: string;
  description: string;
  parameters: any;
  execute(args: unknown): Promise<any>;
}

export type ChatStreamCallback = (ev: any) => void;

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  /** Files attached to this message; expanded into content parts on send. */
  attachments?: Attachment[];
}
