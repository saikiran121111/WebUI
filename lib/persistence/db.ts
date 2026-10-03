import type { Conversation, ConversationMeta, Message } from "../types";

const DB_NAME = "webui-chat";
const DB_VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror    = () => reject(req.error);
  });
}

async function tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(store, mode).objectStore(store);
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const store = await tx("conversations", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const items: ConversationMeta[] = req.result
        .filter((c: any) => c && c.meta)
        .map((c: any) => c.meta)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const store = await tx("conversations", "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  // IDB object store was created with keyPath: "id". Guarantee it exists,
  // even when older records from before the schema change are re-saved.
  if (!conversation.id) {
    if (conversation.meta?.id) {
      conversation.id = conversation.meta.id;
    } else {
      throw new Error("saveConversation: conversation is missing both `id` and `meta.id`");
    }
  }
  const store = await tx("conversations", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(conversation);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteConversation(id: string): Promise<void> {
  const store = await tx("conversations", "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function updateConversationMeta(id: string, patch: Partial<ConversationMeta>): Promise<void> {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.meta = { ...conv.meta, ...patch };
  await saveConversation(conv);
}
