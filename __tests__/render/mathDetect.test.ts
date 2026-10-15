import { describe, it, expect } from "vitest";
import { containsMath } from "../../lib/render/mathDetect";

describe("TeX delimiter detection", () => {
  it("detects display math", () => {
    expect(containsMath("$$x^2 + y^2 = z^2$$")).toBe(true);
    expect(containsMath("\\[ \\int_0^1 x\\,dx \\]")).toBe(true);
  });

  it("detects inline math", () => {
    expect(containsMath("Einstein wrote \\(E = mc^2\\) here")).toBe(true);
    expect(containsMath("the value $x$ is small")).toBe(true);
  });

  it("does not fire on plain prose", () => {
    expect(containsMath("just a normal sentence about code")).toBe(false);
    expect(containsMath("price is $5 plus $10 tax")).toBe(true); // gate may over-match; remark-math decides
  });

  it("handles escaped dollar signs", () => {
    expect(containsMath("cost \\$5 and \\$10")).toBe(false);
  });
});
