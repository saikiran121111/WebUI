/**
 * F11 value model — the single authority for cell/dataset value fidelity.
 *
 * A value in a numeric context is exactly one of:
 *   present-number | present-text | missing | invalid-text | non-finite
 * The engine must NEVER turn missing/invalid into a measured 0 unless the spec
 * explicitly declares that imputation (nullPolicy: "zero"). Currency symbols,
 * percent scale and units are read from the literal text or declared on the
 * column; they are never guessed from magnitude.
 *
 * Percent canonical form is a FRACTION, because that is what the "0.0%" number
 * format (and therefore Excel, LibreOffice and the preview) multiplies by 100.
 */

export type NullPolicy = "blank" | "zero" | "text";
export type ValueFormat = "currency" | "percent" | "date" | "number" | "integer" | "text";

export type IssueReason =
  | "missing_value" | "not_a_number" | "non_finite" | "boolean_value"
  | "percent_scale_undeclared" | "percent_scale_conflict" | "percent_in_non_percent_column"
  | "currency_mismatch" | "currency_dropped" | "unit_dropped" | "imputed_zero";

export interface ValueIssue {
  reason: IssueReason;
  detail: string;
  action: string;
}

export interface ColumnSemantics {
  format: ValueFormat;
  /** How a missing/blank/invalid value is materialized. Default "blank": never invent a measurement. */
  nullPolicy?: NullPolicy;
  /** Declared currency for format "currency" (symbol or ISO code). Default "$". */
  currency?: string;
  /** Declared meaning of a BARE number in a percent column. Required to scale it. */
  percentScale?: "fraction" | "points";
}

export type ScaleSource = "declared" | "bounds" | "none";

/**
 * F11: resolve the scale of a BARE number in a percent column.
 * Only two inputs are allowed, and neither is the value itself:
 *   1. an explicit percentScale declaration, else
 *   2. the column OWN bounds (a decimal validation range that is only
 *      coherent for one scale). max<=1 && min>=-1 means fractions;
 *      min>=1 && max>1 means percentage points.
 * Anything else abstains: the engine must not scale, and says so.
 * Value magnitudes are never evidence â€” that was the old defect.
 */
export function resolvePercentScale(
  semantics: ColumnSemantics,
  bounds?: { min?: number; max?: number },
): { scale?: "fraction" | "points"; source: ScaleSource } {
  if (semantics.percentScale) return { scale: semantics.percentScale, source: "declared" };
  if (semantics.format !== "percent") return { source: "none" };
  const min = typeof bounds?.min === "number" && Number.isFinite(bounds.min) ? bounds.min : undefined;
  const max = typeof bounds?.max === "number" && Number.isFinite(bounds.max) ? bounds.max : undefined;
  if (max !== undefined && max <= 1 && (min === undefined || min >= -1)) return { scale: "fraction", source: "bounds" };
  if (min !== undefined && min >= 1 && (max === undefined || max > 1)) return { scale: "points", source: "bounds" };
  return { source: "none" };
}

export interface ParsedValue {
  /** null means a genuinely empty cell — never a fabricated 0. */
  value: string | number | boolean | null;
  /** Excel number-format fragment for THIS cell (detected currency, declared percent scale). */
  numFmt?: string;
  /** Currency read out of the literal text (provenance), when present. */
  detectedCurrency?: string;
  issue?: ValueIssue;
}

const MISSING_TOKENS = new Set(["-", "--", "—", "–", "n/a", "na", "null", "none", "nil"]);

/** Text-ish formats keep their content verbatim; only numeric formats need a value model. */
export function isTextyFormat(format: string): boolean {
  return format === "text" || format === "date" || format === "string";
}

/**
 * "Missing" for a NUMERIC column: null/undefined, empty/whitespace, or a token
 * that carries no measurement ("-", "N/A", "none"). A text column keeps these
 * verbatim — they are content there, not absence.
 */
export function looksMissing(raw: unknown): boolean {
  if (raw == null) return true;
  const s = String(raw).trim();
  if (!s) return true;
  return MISSING_TOKENS.has(s.toLowerCase());
}

export function currencyFmt(currency?: string): string {
  const c = String(currency ?? "$").trim();
  if (!c) return "#,##0.00";
  if (c === "$") return '$#,##0.00';
  return '"' + c.replace(/["\\]/g, "") + '"#,##0.00';
}

export const PERCENT_FMT = "0.0%";
export const PLAIN_FMT = "#,##0.00";

const NUM_BODY = "(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)";

/**
 * Strict numeric literal reader. Accepts "1,234.50", "-$1,200", "(2,000)"
 * (accounting negative), "12%", "₹1,200", "USD 1,200". Returns null when the
 * text is NOT a pure number — trailing units ("12 kg", "12.5 m/s") are a
 * mismatch, not something to silently truncate into a measurement.
 */
export function parseNumericLiteral(raw: string): { num: number; percent: boolean; currency?: string } | null {
  let s = String(raw).trim();
  if (!s) return null;
  let percent = false;
  if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.slice(1, -1).trim();
  if (s.endsWith("%")) { percent = true; s = s.slice(0, -1).trim(); }
  if (!s) return null;
  let sign = 1;
  if (s.startsWith("-")) { sign = -1; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) s = s.slice(1).trim();

  let currency: string | undefined;
  const sym = s.match(/^([^\d.,)(\s]{1,3})\s*(?=[.,\d])/);
  if (sym) { currency = sym[1]; s = s.slice(sym[1].length).trim(); }
  else {
    const iso = s.match(/^([A-Za-z]{3})\s+(?=[.,\d])/);
    if (iso) { currency = iso[1].toUpperCase(); s = s.slice(3).trim(); }
  }
  const body = new RegExp("^" + NUM_BODY + "$");
  if (!body.test(s)) return null;
  const digits = s.includes(",") ? s.replace(/,/g, "") : s;
  const num = sign * Number(digits);
  if (!Number.isFinite(num)) return null;
  return { num, percent, currency };
}

/** Percent canonicalization: points become fractions; declared fraction stays put. */
function toCanonicalPercent(num: number, fromLiteral: boolean, scale?: "fraction" | "points"): number {
  if (fromLiteral) return num / 100;          // "12%" is 0.12 — the literal declares it
  if (scale === "points") return num / 100;   // column declares 12 means 12%
  return num;                                  // declared fraction, or undeclared (never guessed)
}

/**
 * The one place a raw spec value becomes a cell value. `semantics` carries the
 * declared format, nullPolicy, currency and percent scale.
 */
export function parseCellValue(raw: unknown, semantics: ColumnSemantics): ParsedValue {
  const texty = isTextyFormat(semantics.format);
  const policy: NullPolicy = semantics.nullPolicy ?? "blank";

  if (typeof raw === "boolean") {
    return { value: raw, issue: { reason: "boolean_value", detail: String(raw), action: "kept as TRUE/FALSE (a boolean is not a measurement)" } };
  }

  if (texty) {
    if (raw == null || String(raw).trim() === "") {
      return { value: "N/A", numFmt: "@" };
    }
    return { value: String(raw), numFmt: "@" };
  }

  // ---- numeric formats ----
  if (looksMissing(raw)) {
    if (policy === "zero") {
      return { value: 0, issue: { reason: "imputed_zero", detail: "no value in the request", action: 'imputed 0 because the column declares nullPolicy "zero"' } };
    }
    if (policy === "text") {
      return { value: "N/A", numFmt: "@", issue: { reason: "missing_value", detail: "no value in the request", action: 'wrote the literal text "N/A" (nullPolicy "text")' } };
    }
    return { value: null, issue: { reason: "missing_value", detail: "no value in the request", action: "left the cell empty — inventing 0 would fabricate a measurement (declare nullPolicy to impute)" } };
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      if (policy === "zero") return { value: 0, issue: { reason: "non_finite", detail: String(raw), action: 'imputed 0 (nullPolicy "zero")' } };
      return { value: null, issue: { reason: "non_finite", detail: String(raw), action: "left the cell empty — NaN/Infinity is not a measurement" } };
    }
    if (semantics.format === "percent") {
      if (!semantics.percentScale) {
        return { value: raw, numFmt: PLAIN_FMT, issue: { reason: "percent_scale_undeclared", detail: String(raw), action: "kept the number un-scaled — 12 and 0.12 are both possible; declare percentScale instead of guessing from magnitude" } };
      }
      return { value: toCanonicalPercent(raw, false, semantics.percentScale), numFmt: PERCENT_FMT };
    }
    if (semantics.format === "currency") return { value: raw, numFmt: currencyFmt(semantics.currency) };
    return { value: raw };
  }

  const text = String(raw).trim();
  const parsed = parseNumericLiteral(text);
  if (!parsed) {
    if (policy === "zero") {
      return { value: 0, issue: { reason: "not_a_number", detail: text, action: 'imputed 0 (nullPolicy "zero") even though the text is not a number' } };
    }
    return { value: text, numFmt: "@", issue: { reason: "not_a_number", detail: text, action: "kept the text verbatim rather than inventing a number" } };
  }

  if (parsed.percent) {
    if (semantics.format === "percent") {
      if (semantics.percentScale === "fraction") {
        return { value: parsed.num / 100, numFmt: PERCENT_FMT, detectedCurrency: parsed.currency, issue: { reason: "percent_scale_conflict", detail: text, action: "the literal % decides the scale (0.12), overriding the declared fraction scale" } };
      }
      return { value: parsed.num / 100, numFmt: PERCENT_FMT, detectedCurrency: parsed.currency };
    }
    // A % in a non-percent column: the unit cannot be represented; record it.
    return {
      value: parsed.num,
      numFmt: semantics.format === "currency" ? currencyFmt(semantics.currency) : undefined,
      detectedCurrency: parsed.currency,
      issue: { reason: "percent_in_non_percent_column", detail: text, action: `stored ${parsed.num} and dropped the % unit — the column format is ${semantics.format}; use format "percent" to keep a ratio` },
    };
  }

  if (semantics.format === "percent") {
    if (!semantics.percentScale) {
      return { value: parsed.num, numFmt: PLAIN_FMT, detectedCurrency: parsed.currency, issue: { reason: "percent_scale_undeclared", detail: text, action: "kept the number un-scaled — declare percentScale (fraction|points) to render a percentage" } };
    }
    return { value: toCanonicalPercent(parsed.num, false, semantics.percentScale), numFmt: PERCENT_FMT, detectedCurrency: parsed.currency };
  }

  if (semantics.format === "currency") {
    const declared = String(semantics.currency ?? "$").trim() || "$";
    if (parsed.currency && parsed.currency !== declared) {
      return {
        value: parsed.num,
        numFmt: currencyFmt(parsed.currency),
        detectedCurrency: parsed.currency,
        issue: { reason: "currency_mismatch", detail: `${text} uses ${parsed.currency}, column declares ${declared}`, action: `formatted this cell with ${parsed.currency} (the literal) and kept the numeric value` },
      };
    }
    return { value: parsed.num, numFmt: currencyFmt(parsed.currency ?? declared) };
  }

  if (parsed.currency) {
    return {
      value: parsed.num,
      issue: { reason: "currency_dropped", detail: text, action: `stored ${parsed.num}; the ${parsed.currency} symbol needs format "currency" + currency "${parsed.currency}" to survive` },
      detectedCurrency: parsed.currency,
    };
  }
  return { value: parsed.num };
}

const INT_FMT = "#,##0";

/** Excel number format for a column whose values may carry per-cell overrides. */
export function columnNumFmt(semantics: ColumnSemantics): string {
  switch (semantics.format) {
    case "currency": return currencyFmt(semantics.currency);
    case "percent": return semantics.percentScale ? PERCENT_FMT : PLAIN_FMT;
    case "integer": return INT_FMT;
    case "date": return "yyyy-mm-dd";
    case "text": return "@";
    default: return PLAIN_FMT;
  }
}

/** On-screen text used for column auto-fit and the client preview. No magnitude guessing. */
export function displayValue(v: unknown, semantics: ColumnSemantics): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) return String(v);
  switch (semantics.format) {
    case "currency": {
      const sym = String(semantics.currency ?? "$").trim() || "$";
      return sym + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    case "percent": {
      if (!semantics.percentScale) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
      return (n * 100).toFixed(1) + "%";
    }
    case "integer": return Math.round(n).toLocaleString("en-US");
    case "number": return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    default: return String(v);
  }
}

/** Strict number for rule/comparison values: never "Number(x) || 0". */
export function parseStrictNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw == null) return null;
  const p = parseNumericLiteral(String(raw));
  if (!p || p.percent) return null;
  return Number.isFinite(p.num) ? p.num : null;
}