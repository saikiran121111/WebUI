/**
 * Entity validation — the universal "does this thing exist, and is it STILL
 * real right now?" pass.
 *
 * This is deliberately a FAÇADE, not a second parser. URL shape comes from
 * `web-verify/link-eligibility` and facts come from `web-verify/fact-ledger`,
 * both already regression-locked (67 tests). What this module adds on top is
 * the two things retrieval never produced:
 *
 *   1. a UNIVERSAL STATUS folded from schema.org enums, JSON-LD dates and the
 *      plain-English sentences sites use when something is gone —
 *      `AVAILABLE` / `OUT_OF_STOCK` / `CLOSED_OR_EXPIRED` / `MEDIA_UNAVAILABLE`
 *      / `UNKNOWN` — across genres (products, jobs, places, videos, books,
 *      anime, movies, repos);
 *   2. a machine-readable BANNER per source that the reranker prepends to that
 *      source's first chunk, so the main model cannot read a ₹255 back cover
 *      as the phone, a `/s?k=` search URL as a product page, or an expired
 *      posting as an opening. The banner is also what lets the second hop of a
 *      Discovery → Live-Entity-Verification pass aim at the entity pages that
 *      are still missing: `web-verify/candidate-entities.ts` reads candidate
 *      NAMES out of SEARCH_OR_CATEGORY_PAGE / EDITORIAL_LISTICLE reports and
 *      `canonicalCovering` asks these same reports whether a candidate's own
 *      page is already in the set (`pipeline.ts` wires the two).
 *
 * Deterministic: no model calls, no network, ~ms per source.
 */
import type { EvidencePacket } from "./types";
import type { DiscardedFact, FactHit, SourceKind } from "../web-verify/types";
import { canBeTheItem, classifyUrl } from "../web-verify/link-eligibility";
import {
  NEGATIVE_AVAILABILITY,
  POSITIVE_AVAILABILITY,
  collectSourceFacts,
  type AvailabilityState,
  type SourceFactSet,
} from "../web-verify/fact-ledger";
import { type EntityMatcher } from "../web-verify/entity";
import { accessoryPhraseIn } from "../web-verify/accessory-phrase";
export { ACCESSORY_PHRASES } from "../web-verify/accessory-phrase";

/* ── the universal vocabulary ────────────────────────────────────────────── */

export type EntityStatus =
  | "AVAILABLE"
  | "OUT_OF_STOCK"
  | "CLOSED_OR_EXPIRED"
  | "MEDIA_UNAVAILABLE"
  | "UNKNOWN";

export type UrlType =
  | "CANONICAL_ENTITY"
  | "SEARCH_OR_CATEGORY_PAGE"
  | "EDITORIAL_LISTICLE"
  | "REFERENCE_PAGE"
  | "OTHER";

/** Live facts pulled out of the page, genre-agnostic. */
export interface EntityFactView {
  price?: string;
  priceNumeric?: number;
  currency?: string;
  priceValidUntil?: string;
  rating?: string;
  reviewCount?: string;
  datePublished?: string;
  datePosted?: string;
  validThrough?: string;
  jobStatus?: string;
  author?: string;
  organization?: string;
  productName?: string;
  jobTitle?: string;
  locality?: string;
  version?: string;
  openHours?: string;
}

export interface EntityValidationReport {
  sourceId: string;
  url: string;
  domain: string;
  title: string;
  /** The ledger's host+path classification, kept for the trail card. */
  kind: SourceKind;
  roleLabel: string;
  urlType: UrlType;
  status: EntityStatus;
  /** The enum or the sentence that decided the status (never a guess). */
  statusEvidence?: string;
  /** The phone-case trap: this page is about an accessory / a different item. */
  isAccessoryOrMismatch: boolean;
  mismatchReason?: string;
  entityMatched: boolean;
  hasStructured: boolean;
  internalConflict: boolean;
  facts: EntityFactView;
  /** Full accepted facts + everything seen-but-refused, for the trail card. */
  detailFacts: FactHit[];
  rejections: DiscardedFact[];
  /** Safe to present as "the item itself" (never a search page). */
  canBeItemLink: boolean;
  /** Discovery-only source: useful for names, cannot settle live state alone. */
  discoveryOnly: boolean;
  /** The line the reranker prepends. */
  banner: string;
}

/* ── "it is gone" detectors (the whole point of this module) ─────────────── */

/**
 * Phrases that mean the entity behind a page no longer exists in the state the
 * user needs. Ordered specific → generic; every pattern carries the literal
 * text it matched, because a status with no evidence is just a guess.
 */
export const CLOSED_OR_EXPIRED_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bno longer accepting applications?\b/i, label: "No longer accepting applications" },
  { re: /\bapplications?\s+(?:are\s+)?(?:now\s+)?closed\b/i, label: "Applications closed" },
  {
    re: /\b(?:job|posting|listing|position|vacancy|role|opening)\b[^.!?|]{0,48}\bno longer (?:available|active|open|listed|posted|accepting)\b/i,
    label: "Posting no longer available",
  },
  { re: /\bjob\b[^.!?|]{0,24}\b(?:has\s+|is\s+|was\s+)?expired\b/i, label: "Job expired" },
  {
    re: /\b(?:position|vacancy|role)\b[^.!?|]{0,24}\b(?:filled|closed|withdrawn|cancelled|canceled|taken)\b/i,
    label: "Position closed",
  },
  { re: /\bpermanently closed\b/i, label: "Permanently closed" },
  { re: /\btemporarily closed\b/i, label: "Temporarily closed" },
  { re: /\bno longer in business\b/i, label: "No longer in business" },
  { re: /\b(?:has|have|was|were)\s+been\s+(?:closed|shut down)\b/i, label: "Closed down" },
  { re: /\blisting\s+(?:has\s+)?(?:expired|removed|deleted)\b/i, label: "Listing expired" },
  { re: /\b(?:event|ticket)\s+(?:is\s+)?(?:sold out|past|ended|cancelled|canceled)\b/i, label: "Event over" },
];

/**
 * A page that came back as an error or a tombstone. Gated to canonical entity
 * URLs: "no results found" on a SERP is normal, "404" on the product page the
 * user was told to buy from is the finding.
 */
export const REMOVED_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b404\b[\s\S]{0,24}?\bnot found\b/i, label: "Page not found (404)" },
  { re: /\bpage not found\b/i, label: "Page not found" },
  { re: /\bsorry[,!]?\s*(?:we )?(?:couldn'?t|could not|can'?t|cannot) find\b/i, label: "Page not found" },
  { re: /\bthe item you wanted to view isn'?t available\b/i, label: "Item no longer available" },
  {
    re: /\b(?:item|product|listing|video|page|profile)\b[^.!?|]{0,28}\b(?:has been|was)\s+(?:removed|deleted)\b/i,
    label: "Removed",
  },
];

/** Video / media that will not play. Covers raw `ytInitialPlayerResponse` too:
 *  playability lives in inline JS, never in JSON-LD, so a JSON-LD-only reader
 *  would call an unplayable video playable. */
export const MEDIA_UNAVAILABLE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bvideo unavailable\b/i, label: "Video unavailable" },
  { re: /\bthis video is (?:private|no longer available|not available)\b/i, label: "Video not available" },
  { re: /\bthe uploader has not made this video available\b/i, label: "Removed by uploader" },
  { re: /\bthis video has been removed\b/i, label: "Video removed" },
  {
    re: /\bvideo\s+(?:is\s+)?(?:currently\s+)?unavailable\s+in\s+(?:your\s+)?(?:country|location|region)\b/i,
    label: "Video unavailable in region",
  },
  { re: /\bsign in to confirm (?:that )?you'?re not a bot\b/i, label: "Playback blocked" },
];
/** Raw-HTML playability probe (YouTube and friends inline their player state). */
const PLAYABILITY_RE =
  /playabilityStatus[\s\S]{0,400}?"status"\s*:\s*"(?!(?:OK|CONTENT_TRANSIENT)\b)([A-Z][A-Z_]{2,})"/i;

const MEDIA_HOSTS = [
  "youtube", "youtu.be", "music.youtube", "vimeo", "dailymotion", "twitch",
  "netflix", "primevideo", "hotstar", "jiohotstar", "disneyplus", "crunchyroll",
  "funimation", "hulu", "paramountplus", "sonyliv", "jio", "max", "hbomax",
  "spotify", "soundcloud", "apple", "play.google", "imdb", "myanimelist",
  "animelist", "kitsu", "anidb", "letterboxd", "rottentomatoes", "tmdb",
  "goodreads", "openlibrary", "google",
];
const VENUE_HOSTS = [
  "zomato", "justdial", "tripadvisor", "yelp", "magicpin", "swiggy", "google",
  "maps.google", "makemytrip", "goibibo", "oye", "yatra", "fabhotels",
];

/** The kinds whose own pages state availability, so prose is admissible. */
const STATE_BEARING_KINDS = new Set<SourceKind>([
  "product", "product-listing", "job-posting", "poi", "review-listing",
]);

function matchedLabel(patterns: { re: RegExp; label: string }[], text: string): string | null {
  for (const p of patterns) if (p.re.test(text)) return p.label;
  return null;
}

export function detectMediaUnavailable(text: string): string | null {
  const byPhrase = matchedLabel(MEDIA_UNAVAILABLE_PATTERNS, text);
  if (byPhrase) return byPhrase;
  const play = text.match(PLAYABILITY_RE);
  if (play) return `playabilityStatus=${play[1]}`;
  return null;
}

export function detectClosedOrExpired(text: string, kind: SourceKind): string | null {
  const byPhrase = matchedLabel(CLOSED_OR_EXPIRED_PATTERNS, text);
  if (byPhrase) return byPhrase;
  if (STATE_BEARING_KINDS.has(kind)) {
    const gone = matchedLabel(REMOVED_PATTERNS, text);
    if (gone) return gone;
  }
  return null;
}

/** A `validThrough` in the past closes a posting even if the page still shows
 *  an "Apply" button — the page is stale, the deadline is not. */
export function expiredByDate(validThrough: string | undefined, today: Date): boolean {
  if (!validThrough) return false;
  const t = Date.parse(validThrough);
  if (Number.isNaN(t)) return false;
  return t < today.getTime();
}

/* ── URL type (the spec's canonical / search-page / listicle split) ──────── */

/**
 * Canonical pages for genres the e-commerce host table never covered: video,
 * streaming, books, anime, film, restaurant. Promotion happens HERE rather than
 * in `link-eligibility`'s kind matrix so the already-locked eligibility rules
 * (and their tests) stay untouched.
 */
const CANONICAL_URL_PATTERNS: {
  re: RegExp;
  label: string;
  media?: boolean;
  /** Set when the path shape is only meaningful on that genre's own hosts. */
  hosts?: string[];
}[] = [
  // Matched against PATH + QUERY (the host is checked separately), so these are
  // path-anchored. `v=` is usually the first parameter (`/watch?v=…`), so the
  // segment before it must be optional — requiring a separator swallowed the one
  // canonical form. Host-gated because `/watch/…` on other hosts means nothing.
  { re: /^\/watch\?(?:[^#\s]*[&?])?v=[A-Za-z0-9_-]{6,}/i, label: "YouTube video", media: true, hosts: ["youtube"] },
  { re: /^\/[A-Za-z0-9_-]{11}$/i, label: "YouTube video", media: true, hosts: ["youtu.be"] },
  { re: /^\/title\/[tn]t\d{7,}/i, label: "IMDb title", media: true },
  { re: /^\/(?:anime|manga)\/\d{4,}/i, label: "MyAnimeList entry", media: true },
  { re: /^\/books\/OL\d+[AWM]/i, label: "Open Library work" },
  { re: /^\/book\/(?:show|detail)\/\d{6,}/i, label: "Goodreads work", hosts: ["goodreads"] },
  { re: /^\/(?:title|watch)\/[a-z0-9][a-z0-9\-_.]{4,}/i, label: "Streaming title", media: true, hosts: ["netflix", "primevideo", "hotstar", "jiohotstar", "disneyplus", "crunchyroll", "funimation", "hulu", "paramountplus", "sonyliv", "max", "hbomax", "apple"] },
  { re: /^\/[a-z-]+\/[a-z0-9-]*(?:restaurant|cafe|bar|clinic|doctors?|doctor|hotel|spa)-[a-z0-9-]+/i, label: "Venue page", hosts: VENUE_HOSTS },
  // Deliberately NO bare `/city/<long-slug>` rule here: on Justdial/Zomato that
  // shape is a category page (/bengaluru/restaurants-in-bengaluru), and the
  // whole point of this table is to stop calling a category page the item.
];

/**
 * Same label-set matching as `link-eligibility.hostHas`: these lists hold bare
 * registrable names ("goodreads", "netflix"), and `www.goodreads.com` ends with
 * ".com" — never with ".goodreads", so a suffix test matched nothing.
 */
function hostIn(host: string, list: string[]): boolean {
  const labels = host.split(".").filter((l) => l !== "www" && l !== "m");
  return list.some((h) =>
    h.includes(".") ? host === h || host.endsWith("." + h) : labels.includes(h),
  );
}

function canonicalUrlMatch(url: string): { label: string; media: boolean } | null {
  let path = url;
  let host = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^(?:www|m)\./, "");
    path = u.pathname + u.search;
  } catch {
    /* relative or malformed — match on the raw string */
  }
  for (const p of CANONICAL_URL_PATTERNS) {
    if (!p.re.test(path)) continue;
    // Id-bearing shapes (/title/tt1234567, /anime/1234567, /books/OL7204917A)
    // are unambiguous on any host; the loose ones (/watch/…, /city/slug-venue)
    // are only accepted on the hosts that own them, or an ordinary article URL
    // would be promoted to "the entity page".
    if (p.hosts && !hostIn(host, p.hosts)) continue;
    return { label: p.label, media: !!p.media };
  }
  return null;
}

/** SourceKind → the spec's three public buckets (+ reference/other). */
export function urlTypeOf(kind: SourceKind): UrlType {
  switch (kind) {
    case "product":
    case "job-posting":
    case "poi":
      return "CANONICAL_ENTITY";
    case "serp":
    case "product-listing":
    case "review-listing":
      return "SEARCH_OR_CATEGORY_PAGE";
    case "article":
    case "community":
    case "price-aggregator":
      return "EDITORIAL_LISTICLE";
    case "reference":
      return "REFERENCE_PAGE";
    default:
      return "OTHER";
  }
}

/* ── accessory / wrong-item detection ────────────────────────────────────── */

// The phrase list and its matcher live in `web-verify/accessory-phrase` so the
// fact ledger applies the SAME rule when it decides whether a page's facts may
// be bound to the entity at all. Stricter than `entity.ts` ACCESSORY_MARKERS on
// purpose: a bare "screen" or "case" appears inside perfectly good product
// names ("6.7 inch Curved Screen"), and the live deals rail proves a real phone
// page also carries "Back Cover" tiles in its body — so the phrase scan runs
// only over subject-bearing strings (title, structured name, URL slug).

/* ── fact view (JSON-LD / meta / DOM all land in the same structured block) ─ */

function structuredLine(text: string, label: string): string | undefined {
  const m = text.match(new RegExp("^" + label + ":\\s*(.+)$", "im"));
  return m ? m[1].trim().slice(0, 200) : undefined;
}

function structuredWorkName(text: string): string | undefined {
  const m = text.match(
    /^##\s+(Product|ProductGroup|Job|Article|Video|VideoObject|LocalBusiness|Organization|Person|TVSeries|Movie|Book|Recipe|Event|Course):\s*(\S.*)$/im,
  );
  return m ? m[2].trim().slice(0, 160) : undefined;
}

const firstFact = (set: SourceFactSet, type: FactHit["type"]): FactHit | undefined =>
  set.facts.find((f) => f.type === type);

function factsOf(set: SourceFactSet, text: string): EntityFactView {
  const price = firstFact(set, "price");
  const rating = firstFact(set, "rating");
  const reviews = firstFact(set, "review-count");
  const posted = firstFact(set, "posted")?.value ?? structuredLine(text, "Posted");
  const published =
    structuredLine(text, "Published") ??
    structuredLine(text, "Uploaded") ??
    structuredLine(text, "Date published");
  const view: EntityFactView = {};
  if (price?.value) {
    view.price = price.value;
    if (typeof price.numeric === "number") view.priceNumeric = price.numeric;
    if (price.currency) view.currency = price.currency;
  }
  const until = firstFact(set, "price-valid-until")?.value ?? structuredLine(text, "Price valid until");
  const count = reviews?.value?.match(/\d[\d,]*/)?.[0];
  // The ledger only reads "(N reviews)". A film/anime/database page states
  // "(487,213 votes)" or "(1.3M ratings)" — same fact, different noun, so the
  // structured line is the fallback rather than losing the rating outright.
  view.rating = rating?.value ?? structuredLine(text, "Rating");
  view.reviewCount = count ? count.replace(/,/g, "") : undefined;
  view.priceValidUntil = until;
  view.datePublished = published;
  view.datePosted = posted;
  view.validThrough = structuredLine(text, "Valid through");
  view.jobStatus = structuredLine(text, "Job status");
  view.author = structuredLine(text, "By") ?? structuredLine(text, "Author");
  view.organization =
    firstFact(set, "company")?.value ??
    structuredLine(text, "Company") ??
    structuredLine(text, "Channel") ??
    structuredLine(text, "Publisher") ??
    // For a video or a work there is no company line — the uploader/creator IS
    // the responsible party, and the banner would otherwise print no attribution
    // at all for the genres the user asks about most ("who published this").
    view.author;
  view.productName = firstFact(set, "product-name")?.value ?? structuredWorkName(text);
  view.jobTitle = firstFact(set, "job-title")?.value;
  view.locality = firstFact(set, "locality")?.value ?? structuredLine(text, "Location");
  view.version = firstFact(set, "version")?.value ?? structuredLine(text, "Version");
  view.openHours = firstFact(set, "open-now")?.value ?? structuredLine(text, "Hours");
  return view;
}

/* ── status resolution ───────────────────────────────────────────────────── */

/**
 * schema.org's `jobStatus` arrives as a CamelCase enum, sometimes still namespaced
 * ("https://schema.org/JobPositionClosed"). Word-boundary tests can never match
 * inside CamelCase, so the enum is split into plain words before it is tested.
 */
function normalizeJobStatus(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

function resolveStatus(
  kind: SourceKind,
  urlType: UrlType,
  set: SourceFactSet,
  facts: EntityFactView,
  text: string,
  today: Date,
  canonical: { label: string; media: boolean } | null,
  extraction: EvidencePacket["extraction"],
): { status: EntityStatus; evidence?: string } {
  const closed = detectClosedOrExpired(text, kind);
  if (closed) return { status: "CLOSED_OR_EXPIRED", evidence: closed };

  if (expiredByDate(facts.validThrough, today)) {
    return { status: "CLOSED_OR_EXPIRED", evidence: `valid through ${facts.validThrough}` };
  }
  // schema.org's own values arrive CamelCase ("JobPositionClosed", and the
  // fixture path may still carry the `https://schema.org/` prefix). A `\bclosed\b`
  // test can never match inside CamelCase, so the enum is split into words first.
  // Negative tested first, so JobPositionClosed can never fall through to open.
  const jobStatus = normalizeJobStatus(facts.jobStatus);
  if (jobStatus && /\b(closed|filled|terminated|cancelled|canceled|withdrawn|on leave)\b/.test(jobStatus)) {
    return { status: "CLOSED_OR_EXPIRED", evidence: `job status: ${facts.jobStatus}` };
  }
  if (jobStatus && /\b(job ?opening|position open|^open)\b/.test(jobStatus)) {
    return { status: "AVAILABLE", evidence: `job status: ${facts.jobStatus}` };
  }

  const media = detectMediaUnavailable(text);
  if (media) return { status: "MEDIA_UNAVAILABLE", evidence: media };

  const unavailableFact = set.facts.find(
    (f) => f.type === "availability" && set.availability === "unavailable",
  );
  if (set.availability === "unavailable") {
    return {
      status: "OUT_OF_STOCK",
      evidence: unavailableFact?.value ?? "unavailable",
    };
  }
  // A POSITIVE statement of stock only ever belongs to a page that IS the
  // entity. On a search-results or category page ("Only 3 left in stock" for
  // one of forty listings, an aggregate `Availability: InStock`) it describes
  // somebody else's inventory — and reading it as "the thing you asked about is
  // available" is how an unavailable phone got recommended. A NEGATIVE note is
  // kept: it can only ever make the answer more careful.
  const entitySpecificState = urlType !== "SEARCH_OR_CATEGORY_PAGE";
  if (set.availability && entitySpecificState) {
    const f = set.facts.find((x) => x.type === "availability");
    return { status: "AVAILABLE", evidence: f?.value ?? set.availability };
  }

  // No structured availability: fall back to the page's own English, but only
  // for the kinds that actually carry stock/open state and only when the page
  // is about the asked-for entity. A listicle's "Out of stock" note describes
  // somebody else's inventory at somebody else's date.
  if (STATE_BEARING_KINDS.has(kind) || urlType === "CANONICAL_ENTITY") {
    const neg = text.match(NEGATIVE_AVAILABILITY);
    if (neg) return { status: "OUT_OF_STOCK", evidence: neg[0] };
    if (set.entityMatched && entitySpecificState) {
      const pos =
        text.match(POSITIVE_AVAILABILITY) ??
        (kind === "job-posting"
          ? text.match(/\b(?:easy apply|apply now|now hiring|actively (?:hiring|recruiting)|opening[s]?)\b/i)
          : null) ??
        text.match(/\bopen now\b/i);
      if (pos) return { status: "AVAILABLE", evidence: pos[0] };
    }
  }
  // The positive media case. YouTube and friends state "Video unavailable" ON
  // the page when playback is dead, so a direct read of a canonical watch/
  // title URL that carries no such notice is the evidence that it plays. A
  // snippet-only read gets no such credit — it never saw the player.
  if (canonical?.media && extraction === "direct") {
    return { status: "AVAILABLE", evidence: `${canonical.label} read directly, no unavailability notice` };
  }
  return { status: "UNKNOWN" };
}

/* ── the report ──────────────────────────────────────────────────────────── */

export interface ValidateOptions {
  today?: Date;
}

export function validatePacket(
  packet: EvidencePacket,
  entity: EntityMatcher,
  opts: ValidateOptions = {},
): EntityValidationReport {
  const today = opts.today ?? new Date();
  const text = (packet.passages ?? [])
    .map((p) => String(p.passageText ?? ""))
    .join("\n")
    .slice(0, 20_000);

  const set = collectSourceFacts(packet, entity, {
    accessoryAsk: entity.accessoryAsk === true,
    today,
  });
  const cls = classifyUrl(packet.url);
  const canonical = canonicalUrlMatch(packet.url);

  let urlType = urlTypeOf(cls.kind);
  // An id-shaped canonical URL outranks whatever generic bucket the eligibility
  // table handed it (IMDb's `/title/tt…` reads as an "article", a YouTube watch
  // page as "other"). A SEARCH/CATEGORY page is the one thing that must never be
  // promoted — that mislabel is exactly how `/s?k=` reached the user as "the
  // direct product link".
  if (canonical && urlType !== "SEARCH_OR_CATEGORY_PAGE") urlType = "CANONICAL_ENTITY";

  const facts = factsOf(set, text);
  const { status, evidence } = resolveStatus(
    cls.kind, urlType, set, facts, text, today, canonical, packet.extraction,
  );

  // Two ways into "this page is not the product the user asked about": the page's
  // OWN title/work-name/slug names an accessory phrase, or (cross-source, see
  // applyCrossSourceChecks) its price is an order of magnitude under the entity's
  // own listing. Deliberately NOT the ledger's `accessory-listing` rejection:
  // that is driven by `entity.ts` ACCESSORY_MARKERS — single words ("case",
  // "cover", "screen") that exist to BIND an entity to a page and that appear
  // inside genuine listings too ("6.7 inch Curved Screen"). Stamping on those
  // alone throws away a good in-stock product page.
  const phrase = accessoryPhraseIn(packet.title, structuredWorkName(text), packet.url);
  const titledAsAccessory = !!phrase && urlType === "CANONICAL_ENTITY" && set.entityMatched;
  const isAccessoryOrMismatch = !entity.accessoryAsk && titledAsAccessory;
  const mismatchReason = isAccessoryOrMismatch
    ? phrase
      ? `page is titled as an accessory (${phrase})`
      : "accessory listing"
    : undefined;

  const canBeItemLink = canBeTheItem(cls.kind) || (!!canonical && status !== "MEDIA_UNAVAILABLE");
  const discoveryOnly =
    urlType === "SEARCH_OR_CATEGORY_PAGE" ||
    urlType === "EDITORIAL_LISTICLE" ||
    urlType === "REFERENCE_PAGE";

  const report: EntityValidationReport = {
    sourceId: packet.sourceId,
    url: packet.url,
    domain: packet.domain,
    title: packet.title,
    kind: cls.kind,
    roleLabel: cls.roleLabel,
    urlType,
    status,
    statusEvidence: evidence,
    isAccessoryOrMismatch,
    mismatchReason,
    entityMatched: set.entityMatched,
    hasStructured: set.hasStructured,
    internalConflict: set.internalConflict,
    facts,
    detailFacts: set.facts,
    rejections: set.rejections,
    canBeItemLink,
    discoveryOnly,
    banner: "",
  };
  report.banner = bannerFor(report);
  return report;
}

export function validatePackets(
  packets: EvidencePacket[],
  entity: EntityMatcher,
  opts: ValidateOptions = {},
): EntityValidationReport[] {
  const reports = packets.map((p) => validatePacket(p, entity, opts));
  applyCrossSourceChecks(reports, entity.accessoryAsk === true);
  for (const r of reports) r.banner = bannerFor(r);
  return reports;
}

/**
 * The price trap the user asked for: "₹199–₹599 for a ₹15,000–₹20,000 phone".
 * A category anchor is built from the entity-matched product prices in this
 * very run; anything an order of magnitude under it, on a product page, is not
 * the phone — whatever its title claims.
 */
export function applyCrossSourceChecks(reports: EntityValidationReport[], accessoryAsk: boolean): void {
  const anchors = reports
    .filter((r) => !r.isAccessoryOrMismatch && r.entityMatched && r.kind === "product")
    .map((r) => r.facts.priceNumeric)
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (!anchors.length) return;
  const anchor = Math.max(...anchors);
  if (anchor < 500) return; // no meaningful "category floor" on cheap items
  for (const r of reports) {
    if (r.isAccessoryOrMismatch || accessoryAsk || r.kind !== "product") continue;
    const own = reportsPrice(r);
    if (!own) continue;
    if (own < anchor * 0.1) {
      r.isAccessoryOrMismatch = true;
      r.mismatchReason = `price outlier (${money(own)} against ${money(anchor)} on the entity's own listing)`;
    }
  }
}

function reportsPrice(r: EntityValidationReport): number | undefined {
  const prices = r.detailFacts.filter((f) => f.type === "price" && typeof f.numeric === "number");
  if (!prices.length) return undefined;
  return Math.max(...prices.map((p) => p.numeric as number));
}

function money(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/* ── the banner the reranker prepends ────────────────────────────────────── */

const STATUS_TAG: Record<EntityStatus, string> = {
  AVAILABLE: "AVAILABLE",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  CLOSED_OR_EXPIRED: "EXPIRED_OR_CLOSED",
  MEDIA_UNAVAILABLE: "MEDIA_UNAVAILABLE",
  UNKNOWN: "STATE_UNVERIFIED",
};

// Keyed by EntityStatus, NOT by the display tag below — `CLOSED_OR_EXPIRED`
// prints as `EXPIRED_OR_CLOSED`, and keying by the tag silently lost the
// warning half of every closed/expired banner.
const WARNING: Record<EntityStatus, string> = {
  AVAILABLE: "",
  OUT_OF_STOCK: "DO NOT RECOMMEND AS AVAILABLE",
  CLOSED_OR_EXPIRED: "DO NOT LIST AS OPEN / CURRENT",
  MEDIA_UNAVAILABLE: "DO NOT LINK AS PLAYABLE",
  UNKNOWN: "DO NOT ASSERT PRICE, STOCK OR OPENING FROM THIS PAGE",
};

/** One machine-readable line, ≤ ~300 chars, safe to put in front of a chunk. */
export function bannerFor(r: EntityValidationReport): string {
  const parts: string[] = [];
  const type = r.isAccessoryOrMismatch
    ? `ACCESSORY_MISMATCH${r.mismatchReason ? ` (${r.mismatchReason})` : ""}`
    : r.urlType;
  parts.push(`type=${type}`);
  const statusTag = STATUS_TAG[r.status];
  parts.push(
    `status=${statusTag}${r.statusEvidence ? ` (${clip(r.statusEvidence, 60)})` : ""}`,
  );
  if (r.facts.price) parts.push(`price=${r.facts.price}`);
  if (r.facts.rating) parts.push(`rating=${r.facts.rating}`);
  if (r.facts.reviewCount) parts.push(`reviews=${r.facts.reviewCount}`);
  if (r.facts.datePosted) parts.push(`posted=${r.facts.datePosted}`);
  if (r.facts.datePublished) parts.push(`published=${r.facts.datePublished}`);
  if (r.facts.validThrough) parts.push(`validThrough=${r.facts.validThrough}`);
  if (r.facts.author) parts.push(`author=${clip(r.facts.author, 40)}`);
  if (r.facts.organization) parts.push(`org=${clip(r.facts.organization, 40)}`);
  if (r.facts.locality) parts.push(`place=${clip(r.facts.locality, 40)}`);
  if (r.facts.jobTitle) parts.push(`job=${clip(r.facts.jobTitle, 48)}`);
  if (r.facts.productName) parts.push(`item=${clip(r.facts.productName, 48)}`);
  if (r.entityMatched) parts.push("entity-matched=yes");
  parts.push(`url=${clip(r.url, 110)}`);

  // The suffixes stack instead of crowding each other out. A seller SEARCH page
  // that also carries accessory prices has to say BOTH — losing the "never link
  // this" half is exactly how the `/s?k=` link reached the user.
  const suffixes: string[] = [];
  if (r.discoveryOnly) {
    suffixes.push(
      r.urlType === "SEARCH_OR_CATEGORY_PAGE"
        ? "DISCOVERY ONLY — NEVER PRESENT AS A DIRECT PRODUCT / JOB / PLACE LINK"
        : "SECONDARY SOURCE — CANNOT ESTABLISH LIVE PRICE OR STOCK ALONE",
    );
  }
  if (r.isAccessoryOrMismatch) suffixes.push("NOT THE MAIN PRODUCT");
  const warn = WARNING[r.status];
  if (warn) suffixes.push(warn);
  else if (r.status === "AVAILABLE" && !r.discoveryOnly) {
    suffixes.push("SAFE TO RECOMMEND (live state read from this page)");
  }
  return "[VERIFIED SOURCE STATE: " + parts.join(" | ") + "]" + (suffixes.length ? " " + suffixes.join(" ") : "");
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

/* ── rerank policy (the reranker consumes these, not the rules themselves) ─ */

/** Verified canonical + live = the source the answer should be built from. */
export function rerankMultiplier(r: EntityValidationReport): number {
  if (r.isAccessoryOrMismatch) return 0.2; // −80%
  if (r.urlType === "CANONICAL_ENTITY" && r.status === "AVAILABLE") return 1.35; // +35%
  if (r.status === "OUT_OF_STOCK" || r.status === "CLOSED_OR_EXPIRED" || r.status === "MEDIA_UNAVAILABLE") {
    // Kept visible on purpose: the model has to be able to EXCLUDE or WARN
    // about it. The chunk cap below is what stops it filling the answer up.
    return 1;
  }
  return 1;
}

/** Bad state is stated once, never repeated across every chunk of a page. */
export function maxChunksFor(r: EntityValidationReport): number {
  return r.status === "OUT_OF_STOCK" ||
    r.status === "CLOSED_OR_EXPIRED" ||
    r.status === "MEDIA_UNAVAILABLE" ||
    r.isAccessoryOrMismatch
    ? 1
    : Number.POSITIVE_INFINITY;
}

export function isNegativeStatus(status: EntityStatus): boolean {
  return status === "OUT_OF_STOCK" || status === "CLOSED_OR_EXPIRED" || status === "MEDIA_UNAVAILABLE";
}

/** Source ids whose verified state must never be recommended as actionable. */
export function blockedSourceIds(reports: EntityValidationReport[]): string[] {
  return reports
    .filter((r) => isNegativeStatus(r.status) || r.isAccessoryOrMismatch)
    .map((r) => r.sourceId);
}

export type { AvailabilityState };
