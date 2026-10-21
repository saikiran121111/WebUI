/**
 * Verification re-check planning.
 *
 * When the ledger cannot settle a TRANSACTIONAL ask (price / stock / item
 * page / job posting / delivery), one bounded extra search round is planned
 * so the answer is never built on a gap. The advertised `search_more` tool
 * stub was never executed by anything — this is the deterministic version of
 * it: entity-anchored queries, ≤3 plans, ≤5 new URLs, never after the
 * pipeline ceiling.
 *
 * Only the PLANNING lives here (pure, testable). The pipeline executes the
 * plans with the existing metasearch/extract/rerank helpers.
 */
import type { SearchPlan } from "../web-search/metasearch";
import type { EntityMatcher } from "./entity";
import type { VerificationLedger } from "./types";

/** Store/channel hosts the user named — they get a `site:`-style boost. */
const CHANNEL_HOSTS: { word: string; host: string }[] = [
  { word: "amazon", host: "amazon.in" },
  { word: "flipkart", host: "flipkart.com" },
  { word: "meesho", host: "meesho.com" },
  { word: "croma", host: "croma.com" },
  { word: "bestbuy", host: "bestbuy.com" },
  { word: "walmart", host: "walmart.com" },
  { word: "ebay", host: "ebay.com" },
  { word: "myntra", host: "myntra.com" },
  { word: "naukri", host: "naukri.com" },
  { word: "indeed", host: "in.indeed.com" },
  { word: "linkedin", host: "linkedin.com" },
  { word: "glassdoor", host: "glassdoor.com" },
  { word: "justdial", host: "justdial.com" },
  { word: "tripadvisor", host: "tripadvisor.in" },
  { word: "smartprix", host: "smartprix.com" },
  { word: "91mobiles", host: "91mobiles.com" },
];

export function channelsNamedIn(text: string): string[] {
  const lower = text.toLowerCase();
  return CHANNEL_HOSTS.filter((c) => lower.includes(c.word)).map((c) => c.host);
}

/**
 * Plans for the verification hop, or [] when nothing is missing (the common
 * case: no extra latency). Every plan is anchored on the ENTITY, because the
 * failure being fixed is "we searched the topic but never the item".
 */
export function planVerificationHop(
  ledger: VerificationLedger,
  entity: EntityMatcher,
  userPrompt: string,
  alreadySearched: string[],
): SearchPlan[] {
  const phrase = entity.phrase || userPrompt.slice(0, 60);
  const channels = channelsNamedIn(userPrompt);
  const preferredDomains = channels.slice(0, 3);
  const anchor = userPrompt.slice(0, 300);
  const byStatus = new Map(ledger.claims.map((c) => [c.type, c.status]));
  const unverified = (t: string) => byStatus.get(t as never) === "unverified";

  const wanted: { query: string; freshness?: SearchPlan["freshness"] }[] = [];

  if (unverified("item-link") || unverified("existence")) {
    // The item page itself: quoted entity + the most likely primary host.
    if (preferredDomains.length > 0) {
      wanted.push({ query: `${phrase} ${preferredDomains[0]}` });
    } else {
      wanted.push({ query: `"${phrase}"` });
    }
    wanted.push({ query: `${phrase} official product page` });
  }
  if (unverified("price")) {
    wanted.push({ query: `${phrase} price` });
  }
  if (unverified("availability")) {
    wanted.push({ query: `${phrase} in stock availability` });
  }
  if (unverified("deliverable-to")) {
    const pin = userPrompt.match(/\b\d{6}\b/)?.[0];
    wanted.push({ query: pin ? `${phrase} deliver to ${pin}` : `${phrase} shipping delivery` });
  }
  if (unverified("job-open")) {
    wanted.push({ query: `${phrase} apply`, freshness: "month" });
  }
  if (unverified("rating") || unverified("review-count")) {
    wanted.push({ query: `${phrase} reviews rating` });
  }

  const seenTexts = new Set(alreadySearched.map((q) => q.toLowerCase().replace(/\s+/g, " ").trim()));
  const plans: SearchPlan[] = [];
  for (const w of wanted) {
    const key = w.query.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 4 || seenTexts.has(key)) continue;
    seenTexts.add(key);
    plans.push({
      query: w.query,
      intent: "general",
      preferredDomains: preferredDomains.length > 0 ? preferredDomains : undefined,
      freshness: w.freshness ?? "any",
      relevanceAnchor: anchor,
    });
    if (plans.length >= 3) break;
  }
  return plans;
}

/** How many NEW pages the verification hop may open (latency guard). */
export const VERIFY_HOP_MAX_URLS = 5;

/* ── Discovery → Live-Entity hop (the recommended NAMES, not the asked one) ─ */

interface CandidateLike {
  phrase: string;
  domains?: string[];
}

/**
 * Registrable-label equality: "amazon.in" vs "www.amazon.in" vs "amazon.in"
 * all say amazon; "in.indeed.com" vs "indeed.com" say indeed. Used to stop a
 * site: query aimed at a channel the candidate was ALREADY read from.
 */
function registrable(hostOrDomain: string): string {
  const parts = hostOrDomain.toLowerCase().replace(/^www\./, "").split(".");
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

/**
 * One query per named-and-unverified candidate. Quoted exact-phrase + the
 * channel the user named — `"Honor 200 5G" site:amazon.in` — so the engine is
 * forced onto THAT product's page on THAT store instead of another listicle
 * about the same topic. With no channel named, `"Honor 200 5G" price buy
 * India` pulls the entity's own commerce pages (India when the prompt is
 * Indian: ₹, "India", a PIN — the reported failure quoted prices for a market
 * the user was actually shopping in).
 *
 * Genre variants keep the pattern universal: job listicles ("apply"), venue
 * lists ("reviews open"). The freshness "month" on job asks is what stops the
 * hop from surfacing a posting that expired between the two hops.
 */
export function planCandidateVerificationHop(
  candidates: CandidateLike[],
  userPrompt: string,
  alreadySearched: string[],
  maxPlans = 3,
): SearchPlan[] {
  if (candidates.length === 0 || maxPlans <= 0) return [];
  const channels = channelsNamedIn(userPrompt);
  const regional = /\b(?:india|indian|inr)\b|₹|\brs\.?\s?\d|\b\d{6}\b/i.test(userPrompt) ? " India" : "";
  const jobAsk = /\b(?:job|jobs|vacanc|hiring|apply|application|internship|recruit)\w*\b/i.test(userPrompt);
  const venueAsk =
    /\b(?:restaurant|restaurants|cafe|cafes|hotel|hotels|resort|doctor|doctors|clinic|hospital|store|shops?|salon|gym|open now|near me|deliver)\b/i.test(userPrompt);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const seen = new Set(alreadySearched.map(norm));
  const plans: SearchPlan[] = [];

  for (const c of candidates) {
    if (plans.length >= maxPlans) break;
    const phrase = c.phrase.replace(/["'`]/g, "").trim();
    if (phrase.length < 3) continue;
    const quoted = `"${phrase}"`;
    const fresh = channels.filter(
      (h) => !(c.domains ?? []).some((d) => registrable(d) === registrable(h)),
    );
    let query: string;
    let freshness: SearchPlan["freshness"] = "any";
    if (fresh.length > 0) {
      query = `${quoted} site:${fresh[0]}`;
    } else if (jobAsk) {
      query = `${quoted} apply${regional}`;
      freshness = "month";
    } else if (venueAsk) {
      query = `${quoted} reviews open${regional}`;
    } else {
      query = `${quoted} price buy${regional}`;
    }
    const key = norm(query);
    if (key.length < 6 || seen.has(key)) continue;
    seen.add(key);
    plans.push({
      query,
      intent: "general",
      preferredDomains: channels.length > 0 ? channels.slice(0, 3) : undefined,
      freshness,
      relevanceAnchor: userPrompt.slice(0, 300),
    });
  }
  return plans;
}
