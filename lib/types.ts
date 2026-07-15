export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinkingContent?: string;
  thinkingDuration?: number;
  createdAt: number;
}

export interface StreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
}

export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason?: string | null;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  choices: StreamChoice[];
}
