/**
 * Domain model for the whole app.
 *
 * Nothing in here imports React or Next — these types are shared by the UI,
 * the local Qwen client, the streaming parser, the tool layer and persistence.
 */

import type { FileCategory } from "./files/extensions";
import type { RendererMode } from "./decision/types";
// Verification layer (server-side) types, needed for the Evidence-trail rows
// and the post-answer claim audit. Type-only: erased at compile time, so no
// server code enters the browser bundle.
// (The web-verify imports that lived here were retired 2026-10-22 with the
// ledger + claim audit; older stored messages carry those fields as `unknown`.)

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
  /** Frame image inlined as a data URL — what the model actually receives. */
  dataUrl: string;
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

  /**
   * What the file actually is, decided from its extension. Drives which
   * extraction path ran and how the content is put into the prompt.
   */
  category?: FileCategory;

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
  /** Image content inlined as a data URL (canvas-encoded or ffmpeg-decoded). */
  dataUrl?: string;

  /* Video metadata */
  durationSec?: number;
  frames?: AttachmentFrame[];

  /* Audio metadata */
  transcript?: string;

  /*
   * Knowledge index (server-side). Set when the content exceeded the prompt
   * budget: the full text + embeddings live under .data/attach-index/<id>/,
   * `spine` is the always-injected table of contents, and `text`/`transcript`
   * carry only a small preview. Retrieval happens per question in the chat
   * route via the attachment_ref part — nothing here is ever truncated away.
   */
  indexed?: boolean;
  indexId?: string;
  chunkCount?: number;
  spine?: string;
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
  /**
   * Web-research citations from the gated search pipeline (main-model
   * decision only since 2026-10-22): keyed by sourceId ("S1", "S2", ...),
   * passed to MarkdownRenderer so [S#] markers in the reply become
   * clickable pills.
   */
  webCitations?: Record<string, {
    sourceId: string;
    url: string;
    title: string;
    domain: string;
    publishedAt?: string;
  }>;
  /**
   * Search-gate summary shown in the Research Trail card: which queries
   * were generated, at what depth/freshness, and which authority decided
   * (since 2026-10-22 always "main-model").
   */
  researchLfm?: {
    depth: string;
    freshness: string;
    decidedBy?: string;
    queries: { query: string; intent: string }[];
  };
  /**
   * @deprecated 2026-10-22 — the web-verify ledger and the post-answer claim
   * audit are gone; these fields stay in the type surface only so older
   * stored conversations still parse. New turns never populate them.
   */
  webLedger?: unknown;
  webVerification?: unknown;
  usage?: Usage;
  createdAt: number;
  finishedAt?: number;
  state: MessageState;
  error?: string;
  mode: ChatMode;
  tool_call_id?: string; // for tool role messages
  /** Skill engine: name of the skill that fired for this reply. */
  usedSkill?: string;
  /** Visible auto-repair status while a broken 3D/CAD fence is being fixed. */
  fenceRepair?: string;
  /** Decision Engine mode for this reply: the ONLY renderer/validator allowed. */
  decisionMode?: RendererMode;
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
  /** "manual" = user renamed it (never auto-overwritten); "auto" = machine
   * title; absent = legacy document (title may be the first-message copy). */
  titleSource?: "auto" | "manual";
  /** Message count the current auto title was derived from — lets a newer
   * generation win the race against an older in-flight title job. */
  titleGenCount?: number;
  titleGenAt?: number;
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
/**
 * Live server-side phase event emitted by app/api/chat/route.ts BEFORE the
 * model's first byte (routing, skill load, attachment retrieval, web-research
 * gate). Carries only real counts measured by the pipeline — the client's
 * progress engine (lib/progress/turnProgress.ts) turns these into honest
 * per-step percentages. Web-tier metadata (citations, gate summary) rides a
 * `web_meta` stage instead of response headers on streamed turns.
 */
export interface StageEvent {
  /** decision_done | skill | retrieval | retrieval_done | web_meta | web:<PipelineStage> */
  stage: string;
  detail?: string;
  /** decision mode at decision_done */
  mode?: RendererMode;
  ms?: number;
  done?: number;
  total?: number;
  coverage?: number;
  webCitations?: Record<string, {
    sourceId: string;
    url: string;
    title: string;
    domain: string;
    publishedAt?: string;
  }>;
  researchLfm?: {
    depth: string;
    freshness: string;
    decidedBy?: string;
    queries: { query: string; intent: string }[];
  };
}

export interface StreamEvent {
  content?: string;
  reasoning?: string;
  toolCalls?: StreamToolCallDelta[];
  finishReason?: string | null;
  usage?: Usage;
  /** Server progress phase (ruke_stage SSE frame). */
  stage?: StageEvent;
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
