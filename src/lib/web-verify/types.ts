/**
 * Verification-layer types.
 *
 * The retrieval pipeline (src/lib/web-search/) finds and ranks pages. This
 * layer (src/lib/web-verify/) ADJUDICATES them: what kind of page is this
 * URL, what checkable facts does it actually state, and is the fact about
 * the thing the user asked about. Everything here is deterministic —
 * host/path rules plus regex parsers over the structured facts the
 * extractor already emits. No model calls, no network.
 *
 * WHY this exists (reported failure, 2026-10-21): the assistant handed the
 * user `amazon.in/s?k=honor+200+5g` — a SELLER SEARCH PAGE showing cases
 * and covers — as "the direct product link", asserted availability it had
 * never checked, and printed "~₹16-17K" while its own evidence said
 * ₹18,992 / ₹21,999. Retrieval was fine; adjudication was absent.
 */

/** Deterministic classification of what a source URL IS. */
export type SourceKind =
  /** The item's own page on a seller/store host (`/dp/`, `/products/`). */
  | "product"
  /** A page that lists MANY products (category, collection, browse node). */
  | "product-listing"
  /** Price-comparison / price-history host (its job IS price data). */
  | "price-aggregator"
  /** A single job posting page. */
  | "job-posting"
  /** A search-results page of any kind (engine, seller `/s?k=`, `/job-search`). */
  | "serp"
  /** A place page (Google Maps, OSM, a clinic/restaurant's own place entry). */
  | "poi"
  /** Review/listing site (Justdial, Yelp, TripAdvisor, Zomato). */
  | "review-listing"
  /** Dictionary / encyclopedia / docs / repository. */
  | "reference"
  /** Forum / social (Reddit, Quora, X). */
  | "community"
  /** News or editorial article. */
  | "article"
  | "other";

/** A checkable assertion the answer might make. */
export type ClaimType =
  | "price"
  | "availability"
  | "existence"
  /** "the item's canonical page" — governs which URLs may be presented as THE link */
  | "item-link"
  | "job-open"
  | "rating"
  | "review-count"
  | "open-now"
  | "deliverable-to"
  | "version";

/** Adjudicated status of a claim or of a single source. */
export type ClaimStatus = "verified" | "conflict" | "unverified" | "not-applicable";

/** How much weight a source kind carries for a given claim. */
export type Eligibility =
  /** States the claim authoritatively (the seller's own product page for price/stock). */
  | "primary"
  /** Corroborates but cannot alone settle the claim (a news article's price figure). */
  | "secondary"
  /** Structurally cannot carry this claim (a search page cannot state stock). */
  | "none";

/** A fact parsed out of a page. */
export interface FactHit {
  type: FactType;
  /** Human-readable value, e.g. "₹18,992", "OutOfStock", "4.6 (2,314 reviews)". */
  value: string;
  /** Verbatim snippet the fact was parsed from (≤200 chars) — audit evidence. */
  quote: string;
  /** Set for numeric facts so conflicts can be compared, not string-compared. */
  numeric?: number;
  currency?: string;
  /** Where it came from: structured JSON-LD block vs prose. */
  origin: "structured" | "prose";
}

export type FactType =
  | "price"
  | "availability"
  | "price-valid-until"
  | "rating"
  | "review-count"
  | "open-now"
  | "locality"
  | "deliver-to"
  | "product-name"
  | "job-title"
  | "company"
  | "posted"
  | "version";

/** A fact that was parsed but REJECTED, with the reason (surfaced in verdicts). */
export interface DiscardedFact {
  type: FactType;
  value: string;
  reason:
    | "entity-mismatch"
    | "accessory-listing"
    | "ineligible-source"
    | "non-price-amount"
    | "stale";
}

/** Classification of one source URL. */
export interface LinkClassification {
  kind: SourceKind;
  /** UI-facing name, e.g. "Seller product page", "Seller search page". */
  roleLabel: string;
  /** Short deterministic justification (also useful in logs/tests). */
  reason: string;
}

/** Per-source adjudication — the rows of the Evidence trail card. */
export interface SourceVerdict {
  sourceId: string;
  url: string;
  domain: string;
  title: string;
  kind: SourceKind;
  roleLabel: string;
  status: ClaimStatus;
  /** The line shown under the source, e.g. "Price found and matched to the requested product." */
  verdictLine: string;
  /** What this source can actually support, e.g. "₹18,992" or "product discovery only". */
  supportsLine: string;
  /** Accepted facts (rejected ones are folded into verdictLine/rejections). */
  facts: FactHit[];
  rejections: DiscardedFact[];
}

/** A claim-level verdict computed across all sources. */
export interface ClaimVerdict {
  type: ClaimType;
  status: ClaimStatus;
  /** Verified values (or BOTH values when status === "conflict"). */
  values: string[];
  sourceIds: string[];
  /** One-line justification used in the <verification> prompt block. */
  line: string;
  note?: string;
}

/** The single canonical page the answer is allowed to present as "the link". */
export interface VerifiedLink {
  url: string;
  sourceId: string;
  roleLabel: string;
}

/** Everything the verification stage knows about one turn. */
export interface VerificationLedger {
  scenario: string;
  /** Intent label for the turn header, e.g. "Price check". */
  taskLabel: string;
  /** Lucide icon id chosen deterministically from the scenario. */
  icon: string;
  /** Entity the facts are bound to ("honor 200 5g"). */
  entity: string;
  claims: ClaimVerdict[];
  sources: SourceVerdict[];
  /** URLs the answer may present as the item itself (never a SERP page). */
  itemLinks: VerifiedLink[];
}

/**
 * Compact wire form sent to the browser in `X-Web-Ledger` and stored on
 * Message.webLedger. Quotes (the audit evidence) are dropped — they stay
 * server-side for /api/verify-claims.
 */
export interface LedgerWire {
  scenario: string;
  taskLabel: string;
  icon: string;
  entity: string;
  claims: { type: ClaimType; status: ClaimStatus; values: string[]; sourceIds: string[] }[];
  sources: {
    sourceId: string;
    kind: SourceKind;
    roleLabel: string;
    status: ClaimStatus;
    verdictLine: string;
    supportsLine: string;
  }[];
  itemLinks: VerifiedLink[];
}
