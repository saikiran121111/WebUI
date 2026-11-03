/**
 * P5 — Rich-result protocol (Rich-Results Addendum §2, §40, §75).
 *
 * ONE universal structured-result protocol: tool/retrieval evidence →
 * validated RichResult envelope → client renderer. The model never
 * authors these envelopes and never gets to invent prices, coordinates,
 * weather values, or source metadata (§3) — the pipeline derives them
 * from real retrieval evidence through `deriveRichResults()` below.
 *
 * Trust law: every envelope (server-produced OR future provider) passes
 * `sanitizeRichResult()` before it crosses to the client — safe-URL
 * validation, embed allowlist, coordinate/NaN rejection, payload size
 * cap, and action whitelisting. Unknown kinds fall back to a generic
 * card, never a crash (§2). The Rust mirror (crates/ruke-websearch/src/
 * rich_results.rs) was removed in the 2026-11-03 TS rollback — it kept
 * the same vocabulary, walker law and producer; the TS tests pin those
 * bytes here as the single owner.
 */
import { z } from "zod";
import type { PresentationPlan } from "./presentation";
import { domainWithin } from "./domain-match";
import type { EvidencePacket, RankedResult } from "./types";

/** §2 kind vocabulary (order ⇔ rich_results.rs RichKind serde strings). */
export const RICH_RESULT_KINDS = [
  "generic", "sources", "image_gallery", "video", "audio", "map",
  "local_business", "weather", "finance", "sports", "news",
  "product", "product_carousel", "product_comparison", "restaurant",
  "reservation", "job", "event", "tracker", "entity", "table",
  "chart", "metrics", "timeline", "flashcards", "quiz",
  "simulation", "file", "app",
] as const;
export type RichResultKind = (typeof RICH_RESULT_KINDS)[number];

/** §40 action bridge — 10 variants; the client executes ONLY these. */
const actionId = z.string().min(1).max(120);
export const RichActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_source"), url: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("open_detail"), targetId: actionId }).strict(),
  z.object({ type: z.literal("lightbox"), targetId: actionId }).strict(),
  z.object({ type: z.literal("fullscreen"), targetId: actionId }).strict(),
  z.object({ type: z.literal("pip"), targetId: actionId }).strict(),
  z.object({ type: z.literal("issue_followup"), prompt: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("compare"), ids: z.array(actionId).min(1).max(16) }).strict(),
  z.object({ type: z.literal("select_map_pin"), id: actionId }).strict(),
  z.object({ type: z.literal("seek_media"), seconds: z.number().finite().min(0).max(86_400) }).strict(),
  z.object({ type: z.literal("prepare_action"), actionId: actionId }).strict(),
]);
export type RichAction = z.infer<typeof RichActionSchema>;

export const RichResultSchema = z
  .object({
    id: z.string().min(1).max(160),
    version: z.literal(1),
    kind: z.enum(RICH_RESULT_KINDS),
    title: z.string().max(300).optional(),
    subtitle: z.string().max(300).optional(),
    sourceRefs: z.array(z.string().min(1).max(160)).max(64),
    payload: z.unknown(),
    actions: z.array(RichActionSchema).max(12).optional(),
    presentation: z
      .object({ preferred: z.enum(["inline", "carousel", "grid", "fullscreen", "pip"]) })
      .optional(),
  })
  .strict();
export type RichResult = z.infer<typeof RichResultSchema>;

/** Map evidence gathered by the Maps companion hop (validated provider only). */
export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  address?: string;
  url?: string;
  sourceRef?: string;
}

// ── §75 validation law ───────────────────────────────────────────────────

/** Key contains one of these → its string value must be a safe http(s) URL. */
const URLISH_KEY = /(url|uri|href|src|link|embed|thumb|image|poster|artwork|avatar|website)/i;
/** §61 embed allowlist — explicit, nothing else may frame inside chat. */
const EMBED_HOSTS = ["www.youtube-nocookie.com", "www.openstreetmap.org"];
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069\uFEFF]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_PAYLOAD_BYTES = 65_536;
const MAX_DEPTH = 8;
const MAX_NODES = 4000;

/** Safe display URL: http(s) only, no credentials, no hostless/loopback-ish
 *  bare names, no control/bidi characters, length-capped. (javascript:,
 *  data:, file:, localhost, .local, .onion, and IP-literal hosts are out.) */
export function isSafeHttpUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0 || u.length > 2048) return false;
  if (/\s/.test(u) || CONTROL_CHARS.test(u)) return false;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".onion")) return false;
  if (!host.includes(".") && !host.includes(":")) return false; // bare name / single label
  if (/^\d+$/.test(host.replace(/\./g, ""))) return false; // IPv4 literal
  if (host.startsWith("[")) return false; // IPv6 literal
  return true;
}

/** lat/lng (and lon/latitude/longitude aliases) validated pair-wise. */
function coordsValid(obj: Record<string, unknown>): { lat?: number; lng?: number } | null {
  const lat = obj.lat ?? obj.latitude;
  const lng = obj.lng ?? obj.lon ?? obj.longitude;
  const has = lat !== undefined || lng !== undefined;
  if (!has) return null; // no coordinate fields on this object
  const latOk = typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lngOk = typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  if (!latOk || !lngOk) return { }; // present-but-invalid ⇒ strip the pair (§75)
  return { lat: lat as number, lng: lng as number };
}

interface WalkBudget { nodes: number; overflow: boolean; }

/**
 * Payload hygiene walker (§75): drops forbidden keys, non-safe URL-ish
 * strings, non-allowlisted embeds, non-finite numbers, and invalid
 * coordinate pairs; enforces depth/node budgets. Deterministic; the
 * producer runs it on its own output too (belt-and-braces).
 */
function sanitizeValue(v: unknown, keyHint: string, depth: number, budget: WalkBudget): unknown {
  if (budget.overflow) return undefined;
  if (++budget.nodes > MAX_NODES) {
    budget.overflow = true;
    return undefined;
  }
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v as number) ? v : undefined;
  if (t === "string" || t === "boolean") return v;
  if (t !== "object") return undefined; // functions/symbols/bigint never serialize
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return undefined;
    return v
      .map((item) => sanitizeValue(item, keyHint, depth + 1, budget))
      .filter((x) => x !== undefined);
  }
  if (depth >= MAX_DEPTH) return undefined;
  const src = v as Record<string, unknown>;
  const coords = coordsValid(src);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const isCoordKey = /^(lat|lng|lon|latitude|longitude)$/.test(k);
    if (isCoordKey) continue; // emitted canonically as lat/lng below
    const cleaned = sanitizeValue(val, k, depth + 1, budget);
    if (cleaned === undefined) continue;
    if (typeof cleaned === "string" && URLISH_KEY.test(k)) {
      if (!isSafeHttpUrl(cleaned)) continue;
      if (k.toLowerCase().includes("embed") && !EMBED_HOSTS.includes(new URL(cleaned).hostname)) continue;
    }
    out[k] = cleaned;
  }
  if (coords && coords.lat !== undefined && coords.lng !== undefined) {
    out.lat = coords.lat;
    out.lng = coords.lng;
  }
  return out;
}

/**
 * §75 graceful validation: returns a safe envelope or null (drop the
 * surface). Unknown kind ⇒ generic card; oversized/overflowing payload ⇒
 * drop; invalid actions dropped individually before the envelope itself.
 */
export function sanitizeRichResult(raw: unknown): RichResult | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = { ...(raw as Record<string, unknown>) };
  if (typeof src.id !== "string" || src.id.length === 0) return null; // missing id ⇒ drop
  if (src.version === undefined) src.version = 1;
  if (typeof src.kind !== "string" || !(RICH_RESULT_KINDS as readonly string[]).includes(src.kind)) {
    src.kind = "generic"; // §2 unknown-kind fallback
  }
  if (src.version !== 1) return null; // unknown protocol version ⇒ drop
  if (!Array.isArray(src.sourceRefs)) src.sourceRefs = [];
  const budget: WalkBudget = { nodes: 0, overflow: false };
  let payload: unknown = src.payload;
  if (payload !== undefined) {
    payload = sanitizeValue(payload, "payload", 0, budget);
    if (budget.overflow || payload === undefined) return null;
    try {
      if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return null; // §75 oversized
    } catch {
      return null;
    }
    src.payload = payload;
  }
  if (src.actions !== undefined) {
    const list = Array.isArray(src.actions) ? src.actions : [];
    const kept = list
      .map((a) => (RichActionSchema.safeParse(a).success ? RichActionSchema.parse(a) : undefined))
      .filter((a) => a !== undefined);
    if (kept.length > 12) return null;
    if (kept.length === 0) delete src.actions;
    else src.actions = kept;
  }
  const first = RichResultSchema.safeParse(src);
  if (first.success) return first.data;
  // Graceful retry: a broken optional presentation hint must not kill a
  // sound result.
  delete src.presentation;
  const second = RichResultSchema.safeParse(src);
  return second.success ? second.data : null;
}

// ── Producer: evidence → surfaces (never model-authored) ────────────────

const YOUTUBE_DOMAINS = ["youtube.com", "youtu.be"];
const YT_ID = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/;
const NEWS_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "cnn.com", "nytimes.com",
  "theguardian.com", "washingtonpost.com", "timesofindia.com", "hindustantimes.com",
  "ndtv.com", "aljazeera.com", "cnbc.com", "bloomberg.com",
];

export interface RichResultSource {
  plan: PresentationPlan | null;
  results: RankedResult[];
  packets: EvidencePacket[];
  geoPoints: GeoPoint[];
}

function youtubeVideoId(url: string): string | null {
  const m = YT_ID.exec(url);
  return m ? m[1] : null;
}

function preferredFor(plan: PresentationPlan): RichResult["presentation"] {
  switch (plan.layout) {
    case "carousel": return { preferred: "carousel" };
    case "grid": return { preferred: "grid" };
    case "fullscreen_capable": return { preferred: "fullscreen" };
    default: return { preferred: "inline" };
  }
}

/**
 * Deterministic producer (§54: ONE primary surface by default). Surfaces
 * exist ONLY where retrieval already carries the structured data (§3/§56):
 *  - primary "video"      → YouTube results (structured hop / video domains)
 *  - primary "map"        → the validated geo pins gathered by the Maps hop
 *  - primary "news"       → news-domain ranked results (news intent)
 *  - primary "entity"     → the Wikipedia evidence packet
 * Every other primary keeps prose + citation pills (§53 honesty: we do
 * not synthesize weather/finance/sports payloads we never retrieved).
 */
export function deriveRichResults(src: RichResultSource): RichResult[] {
  const plan = src.plan;
  if (!plan) return [];
  const out: RichResult[] = [];

  if (plan.primary === "video") {
    const seen = new Set<string>();
    let made = 0;
    for (const p of [...src.packets, ...src.results]) {
      if (made >= 6) break;
      if (!YOUTUBE_DOMAINS.some((y) => domainWithin(p.domain, y))) continue;
      const videoId = youtubeVideoId(p.url);
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      made += 1;
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const sourceId = "sourceId" in p ? (p as EvidencePacket).sourceId : p.domain;
      out.push({
        id: `rich:video:${videoId}`,
        version: 1,
        kind: "video",
        title: p.title || undefined,
        sourceRefs: [sourceId],
        payload: {
          videoId,
          url: watchUrl,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        },
        actions: [{ type: "open_source", url: watchUrl }],
        presentation: preferredFor(plan),
      });
    }
  } else if (plan.primary === "map" && src.geoPoints.length > 0) {
    const pins = src.geoPoints.slice(0, 10);
    const first = pins[0];
    out.push({
      id: "rich:map",
      version: 1,
      kind: "map",
      sourceRefs: pins.map((g) => g.sourceRef).filter((r): r is string => Boolean(r)),
      payload: {
        pins: pins.map((g) => {
          const pin: Record<string, unknown> = { id: g.id, lat: g.lat, lng: g.lng };
          if (g.label) pin.label = g.label;
          if (g.address) pin.address = g.address;
          if (g.url) pin.url = g.url;
          return pin;
        }),
      },
      ...(first.url ? { actions: [{ type: "open_source" as const, url: first.url }] } : {}),
      presentation: preferredFor(plan),
    });
  } else if (plan.primary === "news") {
    const seen = new Set<string>();
    const items: { title: string; url: string; domain: string; publishedAt?: string }[] = [];
    for (const r of src.results) {
      if (items.length >= 8) break;
      if (!NEWS_DOMAINS.some((n) => domainWithin(r.domain, n)) || seen.has(r.canonical)) continue;
      seen.add(r.canonical);
      const item: { title: string; url: string; domain: string; publishedAt?: string } = {
        title: r.title,
        url: r.canonical,
        domain: r.domain,
      };
      if (r.publishedDate) item.publishedAt = r.publishedDate;
      items.push(item);
    }
    if (items.length > 0) {
      out.push({
        id: "rich:news",
        version: 1,
        kind: "news",
        title: "News",
        sourceRefs: items.map((i) => i.domain),
        payload: { items },
        presentation: preferredFor(plan),
      });
    }
  } else if (plan.primary === "entity") {
    const wiki = src.packets.find((p) => domainWithin(p.domain, "wikipedia.org"));
    if (wiki) {
      const text = wiki.passages[0]?.passageText ?? "";
      out.push({
        id: `rich:entity:${wiki.sourceId}`,
        version: 1,
        kind: "entity",
        title: wiki.title || undefined,
        subtitle: wiki.domain,
        sourceRefs: [wiki.sourceId],
        payload: {
          url: wiki.url,
          ...(text ? { description: text.slice(0, 480) } : {}),
        },
        actions: [{ type: "open_source", url: wiki.url }],
        presentation: preferredFor(plan),
      });
    }
  }

  // Belt-and-braces: producer output re-enters the §75 walker.
  return out.map(sanitizeRichResult).filter((r): r is RichResult => r !== null);
}
