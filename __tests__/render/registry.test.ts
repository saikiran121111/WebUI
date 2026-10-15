import { describe, it, expect } from "vitest";
import { fenceKind } from "../../lib/render/registry";

describe("fence renderer registry", () => {
  it("routes special fences to their owners", () => {
    expect(fenceKind("mermaid")).toBe("mermaid");
    expect(fenceKind("chart")).toBe("chart");
    expect(fenceKind("widget")).toBe("widget");
  });

  it("is case-insensitive and strips meta info", () => {
    expect(fenceKind("Mermaid")).toBe("mermaid");
    expect(fenceKind("chart:bar")).toBe("chart");
  });

  it("everything else is code", () => {
    expect(fenceKind("js")).toBe("code");
    expect(fenceKind("")).toBe("code");
    expect(fenceKind("not-a-special-fence")).toBe("code");
  });
});
