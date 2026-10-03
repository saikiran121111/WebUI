/**
 * Domain model for the whole app.
 *
 * Nothing in here imports React or Next — these types are shared by the UI,
 * the local Qwen client, the streaming parser, the tool layer and persistence.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export type ChatMode = "chat" | "research";

/** Thinking effort as exposed to the user. */
export type EffortLevel = "off" | "low" | "medium" | "high" | "max";

/* ── Attachments ─────────────────────────────────────────────────────────── */

export type AttachmentKind = "image" | "document" | "video" | "other";

/**
 * Lifecycle of the *content* of an attachment (extraction, frame sampling).
 * Kept separate from upload state because a file can be fully uploaded and
 * still be processing.
 */
export type AttachmentStatus = "pending" | "processing" | "ready" | "error";

export interface AttachmentFrame {
  /** Server-side path under .data/frames, served through /api/files. */
  path: string;
  /** Seconds from the start of the clip. */
  at: number;
}

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  status: AttachmentStatus;
  error?: string;

  /** Key into the attachment blob store. Absent for ephemeral attachments. */
  blobKey?: string;

  /** Client-only. Never persisted — object URLs die with the document. */
  previewUrl?: string;

  /* Document metadata */
  pages?: number;
  truncated?: boolean;
  /** Extracted plain text, loaded lazily for large documents. */
  text?: string;

  /* Image metadata */
  width?: number;
  height?: number;

  /* Video metadata */
  durationSec?: number;
  frames?: AttachmentFrame[];
  transcript?: string;
}

/* ── Tool calls ──────────────────────────────────────────────────────────── */

export type ToolCallStatus =
  | "streaming" // arguments still arriving from the model
  | "pending" // parsed, queued for execution
  | "awaiting_approval" // gated behind a user confirmation
  | "running"
  | "ok"
  | "error"
  | "denied"
  | "complete"; // tool-call finish-reason arrived

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON exactly as streamed. Only parse once the stream closes. */
  args: string;
  status: ToolCallStatus;
  resultSummary?: string;
  resultDetail?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/* ── Citations ───────────────────────────────────────────────────────────── */

export interface Citation {
  /** 1-based ordinal used to render [1] in the answer. */
  n: number;
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  published?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: any;
  execute(args: unknown): Promise<any>;
}

/* ── Usage ───────────────────────────────────────────────────────────────── */

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Tokens/s reported by the server when it exposes timings. */
  tokensPerSecond?: number;
}

/* ── Messages ────────────────────────────────────────────────────────────── */

export type MessageState = "streaming" | "complete" | "error" | "aborted";

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  /** Reasoning summary the local API explicitly chose to expose. */
  reasoning: string;
  reasoningMs?: number;
  attachments: Attachment[];
  toolCalls: ToolCall[];
  citations: Citation[];
  usage?: Usage;
  createdAt: number;
  finishedAt?: number;
  state: MessageState;
  error?: string;
  mode: ChatMode;
  tool_call_id?: string; // for tool role messages
}

/* ── Conversations ───────────────────────────────────────────────────────── */

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  mode: ChatMode;
  /** Last message preview, so the sidebar never needs to load messages. */
  preview: string;
  messageCount: number;
}

export interface Conversation {
  id: string;               // mirrors meta.id — satisfies IDB keyPath "id"
  meta: ConversationMeta;
  messages: Message[];
}

/* ── Streaming protocol ──────────────────────────────────────────────────── */

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argsChunk?: string;
}

/** Normalised, transport-independent view of one SSE chunk. */
export interface StreamEvent {
  content?: string;
  reasoning?: string;
  toolCalls?: StreamToolCallDelta[];
  finishReason?: string | null;
  usage?: Usage;
}

/* ── Research orchestration ──────────────────────────────────────────────── */

export interface ResearchStep {
  index: number;
  label: string;
  status: "pending" | "active" | "done" | "failed";
}

export type ResearchEvent =
  | { type: "plan"; steps: ResearchStep[] }
  | { type: "step"; index: number; status: ResearchStep["status"]; label?: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; status: ToolCallStatus; summary: string; detail?: unknown }
  | { type: "citation"; citation: Citation }
  | { type: "reasoning_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "approval_request"; call: ToolCall; reason: string }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done" };

/* ── Search ──────────────────────────────────────────────────────────────── */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  published?: string;
}
