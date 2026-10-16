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

const chartSliderSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  min: finiteNumber,
  max: finiteNumber,
  step: finiteNumber,
  defaultValue: finiteNumber,
  /** Series name to tune; omitted means every series. */
  targetSeries: z.string().max(80).optional(),
  operation: z.enum(["multiply", "add"]).optional(),
}).strict();

export const chartSpecSchema = z
  .object({
    type: z.enum([
      "line", "bar", "grouped-bar", "stacked-bar", "area",
      "pie", "donut", "scatter", "histogram",
    ]),
    title: z.string().max(120).optional(),
    subtitle: z.string().max(160).optional(),
    insight: z.string().max(500).optional(),
    unit: z.string().max(24).optional(),
    xLabel: z.string().max(60).optional(),
    yLabel: z.string().max(60).optional(),
    categories: z.array(z.string().max(80)).max(200).optional(),
    /** One annotation per category, aligned by index with `categories`. */
    notes: z.array(z.string().max(500)).max(200).optional(),
    series: z.array(chartSeriesSchema).max(12).optional(),
    points: z.array(chartPointSchema).max(500).optional(),
    sliders: z.array(chartSliderSchema).max(8).optional(),
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
    if (spec.notes && spec.notes.length !== spec.categories.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "notes must align one-per-category" });
    }
  });

export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ChartSlider = z.infer<typeof chartSliderSchema>;

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

const kpiSliderSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  min: finiteNumber,
  max: finiteNumber,
  step: finiteNumber.optional(),
  defaultValue: finiteNumber,
  unit: z.string().max(24).optional(),
}).strict();

const kpiCardSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  value: finiteNumber,
  unit: z.string().max(24).optional(),
  prefix: z.string().max(8).optional(),
  delta: z.string().max(40).optional(),
  trend: z.enum(["up", "down", "neutral"]).optional(),
  sparkline: z.array(finiteNumber).min(2).max(64).optional(),
  formula: z.string().max(200).optional(),
  detail: z.string().max(500).optional(),
  /** Slider id whose live value drives this card. */
  bindSlider: z.string().max(40).optional(),
  /** How the bound slider combines with `value` (defaults to multiply). */
  operation: z.enum(["multiply", "add", "percent"]).optional(),
}).strict();

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
  z.object({
    kind: z.literal("kpi"),
    title: z.string().max(120).optional(),
    insight: z.string().max(500).optional(),
    sliders: z.array(kpiSliderSchema).max(8).optional(),
    cards: z.array(kpiCardSchema).min(1).max(12),
  }).strict(),
]);

export type WidgetSpec = z.infer<typeof widgetSpecSchema>;
export type WidgetField = z.infer<typeof widgetFieldSchema>;
export type KpiCard = z.infer<typeof kpiCardSchema>;
export type KpiSlider = z.infer<typeof kpiSliderSchema>;

/* Scene3D v2 schemas live in lib/three3d/sceneSchema.ts (single source of
   truth for the fence contract; the skill docs reference that file). */

export function parseJsonFence<T extends z.ZodTypeAny>(
  source: string,
  schema: T,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (e) {
    // V8's message names the offending token and position — exactly what the
    // user needs to paste back to the model for a targeted fix.
    return { ok: false, error: `invalid JSON — ${(e as Error).message}`.slice(0, 300) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "schema mismatch" };
    const where = issue.path.length ? issue.path.join(".") : "(root)";
    const more = parsed.error.issues.length > 1 ? ` (+${parsed.error.issues.length - 1} more)` : "";
    return { ok: false, error: `${where}: ${issue.message}${more}` };
  }
  return { ok: true, value: parsed.data };
}
