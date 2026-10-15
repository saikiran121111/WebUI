import { describe, expect, it } from "vitest";
import { mathPlugins } from "../../lib/render/math";

// Regression: rehypePlugins used to return a flat [plugin, options] pair, so
// react-markdown passed the options object to unified as a standalone entry.
// unified treated it as a preset with neither plugins nor settings and threw
// "Expected usable value but received an empty preset".
describe("mathPlugins", () => {
  it("remark entries are plugin functions", () => {
    for (const plugin of mathPlugins().remarkPlugins) {
      expect(typeof plugin).toBe("function");
    }
  });

  it("rehype entries are unified-valid: a function or a [function, options] tuple", () => {
    for (const entry of mathPlugins().rehypePlugins) {
      if (Array.isArray(entry)) {
        expect(typeof entry[0]).toBe("function");
        expect(typeof entry[1]).toBe("object");
      } else {
        expect(typeof entry).toBe("function");
      }
    }
  });
});
