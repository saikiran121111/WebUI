import { describe, it, expect } from "vitest";
import { ANATOMY_DEMO_MARKDOWN } from "../../lib/render/anatomyDemoShowcase";
import { anatomySpecSchema } from "../../lib/anatomy/anatomySchema";
import { buildAnatomyFigure } from "../../lib/anatomy/anatomyBuilder";

function fences(markdown: string): string[] {
  return [...markdown.matchAll(/```anatomy\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("Anatomy demo showcase fixtures stay valid", () => {
  const blocks = fences(ANATOMY_DEMO_MARKDOWN);

  it("contains four anatomy fences", () => {
    expect(blocks).toHaveLength(4);
  });

  blocks.forEach((source, index) => {
    it(`figure ${index + 1} validates and builds`, () => {
      const parsed = anatomySpecSchema.parse(JSON.parse(source));
      const figure = buildAnatomyFigure(parsed);
      expect(figure.svg).toContain('class="iso-svg anatomy-svg"');
      expect(figure.plate).toContain('class="iso-figure"');
    });
  });
});
