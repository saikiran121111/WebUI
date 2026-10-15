import { z } from "zod";

/**
 * Constrained, validated component schemas for model-driven generative UI.
 * Anything outside these shapes is rejected and rendered as plain source —
 * the model can never smuggle arbitrary markup or behavior through a fence.
 */

const finiteNumber = z.number().finite();

const chartSeriesSchema = z.object({
  name: z.string().min(1).max(80),
  data: z.array(finiteNumber).min(1).max(500),
});

const chartPointSchema = z.object({
  x: z.union([finiteNumber, z.string().max(80)]),
  y: finiteNumber,
  label: z.string().max(80).optional(),
});

export const chartSpecSchema = z
  .object({
    type: z.enum([
      "line", "bar", "grouped-bar", "stacked-bar", "area",
      "pie", "donut", "scatter", "histogram",
    ]),
    title: z.string().max(120).optional(),
    unit: z.string().max(24).optional(),
    xLabel: z.string().max(60).optional(),
    yLabel: z.string().max(60).optional(),
    categories: z.array(z.string().max(80)).max(200).optional(),
    series: z.array(chartSeriesSchema).max(12).optional(),
    points: z.array(chartPointSchema).max(500).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const series = spec.series ?? [];
    const points = spec.points ?? [];
    if (series.length === 0 && points.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "chart has no data" });
      return;
    }
    if (spec.type === "scatter") {
      if (points.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scatter needs points" });
      }
      return;
    }
    if (spec.type === "histogram") {
      if (series.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "histogram needs exactly one series" });
      }
      return;
    }
    if (!spec.categories || spec.categories.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "categories are required for this chart type" });
      return;
    }
    for (const s of series) {
      if (s.data.length !== spec.categories.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `series "${s.name}" length does not match categories` });
      }
    }
  });

export type ChartSpec = z.infer<typeof chartSpecSchema>;

const widgetFieldSchema = z
  .object({
    name: z.string().min(1).max(60),
    label: z.string().min(1).max(80),
    type: z.enum([
      "text", "textarea", "number", "email", "date", "time",
      "select", "radio", "checkbox", "slider",
    ]),
    options: z.array(z.string().min(1).max(80)).max(50).optional(),
    required: z.boolean().optional(),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
    step: finiteNumber.optional(),
    minLength: z.number().int().min(0).max(10000).optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    placeholder: z.string().max(120).optional(),
    default: z.union([z.string().max(500), finiteNumber, z.boolean()]).optional(),
  })
  .strict();

const contentItemSchema = z.object({
  label: z.string().min(1).max(120),
  content: z.string().max(20000),
});

export const widgetSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("form"),
    title: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    fields: z.array(widgetFieldSchema).min(1).max(20),
    submitLabel: z.string().max(60).optional(),
  }).strict(),
  z.object({
    kind: z.literal("tabs"),
    items: z.array(contentItemSchema).min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal("accordion"),
    items: z.array(contentItemSchema).min(1).max(20),
  }).strict(),
]);

export type WidgetSpec = z.infer<typeof widgetSpecSchema>;
export type WidgetField = z.infer<typeof widgetFieldSchema>;

export function parseJsonFence<T extends z.ZodTypeAny>(
  source: string,
  schema: T,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "schema mismatch" };
  }
  return { ok: true, value: parsed.data };
}
