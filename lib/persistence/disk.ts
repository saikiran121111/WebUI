import fs from "node:fs";
import path from "node:path";
import { conversationsDir } from "./dataRoot";

// R6 (2026-11-15 brief 3.6): the root used to be computed at MODULE LOAD from
// `process.env.HOME!`, which does not exist on native Windows. It is now a
// lazy call into the shared platform-correct resolver, so an isolated
// WEBUI_DATA_DIR set after import is honoured and nothing crashes at import.
const DATA_DIR = (): string => conversationsDir();

/** Make sure the conversations directory exists. */
export function ensureDir() {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
}

/** Filename for a conversation. */
function file(id: string): string {
  // Sanitise — IDs are already safe, but be defensive.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DATA_DIR(), `${safe}.json`);
}

export function listConversationsOnDisk(): { id: string; updatedAt: number }[] {
  ensureDir();
  try {
    return fs.readdirSync(DATA_DIR())
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => {
        const id = f.slice(0, -5);
        const fp = file(id);
        let updatedAt = 0;
        try {
          const s = fs.statSync(fp);
          updatedAt = s.mtimeMs;
        } catch { /* ignore */ }
        return { id, updatedAt };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function getConversationOnDisk(id: string): string | null {
  try {
    return fs.readFileSync(file(id), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Tombstones for ids deleted this server session. A save POST that was
 * already in flight when the user hit delete must not resurrect the file.
 */
const recentlyDeleted = new Map<string, number>();

export function saveConversationOnDisk(id: string, json: string): void {
  const deletedAt = recentlyDeleted.get(id);
  if (deletedAt !== undefined) {
    if (Date.now() - deletedAt < 5000) return; // racing a delete — drop the write
    recentlyDeleted.delete(id);
  }
  ensureDir();
  fs.writeFileSync(file(id), json, "utf-8");
}

export function deleteConversationOnDisk(id: string): void {
  recentlyDeleted.set(id, Date.now());
  const fp = file(id);
  try { fs.unlinkSync(fp); } catch { /* ignore */ }
}

export function getDataDir(): string {
  return DATA_DIR();
}
