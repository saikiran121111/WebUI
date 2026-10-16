import { describe, it, expect } from "vitest";
import { parseInstallRequest } from "../../lib/skills/registry";

describe("parseInstallRequest", () => {
  it("accepts a bare owner/repo slug", () => {
    expect(parseInstallRequest("blader/humanizer")).toEqual({
      repo: "blader/humanizer",
      skillName: null,
    });
  });

  it("accepts owner/repo with --skill", () => {
    expect(parseInstallRequest("blader/humanizer --skill humanizer")).toEqual({
      repo: "blader/humanizer",
      skillName: "humanizer",
    });
  });

  it("strips a full npx skills add command", () => {
    expect(
      parseInstallRequest("npx -y skills add blader/humanizer --skill humanizer -y"),
    ).toEqual({ repo: "blader/humanizer", skillName: "humanizer" });
  });

  it("normalizes a GitHub URL to owner/repo", () => {
    expect(parseInstallRequest("https://github.com/blader/humanizer")).toEqual({
      repo: "blader/humanizer",
      skillName: null,
    });
    expect(parseInstallRequest("https://github.com/blader/humanizer.git")).toEqual({
      repo: "blader/humanizer",
      skillName: null,
    });
  });

  it("rejects empty input", () => {
    expect(() => parseInstallRequest("")).toThrow();
    expect(() => parseInstallRequest("   ")).toThrow();
  });

  it("rejects shell metacharacters in the repo token", () => {
    expect(() => parseInstallRequest("evil; rm -rf /")).toThrow();
    expect(() => parseInstallRequest("evil$(whoami)/repo")).toThrow();
    expect(() => parseInstallRequest("evil|cat/repo")).toThrow();
  });

  it("rejects unknown flags", () => {
    expect(() => parseInstallRequest("owner/repo --force")).toThrow();
  });

  it("rejects unsafe skill names", () => {
    expect(() => parseInstallRequest("owner/repo --skill 'bad name'")).toThrow();
  });
});
