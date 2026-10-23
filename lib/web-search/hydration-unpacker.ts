/**
 * Universal SSR / JS framework hydration unpacker.
 *
 * Millions of custom sites (portfolios, SaaS landing pages, indie dev
 * sites) look empty to a basic HTML scraper because the real content
 * lives in SSR hydration payloads. This module extracts readable text
 * and structured fields from every major framework's hydration state.
 *
 * Covers:
 *   - Next.js App Router (React Server Components): `self.__next_f.push`
 *     Flight payloads.
 *   - Next.js Pages Router: `<script id="__NEXT_DATA__">`.
 *   - Nuxt 3 / Vue SSR: `window.__NUXT__` and `<script id="__NUXT_DATA__">`.
 *   - Remix / React Router: `window.__remixContext`.
 *   - SvelteKit / Astro / Gatsby: embedded hydration props & islands data.
 *   - YouTube / video pages: `ytInitialPlayerResponse`, `ytInitialData`.
 *
 * The unpacker runs on the same HTML body the direct fetcher paid for —
 * no extra network round-trip. The output is a clean markdown block that
 * is prepended to the DOM extraction so text trapped in script state
 * is recovered.
 */

/* ── helpers ─────────────────────────────────────────────────────────── */

function docOf(html: string): any {
  // linkedom's parseHTML returns a Window, not a Document.
  try {
    // Lazy import to keep the module's load cost down
    const { parseHTML } = require("linkedom"); // linkedom returns a Window; pull the Document off it
    const w: any = parseHTML(html);
    return w?.document ?? w;
  } catch {
    return null;
  }
}

/**
 * Walk an arbitrary JSON payload (any shape) and pull every leaf string
 * that looks like human-readable text (length > 8, mostly alphabetic).
 * This is the fallback when a framework's payload shape isn't one we
 * specifically know — it catches SvelteKit islands, Gatsby page context,
 * and any custom hydration object.
 */
function harvestStrings(obj: any, depth = 0, budget: string[] = []): string[] {
  if (depth > 6 || budget.length > 200) return budget;
  if (typeof obj === "string") {
    const clean = obj.replace(/\s+/g, " ").trim();
    if (clean.length > 8 && /[a-zA-Z]{4}/.test(clean)) budget.push(clean);
    return budget;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) harvestStrings(v, depth + 1, budget);
    return budget;
  }
  if (obj && typeof obj === "object") {
    // Skip the big binary-ish keys that would swamp the harvest
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === "id" ||
        k === "key" ||
        k === "component" ||
        k.startsWith("__")
      )
        continue;
      harvestStrings(v, depth + 1, budget);
    }
  }
  return budget;
}

/**
 * Convert a harvested string list into a clean markdown summary, deduped
 * and capped. This is the "universal harvest" — it's what you get when a
 * framework's payload shape isn't specifically recognized.
 */
function summarizeStrings(strings: string[]): string {
  const seen = new Set<string>();
  const uniq = strings.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key) || s.length < 10 || s.length > 1500) return false;
    seen.add(key);
    return true;
  });
  if (uniq.length === 0) return "";
  // Group into lines of ~200 chars for readable markdown
  const lines: string[] = uniq
    .slice(0, 60)
    .map((s) => "- " + s.slice(0, 300));
  return "## Hydration text (universal harvest)\n" + lines.join("\n");
}

/* ── framework-specific extractors ─────────────────────────────────── */

/**
 * Next.js App Router (React Server Components): parse the
 * `self.__next_f.push([N, "chunk", ...])` Flight payloads. RSC chunks
 * carry component text, headings, props, and table cells as JSON
 * strings in the push array. We walk every push call and harvest the
 * string leaves.
 */
function nextFlightUnpack(html: string): string {
  const out: string[] = [];
  // Find every self.__next_f.push([1, "..."]) call
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(html)) !== null && count < 40) {
    count++;
    // The chunk is a JSON-escaped string — unescape it
    let chunk: string;
    try {
      chunk = JSON.parse('"' + m[1] + '"');
    } catch {
      chunk = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    // RSC chunks are JSON strings: "[id","type",props]"
    // Harvest all string leaves
    for (const s of harvestStrings(chunk, 0, [])) {
      out.push(s);
    }
  }
  if (out.length === 0) return "";
  return "## Next.js RSC flight payload\n" + summarizeStrings(out);
}

/**
 * Next.js Pages Router: parse `<script id="__NEXT_DATA__" type="application/json">`.
 */
function nextDataUnpack(html: string): string {
  const m = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m || !m[1]) return "";
  let data: any;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    return "";
  }
  const lines: string[] = [];
  const build = data?.props?.pageProps?.buildManifest;
  const page = data?.props?.pageProps;
  const article = page?.article ?? page?.post ?? page?.content;
  if (article) {
    const title = article.title ?? article.name;
    if (title) lines.push("## " + title);
    const body = article.body ?? article.content ?? article.html;
    if (body) {
      lines.push(
        typeof body === "string"
          ? body.replace(/<[^>]+>/g, " ").slice(0, 4000)
          : JSON.stringify(body).slice(0, 4000),
      );
    }
  } else if (page) {
    // Harvest strings from pageProps directly
    lines.push("## __NEXT_DATA__ pageProps");
    lines.push(summarizeStrings(harvestStrings(page, 0, [])));
  }
  void build;
  const md = lines.join("\n\n");
  return md.length >= 40 ? md : "";
}

/**
 * Nuxt 3 / Vue SSR: `window.__NUXT__` (Nuxt 2) and
 * `<script id="__NUXT_DATA__">` (Nuxt 3).
 */
function nuxtUnpack(html: string): string {
  // Nuxt 3: <script id="__NUXT_DATA__" type="application/json">[...]</script>
  const m3 = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (m3 && m3[1]) {
    let data: any;
    try {
      data = JSON.parse(m3[1].trim());
    } catch {
      data = m3[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) {
      return "## Nuxt 3 hydration state\n" + summarizeStrings(strs);
    }
  }

  // Nuxt 2 / legacy: window.__NUXT__ = {...}
  const m2 = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m2 && m2[1]) {
    let data: any;
    try {
      data = JSON.parse(m2[1]);
    } catch {
      data = m2[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) {
      return "## Nuxt hydration state\n" + summarizeStrings(strs);
    }
  }
  return "";
}

/**
 * Remix / React Router: window.__remixContext / window.__reactRouterContext.
 */
function remixUnpack(html: string): string {
  const m =
    html.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\})\s*;/) ??
    html.match(/window\.__reactRouterContext\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m || !m[1]) return "";
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    data = m[1];
  }
  const strs = harvestStrings(data, 0, []);
  if (strs.length === 0) return "";
  return "## Remix hydration state\n" + summarizeStrings(strs);
}

/**
 * SvelteKit / Astro / Gatsby: look for embedded hydration props.
 *   - SvelteKit: `window.__sveltekit__` object payload
 *   - Astro: `astro-islands` div with JSON data
 *   - Gatsby: `window.___gatsby` payload or gatsby-script tag
 */
function sveltekitAstroGatsbyUnpack(html: string): string {
  const lines: string[] = [];

  // SvelteKit
  const mk = html.match(/window\.__sveltekit__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (mk && mk[1]) {
    let data: any;
    try {
      data = JSON.parse(mk[1]);
    } catch {
      data = mk[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## SvelteKit hydration\n" + summarizeStrings(strs));
  }

  // Astro islands
  const ma = html.match(/<div[^>]*id="astro-islands"[^>]*>([\s\S]*?)<\/div>/);
  if (ma && ma[1]) {
    let data: any;
    try {
      data = JSON.parse(ma[1].trim());
    } catch {
      data = ma[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## Astro islands data\n" + summarizeStrings(strs));
  }

  // Gatsby
  const mg =
    html.match(/window\.___gatsby\s*=\s*(\{[\s\S]*?\})\s*;/) ??
    html.match(/<script[^>]*id="gatsby-script"[^>]*>([\s\S]*?)<\/script>/);
  if (mg && mg[1]) {
    let data: any;
    try {
      data = JSON.parse(mg[1]);
    } catch {
      data = mg[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## Gatsby hydration\n" + summarizeStrings(strs));
  }

  return lines.join("\n\n");
}

/**
 * YouTube / video pages: parse `ytInitialPlayerResponse` and
 * `ytInitialData` for descriptions, chapters, and metadata.
 */
function youtubeUnpack(html: string): string {
  const out: string[] = [];

  const mpr = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  if (mpr && mpr[1]) {
    let data: any;
    try {
      data = JSON.parse(mpr[1]);
    } catch {
      data = mpr[1];
    }
    const vd = data?.videoDetails;
    if (vd) {
      if (vd.title) out.push("## YouTube video: " + vd.title);
      if (vd.author) out.push("Channel: " + vd.author);
      if (vd.viewCount) out.push("Views: " + vd.viewCount);
      if (vd.shortDescription) out.push("Description: " + vd.shortDescription.slice(0, 2000));
    }
    // Chapters
    const chapters: any[] =
      data?.macros?.chapters ?? data?.chapters ?? [];
    if (chapters.length > 0) {
      out.push("Chapters:");
      for (const ch of chapters.slice(0, 10)) {
        out.push("- " + (ch.title?.simpleText ?? ch.title ?? ""));
      }
    }
  }

  const mdi = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});/);
  if (mdi && mdi[1]) {
    let data: any;
    try {
      data = JSON.parse(mdi[1]);
    } catch {
      data = mdi[1];
    }
    const strs = harvestStrings(data, 0, []).filter((s) => s.length > 20);
    if (strs.length > 0) {
      out.push("## YouTube data (ytInitialData)\n" + summarizeStrings(strs));
    }
  }

  return out.join("\n\n");
}

/* ── generic recursive JSON → entity-card walker (universal) ───────────── */

/**
 * Semantic key patterns (no site hardcoding): any object that exposes at
 * least two of these field names is treated as an "entity card" and
 * emitted as a compact line. This is what makes the hydration unpacker
 * site-agnostic — a Myntra product object, a Zomato restaurant object,
 * a BookMyShow event object, a Workday job posting, or a Flipkart listing
 * all share a handful of field names (`name`, `title`, `headline`,
 * `price`, `mrp`, `rating`, `address`, `showtime`, `cast`, `salary`,
 * `inStock`, ...) and this walker recognizes them without knowing the
 * site.
 */
const ENTITY_FIELD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^(name|title|headline|heading|label|displayname|displayName)$/i, label: "name" },
  { re: /^(description|desc|summary|synopsis|shortdescription|shortDescription|blurb|tagline)$/i, label: "desc" },
  { re: /^(price|mrp|offerprice|offerPrice|discountedprice|discountedPrice|sellingprice|sellingPrice|finalprice|finalPrice|listprice|listPrice|cost|rate|amount|salary|salaryrange|salaryRange|baseprice|basePrice|minprice|minPrice|maxprice|maxPrice)$/i, label: "price" },
  { re: /^(currency|pricecurrency|priceCurrency|ccy)$/i, label: "currency" },
  { re: /^(rating|ratingvalue|ratingValue|stars|starrating|starRating|score|avgRating|avgrating|reviewcount|reviewCount|ratingscount|ratingsCount|voteCount|votes)$/i, label: "rating" },
  { re: /^(availability|instock|inStock|stockstatus|stockStatus|outofstock|outOfStock|soldout|soldOut)$/i, label: "availability" },
  { re: /^(address|location|locality|area|city|state|region|country|venue|venueid|venueId|geo|addressline|addressLine|fulladdress|fullAddress|postalcode|postalCode|pincode|pinCode|zip|zipcode|zipCode|nearby)$/i, label: "address" },
  { re: /^(cuisine|cuisines|category|subcategory|subCategory|genre|type|tag|tags|kind|domain|department|brand|vendor|company|organization|organisation|artist|author|director|producer|host|channel)$/i, label: "category" },
  { re: /^(showtime|showtimes|showTimes|showtimes|start|startTime|end|endTime|date|time|datetime|datePublished|eventdate|eventDate|schedule|session|sessions|slot|slots|day|dayofweek|dayOfWeek|weekday|weekend|morning|afternoon|evening|late)$/i, label: "time" },
  { re: /^(cast|castmembers|castMembers|crew|director|actors|actress|performer|performers|artist|artists|writer|writers)$/i, label: "cast" },
  { re: /^(url|link|href|path|permalink|slug|website|webpage|webPage|shareurl|shareUrl|canonical|id|identifier|sku|mpn|ean|upc|asin|isbn)$/i, label: "id" },
  { re: /^(ingredients|components|parts|features|highlights|benefits|specs|specifications|sizes|variants|flavors|flavours|colours|colors|options)$/i, label: "list" },
  { re: /^(review|reviews|testimonial|testimonials|feedback|comment|comments|pr|pros|cons|verdict|summary)$/i, label: "review" },
  { re: /^(phone|contact|contactnumber|contactNumber|customerCare|support|supportphone|supportPhone|email|helpdesk|helpDesk)$/i, label: "contact" },
  { re: /^(hours|openingHours|openhours|openHours|servicehours|serviceHours|availabilityhours|availabilityHours|operatinghours|operatingHours|schedule)$/i, label: "hours" },
  { re: /^(delivery|deliverytime|deliveryTime|deliverable|deliverablein|deliverableIn|shipping|shippable|shippablein|shippableIn|shippableIn|arrival|expectedarrival|expectedArrival|sla|warranty|guarantee|refund)$/i, label: "delivery" },
  { re: /^(image|imageurl|imageUrl|img|thumbnail|thumb|cover|banner|poster|hero|media|videourl|videoUrl|video|thumbnailurl|thumbnailUrl)$/i, label: "image" },
  { re: /^(quantity|qty|count|num|total|size|weight|dimension|dimensions|measure|measurements|capacity|volume|power|battery|screen|resolution|storage|ram|cpuspeed|cpuSpeed|memory|os|platform|architecture|bit)$/i, label: "spec" },
];

const SKIP_KEYS = new Set([
  "@context", "@type", "@id", "@graph", "id", "key", "component",
  "children", "props", "scriptUrl", "css", "cssUrl", "style",
  "classId", "dataId", "hash", "nonce", "bundlePath", "entry", "manifest",
  "webpack", "webpackChunk", "webpackJsonp", "require", "module",
  "react", "webpackPreload", "_r", "_s", "url", "href", "src", "alt",
  "width", "height", "format", "mime", "contentType", "charset", "encoding",
  "cookie", "token", "auth", "apiKey", "session", "csrf", "sentry",
]);

/**
 * Walk an arbitrary JSON object and emit compact entity cards for every
 * object that matches ≥2 semantic field patterns. Recurses up to 14
 * levels, stops when `maxCards` is reached, and deduplicates on (name,
 * id-ish field) so the same card doesn't repeat across parent/child
 * copies of a state tree.
 */
export interface WalkerOptions {
  /** Max number of entity cards to emit (default 60). */
  maxCards?: number;
  /** Label for the output header (the window-key that owned the JSON). */
  label?: string;
  /** Max recursion depth (default 14). */
  maxDepth?: number;
}

/**
 * Generic recursive JSON → readable-entity-card markdown.
 * This is THE universal mechanism (Part 4): any site, any SPA framework,
 * any shape of hydration state — if the objects carry the semantic keys
 * above, they surface here as readable cards without per-site rules.
 */
export function walkGenericJsonForEntities(
  root: unknown,
  opts: WalkerOptions = {},
): string {
  const maxCards = opts.maxCards ?? 60;
  const maxDepth = opts.maxDepth ?? 14;
  const label = opts.label ?? "hydration";

  const cards: string[] = [];
  const seen = new Set<string>();

  function emit(o: Record<string, unknown>): boolean {
    const matched = new Map<string, string>();
    let matchedFields = 0;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === "") continue;
      const isObj = typeof v === "object";
      if (isObj && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      for (const p of ENTITY_FIELD_PATTERNS) {
        if (p.re.test(k)) {
          matched.set(p.label, String(v).slice(0, 300).replace(/\s+/g, " "));
          matchedFields++;
          break;
        }
      }
      void isObj;
    }
    // An object must match ≥2 distinct semantic labels to count as an
    // entity card — a random config blob with one `name` key is not an
    // entity. (E.g. {name, price, rating, availability} = product;
    // {name, address, cuisine, hours} = restaurant; {title, showtime,
    // cast, venue} = event.)
    if (matchedFields < 2) return false;
    const keyParts = [o.name, o.title, o.headline, o.id, o.sku, o.url, o.slug]
      .filter((x) => typeof x === "string" && (x as string).length > 0)
      .map((x) => String(x).toLowerCase());
    const dedupeKey = keyParts.join("|") || matched.size > 0 ? JSON.stringify([...matched.entries()].sort()) : "anon";
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);

    const lines: string[] = [];
    const nameVal =
      o.name ?? o.title ?? o.headline ?? o.displayName ?? o.label;
    if (typeof nameVal === "string" && nameVal.length > 0) {
      lines.push("### " + nameVal.slice(0, 200));
    }
    const ordered: string[] = [];
    for (const lbl of ["desc", "price", "currency", "rating", "availability", "address", "category", "time", "cast", "contact", "hours", "delivery", "list", "spec", "review"]) {
      if (matched.has(lbl)) ordered.push("- " + lbl + ": " + matched.get(lbl));
    }
    lines.push(...ordered);
    // Also surface any `url` field the pattern matched so the caller can
    // cite the exact source page of this card.
    if (typeof o.url === "string" || typeof o.link === "string" || typeof o.href === "string") {
      const linkVal = o.url ?? o.link ?? o.href;
      lines.push("- link: " + String(linkVal).slice(0, 200));
    }
    cards.push(lines.join("\n"));
    return cards.length >= maxCards;
  }

  function walk(node: unknown, depth: number): boolean {
    if (depth > maxDepth || cards.length >= maxCards) return true;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) {
        if (walk(item, depth + 1)) return true;
      }
      return cards.length >= maxCards;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (emit(obj)) return true;
      for (const [k, v] of Object.entries(obj)) {
        if (SKIP_KEYS.has(k) || String(k).startsWith("__")) continue;
        if (v === null || v === undefined) continue;
        if (walk(v, depth + 1)) return true;
      }
    }
    return cards.length >= maxCards;
  }

  walk(root, 0);
  if (cards.length === 0) return "";
  return (
    "## " + label + " — " + cards.length + " entity card(s) (universal JSON walk)\n" +
    cards.join("\n\n")
  );
}

/* ── public API ─────────────────────────────────────────────────────── */

/**
 * Run every framework-specific hydration unpacker against the raw HTML
 * and return the combined clean markdown. The extractor prepends this to
 * the DOM extraction so content trapped in script state is recovered.
 *
 * This is the extractor's universal hydration channel (Pass A) — it
 * covers Next.js App Router, Nuxt 3, Remix,
 * SvelteKit, Astro, Gatsby, and YouTube, not just `__NEXT_DATA__` and
 * `ytInitialData`.
 */
export function unpackHydration(html: string): string {
  const parts: string[] = [];

  // Run every unpacker; each returns "" when it doesn't apply
  parts.push(nextFlightUnpack(html));
  parts.push(nextDataUnpack(html));
  parts.push(nuxtUnpack(html));
  parts.push(remixUnpack(html));
  parts.push(sveltekitAstroGatsbyUnpack(html));
  parts.push(youtubeUnpack(html));

  const combined = parts.filter((p) => p && p.length > 0).join("\n\n");
  if (combined.length === 0) return "";
  return "[SSR Hydration Unpack]\n\n" + combined;
}
