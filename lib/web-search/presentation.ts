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
 * P5 WIRING: the pipeline calls derivePresentation() at bundle assembly and
 * stores the plan on EvidenceBundle.presentation; the rich-result producer
 * builds the envelope from the chosen primary and streams it via the
 * additive `web:surface_*` stage events. (Historical note: a
 * `presentation.rs` mirror lived in the Rust websearch crate removed by
 * the 2026-11-03 TS-rollback. Re-verified 2026-11-13: no presentation.rs
 * and no ladder vocabulary anywhere in rust-backend — the Rust side only
 * relays the plan TS computed; this ladder is TS-only.)
 */
import { domainWithin } from "./domain-match";
import type { PlannerLaw } from "./planner-law";
import type { EvidencePacket, RankedResult, SearchDecision } from "./types";

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
 * AMBIGUOUS-DOMAIN LAW (2026-11-13 brief L189/L190: "Rust 'pattern match'
 * must not select sports"; "avoid domain-intent decisions from ambiguous
 * terms such as stock, package, or series"). An ambiguous domain keyword
 * must never decide a surface by ITSELF. Each affected rung carries:
 *   PRIMARY   — unambiguous multi-word / proper-noun / code-shape forms;
 *               one hit wins, so every measured positive survives intact
 *               ("points table", "status page", "s&p", "market cap"…).
 *   SECONDARY — words whose common-English meaning collides with the
 *               domain (match/series/goal/fixture, stock/market/price,
 *               package/version/release/incident…). A rung fires only
 *               when TWO DISTINCT secondary tokens co-occur — a genuine
 *               domain ask carries its own second signal ("match score",
 *               "stock quote", "package tracking"), a common-English use
 *               never does ("pattern match", "stock photo", "npm package").
 * Rungs whose whole vocabulary is already unambiguous (weather, news
 * domains, map, shopping…) keep their single-hit form.
 */
function ladderHit(p: string, primary: RegExp, secondary: RegExp): boolean {
  if (primary.test(p)) return true;
  const hits = new Set<string>();
  for (const m of p.matchAll(secondary)) hits.add(m[0].toLowerCase());
  return hits.size >= 2;
}

const FIN_PRIMARY = /\b(ticker|s&p|nasdaq|sensex|nifty|bitcoin|ethereum|exchange rate|market cap|crypto price|equit\w*|stock exchange|share price)\b/i;
const FIN_SECONDARY = /\b(stocks?|shares?|prices?|quotes?|markets?|invest\w*|portfolio|portfolios|dividends?|brokers?|etf|etfs|buy|sell|holdings)\b/gi;

const SPORTS_PRIMARY = /\b(standings?|points table|leaderboard|tournaments?|innings)\b/i;
const SPORTS_SECONDARY = /\b(match(?:es)?|scores?|series|goals?|fixtures?)\b/gi;

const TRACKER_PRIMARY = /\b(status page|outages?|downtime|tracking number|shipments?|change ?log|release notes)\b/i;
const TRACKER_SECONDARY = /\b(tracker|trackers|tracking|packages?|versions?|updates?|releases?|incidents?)\b/gi;

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
  if (ladderHit(p, FIN_PRIMARY, FIN_SECONDARY))
    return { primary: "finance", layout: "inline", reason: "finance intent" };
  if (ladderHit(p, SPORTS_PRIMARY, SPORTS_SECONDARY)) {
    const table = rx(/\b(standing|standings|points table|leaderboard|table)\b/i, p);
    return { primary: "sports", layout: table ? "table" : "inline", reason: table ? "sports standings" : "sports intent" };
  }

  // 5. Live-state trackers (status pages, versions, shipments).
  if (ladderHit(p, TRACKER_PRIMARY, TRACKER_SECONDARY))
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

/* ---------------------------------------------------------------------- */
/* F05 (2026-11-15 brief) - SURFACE CORROBORATION
 *
 * The ambiguous-domain law above stops ONE ambiguous word from selecting a
 * vertical surface, and it works: 'npm package for parsing yaml' and
 * 'pattern match' stay off the tracker/sports rungs. It cannot settle an
 * ask that legitimately contains TWO domain-flavored words while being
 * about something else entirely, because the prompt alone does not say
 * which - that needs real evidence. Three rungs are state-dependent
 * (finance prices, sports scores, live-state trackers are only worth a
 * vertical card when a vertical source actually answered), so their choice
 * is corroborated against the retrieval result. The prompt still wins
 * outright whenever it is unambiguous (that rung PRIMARY pattern), which is
 * what keeps every measured positive intact. Nothing here can ADD a
 * surface; it can only decline an unsupported one. The news rung already
 * followed exactly this law (its reason string is '... news domains in top
 * results'), so this extends an existing rule instead of inventing one.
 */
const FINANCE_DOMAINS = [
  "wsj.com", "barrons.com", "marketwatch.com", "investopedia.com", "ft.com",
  "seekingalpha.com", "moneycontrol.com", "valueinvestor.in", "etmoney.com",
  "finance.yahoo.com", "investor.gov", "sec.gov", "irs.gov", "bls.gov",
  "coingecko.com", "coinmarketcap.com", "kraken.com", "binance.com",
];
const SPORTS_DOMAINS = [
  "espn.com", "espn.in", "sports.yahoo.com", "the-score.com", "fifa.com",
  "theifl.com", "icc-cricket.com", "cricbuzz.com", "espncricinfo.com",
  "atptour.com", "wimbledon.com", "iihf.com", "worldrugby.org",
];
const TRACKER_DOMAINS = [
  "github.com", "pypi.org", "npmjs.com", "crates.io", "rubygems.org",
  "statuspage.io", "downdetector.com", "pingdom.com", "ups.com", "fedex.com",
  "dhl.com", "speedpass.co.in", "17track.net",
];

const VERTICAL_DOMAINS: Record<string, string[]> = {
  finance: FINANCE_DOMAINS,
  sports: SPORTS_DOMAINS,
  tracker: TRACKER_DOMAINS,
};

/** PRIMARY pattern of the rung that owns this surface (unambiguous ask). */
const SURFACE_PRIMARY: Record<string, RegExp> = {
  finance: FIN_PRIMARY,
  sports: SPORTS_PRIMARY,
  tracker: TRACKER_PRIMARY,
};

export function corroborateSurface(
  plan: PresentationPlan,
  userPrompt: string,
  evidenceDomains: string[],
): PresentationPlan | null {
  const list = VERTICAL_DOMAINS[plan.primary];
  if (!list) return plan;
  if (SURFACE_PRIMARY[plan.primary].test(userPrompt)) return plan;
  if (evidenceDomains.some((d) => list.some((v) => domainWithin(d, v)))) return plan;
  return null;
}
/** YouTube domain law — structured hop domains and short links alike. */
const YOUTUBE_DOMAINS = ["youtube.com", "youtu.be"];

/**
 * P5 WIRING — computes the §55 signals from pipeline state and runs the
 * router. `hasGeoEvidence` is passed in because coordinates exist ONLY
 * while the Maps companion hop decodes them (§11 law: coordinates come
 * from validated provider data, never inferred from prose). Domain law:
 * ranked results first, then packets, first-seen wins, empties skipped,
 * capped at 5.
 */
export function derivePresentation(
  userPrompt: string,
  plannerLaw: PlannerLaw,
  gateQueries: SearchDecision["queries"],
  searchResults: RankedResult[],
  packets: EvidencePacket[],
  hasGeoEvidence: boolean,
): PresentationPlan | null {
  const seen = new Set<string>();
  const topDomains: string[] = [];
  for (const d of [...searchResults.map((r) => r.domain), ...packets.map((p) => p.domain)]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    topDomains.push(d);
    if (topDomains.length === 5) break;
  }
  const plan = planPresentation({
    userPrompt,
    location: plannerLaw.location,
    hasGeoEvidence,
    hasYouTubeVideo: packets.some((p) => YOUTUBE_DOMAINS.some((y) => domainWithin(p.domain, y))),
    intents: gateQueries.map((q) => q.intent.toLowerCase()),
    topDomains,
  });
  // F05: state-dependent surfaces must be corroborated by the evidence that
  // actually came back. See the corroboration law above.
  return plan ? corroborateSurface(plan, userPrompt, topDomains) : null;
}
