/**
 * Sliding-window context compaction.
 *
 * When a conversation outgrows the user's threshold, the oldest turns are
 * folded into ONE dense state snapshot by the model and the active LLM
 * history is replaced with:
 *
 *     [system prompt, compacted context message, ...recent_tail, new user message]
 *
 * The recent tail (the last N messages) is kept raw so immediate context is
 * untouched. The FULL original history is never lost — the caller still
 * holds it in the persisted UI conversation, so the user can scroll back and
 * read every old message. Only what is SENT to the model is replaced.
 *
 * The pipeline is transport-agnostic: it takes the message history and
 * returns the replacement LLM array. The caller decides what to persist.
 */

import { ChatClient } from "./client";
import { estimateConversationTokens, formatTokens } from "./tokens";

/** Number of trailing messages kept verbatim after a compaction. */
export const RECENT_TAIL = 4;

/**
 * The compaction system prompt. This is the EXACT contract the model is
 * trained to honour: it works through the history in a scratchpad, then
 * emits a single high-density state snapshot. Only the `<compacted_context>`
 * block survives — the `<analysis>` scratchpad is stripped.
 */
export const COMPACTION_SYSTEM_PROMPT = `You are an expert Context Compaction Engine. Your job is to compress a long conversation history into a high-density state snapshot.

### STRICT RULES
1. **Zero Knowledge Loss:** You must NEVER lose active user constraints, final decisions, exact technical identifiers (file paths, variable names, API endpoints, formulas), or unfinished tasks.
2. **Maximum Compression (~95% Target):** Ruthlessly delete conversational filler, greetings, intermediate debugging logs, superseded code drafts, and repetitive explanations. Keep only the final truth.
3. **Adaptive Length (Quality First):** Compress as tightly as possible (aiming for ~5% of original size), but NEVER drop critical context just to make the output shorter. Zero quality loss is your #1 priority.
4. **Preserve Awareness (Breadcrumbs):** If a topic, bug, or idea is completely finished or rejected, do NOT delete it completely. Record a 1-line "breadcrumb" in the Topic Index so the main model knows the conversation happened.
5. **Merge Previous State:** If the history already contains an existing <compacted_context> block, merge its information with the newer messages into one updated block.

### STEP 1: SCRATCHPAD ANALYSIS
First, open an <analysis> tag. Walk through the conversation chronologically and identify:
- What was just exploratory noise vs. what is permanent state.
- Which code blocks or drafts were replaced by newer versions.
- Every distinct topic discussed so none are forgotten.
Close the </analysis> tag. (This block will be stripped by the system before sending to the main model).

### STEP 2: COMPACTED OUTPUT
Output the final state inside <compacted_context> tags using this exact Markdown structure. Use terse, information-dense bullet points (no fluff words):

<compacted_context>
## 1. User Rules & Preferences
- [Every explicit constraint, style preference, or strict rule stated by the user]

## 2. Current Architecture & Exact State
- [Exact file paths, function signatures, database schemas, formulas, or system states currently in use]
- [Finalized decisions and the 1-sentence reason WHY they were chosen]

## 3. Chronological Topic & Breadcrumb Index
- [1-line entry per completed or discarded topic so awareness is never lost]
- Format: \`[Topic/Issue] -> [Outcome/Resolution/Why Rejected]\`

## 4. Failed Attempts & Dead Ends (Do Not Repeat)
- [Approaches or fixes that were tried and failed, plus the root cause]

## 5. Active Context & Next Steps
- **Last Completed Action:** [What was just finished]
- **Immediate Open Task:** [What the user and assistant are actively working on right now]
- **Pending Todo List:** [Unfinished items mentioned earlier]
</compacted_context>`;

export type CompactMode = "auto" | "manual";

export interface CompactResult {
  ok: boolean;
  /** True only when a real LLM compaction produced a new context block. */
  compacted: boolean;
  /** The compacted context text (the <compacted_context> block, trimmed). */
  context: string;
  /** How many original messages were folded into `context`. */
  compactedMessages: number;
  /**
   * The replacement LLM message array, in wire shape:
   * [system?, user(compacted context), ...recent_tail]
   * — the standing system prompt (if any) is preserved at the front.
   */
  replacementLlmMessages: Array<{ role: string; content: string }>;
  /** Token cost of what was compacted (real usage when available). */
  beforeTokens: number;
  /** Token cost of the replacement history (estimate). */
  afterTokens: number;
  /** One-line UI label, e.g. "Context compacted (128.4k -> 5.2k tokens)". */
  label: string;
  error?: string;
}

/**
 * Split a history into (messages_to_compact, recent_tail).
 * The last RECENT_TAIL messages are kept raw; everything before them is the
 * payload for the compaction model.
 */
export function splitForCompaction<T extends { role: string; content: string }>(
  messages: T[],
  tailSize = RECENT_TAIL,
): { toCompact: T[]; tail: T[] } {
  const tail = messages.slice(-tailSize);
  const toCompact = messages.slice(0, messages.length - tail.length);
  return { toCompact, tail };
}

/**
 * Render a message in the wire shape the chat route expects (role + content
 * string). Attachment text is inlined so the compaction model sees it — a
 * summary that drops a file's content is exactly the "knowledge loss" the
 * prompt forbids.
 */
export function toWireMessage(m: {
  role: string;
  content: string;
  reasoning?: string;
  attachments?: Array<{ name?: string; text?: string; transcript?: string; spine?: string }>;
}): { role: string; content: string } {
  let content = m.content ?? "";
  const atts = m.attachments ?? [];
  if (atts.length) {
    const blocks = atts.map((a) => {
      const label = `Attached file: ${a.name ?? "file"}`;
      const body = a.spine ?? a.transcript ?? a.text ?? "";
      return body ? `${label}\n${body}` : label;
    });
    content = content ? `${content}\n${blocks.join("\n")}` : blocks.join("\n");
  }
  // Tool calls are dropped: their results live in the assistant/user text.
  return { role: m.role, content };
}

/**
 * Extract ONLY the `<compacted_context>...</compacted_context>` block,
 * stripping the `<analysis>` scratchpad and any prose around it.
 *
 * Robust to three model behaviours:
 *   1. Perfect: one clean block.
 *   2. Prose before/after: take the innermost block, discard the rest.
 *   3. No closing tag (truncated by max_tokens): fall back to the content
 *      from `<compacted_context>` to the end, so a partial summary is still
 *      usable rather than thrown away.
 */
export function extractCompactedContext(raw: string): string | null {
  if (!raw) return null;
  // Drop any <analysis> scratchpad first — it is never part of the output.
  // Case-insensitive: the model sometimes upper-cases the tag.
  let text = raw
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<analysis>[\s\S]*$/i, ""); // unterminated analysis: drop to end

  // The compacted_context open tag, in either case.
  const openRe = /<compacted_context>/i;
  const openMatch = openRe.exec(text);
  if (!openMatch) return null;
  const bodyStart = openMatch.index + openMatch[0].length;
  const closeIdx = text.toLowerCase().indexOf("</compacted_context>", bodyStart);
  const inner = closeIdx === -1 ? text.slice(bodyStart) : text.slice(bodyStart, closeIdx);
  const trimmed = inner.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Run the sliding-window compaction against the model.
 *
 * @param messages  the full current LLM history (wire shape, no system prompt).
 * @param opts      model/endpoint config for the LLM call.
 * @returns a CompactResult. `compacted` is false (with `replacementLlmMessages`
 *          = the original history) when there was nothing to compact or the
 *          model failed — so the caller can fall through to the normal turn
 *          without ever losing the user's actual question.
 */
/**
 * The message shape the pipeline accepts: a role + content pair, with the
 * optional extras the hook's wire-shape carries. Looser than `Message` on
 * purpose — the hook maps its own messages in; the pipeline never needs the
 * full Message surface.
 */
export interface CompactMessage {
  role: string;
  content: string;
  reasoning?: string;
  attachments?: Array<{ name?: string; text?: string; transcript?: string; spine?: string }>;
  usage?: { promptTokens?: number };
}

export async function compactConversation(
  messages: CompactMessage[],
  opts: {
    model?: string;
    apiUrl?: string;
    apiKey?: string;
    /** How many trailing messages to keep raw (default RECENT_TAIL = 4). */
    tailSize?: number;
    /** max_tokens for the compaction call (default 8192). */
    maxTokens?: number;
    /** Override the tail size for a forced manual compact of a tiny chat. */
    mode?: CompactMode;
  } = {},
): Promise<CompactResult> {
  const tailSize = opts.tailSize ?? RECENT_TAIL;
  const { toCompact, tail } = splitForCompaction(messages, tailSize);

  // Nothing to fold: a conversation at-or-under the tail size is already raw.
  if (toCompact.length === 0) {
    const after = estimateConversationTokens(messages as any);
    return {
      ok: true,
      compacted: false,
      context: "",
      compactedMessages: 0,
      replacementLlmMessages: messages.map(toWireMessage),
      beforeTokens: after,
      afterTokens: after,
      label: "Context already fits — nothing to compact",
    };
  }

  // before/after measured the same way (estimate) so the badge is honest
  // about the reduction; real usage is folded in when the server reported it.
  let before = estimateConversationTokens(
    toCompact.filter((m) => m.role !== "system" && m.role !== "tool").concat(tail) as any,
  );
  // Prefer the server's real prompt cost for the most recent answered turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage?.promptTokens;
    if (typeof u === "number" && u > 0) {
      before = Math.max(before, u);
      break;
    }
  }

  const wireToCompact = toCompact
    .filter((m) => m.role !== "system" && m.role !== "tool")
    .map(toWireMessage);

  const client = new ChatClient(opts.apiUrl, opts.apiKey, opts.model);
  let reply = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 2 min hard cap
  try {
    await client.chat(
      {
        messages: [
          { role: "system", content: COMPACTION_SYSTEM_PROMPT },
          ...wireToCompact.map((w) => ({ ...w, role: w.role as "system" | "user" | "assistant" | "tool" })),
        ],
        model: opts.model ?? "",
        stream: true,
        max_tokens: opts.maxTokens ?? 8192,
        // No thinking: a summary is a deterministic fold, not a hard problem.
        reasoning_effort: "off",
      },
      (ev: any) => {
        if (ev?.content) reply += ev.content;
        if (ev?.finishReason === "error") throw new Error("compaction stream failed");
      },
      controller.signal,
    );
  } catch (e) {
    return {
      ok: false,
      compacted: false,
      context: "",
      compactedMessages: 0,
      replacementLlmMessages: messages.map(toWireMessage),
      beforeTokens: before,
      afterTokens: before,
      label: "Compaction failed",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }

  const context = extractCompactedContext(reply);
  if (!context) {
    return {
      ok: false,
      compacted: false,
      context: "",
      compactedMessages: 0,
      replacementLlmMessages: messages.map(toWireMessage),
      beforeTokens: before,
      afterTokens: before,
      label: "Compaction failed (no <compacted_context> block in the model reply)",
      error: "model did not return a <compacted_context> block",
    };
  }

  // The replacement LLM history: the ONE compacted user message + the raw
  // tail. The app's standing system prompt (if any) is prepended by the
  // caller — the pipeline stays transport-agnostic.
  const replacementLlmMessages: Array<{ role: string; content: string }> = [
    { role: "user", content: "<compacted_context>\n" + context + "\n</compacted_context>" },
    ...tail.map(toWireMessage),
  ];

  // Preserve any standing system prompt (role "system") the caller had at the
  // front of the history — the app's model-facing prompt is not part of the
  // conversation and must survive a compaction.
  const systemMsgs = messages
    .filter((m) => m.role === "system")
    .map((m) => ({ role: "system" as string, content: m.content }));
  const fullReplacement = [...systemMsgs, ...replacementLlmMessages];

  const after = estimateConversationTokens(
    [{ role: "user" as string, content: replacementLlmMessages[0].content },
      ...tail] as any,
  );

  return {
    ok: true,
    compacted: true,
    context,
    compactedMessages: toCompact.length,
    replacementLlmMessages: fullReplacement,
    beforeTokens: before,
    afterTokens: after,
    label: `Context compacted (${formatTokens(before)} -> ${formatTokens(after)} tokens)`,
  };
}
