/**
 * Scenario detection: what KIND of answer the user wants, and therefore
 * which claims must be verified before the answer may state them.
 *
 * Deterministic keyword rules (no model call): the same table drives the
 * `<verification>` prompt block, the Evidence-trail header label/icon, and
 * scripts/eval-verify.mjs. Extending coverage means adding a row here — not
 * touching the pipeline.
 */
import type { SearchDecision } from "../web-search/types";
import type { ClaimType } from "./types";

export type ScenarioId =
  | "product-link"
  | "price"
  | "availability"
  | "delivery"
  | "job"
  | "local-poi"
  | "review"
  | "news"
  | "docs"
  | "general";

export interface Scenario {
  id: ScenarioId;
  /** Turn-header label, e.g. "Honor 200 — Price check". */
  taskLabel: string;
  /** Lucide icon id resolved by the trail card / message header. */
  icon: string;
  /** Claims that must be adjudicated before the answer may assert them. */
  claims: ClaimType[];
  /**
   * Transactional = the user will ACT on the answer (buy, apply, visit).
   * Only these scenarios trigger the bounded verification re-check, because
   * a wrong price/stock/job link has real consequences; a wrong sentence in
   * an essay does not.
   */
  transactional: boolean;
}

const SCENARIOS: Record<ScenarioId, Scenario> = {
  "product-link": {
    id: "product-link",
    taskLabel: "Product link",
    icon: "shopping-bag",
    claims: ["item-link", "existence", "price", "availability"],
    transactional: true,
  },
  price: {
    id: "price",
    taskLabel: "Price check",
    icon: "banknote",
    claims: ["price", "item-link", "availability", "existence"],
    transactional: true,
  },
  availability: {
    id: "availability",
    taskLabel: "Availability check",
    icon: "package-check",
    claims: ["availability", "item-link", "price", "existence"],
    transactional: true,
  },
  delivery: {
    id: "delivery",
    taskLabel: "Delivery check",
    icon: "truck",
    claims: ["deliverable-to", "availability", "item-link"],
    transactional: true,
  },
  job: {
    id: "job",
    taskLabel: "Job search",
    icon: "briefcase",
    claims: ["job-open", "item-link", "existence"],
    transactional: true,
  },
  "local-poi": {
    id: "local-poi",
    taskLabel: "Nearby search",
    icon: "map-pin",
    claims: ["existence", "rating", "review-count", "open-now"],
    transactional: true,
  },
  review: {
    id: "review",
    taskLabel: "Review check",
    icon: "star",
    claims: ["rating", "review-count", "existence"],
    transactional: true,
  },
  news: {
    id: "news",
    taskLabel: "Current events",
    icon: "newspaper",
    claims: ["existence"],
    transactional: false,
  },
  docs: {
    id: "docs",
    taskLabel: "Docs / version check",
    icon: "book-open",
    claims: ["version", "existence"],
    transactional: false,
  },
  general: {
    id: "general",
    taskLabel: "Web research",
    icon: "search",
    claims: ["existence"],
    transactional: false,
  },
};

export function scenarioById(id: ScenarioId): Scenario {
  return SCENARIOS[id];
}

const RE = {
  productLink: /\b(direct link|the link|a link|link (?:for|to|me)|product page|open the (?:product|page)|where (?:can i|to) buy|buy online|purchase online|shop online|add to cart|is it listed|list it|original product|genuine product)\b/i,
  price: /\b(price|prices|pricing|cost|costs|rate|rates|charges|how much|mrp|₹|rs\.?\s?\d|inr)\b/i,
  availability: /\b(availab\w+|in stock|out of stock|stock status|sold out|preorder|pre-order|backorder|in-store|available now)\b/i,
  delivery: /\b(deliver\w*|shipping|ship to|shipped to|courier|pin ?code|\b\d{6}\b|delivery time|delivery date|cash on delivery|cod)\b/i,
  job: /\b(job|jobs|vacanc(y|ies)|hiring|recruit\w+|opening|openings|intern(ship)?s?|apply (?:to|for)|applications?|resume|cv|walk-?in|placement|career)\b/i,
  localPoi: /\b(near me|nearby|near us|around me|close to me|in my (?:area|city|locality)|around (?:my|the) (?:area|place|house)|local|nearest|within \d+ ?(?:km|kms))\b/i,
  review: /\b(review|reviews|rating|rated|stars|worth (?:buying|it)|is it good|good or bad|pros and cons|opinion|feedback|comments from|experienc\w+ of)\b/i,
  news: /\b(news|today|yesterday|tonight|breaking|announced|launch\w*|update|updates|happened|recently|this week)\b/i,
  docs: /\b(version|release|changelog|error|exception|code|function|api|documentation|docs|tutorial|install|configur\w+|command|syntax)\b/i,
};

/**
 * Detect the answer scenario. Order matters: a prompt naming both a price
 * and "direct link" is a LINK ask first (the user wants a URL they can
 * click, so `item-link` must be verified), and a "deliver to 500081" ask is
 * a delivery ask even though it also mentions availability.
 */
export function detectScenario(
  prompt: string,
  decision?: SearchDecision,
): Scenario {
  const p = prompt.toLowerCase();
  const intents = new Set((decision?.queries ?? []).map((q) => q.intent));

  if (RE.localPoi.test(p)) return SCENARIOS["local-poi"];
  if (RE.delivery.test(p) && /\b\d{6}\b/.test(p)) return SCENARIOS.delivery;
  if (RE.productLink.test(p)) return SCENARIOS["product-link"];
  if (RE.job.test(p)) return SCENARIOS.job;
  if (RE.availability.test(p)) return SCENARIOS.availability;
  if (RE.price.test(p)) return SCENARIOS.price;
  if (RE.review.test(p)) return SCENARIOS.review;
  if (RE.delivery.test(p)) return SCENARIOS.delivery;
  if (intents.has("news") || RE.news.test(p)) return SCENARIOS.news;
  if (intents.has("docs") || intents.has("code") || RE.docs.test(p)) return SCENARIOS.docs;
  return SCENARIOS.general;
}

/* ── locality detection (Phase 2: locality-aware search + POI) ───────────── */

/** Venue categories → OSM/Overpass filters + Maps query words. */
export const POI_CATEGORIES: {
  words: string[];
  label: string;
  overpass: string[];
  mapsWord: string;
}[] = [
  { words: ["restaurant", "restaurants", "food", "eat", "eating", "dining", "biriyani", "biryani"], label: "restaurant", overpass: ['["amenity"="restaurant"]'], mapsWord: "restaurants" },
  { words: ["cafe", "cafes", "coffee", "café"], label: "cafe", overpass: ['["amenity"="cafe"]'], mapsWord: "cafes" },
  { words: ["doctor", "doctors", "physician", "clinic", "clinics", "gp", "dermatologist", "gynec", "pediatric"], label: "doctor", overpass: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["healthcare"="clinic"]'], mapsWord: "doctors" },
  { words: ["hospital", "hospitals", "emergency"], label: "hospital", overpass: ['["amenity"="hospital"]'], mapsWord: "hospitals" },
  { words: ["pharmacy", "pharmacies", "medical store", "chemist", "medicine"], label: "pharmacy", overpass: ['["amenity"="pharmacy"]'], mapsWord: "pharmacies" },
  { words: ["hotel", "hotels", "resort", "stay"], label: "hotel", overpass: ['["tourism"="hotel"]'], mapsWord: "hotels" },
  { words: ["gym", "fitness", "yoga"], label: "gym", overpass: ['["leisure"="fitness_centre"]'], mapsWord: "gyms" },
  { words: ["salon", "parlour", "parlor", "barber", "haircut", "spa"], label: "salon", overpass: ['["shop"="beauty"]', '["shop"="hairdresser"]'], mapsWord: "salons" },
  { words: ["school", "schools", "college", "colleges"], label: "school", overpass: ['["amenity"="school"]'], mapsWord: "schools" },
  { words: ["fuel", "petrol", "gas station", "petrol pump"], label: "fuel station", overpass: ['["amenity"="fuel"]'], mapsWord: "petrol pumps" },
  { words: ["park", "parks", "playground"], label: "park", overpass: ['["leisure"="park"]'], mapsWord: "parks" },
  { words: ["bank", "atm", "banking"], label: "bank", overpass: ['["amenity"="bank"]', '["amenity"="atm"]'], mapsWord: "banks" },
  { words: ["grocery", "supermarket", "kirana", "market"], label: "grocery store", overpass: ['["shop"="supermarket"]', '["shop"="convenience"]'], mapsWord: "grocery stores" },
  { words: ["mechanic", "garage", "service center", "repair"], label: "garage", overpass: ['["shop"="car_repair"]'], mapsWord: "car repair shops" },
];

export interface LocalIntent {
  nearMe: boolean;
  category?: string;
  /** Locality words found in the prompt (city/area names are resolved by the geo step). */
  localityWords: string[];
}

/**
 * Does this prompt need a place? True for explicit "near me" phrasing and
 * for superlative + venue-category phrasing ("best restaurant in manikonda").
 */
export function detectLocalIntent(prompt: string): LocalIntent | null {
  const p = prompt.toLowerCase();
  const nearMe = RE.localPoi.test(p);
  const cat = POI_CATEGORIES.find((c) => c.words.some((w) => p.includes(w)));
  if (!nearMe && !cat) return null;
  if (!nearMe && !/\b(best|top|near|close|good|cheapest|safest|recommended)\b/i.test(p)) return null;
  const localityWords = (p.match(/\b(?:in|near|around|at|of)\s+([a-z][a-z\s]{2,28})\b/g) ?? [])
    .map((s) => s.replace(/^\b(?:in|near|around|at|of)\s+/, "").trim())
    .filter((s) => s.length > 2 && !RE.localPoi.test(s));
  return { nearMe, category: cat?.label, localityWords: [...new Set(localityWords)].slice(0, 3) };
}

/** Overpass filter expressions for a category label (Phase 2). */
export function overpassFiltersFor(label: string): string[] {
  const c = POI_CATEGORIES.find((x) => x.label === label);
  return c?.overpass ?? [];
}

export function mapsWordFor(label: string): string {
  return POI_CATEGORIES.find((x) => x.label === label)?.mapsWord ?? label;
}
