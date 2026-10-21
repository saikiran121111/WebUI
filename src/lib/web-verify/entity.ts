/**
 * Entity binding — the difference between "a price was found" and "a price
 * for the thing you asked about was found".
 *
 * WHY: on the reported failure the model read ₹255 off a phone-CASE page and
 * quoted it as the phone's price, and read "₹16-17K" into a table whose own
 * evidence said ₹18,992. Token overlap alone cannot separate
 * "Honor 200 5G" from "Back Cover Case for Honor 200 5G", so entity matching
 * is (a) word-boundary anchored — "200" must not match "1200" — (b) paired with
 * an accessory-marker rule: a name carrying case/cover/film/charger words is a
 * DIFFERENT product unless the user asked for an accessory, and (c) for a
 * model-number-shaped entity, IDENTITY-ANCHORED: every identifying token must
 * appear and the model number must appear *as a model number next to its
 * brand*. Token co-occurrence cannot separate the requested phone from a
 * relative of it, and (c) is the rule that stops "HONOR X9C … 200 MP camera"
 * from being certified as evidence for "Honor 200" — the failure that produced
 * a green ✓ on the wrong product page on 2026-10-21.
 */

/** Words that never identify a specific product (channel/transaction words). */
const TRANSACTIONAL_WORDS = new Set([
  "price", "prices", "pricing", "cost", "costs", "rate", "rates", "charges",
  "buy", "buying", "purchase", "order", "ordering", "shop", "shopping",
  "online", "cheap", "cheapest", "deals", "deal", "offer", "offers", "discount",
  "where", "link", "links", "direct", "page", "site", "website", "official",
  "amazon", "flipkart", "walmart", "ebay", "meesho", "flipkart", "croma",
  "india", "inr", "usd", "rupees", "rs", "today", "current", "latest", "now",
  "check", "checking", "find", "show", "give", "tell", "need", "want", "looking",
  "available", "availability", "stock", "stocks", "sale", "sell", "selling",
  "review", "reviews", "rating", "ratings", "vs", "versus", "compare",
  "comparison", "best", "top", "good", "worth", "near", "nearby", "nearme",
  "how", "much", "is", "are", "was", "the", "a", "an", "of", "for", "to",
  "and", "or", "in", "on", "at", "me", "my", "it", "its", "this", "that",
  "with", "from", "by", "as", "be", "can", "get", "please", "any", "some",
]);

/** Category nouns: they describe a CLASS, never the specific entity. */
const GENERIC_NOUNS = new Set([
  "mobile", "mobiles", "phone", "phones", "smartphone", "smartphones",
  "laptop", "laptops", "computer", "computers", "pc", "pcs", "tv", "tvs",
  "television", "televisions", "camera", "cameras", "watch", "watches",
  "headphones", "headset", "headsets", "earbuds", "earphones", "speaker",
  "tablet", "tablets", "monitor", "keyboard", "mouse", "router", "console",
  "shoes", "shoe", "dress", "shirt", "jeans", "jacket", "bag", "bags",
  "product", "products", "item", "items", "model", "models", "brand",
  "brands", "series", "generation", "gen", "graphics", "card", "cards",
  "bike", "bicycle", "car", "cars", "scooter", "device", "devices",
  "gadget", "gadgets", "appliance", "appliances", "kit", "set", "unit",
]);

/**
 * Accessory markers. A page whose product name carries one of these is NOT
 * the device page — this is the rule that stops a ₹255 case-cover price from
 * ever being reported as a phone's price.
 */
export const ACCESSORY_MARKERS = new Set([
  "case", "cases", "cover", "covers", "backcase", "backcover", "casecover",
  "screen", "protector", "guard", "tempered", "film", "skins", "skin",
  "charger", "charger", "cable", "cables", "adapter", "adaptor", "holder",
  "stand", "tripod", "mount", "strap", "sleeve", "pouch", "sticker",
  "stickers", "decals", "decal", "keyboard", "touch", "digitizer", "spinel",
  "replacement", "spare", "spares", "battery", "panel", "door", "lens",
  "ring", "cleaner", "cushion", "grip", "charm", "chain", "keychain",
]);

/**
 * Spec units. When one of the entity's digit tokens is immediately FOLLOWED by
 * one of these, the number on the page is a SPECIFICATION ("200 MP camera",
 * "5000mAh battery"), not the model number the user asked about.
 *
 * Deliberately excludes "5g" / "4g" / "lte": those legitimately TRAIL a model
 * number ("Honor 200 5G"), and the adjacency of brand + number + variant is
 * exactly what identifies the product.
 */
const SPEC_UNITS = new Set([
  "mp", "megapixel", "megapixels", "px", "mah", "wh", "watt", "watts", "w",
  "gb", "tb", "mb", "kb", "hz", "ghz", "mhz", "nm", "mm", "cm", "inch",
  "inches", "dpi", "ppi", "fps", "nit", "nits", "bit", "core", "cores", "x",
  "zoom", "ml", "cc", "kg", "mg", "g", "l", "v", "a", "km", "rpm",
]);

/** Words that mean the adjacent number is MONEY (or a quantity), never a model. */
const MONEY_WORDS = new Set([
  "rs", "rs", "inr", "rupee", "rupees", "mrp", "mrrp", "price", "prices",
  "cost", "costing", "approx", "approximately", "around", "under", "above",
  "less", "worth", "lakh", "lakhs", "crore", "crores", "thousand", "k",
  "dollar", "dollars", "usd", "euro", "euros", "gbp", "off", "discount",
]);

/**
 * Variant words. "Honor 200 Pro" is a DIFFERENT product from "Honor 200", so a
 * number followed by one of these is not the asked-for model — unless the user
 * asked for that variant themselves (it is then one of the entity's tokens).
 */
const VARIANT_WORDS = new Set([
  "pro", "plus", "ultra", "max", "lite", "light", "se", "fe", "mini", "neo",
  "turbo", "fold", "flip", "edge", "smart", "youth", "prima", "power",
]);

/** Is the user actually asking about an accessory? Then accessory pages are the entity. */
export function isAccessoryAsk(tokens: string[]): boolean {
  return tokens.some((t) => ACCESSORY_MARKERS.has(t));
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9+]+/g, " ").split(" ").filter(Boolean);
}

/** Keep meaningful tokens; short ones survive only when they carry a digit ("5g", "s24"). */
function keepToken(t: string): boolean {
  if (t.length >= 3) return !TRANSACTIONAL_WORDS.has(t);
  return /\d/.test(t) && !TRANSACTIONAL_WORDS.has(t);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary matcher for one token, matching its raw AND punctuation-stripped form. */
function tokenRe(t: string): RegExp {
  const alt = `${escapeRe(t)}|${escapeRe(t.replace(/[.\-_]/g, ""))}`;
  return new RegExp(`(?<![a-z0-9])(?:${alt})(?![a-z0-9])`, "gi");
}

/** Every occurrence of `t` in `norm`, as [start, end) — bounded so a page can never fan out the scan. */
function occurrences(norm: string, t: string): Array<[number, number]> {
  const re = tokenRe(t);
  const out: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= 40) break;
  }
  return out;
}

function firstWordAfter(text: string): string {
  return text.trimStart().match(/^[a-z]+/)?.[0] ?? "";
}

function lastWordBefore(text: string): string {
  return text.replace(/[\s:=(|[\],"'.-]+$/, "").match(/[a-z]+$/)?.[0] ?? "";
}

export interface EntityMatcher {
  /** Display phrase, e.g. "honor 200 5g". */
  phrase: string;
  tokens: string[];
  /** Tokens that actually identify the entity (class nouns excluded). */
  strong: string[];
  accessoryAsk: boolean;
  /** Word-boundary, punctuation-insensitive test. */
  test(text: string): boolean;
  /** How many entity tokens the text mentions. */
  hits(text: string): number;
}

/**
 * Build the entity matcher from the user's prompt plus the gate's keyword
 * queries. The queries are the cheaper signal: the main model writes them
 * entity-first ("honor 200 5g price india"), so the tokens shared across
 * queries ARE the entity, and the channel/transaction words drop out.
 */
export function deriveEntity(
  prompt: string,
  queries: string[],
): EntityMatcher {
  const qTokenSets = queries
    .map((q) => words(q).filter(keepToken))
    .filter((t) => t.length > 0);

  let tokens: string[] = [];
  if (qTokenSets.length >= 2) {
    const shortest = qTokenSets.reduce((a, b) => (b.length < a.length ? b : a));
    const rest = new Set(qTokenSets.filter((t) => t !== shortest).flat());
    const shared = shortest.filter((t) => rest.has(t));
    tokens = shared.length >= 2 ? shared : shortest;
  } else if (qTokenSets.length === 1) {
    tokens = qTokenSets[0];
  } else {
    tokens = words(prompt).filter(keepToken).slice(0, 5);
  }

  // Trim transactional/class words from the edges, cap the phrase.
  tokens = [...new Set(tokens)].slice(0, 6);
  while (tokens.length > 1 && (TRANSACTIONAL_WORDS.has(tokens[0]) || GENERIC_NOUNS.has(tokens[0]))) {
    tokens = tokens.slice(1);
  }
  while (tokens.length > 1 && (TRANSACTIONAL_WORDS.has(tokens[tokens.length - 1]) || GENERIC_NOUNS.has(tokens[tokens.length - 1]))) {
    tokens = tokens.slice(0, -1);
  }
  // Last resort: the rarest tokens of the prompt itself.
  if (tokens.length === 0) {
    tokens = words(prompt)
      .filter((t) => t.length >= 3 && !TRANSACTIONAL_WORDS.has(t))
      .slice(0, 3);
  }

  const strong = tokens.filter((t) => !GENERIC_NOUNS.has(t) && !TRANSACTIONAL_WORDS.has(t));
  const accessoryAsk = isAccessoryAsk(tokens);

  // Word-boundary alternation over BOTH the raw form and the punctuation-
  // stripped form ("next.js" ≡ "nextjs"). Lookaround keeps "200" from
  // matching inside "1200" / "2000mah".
  const forms = new Set<string>();
  for (const t of tokens) {
    forms.add(escapeRe(t));
    forms.add(escapeRe(t.replace(/[.\-_]/g, "")));
  }
  const re = new RegExp(`(?<![a-z0-9])(?:${[...forms].join("|")})(?![a-z0-9])`, "gi");

  const normalize = (text: string): string => {
    const lower = text.toLowerCase();
    return lower + " " + lower.replace(/[.\-_]/g, " ");
  };

  const strongSet = new Set(strong);
  /** Model-number-shaped entity ("honor 200 5g", "galaxy s24"), as opposed to a plain name. */
  const strict = strong.length >= 2 && strong.some((t) => /\d/.test(t));

  /** How close the brand and the model number have to be written to count as one product name. */
  const ADJACENCY_GAP = 18;

  /**
   * Is the OTHER identifying token written right next to this occurrence?
   * The gap must contain no digits: "HONOR X9C 5G (Moonlight, 6.78 inch …
   * 200 MP)" mentions both "HONOR" and "200" and is still not the "Honor 200".
   */
  const anchored = (norm: string, at: number, end: number, self: string): boolean => {
    for (const other of strong) {
      if (other === self) continue;
      for (const [o, oe] of occurrences(norm, other)) {
        if (oe <= at && at - oe <= ADJACENCY_GAP && !/\d/.test(norm.slice(oe, at))) return true;
        if (o >= end && o - end <= ADJACENCY_GAP && !/\d/.test(norm.slice(end, o))) return true;
      }
    }
    return false;
  };

  /**
   * Does this text carry a genuine MODEL-NUMBER occurrence of `t`, as opposed to
   * the same digits used as a spec ("200 MP"), as money ("₹200", "price 200"),
   * or as a different variant ("Honor 200 Pro")? And the occurrence has to read
   * as a product name — the number adjacent to the brand it belongs to.
   */
  const modelOccurrence = (norm: string, t: string): boolean => {
    for (const [at, end] of occurrences(norm, t)) {
      const before = norm.slice(Math.max(0, at - 12), at);
      const after = norm.slice(end, end + 12);
      if (/[₹$€£]/.test(before.slice(-2)) || MONEY_WORDS.has(lastWordBefore(before))) continue;
      const trail = firstWordAfter(after);
      if (SPEC_UNITS.has(trail) || MONEY_WORDS.has(trail)) continue;
      if (VARIANT_WORDS.has(trail) && !strongSet.has(trail)) continue;
      if (anchored(norm, at, end, t)) return true;
    }
    return false;
  };

  return {
    phrase: tokens.join(" "),
    tokens,
    strong,
    accessoryAsk,
    test(text: string): boolean {
      if (tokens.length === 0) return true;
      const norm = normalize(text);

      re.lastIndex = 0;
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(norm))) found.add(m[0].toLowerCase());
      const need = Math.min(2, tokens.length);
      if (!(found.size >= need || tokens.length === 1)) return false;

      if (strong.length > 0) {
        // EVERY identifying token has to appear, not just one of them. The old
        // `.some()` here is the direct cause of the false "✓ Verified" the user
        // reported: for the entity "honor 200", a completely different Honor
        // phone advertising a "200 MP" camera satisfied "honor" OR "200" and
        // was certified as evidence for — and then linked as — the product.
        for (const t of strong) {
          if (occurrences(norm, t).length === 0) return false;
        }
        // …and for a model-number-shaped entity, the number has to appear as a
        // model number next to its brand, not merely somewhere on the page.
        if (strict) {
          for (const t of strong) {
            if (/\d/.test(t) && !modelOccurrence(norm, t)) return false;
          }
        }
      }
      return true;
    },
    hits(text: string): number {
      if (tokens.length === 0) return 0;
      const norm = normalize(text);
      let n = 0;
      for (const t of tokens) if (occurrences(norm, t).length > 0) n++;
      return n;
    },
  };
}

/** Does this text name an ACCESSORY of the entity (the case-cover trap)? */
export function hasAccessoryMarker(text: string): boolean {
  const lower = text.toLowerCase();
  for (const m of ACCESSORY_MARKERS) {
    if (new RegExp(`(?<![a-z])${escapeRe(m)}(?![a-z])`, "i").test(lower)) return true;
  }
  return false;
}
