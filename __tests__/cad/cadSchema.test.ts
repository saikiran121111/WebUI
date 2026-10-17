import { describe, expect, it } from "vitest";
import { CAD_BUDGETS, cadSpecSchema } from "../../lib/cad/cadSchema";

const validSpec = {
  title: "Test plan",
  units: "m",
  layers: [
    { id: "walls", color: "#F87171" },
    { id: "anno", color: "#E2E8F0", lineType: "dashed" },
  ],
  entities: [
    { kind: "line", layer: "walls", from: [0, 0], to: [10, 0] },
    { kind: "text", layer: "anno", x: 5, y: 1, content: "Hall", height: 0.3 },
  ],
  walls: [{ id: "w1", layer: "walls", path: [[0, 0], [10, 0], [10, 6]], closed: true }],
  slabs: [{ id: "s1", layer: "walls", outline: [[0, 0], [10, 0], [10, 6]] }],
  floors: [{ id: "L01", label: "Ground", z: 0 }],
  hotspots: [{ id: "h1", x: 5, y: 3, title: "Core" }],
  flows: [{ id: "f1", points: [[0, 0], [10, 6]], color: "#34D399" }],
};

describe("cadSpecSchema", () => {
  it("parses a valid spec and applies defaults", () => {
    const parsed = cadSpecSchema.parse(validSpec);
    expect(parsed.title).toBe("Test plan");
    expect(parsed.units).toBe("m");
    expect(parsed.scale).toBeUndefined(); // viewer falls back to 1:100
    expect(cadSpecSchema.parse({ ...validSpec, scale: {} }).scale?.ratio).toBe(100);
    expect(parsed.defaultView).toBe("2d");
    expect(parsed.sun).toBeUndefined(); // viewer falls back to { enabled: true, time: 13 }
    expect(cadSpecSchema.parse({ ...validSpec, sun: {} }).sun).toEqual({ enabled: true, time: 13 });
    const walls = parsed.layers.find(l => l.id === "walls")!;
    expect(walls.lineType).toBe("solid");
    expect(walls.opacity).toBe(1);
    expect(walls.locked).toBe(false);
    expect(walls.visible).toBe(true);
    expect(parsed.walls[0].height).toBe(3);
    expect(parsed.walls[0].thickness).toBe(0.2);
    expect(parsed.flows[0].speed).toBe(1);
  });

  it("rejects duplicate layer ids", () => {
    const dup = { ...validSpec, layers: [{ id: "walls", color: "#F87171" }, { id: "walls", color: "#38BDF8" }] };
    expect(cadSpecSchema.safeParse(dup).success).toBe(false);
  });

  it("rejects entities referencing unknown layers", () => {
    const ghost = {
      ...validSpec,
      entities: [{ kind: "line", layer: "ghost", from: [0, 0], to: [1, 1] }],
    };
    expect(cadSpecSchema.safeParse(ghost).success).toBe(false);
  });

  it("rejects duplicate ids within walls", () => {
    const dupWalls = {
      ...validSpec,
      walls: [
        { id: "w1", layer: "walls", path: [[0, 0], [1, 0]] },
        { id: "w1", layer: "walls", path: [[0, 1], [1, 1]] },
      ],
    };
    expect(cadSpecSchema.safeParse(dupWalls).success).toBe(false);
  });

  it("requires at least one layer", () => {
    expect(cadSpecSchema.safeParse({ ...validSpec, layers: [] }).success).toBe(false);
  });

  it("enforces the entity point budget", () => {
    const fat = {
      ...validSpec,
      entities: [{ kind: "polyline", layer: "walls", points: Array.from({ length: CAD_BUDGETS.maxPointsPerEntity + 1 }, (_, i) => [i, 0]) }],
    };
    expect(cadSpecSchema.safeParse(fat).success).toBe(false);
  });
});
