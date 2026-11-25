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

/** meta.updatedAt of a stored document; 0 = undated/legacy/unparseable. */
function docUpdatedAt(json: string | null): number {
  if (!json) return 0;
  try {
    const u = JSON.parse(json)?.meta?.updatedAt;
    return typeof u === "number" && Number.isFinite(u) ? u : 0;
  } catch {
    return 0;
  }
}

export function saveConversationOnDisk(id: string, json: string): void {
  // F153 (2026-11-24) — the PERSISTENCE-ORDERING law. The 5 s wall-clock
  // window below only swallows writes racing the delete; the audit found a
  // queued save landing 6 s later recreating the deleted chat. The law is
  // by CONTENT, not arrival: a document whose meta.updatedAt predates the
  // delete is stale at ANY delay — dropped; a document newer than the
  // delete is a legitimate recreation and retires the tombstone. Undated
  // legacy writes keep the old race window (parity: Rust `save_at`).
  const incomingAt = docUpdatedAt(json);
  const deletedAt = recentlyDeleted.get(id);
  if (deletedAt !== undefined) {
    if (incomingAt > 0) {
      if (incomingAt <= deletedAt) return; // stale by content — never resurrect
      recentlyDeleted.delete(id);
    } else if (Date.now() - deletedAt < 5000) {
      return; // undated write racing a delete — drop the write
    } else {
      recentlyDeleted.delete(id);
    }
  }
  // Out-of-order saves: last writer is decided by the CONTENT timestamp,
  // not by arrival — a late save must not clobber a newer stored document.
  const storedAt = docUpdatedAt(getConversationOnDisk(id));
  if (storedAt > 0 && incomingAt > 0 && incomingAt < storedAt) return;
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
