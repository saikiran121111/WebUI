/**
 * Deterministic link classification + per-claim eligibility.
 *
 * WHY: nothing in the retrieval pipeline can tell a seller's PRODUCT page
 * from that seller's SEARCH page. `amazon.in/s?k=honor+200+5g` and
 * `amazon.in/dp/B0D9R47712` both rank, both get cited, and the main model
 * happily presented the first as "the direct product link" — a page whose
 * listings were phone cases. This module turns that into a machine-checkable
 * fact: every URL gets a `kind`, a UI `roleLabel`, and a per-claim
 * eligibility. Pure host+path rules — no network, no model call, unit
 * testable against fixtures.
 */
import type { ClaimType, Eligibility, LinkClassification, SourceKind } from "./types";

/* ── host groups (matched on dot-labels, so "amazon.in" == label "amazon") ── */

/** Search engines — their SERP is always the page itself. */
const SEARCH_ENGINE_HOSTS = [
  "google", "bing", "duckduckgo", "brave", "startpage", "startpage", "mojeek",
  "searx", "searxng", "searchignore", "aol", "ecosia", "qwant", "yandex", "ask",
];

/** Seller / store hosts. Their `/dp/` is the item, their `/s?k=` is a SERP. */
const MARKETPLACE_HOSTS = [
  "amazon", "flipkart", "walmart", "bestbuy", "ebay", "target", "meesho",
  "indiamart", "croma", "ajio", "myntra", "nykaa", "aliexpress", "alibaba",
  "newegg", "costco", "bigbasket", "dmart", "blinkit", "zepto", "jiosmartbuy",
  "samsung", "apple", "nike", "adidas", "puma", "mi", "boat", "bombship",
  "booking", "agoda", "makeymytrip", "irctc", "paytm", "myntra", "ajio",
  "ashifabb", "landmarkshops", "zudio", "metro", "fairprice", "shopify",
  "myshopify", "squarespace", "wix", "weebly", "woocommerce", "shop",
];

/** Job boards. Their posting page is primary for "is this job still open". */
const JOB_BOARD_HOSTS = [
  "naukri", "indeed", "linkedin", "shine", "timesjobs", "monster", "cutshort",
  "instahyre", "hirist", "foundit", "jobstreet", "naukrimgulf", "apna",
  "workindia", "internshala", "wellfound", "angel", "greenhouse", "lever",
  "jobstreet", "careerbuilder", "dice",
];

/** Maps / place hosts. */
const MAP_HOSTS = ["mappls", "mapmyindia", "google", "maps", "osm", "openstreetmap"];

/** Review / local-listing hosts: ratings and review counts are their product. */
const REVIEW_LISTING_HOSTS = [
  "justdial", "yelp", "tripadvisor", "magicpin", "zomato", "swiggy",
  "wanderlog", "sozoo", "grover",
];

/** Price-comparison / price-history hosts: price data is their whole job. */
const PRICE_AGGREGATOR_HOSTS = [
  "smartprix", "91mobiles", "pricebaba", "buyhatke", "pricehistory",
  "priceminister", "priceobserver", "pricesmart", "price.com",
];

/** Dictionary / encyclopedia / docs / spec references. */
const REFERENCE_HOSTS = [
  "wikipedia", "wiktionary", "wikibooks", "wikidata", "wikiquote", "wikisource",
  "wikimedia", "cambridge", "merriam", "webster", "dictionary", "britannica",
  "freedictionary", "vocabulary", "yourdictionary", "collins", "longman",
  "oxford", "thefreedictionary", "urbandictionary", "who", "cdc", "nih", "sec",
  "arxiv", "acm", "ieee", "readthedocs", "mozilla", "python", "man", "docs",
  "github", "gitlab", "npm", "pypi", "crates", "packagist", "huggingface",
  "gsmarena", "digit", "techlusive", "notebookcheck", "techradar", "tomsguide",
  "theverge", "androidauthority", "wccftech", "indiatoday",
];

/** Community / social hosts: opinions, anecdotes, never authoritative listings. */
const COMMUNITY_HOSTS = [
  "reddit", "quora", "x", "twitter", "facebook", "instagram", "medium", "dev",
  "hashnode", "stackoverflow", "stackexchange", "superuser", "askubuntu",
  "serverfault", "hackernews", "ycombinator", "discord", "telegram", "t.me",
  "producthunt", "skool", "wikipedia", "glassdoor", "ambitionbox",
];

/* ── path/query rules ─────────────────────────────────────────────────────── */

/** Query keys that mean "this page is a search result set". */
const SERP_QUERY_KEYS = [
  "q", "k", "query", "search_query", "searchquery", "keywords", "keyword",
  "text", "nquery", "as_q", "wd", "p", "s", "search", "searchtext", "st",
  "term", "terms", "rq", "encodedtext", "fn", "find",
];

/** Path shapes that mean search-results on ANY host. */
const SERP_PATH_RE = [
  /^\/s(\/|$)/,            // amazon.in/s?k=…, google /s?
  /^\/search\/?$/i,
  /^\/search[a-z]*\/?$/i,  // flipkart /searchn
  /^\/job-search/i,
  /^\/jobs?\/?$/,          // /jobs, /job (list view)
  /^\/kb\/search/i,
  /^\/jobs\/search/i,
  /^\/search\.aspx/i,
  /^\/find\/?$/i,
];

/** Path shapes that mean "this is the item's own page". */
const PRODUCT_PATH_RE = [
  /^\/dp\//,               // amazon product
  /^\/gp\/product\//,
  /^\/gp\/aod\//,
  /^\/gp\/aw\/d\//,
  /^\/gp\/detail/,
  /^\/product\/[^\/]+/i,
  /^\/products\/[^\/]+/i,  // Shopify / WooCommerce
  /^\/pdp\//i,
  /^\/p\/[^\/]/,           // generic short product path (store hosts)
  /^\/itm\/\d/i,           // ebay
  /^\/item\/\d/i,
  /^\/p\/product/i,
  /\/product-[^\/]+\/?$/,
  /\/productdetail\//i,
  /\/product-detail\//i,
  /\/catalog\/product\//i,
  /\/([a-z0-9-]+)-[A-Z0-9]{6,}\/?$/, // "honor-200-5g-B0D9R47712" style slugs
  // Flipkart/Croma put the id last under /p/ after a slug:
  //   flipkart.com/honor-200-5g-…-storage/p/itm12ab34cd
  //   croma.com/honor-200-5g-…-coral-pink-/p/2975572
  // Restricted to id-shaped segments so a Blogger "/p/about.html" static page
  // cannot be mistaken for a product (which would let it become an item link).
  /\/p\/(itm[a-z0-9_-]+|\d{5,})\/?$/i,
  // Amazon's canonical product URL puts a title slug BEFORE the id:
  //   amazon.in/HONOR-200-5G/dp/B0D9R47712
  //   amazon.in/Moonlight-6-7-inch-Quad-Curved-Display/dp/B0D7CG73R4
  // The anchored /^\/dp\// form above only matches the bare /dp/<id>, so real
  // product pages fell through as "Article" and could never be offered as the
  // item link — which is the whole point of this layer.
  /\/(?:gp\/)?(?:dp|aod|aw\/d|product)\/[a-z0-9]{9,}(?:[\/?]|$)/i,
];

/** Category / collection / browse pages: many items, so never "the" item. */
const LISTING_PATH_RE = [
  /^\/b\/[^\/]+/,          // amazon browse node
  /^\/b(\/|\?|$)/,         // amazon browse without a path: /b?node=…, /b
  /^\/collections\/[^\/]+\/?$/i,
  /^\/collections\/[^\/]+\/(products|pages)\//i,
  /^\/category\//i,
  /^\/categories\//i,
  /^\/c\/[^\/]+\/?$/i,
  /^\/departments?\//i,
  /^\/gp\/browse/,
  /^\/browse(\/|$)/,
  /^\/shop\/[^\/]+\/?$/i,
  /\/(list|grid|catalog)\/?$/i,
  // Brand storefronts and category pages seen in live results: they hold many
  // items, so they can never be "the" item the user asked to be linked to.
  /^\/stores?(\/|$)/i,      // amazon.in/stores/Honor/page/…
  /\/pr\/?$/i,              // flipkart.com/mobiles/honor~brand/pr?sid=…
  /^\/(mobiles?|electronics|computers)\//i, // flipkart category roots
];

const JOB_POSTING_PATH_RE = [
  /^\/job-details\//i,
  /^\/jobs\/view\//i,
  /^\/jobs\/promoted\//i,
  /^\/viewjob\//i,
  /^\/jobview\//i,
  /^\/jview\//i,
  /^\/job\/[A-Za-z0-9_-]{4,}/i,
  /^\/jobs\/\d{5,}/i,
  /^\/company\/[^\/]+\/jobs\/[^\/]+\//i,
];

/* ── helpers ──────────────────────────────────────────────────────────────── */

function hostLabels(host: string): string[] {
  return host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
}

/** Label-exact matching: "amazon.in" → ["amazon","in"] hits "amazon". */
function hostHas(host: string, names: string[]): boolean {
  const ls = hostLabels(host);
  return ls.some((l) => names.includes(l));
}

function hasSerpQuery(u: URL): boolean {
  for (const key of SERP_QUERY_KEYS) {
    const v = u.searchParams.get(key);
    if (v && v.trim().length > 0) return true;
  }
  return false;
}

function pathMatches(u: URL, res: RegExp[]): boolean {
  const p = u.pathname.toLowerCase();
  return res.some((re) => re.test(p));
}

/* ── public API ───────────────────────────────────────────────────────────── */

/**
 * Classify one URL. Never throws; unparseable input degrades to
 * { kind: "other" } so a single bad URL can never break a turn.
 */
export function classifyUrl(rawUrl: string): LinkClassification {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: "other", roleLabel: "Unparseable URL", reason: "malformed URL" };
  }
  const host = u.hostname;
  const path = u.pathname.toLowerCase();

  // 1. Google/Bing/DDG-style result pages.
  if (hostHas(host, SEARCH_ENGINE_HOSTS) && !/\/maps\b/.test(path)) {
    if (hostHas(host, ["google"]) && /^\/(search|maps\/search)/.test(path)) {
      return { kind: "serp", roleLabel: "Search-engine results page", reason: "search engine results path" };
    }
    if (hasSerpQuery(u) || path === "/" || /^\/(search|web|images|news)/.test(path)) {
      return { kind: "serp", roleLabel: "Search-engine results page", reason: "search engine" };
    }
  }

  // 2. Maps / place pages.
  if (hostHas(host, MAP_HOSTS) && /\/maps(\/|$)/.test(path)) {
    return { kind: "poi", roleLabel: "Map place page", reason: "maps place URL" };
  }
  if (hostHas(host, ["openstreetmap", "osm"]) && /^\/(way|node|relation)\//.test(path)) {
    return { kind: "poi", roleLabel: "Map place page", reason: "OSM element URL" };
  }

  // 3. Job boards.
  if (hostHas(host, JOB_BOARD_HOSTS)) {
    if (pathMatches(u, JOB_POSTING_PATH_RE) || u.searchParams.has("jobid") || u.searchParams.has("jk")) {
      return { kind: "job-posting", roleLabel: "Job posting", reason: "job posting path" };
    }
    if (pathMatches(u, SERP_PATH_RE) || hasSerpQuery(u)) {
      return { kind: "serp", roleLabel: "Job search page", reason: "job listing/search page" };
    }
    if (/^\/(company|profile|school)\//.test(path)) {
      return { kind: "reference", roleLabel: "Company profile page", reason: "employer profile, not a posting" };
    }
    if (hostHas(host, ["glassdoor", "ambitionbox"])) {
      return { kind: "review-listing", roleLabel: "Employer review page", reason: "employer reviews" };
    }
  }

  // 4. Local review / listing sites.
  if (hostHas(host, REVIEW_LISTING_HOSTS)) {
    if (pathMatches(u, SERP_PATH_RE) || (hasSerpQuery(u) && !/\/(restaurant|store|business|hotel)\//.test(path))) {
      return { kind: "serp", roleLabel: "Local search page", reason: "listing site search results" };
    }
    return { kind: "review-listing", roleLabel: "Review listing page", reason: "local review listing" };
  }

  // 5. Price-comparison / price-history hosts.
  if (hostHas(host, PRICE_AGGREGATOR_HOSTS)) {
    if (pathMatches(u, SERP_PATH_RE) || (hasSerpQuery(u) && path === "/")) {
      return { kind: "serp", roleLabel: "Price search page", reason: "price site search results" };
    }
    return { kind: "price-aggregator", roleLabel: "Price-comparison page", reason: "price comparison host" };
  }

  // 6. Sellers / stores — product vs category vs search.
  const isStore =
    hostHas(host, MARKETPLACE_HOSTS) ||
    /\.myshopify\.com$/.test(host.toLowerCase()) ||
    /\/(products|pdp)\//i.test(path);
  if (isStore) {
    // Product first: a dp/ URL carrying a `k=` param is still the product.
    if (pathMatches(u, PRODUCT_PATH_RE)) {
      return { kind: "product", roleLabel: "Seller product page", reason: "product detail path" };
    }
    if (pathMatches(u, LISTING_PATH_RE)) {
      return { kind: "product-listing", roleLabel: "Seller category page", reason: "category/collection path" };
    }
    if (pathMatches(u, SERP_PATH_RE) || hasSerpQuery(u) || path === "/") {
      const label = hostHas(host, MARKETPLACE_HOSTS) ? "Seller search page" : "Site search page";
      return { kind: "serp", roleLabel: label, reason: "search results on a store host" };
    }
  }

  // 7. Reference / community / generic article, by host labels.
  if (hostHas(host, COMMUNITY_HOSTS)) {
    if (hostHas(host, ["wikipedia", "wiktionary"])) {
      return { kind: "reference", roleLabel: "Encyclopedia article", reason: "wiki host" };
    }
    return { kind: "community", roleLabel: "Community discussion", reason: "social/forum host" };
  }
  if (hostHas(host, REFERENCE_HOSTS)) {
    if (/\/(dictionary|definitions?|meaning)\b/i.test(path) || hostHas(host, ["cambridge", "merriam", "webster", "dictionary", "collins", "vocabulary"])) {
      return { kind: "reference", roleLabel: "Dictionary entry", reason: "dictionary host" };
    }
    if (hostHas(host, ["github", "gitlab"])) {
      return { kind: "reference", roleLabel: "Code repository", reason: "source hosting site" };
    }
    if (/^\/wiki\//.test(path) || hostHas(host, ["wikipedia"])) {
      return { kind: "reference", roleLabel: "Encyclopedia article", reason: "encyclopedia path" };
    }
    return { kind: "reference", roleLabel: "Reference / docs page", reason: "reference host" };
  }

  // 8. Fallback path rules for unknown hosts.
  if (pathMatches(u, PRODUCT_PATH_RE)) {
    return { kind: "product", roleLabel: "Product page", reason: "product-shaped path" };
  }
  if (pathMatches(u, JOB_POSTING_PATH_RE)) {
    return { kind: "job-posting", roleLabel: "Job posting", reason: "job-shaped path" };
  }
  if (pathMatches(u, SERP_PATH_RE) || hasSerpQuery(u)) {
    return { kind: "serp", roleLabel: "Search-results page", reason: "search-shaped path or query" };
  }
  if (pathMatches(u, LISTING_PATH_RE)) {
    return { kind: "product-listing", roleLabel: "Listing page", reason: "listing-shaped path" };
  }
  const depth = path.split("/").filter(Boolean).length;
  if (depth >= 2) {
    return { kind: "article", roleLabel: "Article", reason: "content path on an unknown host" };
  }
  return { kind: "other", roleLabel: "Web page", reason: "unclassified page" };
}

/* ── claim eligibility table ──────────────────────────────────────────────── */

/**
 * Which source kinds may carry which claims. This is the rule that makes a
 * SERP page structurally incapable of supporting "in stock" or "the direct
 * link", no matter how confidently the main model phrases it.
 */
const ELIGIBILITY: Record<ClaimType, Partial<Record<SourceKind, Eligibility>>> = {
  price: {
    product: "primary",
    "price-aggregator": "primary",
    "review-listing": "secondary",
    poi: "secondary",
    article: "secondary",
    community: "secondary",
    "product-listing": "none",
    serp: "none",
    reference: "none",
    other: "none",
  },
  availability: {
    product: "primary",
    "price-aggregator": "secondary",
    poi: "secondary",
    // Everything else cannot establish stock of a specific variant.
    "product-listing": "none",
    serp: "none",
    reference: "none",
    article: "none",
    community: "none",
    other: "none",
  },
  existence: {
    product: "primary",
    "job-posting": "primary",
    poi: "primary",
    "product-listing": "secondary",
    "price-aggregator": "secondary",
    "review-listing": "secondary",
    article: "secondary",
    community: "secondary",
    reference: "secondary",
    serp: "none",
    other: "none",
  },
  "item-link": {
    product: "primary",
    "job-posting": "primary",
    poi: "primary",
    "review-listing": "secondary",
    "price-aggregator": "secondary",
    "product-listing": "secondary",
    article: "secondary",
    reference: "secondary",
    community: "none",
    serp: "none",
    other: "none",
  },
  "job-open": {
    "job-posting": "primary",
    article: "secondary",
    serp: "none",
    reference: "none",
    other: "none",
  },
  rating: {
    "review-listing": "primary",
    poi: "primary",
    product: "primary",
    article: "secondary",
    community: "secondary",
    serp: "none",
    reference: "none",
  },
  "review-count": {
    "review-listing": "primary",
    poi: "primary",
    product: "primary",
    article: "secondary",
    serp: "none",
    reference: "none",
  },
  "open-now": {
    poi: "primary",
    "review-listing": "secondary",
    product: "secondary",
    serp: "none",
    reference: "none",
    article: "none",
  },
  "deliverable-to": {
    product: "primary",
    // A delivery promise is a seller statement; nothing else can make it.
    serp: "none",
    reference: "none",
    article: "none",
    community: "none",
    other: "none",
  },
  version: {
    reference: "primary",
    product: "primary",
    article: "secondary",
    community: "secondary",
    serp: "none",
    other: "none",
  },
};

export function claimEligibility(kind: SourceKind, claim: ClaimType): Eligibility {
  return ELIGIBILITY[claim]?.[kind] ?? "none";
}

/** True when this kind can be presented as the item itself (never a SERP). */
export function canBeTheItem(kind: SourceKind): boolean {
  return claimEligibility(kind, "item-link") === "primary";
}

/** Kinds that are search result sets (never quotable as the item). */
export function isSerpLike(kind: SourceKind): boolean {
  return kind === "serp";
}
