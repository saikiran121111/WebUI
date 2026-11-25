/**
 * F153 (2026-11-24) — the persistence-ordering law, §1 data loss (item d).
 *
 * The disk tombstone in lib/persistence/disk.ts guarded ONLY the 5 s
 * wall-clock race: a save queued before a delete, landing 6 s later,
 * RECREATED the deleted chat (and the audit traced the same shape in the
 * Rust mirror). The law is now by CONTENT, not arrival:
 *   - meta.updatedAt <= the delete stamp  → dropped at ANY delay;
 *   - meta.updatedAt >  the delete stamp  → a legitimate recreation;
 *   - undated (legacy) writes keep the old 5 s race window;
 *   - an out-of-order save never clobbers a NEWER stored document.
 * Parity is pinned in the Rust mirror (persistence.rs save_at tests).
 * Synthetic stores only (WEBUI_DATA_DIR → a temp dir; the resolver is
 * consulted per call — see persistence/data-root.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;
const realEnv = process.env.WEBUI_DATA_DIR;
// Imported fresh under the synthetic root (vi.resetModules pattern).
let disk: typeof import("@/lib/persistence/disk");

const tmpSub = (prefix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `f153-${prefix}-`));

const doc = (id: string, updatedAt: number, title = "t"): string =>
  JSON.stringify({
    id,
    meta: {
      id, title, createdAt: 1, updatedAt,
      pinned: false, archived: false, mode: "chat", preview: "", messageCount: 1,
    },
    messages: [],
  });

beforeAll(async () => {
  dir = tmpSub("stale-save-");
  process.env.WEBUI_DATA_DIR = dir;
  disk = await import("@/lib/persistence/disk");
});

afterAll(() => {
  if (realEnv === undefined) delete process.env.WEBUI_DATA_DIR;
  else process.env.WEBUI_DATA_DIR = realEnv;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("persistence ordering: content timestamps decide, not arrival", () => {
  it("a queued save landing 6 s after the delete must NOT recreate the chat", () => {
    const id = "f153-stale";
    const stale = doc(id, Date.now() - 6000); // captured before the delete
    disk.saveConversationOnDisk(id, stale);
    disk.deleteConversationOnDisk(id);
    disk.saveConversationOnDisk(id, stale); // the late arrival
    expect(disk.getConversationOnDisk(id)).toBeNull();
  });

  it("a document NEWER than the delete is a legitimate recreation", () => {
    const id = "f153-fresh";
    disk.saveConversationOnDisk(id, doc(id, Date.now() - 1000));
    disk.deleteConversationOnDisk(id);
    const fresh = doc(id, Date.now() + 5000);
    disk.saveConversationOnDisk(id, fresh);
    expect(disk.getConversationOnDisk(id)).toContain("f153-fresh");
  });

  it("an out-of-order save never clobbers a NEWER stored document; equal stamps write", () => {
    const id = "f153-order";
    disk.saveConversationOnDisk(id, doc(id, 1000, "newer"));
    disk.saveConversationOnDisk(id, doc(id, 500, "late-and-stale"));
    expect(disk.getConversationOnDisk(id)).toContain("newer");
    disk.saveConversationOnDisk(id, doc(id, 1000, "same-revision")); // title merges ride equal stamps
    expect(disk.getConversationOnDisk(id)).toContain("same-revision");
  });

  it("the exact audit case: a save landing 6 s after the delete recreates NOTHING", async () => {
    // On HEAD the tombstone window expires at 5 s and this write lands —
    // the deleted chat is back. The ordering law drops it: the document
    // predates the delete.
    const id = "f153-6s";
    const queued = doc(id, Date.now() - 7000); // captured before the delete
    disk.saveConversationOnDisk(id, queued);
    disk.deleteConversationOnDisk(id);
    await new Promise(r => setTimeout(r, 6000)); // the queued POST finally lands
    disk.saveConversationOnDisk(id, queued);
    expect(disk.getConversationOnDisk(id)).toBeNull();
  }, 15000);

  it("undated legacy writes keep the 5 s delete-race window (Rust-parity behavior)", () => {
    const id = "f153-legacy";
    disk.saveConversationOnDisk(id, JSON.stringify({ id, messages: [] }));
    disk.deleteConversationOnDisk(id);
    disk.saveConversationOnDisk(id, JSON.stringify({ id, messages: [{ role: "user" }] }));
    expect(disk.getConversationOnDisk(id)).toBeNull();
  });
});
