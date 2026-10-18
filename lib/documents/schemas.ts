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
export interface XlsxSheet {
  name: string; columns: XlsxColumn[]; rows: Record<string, unknown>[];
  freezeHeader: boolean; totalRow: boolean;
}
export interface XlsxSpec { filename: string; sheets: XlsxSheet[] }

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
    sheets.push({
      name: str(sh.name, "Sheet" + (sheets.length + 1)).slice(0, 31),
      columns, rows,
      freezeHeader: sh.freezeHeader !== false,
      totalRow: sh.totalRow === true,
    });
  }
  if (!sheets.length) return null;
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
