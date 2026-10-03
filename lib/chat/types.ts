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

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "document" | "video" | "other";
  previewUrl?: string;
  blobKey?: string;
  text?: string;
  pages?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  frames?: { path: string; at: number }[];
  transcript?: string;
  status: "pending" | "processing" | "ready" | "error";
  error?: string;
}

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
}
