/**
 * P4 — Presentation router (Rich-Results Addendum §55–§56).
 *
 * Deterministic primary-surface decision: when the structured retrieval
 * result ALREADY tells us the answer (geocoded hits, YouTube videos,
 * news clusters, intent labels), no extra LLM call is paid for the
 * presentation choice (§55). The router reads signals from the evidence
 * bundle and picks ONE primary surface; `null` means plain text (the
 * §53 no-spam law — "Who invented the telephone?" gets an answer, not a
 * card).
 *
 * P4 scope: this module is INERT (no call sites yet). P5 consumes it via
 * the additive `web:surface_*` stage events and builds the RichResult
 * envelope from the chosen primary. Rust mirror: presentation.rs — the
 * ladder order, vocabulary, and reason strings are byte-parity tested.
 */
import { domainWithin } from "./planner-law";

/** Verbatim §55 contract. */
export interface PresentationPlan {
  primary:
    | "text" | "images" | "video" | "map" | "weather" | "finance"
    | "sports" | "news" | "shopping" | "business" | "reservation" | "jobs"
    | "events" | "tracker" | "entity" | "table" | "chart" | "learning" | "app";
  layout: "inline" | "carousel" | "grid" | "map_split" | "table" | "fullscreen_capable";
  reason: string;
}

/** Signals computed from the bundle (P5 wiring); pure, serializable. */
export interface PresentationInput {
  userPrompt: string;
  /** Coarse location from the planner law (§11.17), or null. */
  location: string | null;
  /** True when retrieval produced geocoded/coordinate evidence. */
  hasGeoEvidence: boolean;
  /** True when the YouTube structured hop returned video results. */
  hasYouTubeVideo: boolean;
  /** Gate + planned intents (lowercased). */
  intents: string[];
  /** Top ranked/packet domains, best first (≤5 consulted). */
  topDomains: string[];
}

const NEWS_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "cnn.com", "nytimes.com",
  "theguardian.com", "washingtonpost.com", "timesofindia.com", "hindustantimes.com",
  "ndtv.com", "aljazeera.com", "cnbc.com", "bloomberg.com",
];

const rx = (re: RegExp, p: string): boolean => re.test(p);

/**
 * §56 structured-source routing ladder — checked in priority order.
 * The FIRST signal that fires wins (one primary surface by default);
 * the reason string names the signal so the UI can explain its choice.
 */
export function planPresentation(input: PresentationInput): PresentationPlan | null {
  const p = input.userPrompt;
  const top = input.topDomains.slice(0, 5);

  // 1. Geocoded evidence → map is the primary surface (§56).
  if (input.hasGeoEvidence) return { primary: "map", layout: "map_split", reason: "geocoded search evidence" };

  // 2–4. Structured verticals that retrieval already typed.
  if (rx(/\b(weather|forecast|temperature|humidity|air quality|rain|snow|uv index)\b/i, p))
    return { primary: "weather", layout: "inline", reason: "weather intent" };
  if (rx(/\b(stock|stocks|share price|shares|ticker|equit|nasdaq|s&p|sensex|nifty|bitcoin|ethereum|crypto price|exchange rate|market cap)\b/i, p))
    return { primary: "finance", layout: "inline", reason: "finance intent" };
  if (rx(/\b(match|score|standing|standings|points table|leaderboard|tournament|fixture|series|innings|goal)\b/i, p)) {
    const table = rx(/\b(standing|standings|points table|leaderboard|table)\b/i, p);
    return { primary: "sports", layout: table ? "table" : "inline", reason: table ? "sports standings" : "sports intent" };
  }

  // 5. Live-state trackers (status pages, versions, shipments).
  if (rx(/\b(status page|outage|downtime|incident|tracker|tracking number|shipment|package|version|changelog|release notes)\b/i, p))
    return { primary: "tracker", layout: "inline", reason: "live-state intent" };

  // 6–9. Intent-typed asks.
  if (rx(/\b(reserv|book (?:a |an )?(?:table|room|slot|ticket)|booking)\b/i, p))
    return { primary: "reservation", layout: "inline", reason: "reservation intent" };
  if (rx(/\b(jobs?|vacanc|hiring|career|internship|job openings?|employment)\b/i, p))
    return { primary: "jobs", layout: "grid", reason: "jobs intent" };
  if (rx(/\b(events?|concert|meetup|webinar|conference|festival|workshop)\b/i, p))
    return { primary: "events", layout: "grid", reason: "events intent" };
  if (rx(/\b(company|business|startup|restaurant|hotel|clinic|store)\b/i, p) &&
      rx(/\b(hours|rating|reviews?|contact|address|phone|open now)\b/i, p))
    return { primary: "business", layout: "inline", reason: "business info intent" };

  // 10. Localization law or explicit map ask → map split.
  if (input.location || rx(/\b(map|maps|directions|route|near me|around me|distance)\b/i, p))
    return { primary: "map", layout: "map_split", reason: input.location ? `coarse location "${input.location}"` : "map intent" };

  // 11. Shopping.
  if (rx(/\b(buy|purchase|for sale|deal|discount|coupon|shop for|best .{0,24} under|product)\b/i, p))
    return { primary: "shopping", layout: "grid", reason: "shopping intent" };

  // 12. Video results — structured hop or video-domains up top (§56).
  const videoTop = top.slice(0, 2).some((d) => domainWithin(d, "youtube.com") || domainWithin(d, "youtu.be"));
  if (input.hasYouTubeVideo || videoTop)
    return { primary: "video", layout: "carousel", reason: "video results in evidence" };

  // 13. News cluster — gate intent or ≥2 news domains in the top five.
  const newsHits = top.filter((d) => NEWS_DOMAINS.some((n) => domainWithin(d, n))).length;
  if (input.intents.includes("news") || newsHits >= 2)
    return { primary: "news", layout: "grid", reason: newsHits >= 2 ? `${newsHits} news domains in top results` : "news intent" };

  // 14–18. Remaining surfaces.
  if (rx(/\b(tutorial|learn|course|guide|how to|explain|documentation|docs)\b/i, p))
    return { primary: "learning", layout: "grid", reason: "learning intent" };
  if (top.slice(0, 2).some((d) => domainWithin(d, "wikipedia.org")))
    return { primary: "entity", layout: "inline", reason: "entity evidence (wikipedia)" };
  if (rx(/\b(compare|comparison|versus|\bvs\.?\b|difference between|alternative to|best \w+|top \d)/i, p))
    return { primary: "table", layout: "table", reason: "comparison intent" };
  if (rx(/\b(trend|trends|over time|history of|growth|chart|statistics|percentage|population)\b/i, p))
    return { primary: "chart", layout: "inline", reason: "trend/statistics intent" };
  if (rx(/\b(app|apps|software|tool|library|framework|sdk|download|install)\b/i, p))
    return { primary: "app", layout: "grid", reason: "app intent" };

  // §53: no rich signal → plain text. Never decorate a plain answer.
  return null;
}
