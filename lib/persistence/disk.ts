import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.WEBUI_DATA_DIR ?? path.join(process.env.HOME!, ".local-intelligence", "conversations");

/** Make sure the conversations directory exists. */
export function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Filename for a conversation. */
function file(id: string): string {
  // Sanitise — IDs are already safe, but be defensive.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DATA_DIR, `${safe}.json`);
}

export function listConversationsOnDisk(): { id: string; updatedAt: number }[] {
  ensureDir();
  try {
    return fs.readdirSync(DATA_DIR)
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

export function saveConversationOnDisk(id: string, json: string): void {
  ensureDir();
  fs.writeFileSync(file(id), json, "utf-8");
}

export function deleteConversationOnDisk(id: string): void {
  const fp = file(id);
  try { fs.unlinkSync(fp); } catch { /* ignore */ }
}

export function getDataDir(): string {
  return DATA_DIR;
}
