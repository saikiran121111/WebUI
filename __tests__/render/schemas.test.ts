import { describe, it, expect } from "vitest";
import { chartSpecSchema, widgetSpecSchema, parseJsonFence } from "../../lib/render/schemas";

describe("chart spec validation", () => {
  it("accepts a well-formed bar chart", () => {
    const spec = {
      type: "bar",
      title: "Rainfall",
      unit: "mm",
      categories: ["Jan", "Feb", "Mar"],
      series: [{ name: "2025", data: [10, 20, 30] }],
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts scatter via points", () => {
    const spec = { type: "scatter", points: [{ x: 1, y: 2 }, { x: 3, y: 4, label: "p" }] };
    expect(chartSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects scatter without points", () => {
    const spec = { type: "scatter", categories: ["a"], series: [{ name: "s", data: [1] }] };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects histogram with more than one series", () => {
    const spec = {
      type: "histogram",
      categories: ["0-9", "10-19"],
      series: [
        { name: "a", data: [1, 2] },
        { name: "b", data: [3, 4] },
      ],
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects series length mismatching categories", () => {
    const spec = {
      type: "line",
      categories: ["a", "b", "c"],
      series: [{ name: "s", data: [1, 2] }],
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects non-finite numbers and invented placeholders", () => {
    const spec = {
      type: "bar",
      categories: ["a"],
      series: [{ name: "s", data: [Number.NaN] }],
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects unknown keys (strict schema)", () => {
    const spec = {
      type: "bar",
      categories: ["a"],
      series: [{ name: "s", data: [1] }],
      hallucinatedOption: true,
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects unknown chart types", () => {
    const spec = {
      type: "3d-pie-explode",
      categories: ["a"],
      series: [{ name: "s", data: [1] }],
    };
    expect(chartSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe("widget spec validation", () => {
  it("accepts a form widget", () => {
    const spec = {
      kind: "form",
      title: "Booking",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "when", label: "Date", type: "date" },
        { name: "guests", label: "Guests", type: "number", min: 1, max: 10 },
        { name: "plan", label: "Plan", type: "select", options: ["a", "b"] },
      ],
    };
    expect(widgetSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("accepts tabs and accordion widgets", () => {
    expect(widgetSpecSchema.safeParse({
      kind: "tabs",
      items: [{ label: "One", content: "**first**" }, { label: "Two", content: "second" }],
    }).success).toBe(true);
    expect(widgetSpecSchema.safeParse({
      kind: "accordion",
      items: [{ label: "Q", content: "A" }],
    }).success).toBe(true);
  });

  it("rejects unknown widget kinds and field types", () => {
    expect(widgetSpecSchema.safeParse({ kind: "game", items: [] }).success).toBe(false);
    expect(widgetSpecSchema.safeParse({
      kind: "form",
      fields: [{ name: "x", label: "X", type: "colorpicker" }],
    }).success).toBe(false);
  });

  it("rejects empty field/item lists", () => {
    expect(widgetSpecSchema.safeParse({ kind: "form", fields: [] }).success).toBe(false);
    expect(widgetSpecSchema.safeParse({ kind: "tabs", items: [] }).success).toBe(false);
  });

  it("accepts a kpi widget with sliders and formula cards", () => {
    expect(widgetSpecSchema.safeParse({
      kind: "kpi",
      title: "Unit economics",
      sliders: [{ id: "g", label: "Growth", min: 0.5, max: 2, step: 0.05, defaultValue: 1 }],
      cards: [{
        id: "rev", label: "Revenue", value: 52, prefix: "$", unit: "k",
        delta: "+18%", trend: "up", sparkline: [40, 42, 45],
        formula: "base × growth", bindSlider: "g", operation: "multiply",
      }],
    }).success).toBe(true);
  });

  it("rejects invalid kpi cards", () => {
    expect(widgetSpecSchema.safeParse({ kind: "kpi", cards: [] }).success).toBe(false);
    expect(widgetSpecSchema.safeParse({
      kind: "kpi", cards: [{ id: "a", label: "A", value: 1, trend: "rocket" }],
    }).success).toBe(false);
    expect(widgetSpecSchema.safeParse({
      kind: "kpi", cards: [{ id: "a", label: "A", value: 1, operation: "divide" }],
    }).success).toBe(false);
    expect(widgetSpecSchema.safeParse({
      kind: "kpi", cards: [{ id: "a", label: "A", value: Number.NaN }],
    }).success).toBe(false);
  });
});

describe("parseJsonFence", () => {
  it("returns ok with the parsed value", () => {
    const r = parseJsonFence('{"type":"bar","categories":["a"],"series":[{"name":"s","data":[1]}]}', chartSpecSchema);
    expect(r.ok).toBe(true);
  });

  it("returns a readable error naming the offending token for malformed JSON", () => {
    const r = parseJsonFence('{"a":[1,],[2]}', chartSpecSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid JSON");
  });

  it("returns a readable error for schema violations", () => {
    const r = parseJsonFence('{"type":"bar"}', chartSpecSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("chart has no data");
  });

  it("prefixes schema errors with the exact issue path and issue count", () => {
    const r = parseJsonFence('{"type":"bar","categories":["a"],"series":[{"data":[1]}],"points":[{"x":1}]}', chartSpecSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("series.0.name: Required");
      expect(r.error).toMatch(/\(\+\d+ more\)/);
    }
  });
});
