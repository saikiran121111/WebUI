import { describe, it, expect } from "vitest";
import { anatomySpecSchema } from "../../lib/anatomy/anatomySchema";
import { expandFloorModules } from "../../lib/anatomy/floorModules";

const SPEC = anatomySpecSchema.parse({
  title: "Module expansion",
  fig: "FIG 9",
  label: "One module instantiated on two levels",
  parts: [
    { id: "core", tone: "structure", kind: "rod", r: 2, path: [[0, 0, 0], [0, 0, 40]], label: "Core" },
  ],
  modules: [
    {
      id: "unit",
      anchorZ: 4,
      parts: [
        { id: "plate", tone: "base", kind: "slab", plan: { x: -8, y: -8, w: 16, d: 16, r: 1 }, z: 0, height: 3, label: "Plate" },
        { id: "post", tone: "structure", kind: "rod", r: 1, path: [[6, 6, 3], [6, 6, 12]], label: "Post", on: "plate" },
      ],
    },
  ],
  floors: [
    { id: "f1", z: 4, module: "unit", label: "Level 1" },
    { id: "f2", z: 24, module: "unit", label: "Level 2" },
  ],
});

describe("expandFloorModules", () => {
  const expanded = expandFloorModules(SPEC);

  it("keeps authored parts and adds one instance set per floor", () => {
    expect(expanded.map((p) => p.id)).toEqual(["core", "f1__plate", "f1__post", "f2__plate", "f2__post"]);
  });

  it("shifts module root parts by floor.z - anchorZ; children stay parent-relative", () => {
    const plate = expanded.find((p) => p.id === "f2__plate") as any;
    expect(plate.z).toBe(24 - 4); // anchorZ offset honoured
    const post = expanded.find((p) => p.id === "f2__post") as any;
    expect(post.path).toEqual([[6, 6, 3], [6, 6, 12]]); // unchanged: follows its parent
  });

  it("prefixes child parent-links so instances stay addressable per floor", () => {
    const post = expanded.find((p) => p.id === "f1__post") as any;
    expect(post.on).toBe("f1__plate");
  });

  it("stamps instances with their floor id for inspection and visibility", () => {
    expect(expanded.find((p) => p.id === "f2__plate")?.floor).toBe("f2");
    expect(expanded.find((p) => p.id === "f2__post")?.floor).toBe("f2");
    expect(expanded.find((p) => p.id === "core")?.floor).toBeUndefined();
  });
});
