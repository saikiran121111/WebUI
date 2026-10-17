import { describe, expect, it } from "vitest";
import { cadSpecSchema } from "../../lib/cad/cadSchema";
import { buildCadStandaloneHtml } from "../../lib/cad/cadStandalone";

const spec = cadSpecSchema.parse({
  title: "Standalone test",
  units: "m",
  layers: [{ id: "walls", color: "#F87171" }],
  entities: [
    { kind: "line", layer: "walls", from: [0, 0], to: [10, 0] },
    { kind: "text", layer: "walls", x: 1, y: 1, content: "evil</script><b>", height: 0.3 },
  ],
  walls: [{ id: "w1", layer: "walls", path: [[0, 0], [10, 0]], closed: false }],
  slabs: [],
  floors: [],
  hotspots: [],
  flows: [{ id: "f1", points: [[0, 0], [10, 0]], color: "#34D399" }],
});

describe("buildCadStandaloneHtml", () => {
  const html = buildCadStandaloneHtml(spec);

  it("escapes embedded </script> so the page has exactly one script close", () => {
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
    expect(html).toContain("<\\/script>");
  });

  it("ships the interactive controls offline", () => {
    expect(html).toContain("btn2d");
    expect(html).toContain("explode");
    expect(html).toContain("measure");
  });

  it("is a complete standalone document", () => {
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });
});
