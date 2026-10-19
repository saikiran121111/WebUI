/**
 * Queue behaviour on a throwaway WEBUI_DATA_DIR with an injected fake model:
 * eligibility gates, coalescing, global serialisation (never two title calls
 * at once — protects the shared inference slot), bounded retry, and the
 * end-to-end stale-job guard (an older job can never overwrite a newer title).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  beginUserTurn,
  endUserTurn,
  resetInferenceBusy,
} from "@/lib/server/inference-busy";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webui-titles-queue-"));

// Dynamic imports inside beforeAll: disk.ts resolves DATA_DIR at module
// load, so the env var must be set before the module is first imported.
type DiskMod = typeof import("@/lib/persistence/disk");
type QueueMod = typeof import("@/lib/server/titles/queue");
let disk: DiskMod;
let queue: QueueMod;
type CallModel = import("@/lib/server/titles/generate").CallModel;

beforeAll(async () => {
  process.env.WEBUI_DATA_DIR = tmp;
  disk = await import("@/lib/persistence/disk");
  queue = await import("@/lib/server/titles/queue");
});

const msg = (role: string, content: string) => ({
  id: `${role}-${Math.random().toString(36).slice(2)}`,
  conversationId: "c_q",
  role,
  content,
  attachments: [],
  state: "complete",
});

function seed(id: string, meta: Record<string, unknown>, messages: ReturnType<typeof msg>[]) {
  disk.saveConversationOnDisk(id, JSON.stringify({ id, meta, messages }));
}

function read(id: string): any {
  return JSON.parse(disk.getConversationOnDisk(id)!);
}

const conv = () => [
  msg("user", "Can you watch this video and explain the timestamp drift issue in detail please"),
  msg("assistant", "Sure — the drift comes from variable frame rate."),
];

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  queue.resetTitleQueue();
  resetInferenceBusy();
});

describe("title queue", () => {
  it("generates and persists a title for a legacy first-message title", async () => {
    const id = "c_legacy";
    const first = conv()[0].content;
    seed(id, { id, title: first.slice(0, 40), createdAt: 1, updatedAt: 111 }, conv());

    const r = queue.requestTitleGeneration(id, { callModel: async () => "Video Timestamp Drift Fix" });
    expect(r.status).toBe("queued");
    const done = await r.done!;
    expect(done).toEqual({ ok: true, title: "Video Timestamp Drift Fix" });

    const meta = read(id).meta;
    expect(meta.title).toBe("Video Timestamp Drift Fix");
    expect(meta.titleSource).toBe("auto");
    expect(meta.titleGenCount).toBe(2);
    expect(meta.updatedAt).toBe(111); // sidebar order preserved
  });

  it("skips manual titles, fresh generations, and non-auto titles under force", async () => {
    seed("c_man", { id: "c_man", title: "Keep Me", titleSource: "manual" }, conv());
    expect(queue.requestTitleGeneration("c_man", { callModel: async () => "X" }).status).toBe("skipped");

    seed("c_fresh", { id: "c_fresh", title: "T", titleSource: "auto", titleGenCount: 2 }, conv());
    const fresh = queue.requestTitleGeneration("c_fresh", { callModel: async () => "X" });
    expect(fresh.status).toBe("skipped");
    expect(fresh.reason).toBe("fresh");

    seed("c_hand", { id: "c_hand", title: "My Handwritten Title" }, conv());
    const forced = queue.requestTitleGeneration("c_hand", { force: true, callModel: async () => "X" });
    expect(forced.status).toBe("skipped");
    expect(forced.reason).toBe("not-auto-title");

    // Same doc, but the title IS the legacy first-message copy → force runs.
    seed("c_leg2", { id: "c_leg2", title: conv()[0].content.slice(0, 40) }, conv());
    expect(queue.requestTitleGeneration("c_leg2", { force: true, callModel: async () => "Forced Title" }).status).toBe("queued");
    await waitFor(() => read("c_leg2").meta.title === "Forced Title");
  });

  it("waits for a meaningful assistant reply; keeps the old title when there is none", async () => {
    seed("c_noasst", { id: "c_noasst", title: "Old Title" }, [
      msg("user", "first question here"),
      msg("user", "second question here"),
    ]);
    const r = queue.requestTitleGeneration("c_noasst", { callModel: async () => "Should Not Run" });
    expect(r.status).toBe("queued");
    const done = await r.done!;
    expect(done.ok).toBe(false);
    expect(done.reason).toBe("no-assistant-reply");
    expect(read("c_noasst").meta.title).toBe("Old Title");
  });

  it("coalesces a mid-job request: the job reruns once on the freshest history", async () => {
    const id = "c_coal";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) await gate;
      return `Title ${calls}`;
    };

    const a = queue.requestTitleGeneration(id, { callModel: fn });
    expect(a.status).toBe("queued");
    await waitFor(() => calls === 1); // job is inside the model call

    const b = queue.requestTitleGeneration(id, { callModel: fn });
    expect(b.status).toBe("coalesced");

    release();
    const done = await a.done!;
    expect(done.ok).toBe(true);
    expect(calls).toBe(2); // pending flag forced one rerun, not a parallel job
    expect(read(id).meta.title).toBe("Title 2");
  });

  it("never runs two title jobs at once (shared inference slot protection)", async () => {
    seed("c_s1", { id: "c_s1", title: conv()[0].content.slice(0, 40) }, conv());
    seed("c_s2", { id: "c_s2", title: conv()[0].content.slice(0, 40) }, conv());

    let active = 0;
    let maxActive = 0;
    const fn: CallModel = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return "Serial Title";
    };

    const r1 = queue.requestTitleGeneration("c_s1", { callModel: fn });
    const r2 = queue.requestTitleGeneration("c_s2", { callModel: fn });
    await Promise.all([r1.done!, r2.done!]);
    expect(maxActive).toBe(1);
    expect(read("c_s1").meta.title).toBe("Serial Title");
    expect(read("c_s2").meta.title).toBe("Serial Title");
  });

  it("bounded retry: one null attempt, then success; the title survives both failures", async () => {
    const id = "c_retry";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    let calls = 0;
    const fn = async () => {
      calls++;
      return calls === 1 ? null : "Recovered Title";
    };
    const r = queue.requestTitleGeneration(id, { callModel: fn });
    const done = await r.done!;
    expect(done.ok).toBe(true);
    expect(done.title).toBe("Recovered Title");
    expect(calls).toBe(2);
  }, 15000);

  it("gives up after MAX attempts and keeps the last valid title", async () => {
    const id = "c_fail";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    let calls = 0;
    const fn = async () => {
      calls++;
      return null;
    };
    const r = queue.requestTitleGeneration(id, { callModel: fn });
    const done = await r.done!;
    expect(done.ok).toBe(false);
    expect(done.reason).toBe("generation-failed");
    expect(calls).toBe(2); // bounded — no retry storm
    expect(read(id).meta.title).toBe(conv()[0].content.slice(0, 40));
  }, 15000);

  it("an older in-flight job cannot overwrite a newer title that landed mid-call", async () => {
    const id = "c_stale";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const r = queue.requestTitleGeneration(id, {
      callModel: async () => {
        entered = true; // the 2-message snapshot was taken before this call
        await gate;
        return "Stale Job Result";
      },
    });
    await waitFor(() => entered);

    // Meanwhile a NEWER generation lands (10-message snapshot).
    const doc = read(id);
    doc.meta.title = "Newer Title";
    doc.meta.titleSource = "auto";
    doc.meta.titleGenCount = 10;
    disk.saveConversationOnDisk(id, JSON.stringify(doc));

    release();
    const done = await r.done!;
    expect(done.ok).toBe(false);
    expect(done.reason).toBe("stale-or-manual");
    expect(read(id).meta.title).toBe("Newer Title");
  });

  it("defers the job while a user turn owns the shared inference slot", async () => {
    const id = "c_defer";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    beginUserTurn(); // the user's stream is mid-flight when the job is queued
    let started = false;
    const r = queue.requestTitleGeneration(id, {
      callModel: async () => {
        started = true;
        return "Deferred Title";
      },
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(started).toBe(false); // never starts while the user holds the slot

    endUserTurn();
    const done = await r.done!; // proceeds once the slot frees (poll cadence)
    expect(done.ok).toBe(true);
    expect(started).toBe(true);
    expect(read(id).meta.title).toBe("Deferred Title");
  }, 15000);

  it("a user turn starting mid-call aborts the title job (user inference always wins)", async () => {
    const id = "c_yield";
    seed(id, { id, title: conv()[0].content.slice(0, 40) }, conv());

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const r = queue.requestTitleGeneration(id, {
      callModel: async () => {
        entered = true;
        await gate; // simulates a slow model call holding the slot
        return "Late Title";
      },
    });
    await waitFor(() => entered);

    beginUserTurn(); // the user sends their next message mid-title-call
    endUserTurn();
    release();

    const done = await r.done!;
    expect(done.ok).toBe(false);
    expect(done.reason).toBe("yielded-to-user");
    expect(read(id).meta.title).toBe(conv()[0].content.slice(0, 40)); // last valid title kept
  });
});
