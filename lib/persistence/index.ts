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

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`/api/conversations/${id}`, { method: "DELETE" });
}

export async function updateConversationMeta(id: string, patch: Partial<ConversationMeta>): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.meta = { ...conv.meta, ...patch };
  await saveConversation(conv);
}