/**
 * Chronological transcript for title generation: the COMPLETE conversation
 * (user + assistant, in order), never system prompts, reasoning, tool
 * internals or attachment file bodies. Long turns are capped per message so
 * every turn still contributes; overflow is handled by the map-reduce path
 * in generate.ts — never by silently dropping the middle or start.
 */

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/** Per-message caps: enough signal per turn, bounded total. */
const USER_TURN_CHARS = 500;
const ASSISTANT_TURN_CHARS = 400;

/**
 * The text the user actually typed — the FIRST text part (mirrors the chat
 * route's firstTextPart; extractUserText would join inlined attachment
 * content and pollute the title). Attachment NAMES ride along as a compact
 * note so "that video" conversations stay identifiable.
 */
function userTurnText(m: any): string {
  let text = "";
  if (typeof m?.content === "string") text = m.content;
  else if (Array.isArray(m?.content)) {
    for (const part of m.content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        text = part.text;
        break;
      }
    }
  }
  const names = (Array.isArray(m?.attachments) ? m.attachments : [])
    .map((a: any) => (typeof a?.name === "string" ? a.name : ""))
    .filter(Boolean);
  if (names.length) text = `${text} [attached: ${names.join(", ")}]`;
  return text.replace(/\s+/g, " ").trim().slice(0, USER_TURN_CHARS);
}

/** user + assistant turns only, chronological, blanks dropped. */
export function buildTranscript(messages: unknown[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const m of messages as any[]) {
    const role = m?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text =
      role === "user"
        ? userTurnText(m)
        : String(m?.content ?? "").replace(/\s+/g, " ").trim().slice(0, ASSISTANT_TURN_CHARS);
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

function turnChars(t: TranscriptTurn): number {
  return t.text.length + t.role.length + 3;
}

export function transcriptChars(turns: TranscriptTurn[]): number {
  return turns.reduce((n, t) => n + turnChars(t), 0);
}

export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.text}`).join("\n");
}

/** Chronological chunks, each ≤ maxChars (a single oversized turn rides alone). */
export function chunkTurns(turns: TranscriptTurn[], maxChars: number): TranscriptTurn[][] {
  const chunks: TranscriptTurn[][] = [];
  let cur: TranscriptTurn[] = [];
  let size = 0;
  for (const t of turns) {
    const len = turnChars(t);
    if (cur.length && size + len > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
