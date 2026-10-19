import type { Conversation, ConversationMeta } from "../types";

export async function listConversations(): Promise<ConversationMeta[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) return [];
  const rows: Array<{ meta: ConversationMeta }> = await res.json();
  return rows
    .map(r => r.meta)
    .filter((m): m is ConversationMeta => !!m)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) return null;
  try { return (await res.json()) as Conversation; } catch { return null; }
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: conv.id, json: JSON.stringify(conv) }),
  });
}

export async function deleteConversation(id: string): Promise<boolean> {
  const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  return res.ok;
}

/**
 * Ask the server to (re)generate this conversation's auto title from its
 * full stored history. Best-effort background work: the job runs server-side
 * (surviving this request), the queue serialises it behind active inference,
 * and any failure simply keeps the last valid title — so errors are silent.
 */
export async function requestTitleGeneration(id: string, model?: string): Promise<void> {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}/title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model || undefined }),
    });
  } catch {
    // title generation is best-effort — never surface to the conversation
  }
}

export async function updateConversationMeta(id: string, patch: Partial<ConversationMeta>): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.meta = { ...conv.meta, ...patch };
  await saveConversation(conv);
}