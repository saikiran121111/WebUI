/**
 * Title policy: who owns a conversation's title, when a refresh is due, and
 * the guarded write that makes concurrent/late title jobs safe.
 *
 * A title is either "manual" (user renamed it — never overwritten) or "auto"
 * (machine-generated — owned by the server-side title job). Legacy documents
 * have no titleSource; they are recognised as auto by matching the title
 * against the first user message (the old page.tsx `slice(0, 40)` fallback).
 */

/** A refresh is due once the conversation grew by this many messages since the
 * last generation (~every two exchanges — enough new signal, bounded cost). */
export const REFRESH_MESSAGE_DELTA = 4;

/** The first user message's typed text (first text part for parts arrays). */
export function firstUserText(messages: unknown[]): string {
  for (const m of messages as any[]) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p?.text === "string" && p.text.trim()) return p.text;
      }
    }
    return "";
  }
  return "";
}

/**
 * Does this title look like the legacy auto-copy of the first message (or a
 * blank placeholder)? Used by the backfill/force path to decide whether a
 * title may be regenerated — a title that matches neither the first message
 * nor a placeholder is treated as user-authored and left alone.
 */
export function looksAutoTitle(title: string, firstText: string): boolean {
  const t = (title ?? "").trim();
  if (!t || t === "New conversation" || t === "Untitled") return true;
  const first = (firstText ?? "").trim();
  if (!first) return false;
  return t === first.slice(0, 40) || t === first.replace(/\s+/g, " ").slice(0, 40);
}

/** Should a (non-forced) title job run for this conversation right now? */
export function shouldGenerate(meta: any, messageCount: number, force: boolean): boolean {
  if (meta?.titleSource === "manual") return false;
  if (force) return true;
  // Never generated: once a meaningful exchange exists (user + assistant).
  if (typeof meta?.titleGenCount !== "number") return messageCount >= 2;
  return messageCount - meta.titleGenCount >= REFRESH_MESSAGE_DELTA;
}

/**
 * Guarded in-memory title write. Returns false (doc untouched) when the title
 * is manual or the stored generation is NEWER than this job's snapshot — the
 * "an older job must never overwrite a newer title" rule. Deliberately does
 * NOT bump updatedAt: a background title refresh must not reorder the sidebar.
 */
export function applyTitleToDoc(doc: any, title: string, genCount: number): boolean {
  const meta = doc?.meta;
  if (!meta || !title) return false;
  if (meta.titleSource === "manual") return false;
  if (typeof meta.titleGenCount === "number" && meta.titleGenCount > genCount) return false;
  meta.title = title;
  meta.titleSource = "auto";
  meta.titleGenCount = genCount;
  meta.titleGenAt = Date.now();
  return true;
}
