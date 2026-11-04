/**
 * resultHelpers.ts — defensive payload readers for the rich-result surfaces.
 *
 * The §3 law: structured data drives the UI. A payload was already
 * sanitized on both servers, but renderers still read EVERY field
 * defensively — a malformed payload degrades to the generic/source view,
 * it never throws inside a component (§59 one broken widget law, §75).
 * Pure functions: node-testable (renderToString harnesses use them too).
 */
import type { RichResult } from "../../lib/web-search/rich-results";
import { isSafeHttpUrl } from "../../lib/web-search/rich-results";
import type { CitationEntryLite } from "./richResultContext";

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function payloadOf(r: RichResult): Record<string, unknown> {
  return obj(r.payload) ?? {};
}

export function str(v: unknown, max = 500): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Safe display number: finite only; NaN/Infinity render as absent (§75). */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Safe coordinate pair — map/video embed hosts re-check separately. */
export function coord(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Math.abs(n) <= 180 ? n : undefined;
}

export function itemsOf(payload: Record<string, unknown>, key = "items"): Record<string, unknown>[] {
  const arr = payload[key];
  if (!Array.isArray(arr)) return [];
  return arr.map(obj).filter((o): o is Record<string, unknown> => o !== null);
}

export function strList(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, 160)).filter((x): x is string => x !== undefined).slice(0, max);
}

/** Validated https URL for rendering — anything else is absent, never a href. */
export function safeUrl(v: unknown): string | undefined {
  return isSafeHttpUrl(v) ? v : undefined;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Money display: a value + a currency code; never invents a symbol. */
export function money(value: unknown, currency?: unknown): string | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  const cur = str(currency, 8);
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n);
  return cur ? `${formatted} ${cur}` : formatted;
}

/** Seconds → m:ss / h:mm:ss (video durations, seek targets). */
export function duration(seconds: unknown): string | undefined {
  const n = num(seconds);
  if (n === undefined || n < 0) return undefined;
  const s = Math.round(n);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Dates render as-is (ISO or provider string); never reinterpreted. */
export function dateLabel(v: unknown): string | undefined {
  return str(v, 40);
}

/**
 * §42 provenance: resolve an envelope sourceRef to the citation entry when
 * the message carries the [S#] map; otherwise fall back to the ref string
 * itself. A surface's provenance is ALWAYS visible — never suppressed.
 */
export function resolveSource(
  ref: string,
  citationMap?: Record<string, CitationEntryLite>,
): { label: string; url?: string } {
  const entry = citationMap?.[ref];
  if (entry) {
    return { label: entry.domain || hostOf(entry.url) || ref, url: safeUrl(entry.url) };
  }
  // A bare URL ref (map packets carry e.g. "maps" labels, items carry domains).
  if (isSafeHttpUrl(ref)) return { label: hostOf(ref), url: ref };
  return { label: ref };
}

/** Find a payload item by id across the common shapes (open_detail/lightbox). */
export function findItemById(
  payload: Record<string, unknown>,
  id: string,
): Record<string, unknown> | null {
  for (const key of ["items", "images", "videos", "products", "pins", "slots", "events", "jobs", "cards", "questions"]) {
    for (const it of itemsOf(payload, key)) {
      if (str(it.id) === id) return it;
    }
  }
  return null;
}

/** Field-level provenance label for one item ("via reuters.com"). */
export function itemProvenance(item: Record<string, unknown>): string | undefined {
  return str(item.sourceRef, 80) ?? str(item.domain, 80) ?? (hostOf(safeUrl(item.url) ?? "") || undefined);
}
