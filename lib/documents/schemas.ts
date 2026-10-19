/**
 * Fence-spec contracts for the document modalities (PHASES 3-5). Lenient
 * normalizers absorb local-model drift (aliases, missing fields, wrong
 * containers) so a fence renders; the API routes re-validate server-side
 * with the same normalizers ("never trust the wire"). Pure TS — safe for
 * both server engines and client viewers.
 */

export type CellFormat = "currency" | "percent" | "date" | "number" | "integer" | "text";

// ---------- resume ----------
export interface ResumeLink { label: string; url: string }
export interface ResumeBasics {
  name: string; title: string; email: string; phone: string; location: string;
  links: ResumeLink[]; summary: string;
}
export interface ResumeItem {
  heading: string; subheading: string; dateLocation: string;
  keywords: string[]; bullets: string[];
}
export interface ResumeSection { id: string; title: string; items: ResumeItem[] }
export interface ResumeSpec { basics: ResumeBasics; sections: ResumeSection[] }

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function normalizeResume(raw: any): ResumeSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw.basics ?? raw.meta ?? raw;
  const name = str(b.name ?? b.fullName) || str(raw.name);
  if (!name) return null;
  const basics: ResumeBasics = {
    name,
    title: str(b.title ?? b.jobTitle ?? b.headline),
    email: str(b.email),
    phone: str(b.phone ?? b.telephone),
    location: str(b.location ?? b.address ?? b.city),
    links: arr(b.links ?? b.socials).map((l: any) => ({ label: str(l?.label ?? l?.network), url: str(l?.url ?? l?.link) })).filter((l) => l.url),
    summary: str(b.summary ?? b.profile ?? b.objective),
  };
  const rawSections = arr(raw.sections);
  const sections: ResumeSection[] = rawSections.map((s: any, i) => ({
    id: str(s?.id, "section" + i),
    title: str(s?.title ?? s?.name, "Section"),
    items: arr(s?.items ?? s?.entries).map((it: any) => ({
      heading: str(it?.heading ?? it?.company ?? it?.title ?? it?.organization),
      subheading: str(it?.subheading ?? it?.role ?? it?.position ?? it?.degree),
      dateLocation: str(it?.dateLocation ?? [it?.date, it?.location].filter(Boolean).join(" · ")),
      keywords: arr(it?.keywords).map((k) => str(k)).filter(Boolean),
      bullets: arr(it?.bullets ?? it?.details ?? it?.description ?? it?.highlights)
        .flatMap((x) => (typeof x === "string" ? x.split(/\r?\n/).map((line) => line.replace(/^[-•*]\s*/, "").trim()).filter(Boolean) : [str(x)]))
        .filter(Boolean),
    })),
  }));
  return { basics, sections: sections.length ? sections : [{ id: "summary", title: "Summary", items: [] }] };
}

// ---------- docx ----------
export type DocxSection =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "chart"; title: string; chart: ChartSpecLite };
export interface ChartSpecLite {
  type: "bar" | "line" | "pie" | "donut" | "area";
  categories: string[];
  series: { name: string; data: number[] }[];
}
export interface DocxSpec { filename: string; title: string; author: string; sections: DocxSection[] }

const CHART_TYPES = new Set(["bar", "line", "pie", "donut", "area"]);

function normalizeChartLite(c: any): ChartSpecLite | null {
  if (!c || typeof c !== "object") return null;
  const type = CHART_TYPES.has(str(c.type)) ? c.type : "bar";
  const categories = arr(c.categories ?? c.labels).map((x) => str(x));
  let series: { name: string; data: number[] }[];
  if (Array.isArray(c.series)) {
    series = c.series.map((s: any, i: number) => ({ name: str(s?.name, "Series " + (i + 1)), data: arr(s?.data ?? s?.values).map((v) => Number(v) || 0) }));
  } else if (Array.isArray(c.data)) {
    series = [{ name: str(c.seriesName, "Value"), data: c.data.map((v: any) => (typeof v === "object" ? Number(v.value ?? v.y) || 0 : Number(v) || 0)) }];
    if (!categories.length) categories.push(...(Array.isArray(c.labels) ? c.labels.map((x: any) => str(x)) : series[0].data.map((_, i) => String(i + 1))));
  } else {
    return null;
  }
  if (!series.length || !categories.length) return null;
  return { type, categories, series };
}

export function normalizeDocx(raw: any): DocxSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const sections: DocxSection[] = [];
  for (const s of arr(raw.sections ?? raw.content) as any[]) {
    if (!s || typeof s !== "object") continue;
    const type = str(s.type).toLowerCase();
    if (type === "heading" || type === "h1" || type === "title") {
      const level = type === "heading" ? Math.min(4, Math.max(1, Number(s.level) || 1)) : 1;
      sections.push({ type: "heading", level, text: str(s.text ?? s.content) });
    } else if (type === "paragraph" || type === "text" || type === "p") {
      sections.push({ type: "paragraph", text: str(s.text ?? s.content) });
    } else if (type === "bullets" || type === "list" || type === "ul") {
      sections.push({ type: "bullets", items: arr(s.items ?? s.bullets ?? s.list).map((x) => str(x)).filter(Boolean) });
    } else if (type === "table") {
      const headers = arr(s.headers ?? s.columns).map((x: any) => (typeof x === "object" ? str(x?.name ?? x?.label) : str(x)));
      const rows = arr(s.rows).map((r: any) => arr(r).map((cell: any) => (cell == null ? "" : typeof cell === "object" ? str(cell?.value) : str(cell))));
      sections.push({ type: "table", headers, rows });
    } else if (type === "chart") {
      const chart = normalizeChartLite(s.chart ?? s);
      if (chart) sections.push({ type: "chart", title: str(s.title), chart });
    }
  }
  if (!sections.length) return null;
  return { filename: str(raw.filename, str(raw.title, "document")), title: str(raw.title), author: str(raw.author, "Local AI WebUI"), sections };
}

// ---------- xlsx ----------
export interface XlsxColumn {
  key: string; label: string; width?: number; format: CellFormat;
  validation?: { type: "list"; values: string[] } | { type: "decimal"; min?: number; max?: number };
}
/**
 * Bulk-row generator: the LLM emits ONE compact descriptor (~40 tokens) and
 * the engine materializes the full grid deterministically — a 500-row sheet
 * costs ~1,500 prompt tokens, never 15,000. Expansion runs inside
 * normalizeXlsx so the server engine AND the client preview see identical
 * materialized rows. Documented in XLSX_CONTRACT (lib/decision/contracts.ts).
 */
export interface XlsxRowGenColumn {
  key: string;
  /** Precedence: formulaTemplate > pattern > cycle > dateRange > numberRange > sequence > value. */
  formulaTemplate?: string;   // "{row}" → real spreadsheet row number: "=ROUND(D{row}*E{row},2)"
  pattern?: string;           // "TXN-{1001..1500}" → TXN-1001, TXN-1002, ...
  cycle?: unknown[];          // repeats: ["Food","Rent",...]
  dateRange?: { start: string; end: string }; // evenly spaced ISO dates
  numberRange?: { min: number; max: number; decimals?: number }; // deterministic per (sheet,key,row) hash
  sequence?: { start: number; step: number };
  value?: string | number | boolean;
}
export interface XlsxRowGenerator {
  count: number;
  /** Spreadsheet row of the FIRST generated row (default: right after existing rows, min 2). */
  startRow?: number;
  columns: XlsxRowGenColumn[];
}
export interface XlsxChart {
  type: "bar" | "line" | "pie" | "donut" | "area";
  title: string;
  categories: string[];
  series: { name: string; data: number[] }[];
  /** Cell anchor like "H2"; default: stacked below the data block. */
  anchor?: string;
}
export interface XlsxConditionalFormat {
  range?: string;             // "G2:G501" — takes precedence over columnKey
  columnKey?: string;         // resolved to the column's data range
  rule: "greaterThan" | "lessThan" | "equal" | "containsText" | "between";
  value?: string | number;
  min?: number;
  max?: number;
  fill?: string;              // #RRGGBB; default per rule (status words get red/amber/green)
  fontColor?: string;         // #RRGGBB
}
export interface XlsxSheet {
  name: string; columns: XlsxColumn[]; rows: Record<string, unknown>[];
  freezeHeader: boolean; totalRow: boolean;
  rowGenerator?: XlsxRowGenerator;
  charts?: XlsxChart[];
  conditionalFormatting?: XlsxConditionalFormat[];
}
export interface XlsxSpec { filename: string; sheets: XlsxSheet[] }

/** Default status colors: FAIL/OVERSPEND red, REORDER amber, OK/PASS green. */
export const CF_STATUS_COLORS: Record<string, { fill: string; fontColor: string }> = {
  OVERSPEND: { fill: "#FEE2E2", fontColor: "#B91C1C" },
  FAIL: { fill: "#FEE2E2", fontColor: "#B91C1C" },
  REORDER: { fill: "#FEF3C7", fontColor: "#B45309" },
  OK: { fill: "#DCFCE7", fontColor: "#15803D" },
  PASS: { fill: "#DCFCE7", fontColor: "#15803D" },
};

// Deterministic PRNG (FNV-1a hash → mulberry32): same spec ⇒ same rows on
// server build and client preview, byte-for-byte. No Math.random anywhere.
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CF_RULES = new Set(["greaterThan", "lessThan", "equal", "containsText", "between"]);

/** Effective colors for a CF rule: explicit win; status words get the
 *  default red/amber/green; everything else amber. Shared by the xlsx engine
 *  (ExcelJS styles) and the client preview (inline styles) — identical output. */
export function cfColors(cf: XlsxConditionalFormat): { fill: string; fontColor: string } {
  const status = (typeof cf.value === "string" ? cf.value : "").toUpperCase();
  const d = (cf.rule === "equal" || cf.rule === "containsText") && CF_STATUS_COLORS[status]
    ? CF_STATUS_COLORS[status]
    : { fill: "#FEF3C7", fontColor: "#B45309" };
  return { fill: cf.fill || d.fill, fontColor: cf.fontColor || d.fontColor };
}

function normalizeRowGenColumn(c: any): XlsxRowGenColumn | null {
  if (!c || typeof c !== "object") return null;
  const key = str(c.key ?? c.id ?? c.name);
  if (!key) return null;
  const out: XlsxRowGenColumn = { key };
  if (c.formulaTemplate != null) out.formulaTemplate = str(c.formulaTemplate);
  if (c.pattern != null) out.pattern = str(c.pattern);
  if (Array.isArray(c.cycle) && c.cycle.length) out.cycle = c.cycle;
  if (c.dateRange && typeof c.dateRange === "object") {
    const s = str(c.dateRange.start ?? c.dateRange.from), e = str(c.dateRange.end ?? c.dateRange.to);
    if (s && e) out.dateRange = { start: s, end: e };
  }
  if (c.numberRange && typeof c.numberRange === "object") {
    const min = Number(c.numberRange.min), max = Number(c.numberRange.max);
    if (isFinite(min) && isFinite(max)) {
      const dec = c.numberRange.decimals == null ? 2 : Number(c.numberRange.decimals) || 0;
      out.numberRange = { min, max, decimals: Math.max(0, Math.min(6, dec)) };
    }
  }
  if (c.sequence && typeof c.sequence === "object") {
    const start = Number(c.sequence.start ?? c.sequence.from) || 0;
    const step = c.sequence.step == null ? 1 : Number(c.sequence.step);
    out.sequence = { start, step: isFinite(step) ? step : 1 };
  }
  if (c.value !== undefined && !out.formulaTemplate && !out.pattern && !out.cycle && !out.numberRange && !out.sequence && !out.dateRange) {
    out.value = typeof c.value === "boolean" ? c.value : typeof c.value === "number" ? c.value : str(c.value);
  }
  return out;
}

/** Materialize gen.rows into sheet.rows (deterministic; runs inside normalizeXlsx). */
function expandRowGenerator(sheet: XlsxSheet): void {
  const gen = sheet.rowGenerator;
  if (!gen || !Array.isArray(gen.columns) || !gen.columns.length) return;
  const count = Math.max(0, Math.min(5000, Number(gen.count) || 0));
  const base = sheet.rows.length;
  const firstRow = Math.max(2, Number(gen.startRow) || 2 + base);
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  for (let i = 0; i < count; i++) {
    const rowNum = firstRow + i;
    const row: Record<string, unknown> = {};
    for (const gc of gen.columns) {
      if (gc.formulaTemplate) {
        row[gc.key] = gc.formulaTemplate.replace(/\{row\}/g, String(rowNum));
      } else if (gc.pattern) {
        const m = /^(.*?)\{(\d+)\s*\.\.\s*(\d+)\}(.*)$/.exec(gc.pattern);
        if (m) {
          const start = parseInt(m[2], 10);
          const width = Math.max(m[2].length, m[3].length);
          row[gc.key] = m[1] + String(start + i).padStart(width, "0") + m[4];
        } else {
          row[gc.key] = gc.pattern;
        }
      } else if (gc.cycle && gc.cycle.length) {
        row[gc.key] = gc.cycle[i % gc.cycle.length];
      } else if (gc.dateRange) {
        const t0 = Date.parse(gc.dateRange.start), t1 = Date.parse(gc.dateRange.end);
        if (isFinite(t0) && isFinite(t1)) {
          const step = count > 1 ? (t1 - t0) / (count - 1) : 0;
          row[gc.key] = isoDay(new Date(Math.round(t0 + step * i)));
        } else row[gc.key] = gc.dateRange.start;
      } else if (gc.numberRange) {
        const rnd = mulberry32(fnv1a(sheet.name + "|" + gc.key + "|" + rowNum));
        const { min, max, decimals = 2 } = gc.numberRange;
        const v = min + rnd() * (max - min);
        const f = Math.pow(10, decimals);
        row[gc.key] = Math.round(v * f) / f;
      } else if (gc.sequence) {
        row[gc.key] = gc.sequence.start + gc.sequence.step * i;
      } else {
        row[gc.key] = gc.value ?? 0;
      }
    }
    sheet.rows.push(row);
  }
}

function normalizeXlsxChart(c: any): XlsxChart | null {
  const lite = normalizeChartLite(c);
  if (!lite) return null;
  const type = lite.type as XlsxChart["type"];
  return { type, title: str(c?.title), categories: lite.categories, series: lite.series, anchor: str(c?.anchor) || undefined };
}

function normalizeConditionalFormat(cf: any): XlsxConditionalFormat | null {
  if (!cf || typeof cf !== "object") return null;
  const rule = str(cf.rule ?? cf.type).replace(/^cell(is)?$/i, "greaterThan");
  if (!CF_RULES.has(rule)) return null;
  const out: XlsxConditionalFormat = { rule: rule as XlsxConditionalFormat["rule"] };
  if (cf.range != null) out.range = str(cf.range).toUpperCase();
  if (cf.columnKey != null) out.columnKey = str(cf.columnKey ?? cf.column);
  if (cf.value != null) out.value = typeof cf.value === "number" ? cf.value : str(cf.value);
  if (cf.min != null && isFinite(Number(cf.min))) out.min = Number(cf.min);
  if (cf.max != null && isFinite(Number(cf.max))) out.max = Number(cf.max);
  if (cf.fill != null) out.fill = str(cf.fill);
  if (cf.fontColor != null || cf.font_color != null) out.fontColor = str(cf.fontColor ?? cf.font_color);
  if (!out.range && !out.columnKey) return null;
  return out;
}

const FORMATS = new Set<CellFormat>(["currency", "percent", "date", "number", "integer", "text"]);

export function normalizeXlsx(raw: any): XlsxSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const sheets: XlsxSheet[] = [];
  for (const sh of arr(raw.sheets ?? raw.worksheets ?? (raw.columns ? [raw] : [])) as any[]) {
    if (!sh || typeof sh !== "object") continue;
    const columns: XlsxColumn[] = arr(sh.columns).map((c: any, i: number) => {
      const key = str(c?.key ?? c?.id ?? c?.name, "col" + (i + 1));
      const fmt = FORMATS.has(str(c?.format) as CellFormat) ? (c.format as CellFormat) : "text";
      const validation = c?.validation && typeof c.validation === "object"
        ? (str(c.validation.type) === "list"
            ? { type: "list" as const, values: arr(c.validation.values).map((v) => str(v)).filter(Boolean) }
            : { type: "decimal" as const, min: c.validation.min == null ? undefined : Number(c.validation.min), max: c.validation.max == null ? undefined : Number(c.validation.max) })
        : undefined;
      return { key, label: str(c?.label ?? c?.header, key), width: c?.width ? Number(c.width) || undefined : undefined, format: fmt, validation };
    });
    if (!columns.length) continue;
    const rawRows = arr(sh.rows ?? sh.data);
    const rows = rawRows.map((r: any) => {
      if (Array.isArray(r)) {
        const obj: Record<string, unknown> = {};
        columns.forEach((c, i) => { obj[c.key] = r[i]; });
        return obj;
      }
      return r && typeof r === "object" ? r : {};
    });
    const sheet: XlsxSheet = {
      name: str(sh.name, "Sheet" + (sheets.length + 1)).slice(0, 31),
      columns, rows,
      freezeHeader: sh.freezeHeader !== false,
      totalRow: sh.totalRow === true,
    };
    if (sh.rowGenerator && typeof sh.rowGenerator === "object") {
      const genCols = arr(sh.rowGenerator.columns ?? sh.rowGenerator.cols).map(normalizeRowGenColumn).filter((c): c is XlsxRowGenColumn => !!c);
      if (genCols.length) sheet.rowGenerator = { count: Number(sh.rowGenerator.count ?? sh.rowGenerator.rows) || 0, startRow: sh.rowGenerator.startRow == null ? undefined : Number(sh.rowGenerator.startRow), columns: genCols };
    }
    const shCharts = arr(sh.charts ?? sh.graphs).map(normalizeXlsxChart).filter((c): c is XlsxChart => !!c);
    if (shCharts.length) sheet.charts = shCharts;
    const shCf = arr(sh.conditionalFormatting ?? sh.condFormatting ?? sh.cf).map(normalizeConditionalFormat).filter((c): c is XlsxConditionalFormat => !!c);
    if (shCf.length) sheet.conditionalFormatting = shCf;
    expandRowGenerator(sheet); // deterministic materialization — engine + preview identical
    sheet.rowGenerator = undefined; // cleared: re-normalizing must NOT duplicate rows
    sheets.push(sheet);
  }
  if (!sheets.length) return null;
  // Workbook-level charts land on the first sheet (Dashboard convention).
  const wbCharts = arr(raw.charts).map(normalizeXlsxChart).filter((c): c is XlsxChart => !!c);
  if (wbCharts.length) sheets[0].charts = [...(sheets[0].charts ?? []), ...wbCharts];
  return { filename: str(raw.filename, "workbook"), sheets };
}

// ---------- pptx ----------
export type PptxTier = "insane" | "normal" | "simple";
export type PptxLayout = "title" | "hero" | "stats" | "split" | "spotlight" | "chart" | "table" | "bullets";
export interface PptxSlide {
  layout: PptxLayout; title: string; subtitle: string; bullets: string[];
  stats: { label: string; value: string; suffix?: string }[];
  chart?: ChartSpecLite; table?: { headers: string[]; rows: string[][] };
  morphGroup?: string;
}
export interface PptxSpec {
  filename: string; title: string; tier: PptxTier;
  theme: { bg: string; accent: string; positive: string };
  slides: PptxSlide[];
}

const LAYOUTS = new Set<PptxLayout>(["title", "hero", "stats", "split", "spotlight", "chart", "table", "bullets"]);

export function normalizePptx(raw: any): PptxSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const tierRaw = str(raw.tier, "insane").toLowerCase();
  const tier: PptxTier = tierRaw === "simple" ? "simple" : tierRaw === "normal" ? "normal" : "insane";
  const slides: PptxSlide[] = arr(raw.slides).map((s: any, i: number) => {
    const layout = LAYOUTS.has(str(s?.layout) as PptxLayout) ? (s.layout as PptxLayout) : i === 0 ? "title" : s?.stats ? "stats" : s?.chart ? "chart" : s?.table ? "table" : "bullets";
    return {
      layout,
      title: str(s?.title ?? s?.heading),
      subtitle: str(s?.subtitle ?? s?.subheading),
      bullets: arr(s?.bullets ?? s?.points).map((b) => str(b)).filter(Boolean),
      stats: arr(s?.stats).map((st: any) => ({ label: str(st?.label), value: str(st?.value ?? st?.number), suffix: str(st?.suffix) || undefined })),
      chart: s?.chart ? normalizeChartLite(s.chart) ?? undefined : undefined,
      table: s?.table ? { headers: arr(s.table.headers ?? s.table.columns).map((x: any) => (typeof x === "object" ? str(x.name ?? x.label) : str(x))), rows: arr(s.table.rows).map((r: any) => arr(r).map((c) => str(c ?? ""))) } : undefined,
      morphGroup: str(s?.morphGroup ?? s?.morph) || undefined,
    };
  });
  if (!slides.length) return null;
  const theme = raw.theme && typeof raw.theme === "object" ? raw.theme : {};
  return {
    filename: str(raw.filename, str(raw.title, "presentation")),
    title: str(raw.title, "Presentation"),
    tier,
    theme: { bg: str(theme.bg, "#0A0A0A"), accent: str(theme.accent, "#38E8FF"), positive: str(theme.positive, "#22C55E") },
    slides,
  };
}

// ---------- powerbi ----------
export type BiColumnType = "string" | "number" | "date";
export interface BiColumn { name: string; type: BiColumnType }
export interface BiMeasure { name: string; dax: string }
export interface BiVisual { type: "kpi" | "bar" | "area" | "donut" | "waterfall" | "table"; title: string; dimension?: string; measure?: string; format?: "currency" | "percent" | "number"; columns?: string[] }
export interface BiSlicer { field: string; type: "list" | "date-range" }
export interface PowerbiSpec {
  filename: string;
  dataset: { columns: BiColumn[]; rows: (string | number | null)[][] };
  measures: BiMeasure[];
  visuals: BiVisual[];
  slicers: BiSlicer[];
  synthetic: boolean;
}

const BI_TYPES = new Set<BiColumnType>(["string", "number", "date"]);
const VISUAL_TYPES = new Set(["kpi", "bar", "area", "donut", "waterfall", "table"]);

/** Infer a column type from its values when the model omits/gets it wrong. */
function inferType(values: unknown[]): BiColumnType {
  let num = 0, date = 0, total = 0;
  for (const v of values) {
    if (v == null || v === "") continue;
    total++;
    if (typeof v === "number") { num++; continue; }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { date++; continue; }
    if (s !== "" && !isNaN(Number(s.replace(/[$,%]/g, "")))) num++;
  }
  if (!total) return "string";
  if (date / total > 0.6) return "date";
  if (num / total > 0.6) return "number";
  return "string";
}

/** Zero-null sanitization: numeric → 0, text/date → "N/A". */
export function sanitizeBiDataset(columns: BiColumn[], rows: unknown[][]): (string | number | null)[][] {
  return rows.map((r) => columns.map((c, i) => {
    const v = r?.[i];
    if (c.type === "number") {
      if (typeof v === "number" && isFinite(v)) return v;
      const n = Number(String(v ?? "").replace(/[$,%\s]/g, ""));
      return isFinite(n) ? n : 0;
    }
    if (v == null || v === "") return "N/A";
    return String(v);
  }));
}

export function normalizePowerbi(raw: any): PowerbiSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const ds = raw.dataset ?? raw.data;
  if (!ds || !Array.isArray(ds.columns) || !Array.isArray(ds.rows)) return null;
  const columns: BiColumn[] = ds.columns.map((c: any, i: number) => ({
    name: str(c?.name ?? c?.label, "col" + (i + 1)),
    type: BI_TYPES.has(str(c?.type) as BiColumnType) ? (c.type as BiColumnType) : inferType(ds.rows.map((r: any) => r?.[i])),
  }));
  const rows = sanitizeBiDataset(columns, ds.rows);
  const measures: BiMeasure[] = arr(raw.measures).map((m: any) => ({ name: str(m?.name), dax: str(m?.dax ?? m?.expression) })).filter((m) => m.name && m.dax);
  if (!measures.length) {
    const numCol = columns.find((c) => c.type === "number");
    if (numCol) measures.push({ name: "Total " + numCol.name, dax: `SUM(Sales[${numCol.name}])` });
  }
  const visuals: BiVisual[] = arr(raw.visuals).map((v: any) => ({
    type: VISUAL_TYPES.has(str(v?.type)) ? v.type : "bar",
    title: str(v?.title, str(v?.type, "Visual")),
    dimension: str(v?.dimension ?? v?.field) || undefined,
    measure: str(v?.measure) || measures[0]?.name,
    format: v?.format === "currency" || v?.format === "percent" ? v.format : "number",
    columns: arr(v?.columns).map((c) => str(c)).filter(Boolean),
  }));
  if (!visuals.length) {
    visuals.push({ type: "kpi", title: measures[0]?.name ?? "Total", measure: measures[0]?.name, format: "number" });
    const dim = columns.find((c) => c.type === "string");
    const num = columns.find((c) => c.type === "number");
    if (dim && num) visuals.push({ type: "bar", title: `${num.name} by ${dim.name}`, dimension: dim.name, measure: measures[0]?.name, format: "number" });
  }
  const slicers: BiSlicer[] = arr(raw.slicers).map((s: any) => ({ field: str(s?.field), type: (s?.type === "date-range" ? "date-range" : "list") as BiSlicer["type"] })).filter((s) => s.field);
  return {
    filename: str(raw.filename, "powerbi_report"),
    dataset: { columns, rows },
    measures, visuals, slicers,
    synthetic: raw.synthetic === true,
  };
}

/** Filesystem-safe download filename — identical on server and preview UI. */
export function safeName(name: unknown): string {
  const cleaned = String(name ?? "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
  return cleaned || "document";
}

// ---------- html ----------
/** An html fence is broken when it has no markup at all (JSON fences get zod). */
export function isBrokenHtmlFence(body: string): boolean {
  const t = body.trim();
  return t.length < 24 || !/[<]/.test(t) || !/<(div|html|body|svg|h1|section|main|p|canvas|table|button|input)\b/i.test(t);
}
