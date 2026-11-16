/**
 * R06 (2026-11-15 brief section 3.6) - native-Windows data-root resolution.
 *
 * Reproduced defect: lib/persistence/disk.ts and research-journal.ts computed
 * `path.join(process.env.HOME!, ...)` AT MODULE LOAD. Native Windows
 * (PowerShell / codex-local) sets USERPROFILE but usually no HOME, so test
 * collection and server start died with a property-access TypeError before
 * any conversation was read.
 *
 * What this pins:
 *   - an explicit WEBUI_DATA_DIR always wins (the test-isolation seam),
 *   - otherwise the OS home (os.homedir(): $HOME on POSIX, %USERPROFILE% on
 *     Windows) keeps the EXISTING location, so no user data ever moves,
 *   - a HOME-less Windows session still resolves via USERPROFILE,
 *   - a machine with no home at all fails with an actionable message, never
 *     a silent fallback that would relocate (or appear to relocate) data,
 *   - both persistence modules share the resolver and honour an override set
 *     AFTER import (lazy resolution per call, not a module-load constant).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const osMock = vi.hoisted(() => ({
  home: "C:\\Users\\Ruku",
  throwHomedir: false,
  tmp: "",
}));

vi.mock("node:os", () => ({
  default: {
    homedir: () => {
      if (osMock.throwHomedir) throw new Error("HOME could not be determined");
      return osMock.home;
    },
    tmpdir: () => osMock.tmp,
    platform: () => "win32",
  },
  homedir: () => {
    if (osMock.throwHomedir) throw new Error("HOME could not be determined");
    return osMock.home;
  },
  tmpdir: () => osMock.tmp,
  platform: () => "win32",
}));

const REL = [".local-intelligence", "conversations"];

function tmpSub(name: string): string {
  const dir = fs.mkdtempSync(path.join(osMock.tmp, name));
  tmpCreated.push(dir);
  return dir;
}
const tmpCreated: string[] = [];

const savedEnv = {
  data: process.env.WEBUI_DATA_DIR,
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
};

function restoreEnv(): void {
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  put("WEBUI_DATA_DIR", savedEnv.data);
  put("HOME", savedEnv.home);
  put("USERPROFILE", savedEnv.userprofile);
  osMock.throwHomedir = false;
}

async function freshResolver(): Promise<typeof import("@/lib/persistence/dataRoot")> {
  vi.resetModules();
  return await import("@/lib/persistence/dataRoot");
}

beforeAll(() => {
  osMock.tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "r06-os-"));
  tmpCreated.push(osMock.tmp);
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("R06 data-root resolver", () => {
  it("an explicit WEBUI_DATA_DIR always wins, on any platform", async () => {
    const dir = tmpSub("r06-override-");
    process.env.WEBUI_DATA_DIR = dir;
    osMock.home = "/home/ruku";
    const m = await freshResolver();
    expect(m.hasDataDirOverride()).toBe(true);
    expect(m.conversationsDir()).toBe(path.resolve(dir));
    const report = m.conversationDirReport();
    expect(report.source).toBe("override");
    expect(report.exists).toBe(true);
  });

  it("no override keeps the existing home location (POSIX spelling)", async () => {
    delete process.env.WEBUI_DATA_DIR;
    osMock.home = "/home/ruku";
    osMock.throwHomedir = false;
    const m = await freshResolver();
    expect(m.hasDataDirOverride()).toBe(false);
    // path.join normalises separators per platform, so compare to the join.
    expect(m.conversationsDir()).toBe(path.join("/home/ruku", ...REL));
    expect(m.conversationDirReport().source).toBe("home");
  });

  it("HOME-less native Windows resolves through USERPROFILE", async () => {
    delete process.env.WEBUI_DATA_DIR;
    delete process.env.HOME;
    process.env.USERPROFILE = "C:\\Users\\Ruku";
    osMock.throwHomedir = true; // hardened/odd sessions can fail os.homedir()
    const m = await freshResolver();
    expect(m.conversationsDir()).toBe(path.join("C:\\Users\\Ruku", ...REL));
  });

  it("USERPROFILE is also the fallback when os.homedir() is empty", async () => {
    delete process.env.WEBUI_DATA_DIR;
    delete process.env.HOME;
    process.env.USERPROFILE = "D:\\UserHomes\\Ruku";
    osMock.home = "   ";
    osMock.throwHomedir = false;
    const m = await freshResolver();
    expect(m.conversationsDir()).toBe(path.join("D:\\UserHomes\\Ruku", ...REL));
  });

  it("no override and no home fails with an actionable error, not a TypeError", async () => {
    delete process.env.WEBUI_DATA_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    osMock.throwHomedir = true;
    const m = await freshResolver();
    let caught: unknown = null;
    try {
      m.conversationsDir();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("Error");
    expect((caught as Error).message).toContain("WEBUI_DATA_DIR");
    // The old defect was a property-access crash, which stays impossible.
    expect((caught as Error).message).not.toMatch(/undefined/);
  });

  it("persistence modules share the resolver and honour a late-set override", async () => {
    // The isolation seam the audit needed: WEBUI_DATA_DIR set, THEN import.
    const dir = tmpSub("r06-wiring-");
    process.env.WEBUI_DATA_DIR = dir;
    vi.resetModules();
    const disk = await import("@/lib/persistence/disk");
    const journal = await import("@/lib/persistence/research-journal");
    expect(disk.getDataDir()).toBe(path.resolve(dir));

    disk.ensureDir();
    disk.saveConversationOnDisk("r06-demo", JSON.stringify({ id: "r06-demo", messages: [] }));
    expect(fs.existsSync(path.join(dir, "r06-demo.json"))).toBe(true);
    expect(disk.getConversationOnDisk("r06-demo")).toContain("r06-demo");

    // Same root, journal filename never collides with the document store.
    expect(journal.researchJournalFile("r06-demo")).toBe(path.join(dir, "r06-demo.research.json"));

    // And the override is honoured PER CALL, so a later isolated run can
    // repoint both modules without a reimport (module-load constants were
    // part of the original defect).
    const dir2 = tmpSub("r06-wiring2-");
    process.env.WEBUI_DATA_DIR = dir2;
    expect(disk.getDataDir()).toBe(path.resolve(dir2));
    expect(journal.researchJournalFile("r06-demo")).toBe(path.join(dir2, "r06-demo.research.json"));
    expect(disk.listConversationsOnDisk()).toHaveLength(0);
  });

  it("nothing is created, moved or deleted by resolution itself", async () => {
    const ghost = path.join(osMock.tmp, "r06-never-created");
    process.env.WEBUI_DATA_DIR = ghost;
    const m = await freshResolver();
    expect(m.conversationsDir()).toBe(path.resolve(ghost));
    expect(fs.existsSync(ghost)).toBe(false);
    expect(m.conversationDirReport().exists).toBe(false);
  });
});

afterAll(() => {
  for (const dir of tmpCreated) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  restoreEnv();
});
