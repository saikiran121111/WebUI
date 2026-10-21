/**
 * Fact ledger: turn retrieved pages into adjudicable facts.
 *
 * The extractor already emits a machine-readable block per page
 * (`[Structured Page Facts]` → `## Product: <name>` + `Price:` /
 * `Availability:` / `Price valid until:` / `Rating:`, `## Job:` + `Posted:`),
 * and the reranker protects that block atomically. This module PARSES it
 * (plus prose patterns) and — critically — BINDS each fact to the entity the
 * user asked about, so a case-cover page's ₹255 can never be quoted as the
 * phone's price and a "Currently unavailable" label from a different listing
 * can never settle this one's stock.
 *
 * Deterministic: regex + rules, no model, no network. Anything the parser
 * cannot bind is recorded as a REJECTION with a reason, which is what the
 * Evidence-trail "Supports:" lines and the eval script report on.
 */
import type { EvidencePacket } from "../web-search/types";
import { classifyUrl } from "./link-eligibility";
import { type EntityMatcher } from "./entity";
import { accessoryPhraseIn, hasAccessoryPhrase } from "./accessory-phrase";
import type { DiscardedFact, FactHit, FactType, SourceKind } from "./types";

/** Canonical availability vocabulary (structured enums + prose map onto it). */
export type AvailabilityState =
  | "in-stock"
  | "limited"
  | "preorder"
  | "unavailable"
  | "unknown";

const AVAILABILITY_MAP: Record<string, { state: AvailabilityState; value: string }> = {
  instock: { state: "in-stock", value: "In stock" },
  in_stock: { state: "in-stock", value: "In stock" },
  available: { state: "in-stock", value: "In stock" },
  availableinstore: { state: "in-stock", value: "In-store only" },
  instoreonly: { state: "in-stock", value: "In-store only" },
  onlineonly: { state: "in-stock", value: "Online only" },
  limitedavailability: { state: "limited", value: "Limited stock" },
  onlyafewleft: { state: "limited", value: "Limited stock" },
  preorder: { state: "preorder", value: "Pre-order" },
  presale: { state: "preorder", value: "Pre-order" },
  backorder: { state: "preorder", value: "Back-order" },
  outofstock: { state: "unavailable", value: "Out of stock" },
  out_stock: { state: "unavailable", value: "Out of stock" },
  soldout: { state: "unavailable", value: "Sold out" },
  discontinued: { state: "unavailable", value: "Discontinued" },
  unavailable: { state: "unavailable", value: "Currently unavailable" },
  nocopies: { state: "unavailable", value: "Unavailable" },
};

/** Prose availability patterns. Negative patterns are tested FIRST — the
 *  reported bug was a page reading "Currently unavailable" being reported as
 *  available because a positive substring ("available") matched first. */
export const NEGATIVE_AVAILABILITY =
  /\b(currently unavailable|not available(?: for (?:sale|purchase|shipping))?|no longer (?:available|sold|sold out)|out of stock|sold out|not in stock|unavailable|temporarily (?:unavailable|out of stock)|discontinued|does not ship|we do not ship)\b/i;
export const POSITIVE_AVAILABILITY =
  /\b(in stock(?: and ready to ship)?|currently available|available now|available for (?:sale|purchase|preorder)|only \d+ (?:left|in stock|copies|items left)|ready to ship|in stock)\b/i;
const PREORDER_AVAILABILITY = /\b(pre-?order(?:ing)?|back-?order(?:ed)?|coming soon|launches? on)\b/i;

export interface FactOptions {
  /** The user asked about an accessory (case/cover/charger) — accessory pages are then the entity. */
  accessoryAsk: boolean;
  /** Injectable for tests. */
  today?: Date;
}

export interface SourceFactSet {
  sourceId: string;
  url: string;
  domain: string;
  title: string;
  kind: SourceKind;
  roleLabel: string;
  /** Accepted facts. */
  facts: FactHit[];
  /** Facts seen but refused, with the reason — drives the trail verdict. */
  rejections: DiscardedFact[];
  /** Did this page actually name the entity the user asked about? */
  entityMatched: boolean;
  /** Did the page carry a parseable `[Structured Page Facts]` block? */
  hasStructured: boolean;
  /** Name from the entity-shaped structured block, when present. */
  structuredName?: string;
  /** Availability folded from all accepted availability facts. */
  availability?: AvailabilityState;
  /** True when accepted facts contradict each other (two different stock states). */
  internalConflict: boolean;
  scannedChars: number;
}

/* ── price parsing ───────────────────────────────────────────────────────── */

const CURRENCY_SYMBOLS: { re: RegExp; code: string }[] = [
  { re: /(?:₹|Rs\.?|INR)/i, code: "INR" },
  { re: /(?:US ?\$|\$)/, code: "USD" },
  { re: /(?:€|EUR)/i, code: "EUR" },
  { re: /(?:£|GBP)/i, code: "GBP" },
];

function groupNumber(n: number, currency?: string): string {
  const locale = currency === "INR" ? "en-IN" : "en-US";
  try {
    return n.toLocaleString(locale, { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
  } catch {
    return String(n);
  }
}

/** Parse a money string into { numeric, currency, display }. Handles
 *  "18992", "18,992.00", "₹1.2 lakh", "1.5L", "2 crore", "US$1,099". */
export function parsePrice(raw: string, currencyHint?: string): FactHit | null {
  const text = raw.trim();
  if (!text) return null;

  let currency: string | undefined;
  for (const c of CURRENCY_SYMBOLS) {
    if (c.re.test(text)) {
      currency = c.code;
      break;
    }
  }
  if (!currency) {
    const hint = (currencyHint ?? "").trim().toUpperCase();
    if (/^(INR|USD|EUR|GBP|SGD|AED|AUD|CAD)$/.test(hint)) currency = hint;
  }

  const m = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(lakh|lakhs|L|crore|crores|cr|k|K)?/);
  if (!m) return null;
  // A number glued to a unit is a spec, not a price: "200MP camera", "8GB RAM",
  // "60W charger", "5,000mAh". The multiplier shorthand ("₹16K") is allowed
  // because the currency marker precedes it; a trailing ISO currency code is
  // allowed too ("1,099 USD"). Without this, a camera megapixel count becomes
  // a "price" and pollutes the price claim.
  const tail = text.slice((m.index ?? 0) + m[0].length);
  if (/^[A-Za-z]/.test(tail) && !m[2] && !/^(INR|USD|EUR|GBP|SGD|AED|AUD|CAD)\b/.test(tail)) {
    return null;
  }
  const digits = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(digits) || digits <= 0) return null;
  const multRaw = (m[2] ?? "").toLowerCase();
  const mult = multRaw.startsWith("l") ? 100_000 : multRaw.startsWith("c") ? 10_000_000 : multRaw === "k" ? 1_000 : 1;
  const numeric = digits * mult;

  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  const display = symbol + groupNumber(numeric, currency) + (currency && !symbol ? " " + currency : "");
  return { type: "price", value: display, numeric, currency, quote: text.slice(0, 200), origin: "structured" };
}

/* ── structured block parsing ────────────────────────────────────────────── */

const STRUCTURED_MARKER = "[Structured Page Facts]";

interface Section {
  header: string;
  name: string;
  body: string;
}

/** Split the structured block into `## <Header>: <name>` sections. */
function splitSections(structured: string): Section[] {
  const out: Section[] = [];
  const parts = structured.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const headLine = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? "" : part.slice(nl + 1);
    const colon = headLine.indexOf(":");
    const header = (colon === -1 ? headLine : headLine.slice(0, colon)).trim();
    const name = colon === -1 ? "" : headLine.slice(colon + 1).trim();
    if (header) out.push({ header: header.toLowerCase(), name, body });
  }
  return out;
}

function lineValue(body: string, label: string): string | undefined {
  const m = body.match(new RegExp("^" + label + ":\\s*(.+)$", "im"));
  return m ? m[1].trim() : undefined;
}

/** Availability from a schema.org enum, tolerating "http://schema.org/OutOfStock". */
function mapAvailability(raw: string): { state: AvailabilityState; value: string } | null {
  const key = raw
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/[\s-]+/g, "")
    .toLowerCase();
  return AVAILABILITY_MAP[key] ?? null;
}

/* ── prose fact scanning ─────────────────────────────────────────────────── */

const PRICE_PROSE_RE =
  /(?:₹|Rs\.?\s*|INR\s*|US ?\$|\$|€|£)\s?[\d][\d,]*(?:\.\d{1,2})?(?:\s*(?:lakh|lakhs|crore|crores|k|K))?/g;
/**
 * True when the text immediately before a price labels it a list / strike-through
 * price rather than the selling price ("M.R.P: ₹21,999", "List Price", "Was:").
 * Those are the discount baseline, so they must not be read as a second price —
 * the page states one selling price, and inventing a conflict out of a strikethrough
 * is exactly the "which number is it?" confusion this layer exists to remove.
 */
function isListPrice(before: string): boolean {
  return /(?:m\.?\s?r\.?\s?p|list\s+price|msrp|strike-?through|was\s*[:)]?)\s*[:=]?\s*$/i.test(
    before.trim(),
  );
}

/**
 * Money on a commerce page is not always the price. A product page carries
 * savings, coupons, cashback, EMI and exchange amounts and shipping fees in the
 * same sentences as its price, and an amount misread as a price becomes a
 * fabricated figure in the answer (live case: one source's facts ended up as
 * "₹25,000 · ₹194" for a phone listed at ₹34,999). Deliberately narrow: the
 * label must sit immediately before the amount, so a genuine
 * "Price: ₹18,992 (47% off)" still parses.
 */
function isNonPriceAmount(before: string): boolean {
  return /(?:save[sd]?|savings|cash\s?back|coupon|voucher|discount|rebate|emi|installments?|rental|renting|down\s+payment|deposit|exchange|shipping|delivery\s+charge[s]?|handling|gift\s+card|worth)\s*[:=(]?\s*$/i.test(
    before.trim(),
  );
}

/**
 * The same amount read the other way round: an instalment or rental figure is
 * not the price either. "₹877/mo EMI" sat two sentences from "Price: ₹18,992" on
 * a live product page and would have shown up as a second, absurd price.
 */
function isRecurringAmount(after: string): boolean {
  return (
    /^\s*\/\s*(?:mo|month|day|week|yr|year)\b/i.test(after.trim()) ||
    /^\s*per\s+(?:month|mo|week|day|year|annum)\b/i.test(after.trim()) ||
    /^\s*(?:emi|monthly|weekly|per\s+day)\b/i.test(after.trim())
  );
}

/**
 * A compare / carousel block, which names OTHER products. The amount in
 * question may sit on a page that IS about the asked-for product (so
 * page-level binding is legitimate) while the number itself belongs to one of
 * the tiles beside it. Live failure this guards: the CORRECT Honor 200 page
 * fed "₹25,000 · ₹59,999 · ₹39,999 · ₹499" into the price claim — compare
 * tiles and accessory add-ons, read as prices of the requested phone. When a
 * carousel marker precedes the amount, the amount's own sentence has to name
 * the entity, no matter what the rest of the page matched.
 */
const CAROUSEL_RE =
  /\b(?:compare (?:with|that)|similar items?|similar products?|other sellers|buying options|also bought|also viewed|you may also like|frequently bought|related products?|comparison table)\b/i;

/**
 * A threshold or policy amount is money the page mentions, never the item's
 * price. Live case: "For products worth more than INR 25000, we only offer
 * Self-Return option." on a product page put "₹25,000" into that phone's price
 * claim — a policy threshold read out as a price. Narrow on purpose: the
 * threshold word has to sit right before the amount.
 */
const THRESHOLD_BEFORE_RE =
  /\b(?:more|less|greater|fewer|higher|lower|above|over|under|beyond|up\s?to|worth|at least|at most|exceeding|between|equal to|than|minimum|maximum|threshold|minimum purchase)\s*(?:₹|INR|Rs\.?)?\s*$/i;
const POLICY_SENTENCE_RE =
  /\b(?:self[- ]return|return policy|cancellation policy|refund policy|extended warranty|amc plan|no-cost emi|cash on delivery)\b/i;

/**
 * Words that introduce an amount AS a price. A number nobody called a price is
 * an assumption: on a page with no structured block, the amount's own sentence
 * either names the entity or is introduced as a price, or it is not evidence.
 */
const PRICE_LABEL_BEFORE_RE =
  /(?:price|mrp|m\.?\s?r\.?\s?p|costs?|cost|priced|listed|selling price|retail price|amount|fare|fees?|salary|ctc)\s*[:=(]?\s*$/i;
const PRICE_WORD_RE = /\b(?:price|pricing|priced|costs?|listed|selling price|retail price|MRP)\b/i;

/* ── links to OTHER products / jobs ──────────────────────────────────────── */

/**
 * A markdown link whose TARGET is some other product's (or job's) detail page
 * is a tile — a deals rail, a "similar items" strip, a bundle — and the tile's
 * price lives in its LABEL. Such an amount can never be the price of the item
 * the user asked about, no matter how well the page as a whole matches.
 *
 * The failure this removes (live, 2026-10-21): BOTH correct Honor 200 pages
 * were certified as "Supports: ₹25,000 · ₹59,999 · ₹39,999" and "₹25,000 · ₹194
 * · ₹59,999". Not one of those numbers was the phone's price. The passages were
 * Amazon's deals rail, rendered as link rows like
 * `[₹20,900.00](/Motorola-Edge-Fusion-256GB-Storage/dp/B0F46CBG95/ref=…)` and
 * `M.R.P: ₹59,999.00` under `[Tecno-Nebula-…/dp/B0GXMDXWK5…]`, plus a ₹499
 * screen-protector tile. Page-level binding was legitimately true (the title DID
 * name Honor 200 5G), so no sentence-window rule could have caught any of it.
 *
 * Rule, structural rather than keyword-guessing: drop the whole link — label
 * included — when its target is a detail page for a product/job other than this
 * page's own, unless the label itself names the entity (an article citing the
 * right product keeps its citation). Every other link keeps its label and loses
 * its target: a URL's `.` and `?` shred `sentenceAround` into meaningless
 * fragments, and a slug can fake an entity match — `/Honor-Emerald-Risk-Free-
 * Display-…/dp/…` mentions "Honor" while being a screen protector.
 */
const DETAIL_PATH_RE =
  /\/(?:dp|gp\/product|gp\/aw\/d|productDetails|p|ip|job-details|viewjob|pub\/job|l\/jobs\/view)\/([^/?#\s]+)/i;
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^)>\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function detailIdOf(url: string): string {
  const m = (url ?? "").match(DETAIL_PATH_RE);
  return m ? m[1].toLowerCase() : "";
}

/** Remove link targets, and whole links that point at some other item. */
function scrubLinks(text: string, ownDetailIds: Set<string>, entity: EntityMatcher): string {
  const out = text.replace(
    MD_LINK_RE,
    (_all, bang: string, label: string, target: string) => {
      if (bang) return " "; // an image carries no facts
      const foreign = detailIdOf(target);
      if (foreign && !ownDetailIds.has(foreign) && !entity.test(label ?? "")) return " ";
      return label || " ";
    },
  );
  // A bare URL (not in link syntax) is the same noise with no label attached.
  return out.replace(/https?:\/\/[^\s)\]]+/gi, " ");
}

/**
 * Discount mechanics are never the listed price. Deliberately excludes a bare
 * "47% off", which routinely sits INSIDE a genuine "Price: ₹18,992 (47% off)".
 */
const OFFER_SENTENCE_RE =
  /\b(?:bank offer|instant (?:discount|offer)|exchange offer|with exchange|apply coupon|on applying|coupon|voucher|cash\s?back|extra\s+₹?\s?[\d,]+\s*off|additional\s+₹?\s?[\d,]+\s*off|save[sd]?\s+₹|₹\s?[\d,]+\s*off\b|emi|(?:instalment|installment))\b/i;

const RATING_PROSE_RE = /(\d\.\d)\s*(?:star|★|\/\s*5\b|out of 5)/i;
const REVIEW_COUNT_PROSE_RE = /\b([\d,]+)\s+(?:reviews?\b|ratings?\b|Google reviews?\b)/i;
// No `.` inside the capture: on a live Amazon page "delivered to you. For
// device-related issues in Apple i…" became a "deliver-to" fact about a place
// called "you. For device-related issues in Apple i". A delivery fact has to
// name a PIN or a place, and a pronoun names nothing.
const DELIVERS_TO_RE =
  /\b(?:deliver(?:s|ed)? (?:to|in)|ship(?:s|ping)? to|available (?:for )?delivery (?:to|in)|can (?:be )?(?:deliver|ship)(?:ed)? to)\s+([A-Za-z][A-Za-z0-9 ,-]{1,40}|\d{6})/i;
const STOP_LOCALITY_RE =
  /^(?:you|your|yours|home|address|doorstep|us|it|this|that|here|there|worldwide|anywhere|everywhere|order|customers?|next|all|free)\b/i;
const PIN_RE = /\b\d{6}\b/;
const VERSION_PROSE_RE = /\bversion\s+v?(\d+(?:\.\d+){1,3})\b/i;
const POSTED_PROSE_RE = /\b(?:posted|published|listed)\s+(?:on\s+)?((?:\d+\s+(?:days?|weeks?|hours?|months?)\s+ago)|(?:[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i;

function windowAround(text: string, index: number, length: number): string {
  const half = 160;
  return text.slice(Math.max(0, index - half), Math.min(text.length, index + length + half));
}

/**
 * The sentence holding `index`. A ±160-char window is far too generous when the
 * page is about a different product: it swallows "Compare with similar items:
 * <entity>, …" carousels and lets their prices bind to our claim. On such a page
 * a fact must be named by the very sentence it sits in.
 */
function sentenceAround(text: string, index: number): string {
  const breakers = new Set([".", "!", "?", "\n", "|", "•", "·", "—"]);
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (breakers.has(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    if (breakers.has(text[i])) {
      end = i;
      break;
    }
  }
  return text.slice(start, Math.min(end, start + 400));
}

/* ── the ledger builder ──────────────────────────────────────────────────── */

const MAX_SCANNED_CHARS = 20_000;
const MAX_FACTS_PER_SOURCE = 12;

/**
 * Adjudicate one packet into a SourceFactSet.
 *
 * Binding rules (the anti-hallucination core):
 *  - a structured block's facts belong to the NAMED product; if that name
 *    doesn't match the entity the user asked about, every fact in the block
 *    is rejected as `entity-mismatch` (this is what kills the ₹255 case price);
 *  - an accessory-named block is rejected unless the user asked for an accessory;
 *  - prose facts must sit in a window that names the entity, OR on a page
 *    whose own structured block already matched (a seller product page talks
 *    about one product, so page-level binding is legitimate there);
 *  - on a page whose structured block names a DIFFERENT product and whose
 *    title doesn't match either, page-level binding is void — only an
 *    explicitly named window binds. Live failure this guards: an unrelated
 *    phone's product page lent "₹25,000 · ₹59,999" to a Honor 200 ask because
 *    the passage mentioned Honor 200 in a related-products carousel;
 *  - amounts that are not the price (savings, cashback, EMI, shipping) and
 *    recurring amounts ("₹877/mo") are never parsed as a price.
 */
/**
 * Fact types an ACCESSORY page may never contribute about the asked item.
 * CONTRACT rule 7's wording is the exact rationale: "a figure found on an
 * accessory, case, or different-model page is never a fact about the item".
 * locality/company/posted/version stay ungated — they are not item claims,
 * and rejecting them would only noise the Evidence trail.
 */
const ACCESSORY_GATED_FACT_TYPES = new Set<FactType>([
  "price",
  "availability",
  "price-valid-until",
  "rating",
  "review-count",
  "open-now",
  "deliver-to",
  "product-name",
]);

/**
 * The accessory phrase the PAGE ITSELF is named after, or null.
 *
 * Live failure this closes (recorded session, 2026-10-21): a cover page —
 * "Honor 200 5G Back Cover, Premium Vegan Leather Case with Kickstand",
 * ₹255, InStock — polluted the PHONE's adjudication. Its passages never use
 * an accessory phrase ("Designed to fit Honor 200 5G."), so the section-name
 * and prose-window checks inside `collectSourceFacts` missed it entirely: no
 * rejection was recorded, so the ₹255 entered the price claim as a "conflict"
 * value, its InStock read as the phone's stock, and the page qualified as
 * "the item page" — the user's exact "opened your link and saw only cases
 * and covers" class. Title and URL slug ARE subject-bearing strings, which
 * is what `accessory-phrase.ts` demands of this predicate: a real product
 * page lists accessories inside its body ("Back Cover" deal tiles), its own
 * title never names one.
 *
 * Guard: the phrase must not BE the asked entity itself. ACCESSORY_PHRASES
 * doubles as a list of genuine product categories ("charger", "earbuds",
 * "power bank") — an ask for one of those must not stamp every matching
 * product page as an accessory of itself.
 */
function pageAccessoryPhrase(entity: EntityMatcher, packet: EvidencePacket): string | null {
  let decoded = packet.url;
  try {
    decoded = decodeURIComponent(packet.url);
  } catch {
    /* malformed percent-encoding: match on the raw URL */
  }
  const phrase = accessoryPhraseIn(packet.title, decoded);
  if (!phrase) return null;
  const asked = (entity.phrase || "").toLowerCase();
  return asked.includes(phrase) ? null : phrase;
}

export function collectSourceFacts(
  packet: EvidencePacket,
  entity: EntityMatcher,
  opts: FactOptions,
): SourceFactSet {
  const cls = classifyUrl(packet.url);
  const facts: FactHit[] = [];
  const rejections: DiscardedFact[] = [];
  const factKeys = new Set<string>();
  const passageKeys = new Set<string>();
  /** The price(s) this page declares about the asked-for item, structurally. */
  const structuredPrices: number[] = [];

  const uniquePassages: string[] = [];
  const structuredChunks: string[] = [];
  let scanned = 0;
  // THIS page's own detail id (an Amazon ASIN, a Flipkart ITID, a job id) — the
  // reference for "does this link point at some other product's page?".
  const ownDetailIds = new Set([detailIdOf(packet.url)].filter(Boolean));
  for (const p of packet.passages) {
    const t = p.passageText ?? "";
    if (!t || passageKeys.has(t)) continue;
    passageKeys.add(t);
    if (t.includes(STRUCTURED_MARKER)) structuredChunks.push(t.slice(t.indexOf(STRUCTURED_MARKER)));
    // Structured blocks are parsed raw; prose is parsed with the links scrubbed
    // (see scrubLinks — the deals-rail failure of 2026-10-21).
    else uniquePassages.push(scrubLinks(t, ownDetailIds, entity));
    scanned += t.length;
    if (scanned > MAX_SCANNED_CHARS) break;
  }
  const hasStructured = structuredChunks.length > 0;

  const titleMatched = entity.test(packet.title);
  let structuredName: string | undefined;
  let structuredMatched = false;
  // True when the page's own structured block NAMES a product that is not the
  // one asked about — the page is about that other product.
  let structuredNamedOther = false;
  let entityMatched = titleMatched;

  // Page-level accessory signal (see `pageAccessoryPhrase` above): when the
  // page NAMES an accessory, every item fact it carries is the ACCESSORY's
  // fact — it must land in `rejections`, not `facts`. claim-rules already keys
  // its "Accessory listing (…), not the requested product." verdict, its
  // item-link disqualification, and its ineligible-URL stamp on exactly such
  // a recorded rejection; the only gap was that nothing ever recorded one for
  // a page whose accessory wording lives in the title/slug instead of a
  // passage window.
  const pageAccessory = opts.accessoryAsk ? null : pageAccessoryPhrase(entity, packet);

  const add = (f: FactHit | null) => {
    if (!f || facts.length >= MAX_FACTS_PER_SOURCE) return;
    if (pageAccessory && ACCESSORY_GATED_FACT_TYPES.has(f.type)) {
      reject(f.type, f.value, "accessory-listing");
      return;
    }
    const key = f.type + "|" + f.value;
    if (factKeys.has(key)) return;
    factKeys.add(key);
    facts.push(f);
  };
  const reject = (type: FactType, value: string, reason: DiscardedFact["reason"]) => {
    if (rejections.length >= 6) return;
    if (rejections.some((r) => r.type === type && r.value === value)) return;
    rejections.push({ type, value, reason });
  };

  /* 1. structured facts, scoped per product/job block */
  for (const chunk of structuredChunks) {
    for (const section of splitSections(chunk)) {
      const isProductish = /^product(s)?$|^offer|^software|^app|^book|^movie/.test(section.header);
      const isJobish = /^job/.test(section.header);
      if (!isProductish && !isJobish) continue;

      const name = section.name && section.name.toLowerCase() !== "unnamed" && section.name.toLowerCase() !== "listing"
        ? section.name
        : "";
      const nameMatched = name ? entity.test(name) : false;
      if (name && !nameMatched && isProductish) structuredNamedOther = true;
      // Phrase-level on purpose (see `accessory-phrase.ts`): the marker list in
      // `entity.ts` fires on "screen", "glass", "case" — words that live inside
      // genuine product names — and rejecting on those loses the price and stock
      // of the actual product the user asked about.
      const accessoryHere =
        hasAccessoryPhrase(name || section.body.slice(0, 300)) || pageAccessory !== null;

      // Block-level binding decision, computed once and applied to every fact.
      let blockOk: boolean;
      let rejectReason: DiscardedFact["reason"] | null = null;
      if (accessoryHere && !opts.accessoryAsk) {
        blockOk = false;
        rejectReason = "accessory-listing";
      } else if (nameMatched) {
        blockOk = true;
      } else if (!name) {
        // Unnamed block: fall back to page title / whole-block text.
        blockOk = titleMatched || entity.test(chunk);
        if (!blockOk) rejectReason = "entity-mismatch";
      } else {
        blockOk = false;
        rejectReason = "entity-mismatch";
      }

      if (blockOk) {
        structuredMatched = true;
        entityMatched = true;
        if (!structuredName && name) structuredName = name;
      }

      const emit = (f: FactHit | null) => {
        if (!f) return;
        if (blockOk) add(f);
        else reject(f.type, f.value, rejectReason ?? "entity-mismatch");
      };

      if (isProductish) {
        const price = lineValue(section.body, "Price");
        if (price) {
          const parsed = parsePrice(price);
          emit(parsed ? { ...parsed, origin: "structured" } : null);
          // The page's OWN declared price. It outranks every currency-bearing
          // number elsewhere in the page's prose, which is why it is recorded.
          if (blockOk && parsed && Number.isFinite(parsed.numeric ?? NaN)) structuredPrices.push(parsed.numeric!);
        }
        const avail = lineValue(section.body, "Availability");
        if (avail) {
          const mapped = mapAvailability(avail);
          const f: FactHit = {
            type: "availability",
            value: mapped ? mapped.value : avail.trim().slice(0, 80),
            quote: avail.slice(0, 200),
            origin: "structured",
          };
          if (mapped) emit(f);
          else reject("availability", f.value, "entity-mismatch");
        }
        const validUntil = lineValue(section.body, "Price valid until");
        if (validUntil) {
          const stale = opts.today && Date.parse(validUntil) < opts.today.getTime();
          const f: FactHit = { type: "price-valid-until", value: validUntil.trim(), quote: validUntil.slice(0, 200), origin: "structured" };
          if (blockOk) {
            add(f);
            if (stale) reject("price", "all prices from this listing", "stale");
          }
        }
        const rating = lineValue(section.body, "Rating");
        if (rating) {
          const m =
            rating.match(/([\d.]+)\s*\(\s*(\d[\d,]*)\s*(?:reviews?|ratings?)/i) ??
            rating.match(/([\d.]+)/);
          if (m) {
            emit({ type: "rating", value: `${m[1]}/5`, numeric: Number(m[1]), quote: rating.slice(0, 200), origin: "structured" });
            if (m[2]) emit({ type: "review-count", value: `${m[2].replace(/,/g, "")} reviews`, numeric: Number(m[2].replace(/,/g, "")), quote: rating.slice(0, 200), origin: "structured" });
          }
        }
      }
      if (isJobish) {
        const posted = lineValue(section.body, "Posted");
        if (posted) emit({ type: "posted", value: posted.trim(), quote: posted.slice(0, 200), origin: "structured" });
        const salary = lineValue(section.body, "Salary");
        if (salary) {
          const parsed = parsePrice(salary);
          if (parsed) emit({ ...parsed, type: "price", origin: "structured" });
        }
        const loc = lineValue(section.body, "Location");
        if (loc) emit({ type: "locality", value: loc.trim(), quote: loc.slice(0, 200), origin: "structured" });
        if (name) emit({ type: "job-title", value: name, quote: name.slice(0, 200), origin: "structured" });
        const company = lineValue(section.body, "Company");
        if (company) emit({ type: "company", value: company.trim(), quote: company.slice(0, 200), origin: "structured" });
      }
    }
  }

  /* 2. prose facts, window-bound to the entity */
  // A page whose structured block NAMES a different product is about that other
  // product, so a bare page-level match must not let its prose numbers bind.
  // Live failure: an amazon "Moonlight 6.7 inch" page contributed
  // "Supports: ₹25,000 · ₹59,999" to a Honor 200 ask because the passage merely
  // mentioned Honor 200 in a related-products carousel. Its own structured
  // (mismatched) block is the tell, so prose facts need an explicit named
  // window on such a page.
  const pageBinds = (structuredMatched || titleMatched) && !structuredNamedOther;
  // The stricter case: the page's own structured block names a different
  // product and nothing else on the page names ours. Its passages may still
  // mention the asked item (related-product carousels, "similar items",
  // comparison tables) and a number lifted out of that context becomes a
  // fabricated price. Live failure this guards: a "Moonlight 6.7 inch" page
  // contributed "Supports: ₹25,000 · ₹59,999" to a Honor 200 ask. Page-level
  // binding is void there, so the fact's own SENTENCE must name the entity —
  // a ±160-char window is nowhere near tight enough for it.
  const pageAboutOtherOnly = structuredNamedOther && !structuredMatched && !titleMatched;
  const proseOk = (text: string, at: number, win: string): boolean =>
    pageBinds || (pageAboutOtherOnly ? entity.test(sentenceAround(text, at)) : entity.test(win));
  for (const text of uniquePassages) {
    if (facts.length >= MAX_FACTS_PER_SOURCE) break;

    // Availability — negative first.
    const neg = text.match(NEGATIVE_AVAILABILITY);
    const pre = text.match(PREORDER_AVAILABILITY);
    const pos = text.match(POSITIVE_AVAILABILITY);
    const availMatch = neg ?? pre ?? pos;
    if (availMatch && availMatch.index !== undefined) {
      const win = windowAround(text, availMatch.index, availMatch[0].length);
      const mapped = neg
        ? /discontinu/i.test(neg[0])
          ? { state: "unavailable" as const, value: "Discontinued" }
          : /sold out/i.test(neg[0])
            ? { state: "unavailable" as const, value: "Sold out" }
            : { state: "unavailable" as const, value: "Currently unavailable" }
        : pre
          ? { state: "preorder" as const, value: /coming soon|launches/i.test(pre[0]) ? "Not yet released" : "Pre-order" }
          : /only \d+/i.test(pos![0])
            ? { state: "limited" as const, value: "Limited stock" }
            : { state: "in-stock" as const, value: "In stock" };
      const f: FactHit = { type: "availability", value: mapped.value, quote: win.replace(/\s+/g, " ").slice(0, 200), origin: "prose" };
      if (proseOk(text, availMatch.index ?? 0, win)) add(f);
      else reject("availability", mapped.value, "entity-mismatch");
    }

    // Prices — every currency-bearing number in the passage.
    PRICE_PROSE_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    let priceCount = 0;
    while ((pm = PRICE_PROSE_RE.exec(text)) && priceCount < 6) {
      priceCount++;
      const win = windowAround(text, pm.index, pm[0].length);
      const parsed = parsePrice(pm[0]);
      if (!parsed) continue;
      // A list / strike-through price is not the selling price. Reading
      // "M.R.P: ₹21,999" next to "Price: ₹18,992" as two prices would invent a
      // conflict where the page states one price and its discount baseline.
      const before = text.slice(Math.max(0, pm.index - 24), pm.index);
      const after = text.slice(pm.index + pm[0].length, pm.index + pm[0].length + 16);
      if (isListPrice(before) || isNonPriceAmount(before) || isRecurringAmount(after)) continue;

      // Three price-hygiene guards, all added after the live run of 2026-10-21
      // where the CORRECT product page fed "₹25,000 · ₹59,999 · ₹39,999 · ₹499"
      // into a "price of the Honor 200" claim. Page-level binding says the page
      // is about the right product; it does NOT say every number on it is that
      // product's price.
      const sentence = sentenceAround(text, pm.index);
      // (1) Compare-tile / carousel amounts belong to the tile, not to the
      //     item the page is about. The carousel marker has to appear right
      //     before the amount, and the amount's own sentence must name the
      //     entity — otherwise it is another product's price.
      const nearCarousel = CAROUSEL_RE.test(text.slice(Math.max(0, pm.index - 400), pm.index));
      if (nearCarousel && !entity.test(sentence)) {
        reject("price", parsed.value, "entity-mismatch");
        continue;
      }
      // (2) Savings, cashback, exchange and EMI lines are money, never a price.
      if (OFFER_SENTENCE_RE.test(sentence)) {
        reject("price", parsed.value, "non-price-amount");
        continue;
      }
      // (3) The page's own declared price outranks its loose numbers: a prose
      //     figure that disagrees with EVERY price this page declares about
      //     the item (beyond the 2% tolerance) is an add-on or a tile.
      const pn = parsed.numeric;
      if (pn !== undefined && structuredPrices.length > 0 &&
          structuredPrices.every((v) => pricesConflict([v, pn]))) {
        reject("price", parsed.value, "non-price-amount");
        continue;
      }
      // (4) A policy threshold ("worth more than INR 25000") or a returns /
      //     warranty / CoD sentence is not the item's price.
      if (THRESHOLD_BEFORE_RE.test(before.trim()) || POLICY_SENTENCE_RE.test(sentence)) {
        reject("price", parsed.value, "non-price-amount");
        continue;
      }
      // (5) An amount nobody attached to the item. On a page that carries no
      //     structured block — the usual shape for a directly-fetched commerce
      //     page — an amount is evidence only if its own sentence names the
      //     entity or introduces it AS a price. Everything else is a tile, an
      //     accessory or a policy figure that survived rule (1) by not using
      //     carousel wording (the deals rail renders as bare link rows).
      if (!hasStructured && !PRICE_WORD_RE.test(sentence) && !entity.test(sentence)) {
        reject("price", parsed.value, "entity-mismatch");
        continue;
      }

      const f: FactHit = { ...parsed, origin: "prose" };
      if (hasAccessoryPhrase(win) && !opts.accessoryAsk) reject("price", parsed.value, "accessory-listing");
      else if (proseOk(text, pm.index, win)) add(f);
      else reject("price", parsed.value, "entity-mismatch");
    }

    // Rating + review count.
    const rm = text.match(RATING_PROSE_RE);
    if (rm) {
      const win = windowAround(text, rm.index ?? 0, rm[0].length);
      const f: FactHit = { type: "rating", value: `${rm[1]}/5`, numeric: Number(rm[1]), quote: win.replace(/\s+/g, " ").slice(0, 200), origin: "prose" };
      if (proseOk(text, rm.index ?? 0, win)) add(f);
      else reject("rating", f.value, "entity-mismatch");
    }
    // Every remaining prose fact binds the same way as the ones above: the
    // window must be attributable to the item the user asked about. Review
    // counts feed the rating claim, delivery lines feed "is it deliverable to
    // my PIN", and a version/date feeds a docs or job-freshness answer — a
    // wrong source for any of them is a wrong answer, exactly like a price.
    const bindProse = (
      type: FactType,
      value: string,
      at: number,
      len: number,
      numeric?: number,
    ) => {
      const win = windowAround(text, at, len);
      const f: FactHit = { type, value, numeric, quote: win.replace(/\s+/g, " ").slice(0, 200), origin: "prose" };
      if (proseOk(text, at, win)) add(f);
      else reject(type, value, "entity-mismatch");
    };

    const rc = text.match(REVIEW_COUNT_PROSE_RE);
    if (rc) {
      const n = Number(rc[1].replace(/,/g, ""));
      bindProse("review-count", `${n} reviews`, rc.index ?? 0, rc[0].length, n);
    }

    // Delivery / locality.
    const dm = text.match(DELIVERS_TO_RE);
    if (dm && !STOP_LOCALITY_RE.test(dm[1].trim())) {
      bindProse("deliver-to", dm[1].trim(), dm.index ?? 0, dm[0].length);
    }
    const pin = text.match(PIN_RE);
    if (pin) bindProse("deliver-to", pin[0], pin.index ?? 0, 6);

    // Version / posted date (docs + job freshness).
    const vm = text.match(VERSION_PROSE_RE);
    if (vm) bindProse("version", vm[1], vm.index ?? 0, vm[0].length);
    const pd = text.match(POSTED_PROSE_RE);
    if (pd) bindProse("posted", pd[1], pd.index ?? 0, pd[0].length);
  }

  /* 3. fold availability + detect a source that contradicts itself */
  // An accessory page that parsed NO item facts still needs the rejection on
  // record: the source-verdict label and the item-link disqualification are
  // both keyed on an "accessory-listing" rejection, and "no facts" must not
  // launder a cover page back into "eligible item page".
  if (pageAccessory && !rejections.some((r) => r.reason === "accessory-listing")) {
    reject("availability", pageAccessory, "accessory-listing");
  }

  const availFacts = facts.filter((f) => f.type === "availability");
  let availability: AvailabilityState | undefined;
  let internalConflict = false;
  if (availFacts.length > 0) {
    const states = new Set<string>();
    for (const f of availFacts) {
      const mapped = Object.values(AVAILABILITY_MAP).find((v) => v.value === f.value);
      if (mapped) states.add(mapped.state);
    }
    if (states.size > 1) {
      internalConflict = true;
      availability = "unknown";
    } else {
      availability = [...states][0] as AvailabilityState;
    }
  }

  return {
    sourceId: packet.sourceId,
    url: packet.url,
    domain: packet.domain,
    title: packet.title,
    kind: cls.kind,
    roleLabel: cls.roleLabel,
    facts,
    rejections,
    entityMatched,
    hasStructured: structuredChunks.length > 0,
    structuredName,
    availability,
    internalConflict,
    scannedChars: scanned,
  };
}

export function buildFactSets(
  packets: EvidencePacket[],
  entity: EntityMatcher,
  opts: FactOptions,
): SourceFactSet[] {
  return packets.map((p) => collectSourceFacts(p, entity, opts));
}

/** Two same-currency prices more than 2% apart are a conflict, never an average. */
export function pricesConflict(values: number[], currency?: string): boolean {
  const same = values.filter((v) => Number.isFinite(v));
  if (same.length < 2) return false;
  const lo = Math.min(...same);
  const hi = Math.max(...same);
  if (lo <= 0) return hi > 0;
  return (hi - lo) / lo > 0.02;
}
