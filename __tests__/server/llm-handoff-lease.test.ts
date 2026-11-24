import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 2026-11-17 resource-aware handoff amendment, sections 3-5.
 *
 * The main model is parked by ONE client at a time. The Rust server, the
 * Python ML backend (and, until F123 retired it, the Node ASR stage) are
 * separate processes, so the shared lease FILE is the authority; ruke-core's
 * admission gate and ruke_ml/handoff.py consult it exactly the way the
 * record format pinned here describes. These tests are hermetic: every lease
 * lives in a throwaway temp dir, never the real project root.
 */

import {
  LEASE_RECORD_BYTES,
  acquireLease,
  heartbeatLease,
  leasePath,
  leaseState,
  releaseLease,
} from "../../lib/server/coordination/llm-lease";

let dir = "";
let lease = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-lease-"));
  lease = path.join(dir, ".ai-coordination", "llm-handoff.lock");
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best effort */
  }
});

/** Write a record in exactly the wire format the other two clients emit. */
function writeRaw(record: Record<string, unknown>, oldMtime = false): void {
  fs.mkdirSync(path.dirname(lease), { recursive: true });
  const text = JSON.stringify(record);
  const data = Buffer.from(text, "utf8").subarray(0, LEASE_RECORD_BYTES);
  const out = Buffer.alloc(LEASE_RECORD_BYTES, 0);
  out.set(data, 0);
  fs.writeFileSync(lease, out);
  if (oldMtime) {
    // The other two clients treat file mtime as evidence too, so a test that
    // wants a genuinely abandoned record must age BOTH the heartbeat and mtime.
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(lease, past, past);
  }
}

describe("the shared lease record itself", () => {
  it("reports held/owner/phase and keeps the record fixed-width", () => {
    const took = acquireLease("ruke-node-asr", "processing", lease);
    expect(took.acquired).toBe(true);
    expect(fs.statSync(lease).size).toBe(LEASE_RECORD_BYTES);
    const state = leaseState(lease);
    expect(state.held).toBe(true);
    expect(state.stale).toBe(false);
    expect(state.proof).toContain("ruke-node-asr");
    expect(state.proof).toContain("phase processing");
    expect(state.holder?.pid).toBe(process.pid);
  });

  it("a second client refuses instead of stealing the token, and cannot overwrite it", () => {
    const first = acquireLease("ruke-python", "processing", lease);
    const second = acquireLease("ruke-node-asr", "processing", lease);
    expect(second.acquired).toBe(false);
    expect(second.refusal).toContain("already parked");
    expect(leaseState(lease).holder?.token).toBe(first.token);
  });

  it("release is owner-only: a foreign token never deletes the lock", () => {
    const first = acquireLease("ruke-python", "processing", lease);
    expect(releaseLease(lease, "deadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
    expect(leaseState(lease).held).toBe(true);
    expect(releaseLease(lease, first.token)).toBe(true);
    expect(leaseState(lease).held).toBe(false);
  });

  it("heartbeat is owner-only and refreshes the evidence", () => {
    const first = acquireLease("ruke-python", "processing", lease);
    expect(heartbeatLease(lease, "nope", "ready")).toBe(false);
    writeRaw({ ...(first.state.holder as object), heartbeat: Date.now() / 1000 - 3600 }, true);
    const old = leaseState(lease);
    expect(old.stale).toBe(true);
    expect(heartbeatLease(lease, first.token, "releasing_worker")).toBe(true);
    const fresh = leaseState(lease);
    expect(fresh.held).toBe(true);
    expect(fresh.holder?.phase).toBe("releasing_worker");
  });

  it("blank and garbage records fail OPEN with a stated proof, and a timestamp-less record is only trusted while its mtime is fresh", () => {
    // A record we cannot read is NOT evidence that the model is free. Treating
    // corrupt bytes as "unlocked" let a second client park a model that a live
    // supervisor was still holding. It is held-UNCERTAIN until its OWN file age
    // proves it was abandoned - and that window is bounded, so a broken record
    // can never park the app forever either.
    for (const junk of ["", "   ", "not json at all", "[1,2,3]"]) {
      fs.mkdirSync(path.dirname(lease), { recursive: true });
      fs.writeFileSync(lease, junk);
      const state = leaseState(lease);
      expect(state.state, junk).toBe("corrupt");
      expect(state.held, junk).toBe(true);
      expect(state.uncertain, junk).toBe(true);
      expect(state.abandoned, junk).toBe(false);
      expect(state.proof, junk).toMatch(/blank|not parseable|not an object/i);
      expect(state.proof, junk).toMatch(/no holder can be ruled out/);
      // And a second client must be refused, not silently allowed to park.
      const took = acquireLease("ruke-node-asr", "processing", lease);
      expect(took.acquired, junk).toBe(false);
      expect(took.refusal, junk).toMatch(/already parked|ruled out/);
    }
    // A record with no heartbeat field rides on file mtime; once that is past
    // the window too, it is provably abandoned and admission proceeds.
    writeRaw({ token: "e".repeat(32), owner: "no-heartbeat", pid: process.pid, phase: "processing" }, true);
    const aged = leaseState(lease);
    expect(aged.state).toBe("ok");
    expect(aged.held).toBe(false);
    expect(aged.stale).toBe(true);
    expect(aged.abandoned).toBe(true);
    expect(aged.proof).toMatch(/window/);
  });

  it("a record that exists but cannot be read is unreadable, not free", () => {
    // A directory where the record should be: readFileSync raises EISDIR, which
    // is not ENOENT, so claiming "no lease exists" would be a lie.
    fs.mkdirSync(lease, { recursive: true });
    const state = leaseState(lease);
    expect(state.state).toBe("unreadable");
    expect(state.held).toBe(true);
    expect(state.uncertain).toBe(true);
    expect(state.proof).toMatch(/could not be read/);
    const took = acquireLease("ruke-node-asr", "processing", lease);
    expect(took.acquired).toBe(false);
  });

  it("an aged unreadable record IS abandoned, so a broken supervisor cannot park the app forever", () => {
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, "truncated because a writer died mid-write {");
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(lease, past, past);
    const state = leaseState(lease);
    expect(state.state).toBe("corrupt");
    expect(state.held).toBe(false);
    expect(state.abandoned).toBe(true);
    expect(state.proof).toMatch(/abandoned/);
  });

  it("a record with neither token nor owner cannot even name a holder", () => {
    writeRaw({ phase: "processing", pid: process.pid });
    const state = leaseState(lease);
    expect(state.state).toBe("corrupt");
    expect(state.held).toBe(true);
    expect(state.uncertain).toBe(true);
    expect(state.proof).toMatch(/neither a token nor an owner/);
  });

  it("an oversized heartbeat drops optional payload instead of truncating JSON", () => {
    const first = acquireLease("ruke-node-asr", "processing", lease);
    expect(first.acquired).toBe(true);
    expect(
      heartbeatLease(lease, first.token, "processing", { note: "y".repeat(8_000) }),
    ).toBe(true);
    // Still exactly one fixed-width slot, still parseable, still OURS.
    expect(fs.statSync(lease).size).toBe(LEASE_RECORD_BYTES);
    const state = leaseState(lease);
    expect(state.state).toBe("ok");
    expect(state.held).toBe(true);
    expect(state.uncertain).toBe(false);
    expect(state.holder?.token).toBe(first.token);
    expect(state.holder?.owner).toBe("ruke-node-asr");
    expect(state.holder?.phase).toBe("processing");
    expect(state.holder?.heartbeat).toBeGreaterThan(Date.now() / 1000 - 60);
    // The optional payload is gone; the lease itself is intact.
    expect(state.holder?.note).toBeUndefined();
    expect(releaseLease(lease, first.token)).toBe(true);
  });

  it("file mtime alone counts as evidence, so a client without heartbeats is not orphaned", () => {
    writeRaw({ token: "a".repeat(32), owner: "handoff-cli", pid: process.pid, phase: "processing", heartbeat: Date.now() / 1000 - 3600 });
    fs.utimesSync(lease, new Date(), new Date());
    expect(leaseState(lease).held).toBe(true);
  });

  it("an abandoned record with a DEAD pid is taken over, a live pid is not", () => {
    // pid 0x7FFFFFFF is not a real process on this host.
    writeRaw({ token: "b".repeat(32), owner: "crashed-cli", pid: 0x7ffffffe, phase: "processing", heartbeat: Date.now() / 1000 - 3600 }, true);
    const dead = leaseState(lease);
    expect(dead.stale).toBe(true);
    const took = acquireLease("ruke-node-asr", "processing", lease);
    expect(took.acquired).toBe(true);

    writeRaw({ token: "c".repeat(32), owner: "quiet-but-alive", pid: process.pid, phase: "processing", heartbeat: Date.now() / 1000 - 3600 }, true);
    const refused = acquireLease("ruke-node-asr", "processing", lease);
    expect(refused.acquired).toBe(false);
    expect(refused.refusal).toMatch(/still running/);
  });

  it("leasePath points at the project-local coordination file other clients read", () => {
    expect(leasePath("/tmp/x")).toBe(path.join("/tmp/x", ".ai-coordination", "llm-handoff.lock"));
  });
});

/* ------------------------------------------------------------------ *
 * F123 (2026-11-23): the Node ASR stage-2 coordination tests that lived
 * here are retired with lib/server/extract/audio.ts (the TypeScript
 * whisper substitution). The law they pinned did not die: the unload
 * discipline (foreign live lease -> refuse the unload; own lease ->
 * release BEFORE the restore warm-up; handoff policy off -> never claim
 * the lease; test processes never POST /unload at the live provider)
 * is now enforced and tested on the Python side, where the placement
 * decision actually happens: ruke_ml/handoff.py + the F91 placement
 * tests in tests/test_asr_dispatch.py and tests/test_handoff_devices.py,
 * against the SAME lease record this file pins the format of.
 * ------------------------------------------------------------------ */
