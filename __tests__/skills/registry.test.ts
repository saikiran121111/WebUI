import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureScenario,
  readScenario,
  updateScenario,
  deleteSkill,
  syncInstalledSkills,
  listInstalledSkillNames,
  loadSkillBundle,
} from "../../lib/skills/registry";
import { BLOCKED_REASON } from "../../lib/skills/types";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "webui-registry-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeSkillDir(name: string, markdown: string) {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), markdown);
}

describe("ensureScenario", () => {
  it("creates the default scenario on first install", async () => {
    writeSkillDir("humanizer", "---\nname: humanizer\n---\nBody.");
    await ensureScenario(root, "humanizer", "blader/humanizer");
    expect(await readScenario(root, "humanizer")).toEqual({
      skillName: "humanizer",
      sourceRepo: "blader/humanizer",
      enabled: true,
      autoUse: false,
      whenToUse: "",
      triggerKeywords: [],
      blockedReason: null,
    });
  });

  it("never overwrites an existing scenario on re-index", async () => {
    writeSkillDir("humanizer", "Body.");
    await ensureScenario(root, "humanizer");
    await updateScenario(root, "humanizer", { autoUse: true, whenToUse: "When humanizing." });
    await ensureScenario(root, "humanizer", "other/repo");
    const scenario = (await readScenario(root, "humanizer"))!;
    expect(scenario.autoUse).toBe(true);
    expect(scenario.whenToUse).toBe("When humanizing.");
    expect(scenario.sourceRepo).not.toBe("other/repo");
  });

  it("blocks media-generation skills at creation", async () => {
    writeSkillDir("image-maker", "Use DALL-E to generate the hero image.");
    await ensureScenario(root, "image-maker", "acme/image-maker");
    const scenario = (await readScenario(root, "image-maker"))!;
    expect(scenario.enabled).toBe(false);
    expect(scenario.blockedReason).toBe(BLOCKED_REASON);
  });
});

describe("syncInstalledSkills", () => {
  it("moves temp installs into ./skills and removes duplicate copies", async () => {
    for (const tempDir of [".agents/skills", ".claude/skills"]) {
      const dir = join(root, tempDir, "demo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\nBody.");
    }
    const moved = await syncInstalledSkills(root);
    expect(moved).toContain("demo");
    expect(existsSync(join(root, "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "demo"))).toBe(false);
    expect(existsSync(join(root, ".claude", "skills", "demo"))).toBe(false);
    expect(await listInstalledSkillNames(root)).toEqual(["demo"]);
    expect(await readScenario(root, "demo")).not.toBeNull();
  });
});

describe("syncInstalledSkills", () => {
  it("removes dangling symlinks the CLI leaves in .claude/skills", async (ctx) => {
    const tempDir = join(root, ".claude", "skills");
    mkdirSync(tempDir, { recursive: true });
    try {
      symlinkSync(join(root, "skills", "demo"), join(tempDir, "demo"));
    } catch {
      ctx.skip(); // Windows without symlink privileges
    }
    await syncInstalledSkills(root);
    expect(existsSync(join(tempDir, "demo"))).toBe(false);
  });
});

describe("updateScenario / deleteSkill", () => {
  it("patches only the requested fields", async () => {
    writeSkillDir("humanizer", "Body.");
    await ensureScenario(root, "humanizer", "blader/humanizer");
    await updateScenario(root, "humanizer", { autoUse: true, triggerKeywords: ["humanize"] });
    const scenario = (await readScenario(root, "humanizer"))!;
    expect(scenario.autoUse).toBe(true);
    expect(scenario.triggerKeywords).toEqual(["humanize"]);
    expect(scenario.whenToUse).toBe("");
  });

  it("deletes the skill directory and its scenario together", async () => {
    writeSkillDir("humanizer", "Body.");
    await ensureScenario(root, "humanizer");
    expect(await deleteSkill(root, "humanizer")).toBe(true);
    expect(existsSync(join(root, "skills", "humanizer"))).toBe(false);
    expect(existsSync(join(root, "skill-scenarios", "humanizer.json"))).toBe(false);
    expect(await deleteSkill(root, "humanizer")).toBe(false);
  });
});

describe("loadSkillBundle", () => {
  it("includes SKILL.md plus referenced markdown inside the skill folder", async () => {
    writeSkillDir("demo", "# Demo\nSee [the guide](guide.md).");
    writeFileSync(join(root, "skills", "demo", "guide.md"), "Guide body.");
    const bundle = (await loadSkillBundle(root, "demo"))!;
    expect(bundle).toContain("# Demo");
    expect(bundle).toContain("Guide body.");
  });

  it("refuses to follow links outside the skill directory", async () => {
    writeSkillDir("demo", "Escape [attempt](../../outside.md).");
    writeFileSync(join(root, "outside.md"), "SECRET OUTSIDE");
    const bundle = (await loadSkillBundle(root, "demo"))!;
    expect(bundle).not.toContain("SECRET OUTSIDE");
  });

  it("returns null for unknown skills", async () => {
    expect(await loadSkillBundle(root, "nope")).toBeNull();
  });
});
