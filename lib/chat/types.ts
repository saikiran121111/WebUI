import type { Attachment } from "../types";
import type { RendererMode } from "../decision/types";

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
  /** Pin the mode for a follow-up round (fence repair) — skips re-deciding. */
  decision_mode?: RendererMode;
  /**
   * Internal transport marker. "compact" = the Context Compaction Engine's
   * own call: the route must NOT run slash routing, the Decision Engine,
   * skill injection, or the web-research gate over it — the compaction
   * system prompt IS the contract and the history must stay verbatim.
   */
  purpose?: "compact";
  /**
   * Browser Use transport markers (task-scope audit brief #2 + user
   * rescope 2026-11-07): `browser_session` = the conversation id for
   * EVERY chat send — presence alone does NOT route the turn; it is
   * research-journal/panel IDENTITY only. `browser_armed` = true ONLY
   * while the Browser Panel is OPEN at send time (the TopBar toggle IS
   * the human's explicit "open browser" action). The Rust chat route
   * combines both with the server-owned task-scope contract via
   * task_scope::browser_activates (Operate intent ∧ (armed ∨ the turn's
   * words naming the harness browser) ⇒ browser tool loop; everything
   * else ⇒ the scope-enforced research path or plain forwarding) and
   * strips BOTH before forwarding — they never reach upstream. Browser
   * turns are streaming-path only; compaction/fence-repair never set
   * them.
   */
  browser_session?: string;
  browser_armed?: boolean;
  /**
   * P1 clock grounding: the browser's IANA zone —
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`. The chat route uses
   * it for the per-turn <runtime_clock> block (session-local time for the
   * user who is asking) and deletes the key before forwarding, like
   * browser_session — it never reaches upstream.
   */
  timezone?: string;
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
