/**
 * Pass A structured-facts extractor (cheerio) — JSON-LD (all schema.org
 * types incl. @graph), Microdata, and OpenGraph/Twitter meta → a compact
 * markdown facts block.
 *
 * Replaces the deleted universal-discovery.ts schema channel. Firecrawl-
 * grade coverage: Product offers + aggregateRating (Blinkit/Myntra/Zepto
 * prices), JobPosting (Workday/Greenhouse), Movie/TVSeries aggregateRating
 * (IMDb ratings), FAQPage Q&A, Person/Organization profiles (LinkedIn
 * JSON-LD when served), Event, LocalBusiness (.gov/POI), Recipe, HowTo,
 * plus a generic key/value fallback for every unknown @type so NO schema
 * block is silently dropped. Hydration states (__NEXT_DATA__,
 * __NEXT_Hydration __NEXT_F, __PRELOADED_STATE__, __myx, __INITIAL_STATE__)
 * remain the job of hydration-unpacker.ts.
 */
import * as cheerio from "cheerio";

/* ── public API ─────────────────────────────────────────────────────── */

/** Extract `[Structured Page Facts]` markdown from a full HTML document. */
export function schemaExtract(html: string): string {
  if (!html || html.length < 200) return "";
  let $: any;
  try {
    $ = cheerio.load(html);
  } catch {
    return "";
  }

  const out: string[] = [];
  const title = $("title").first().text()?.trim();
  if (title) out.push("# " + title);

  const schemaLines: string[] = [];

  // ── JSON-LD (script[type="application/ld+json"], incl. @graph) ──
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_: number, el: any) => {
    const raw = $(el).text()?.trim();
    if (!raw) return;
    try {
      blocks.push(JSON.parse(sanitizeLdJson(raw)));
    } catch {
      /* malformed block — skip */
    }
  });
  for (const line of schemaExtractFromBlocks(blocks)) schemaLines.push(line);

  // ── Microdata (itemtype= / itemprop=) ──
  const micro: string[] = [];
  $("[itemtype]").each((_: number, el: any) => {
    if (micro.length >= 4) return;
    const itemType = $(el).attr("itemtype");
    const props: string[] = [];
    $(el)
      .find("[itemprop]")
      .each((__: number, p: any) => {
        const prop = $(p).attr("itemprop");
        const val = $(p).text()?.trim() || $(p).attr("content") || "";
        if (prop && val) props.push("- " + prop + ": " + val.slice(0, 200));
      });
    if (props.length) {
      micro.push("## Microdata: " + (itemType ?? "unknown") + "\n" + props.slice(0, 12).join("\n"));
    }
  });
  for (const m of micro) schemaLines.push(m);

  // ── OpenGraph / Twitter meta ──
  const metaLines: string[] = [];
  const props = new Set([
    "og:title", "og:description", "og:site_name", "og:url",
    "og:image", "og:video", "og:type", "og:price:amount", "og:price:currency",
    "twitter:title", "twitter:description", "twitter:card",
    "twitter:site", "twitter:creator", "twitter:data1", "twitter:label1",
    "twitter:data2", "twitter:label2",
  ]);
  $("meta").each((_: number, el: any) => {
    const prop = $(el).attr("property") ?? $(el).attr("name");
    const content = $(el).attr("content");
    if (prop && props.has(prop) && content) {
      metaLines.push(prop + ": " + content.slice(0, 300));
    }
  });
  if (metaLines.length > 0) {
    schemaLines.push("## Page Metadata (OpenGraph)\n" + metaLines.join("\n"));
  }

  if (schemaLines.length === 0) return "";
  return "[Structured Page Facts]\n\n" + schemaLines.join("\n\n").trim();
}

/** Format already-parsed JSON-LD objects → markdown sections. */
export function schemaExtractFromBlocks(blocks: unknown[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    for (const item of flattenSchema(block)) {
      const md = formatSchemaItem(item);
      if (md) lines.push(md);
    }
  }
  return lines;
}

/* ── internals ──────────────────────────────────────────────────────── */

// JSON-LD embedded in HTML may contain </script>-breaking strings or
// single-quoted pseudo-JSON; cheerio already unescapes entity refs.
function sanitizeLdJson(raw: string): string {
  return raw.replace(/<!--|-->/g, "").trim();
}

/** Expand arrays + @graph into a flat item list. */
function flattenSchema(node: any): any[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(flattenSchema);
  if (typeof node === "object" && Array.isArray(node["@graph"])) {
    return [stripContext(node), ...node["@graph"].flatMap(flattenSchema)];
  }
  return [stripContext(node)];
}

function stripContext(item: any): any {
  if (!item || typeof item !== "object") return item;
  const { "@context": _ctx, ...rest } = item;
  return rest;
}

function typeOf(item: any): string {
  const t = item?.["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x: any) => typeof x === "string").join(",");
  return "";
}

/** Primitives, {name}, {value}, and arrays of either → plain string. */
function v(x: any): string {
  if (x == null) return "";
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(v).filter(Boolean).join(", ");
  if (typeof x === "object") {
    if (x.name != null) return v(x.name);
    if (x.value != null) return v(x.value);
    if (x.telephone != null) return v(x.telephone);
    if (x.text != null) return v(x.text);
    return "";
  }
  return "";
}

function ratingLine(agg: any, label = "Rating"): string {
  if (!agg || typeof agg !== "object") return "";
  const rv = v(agg.ratingValue);
  if (!rv) return "";
  const parts = [label + ": " + rv];
  const best = v(agg.bestRating);
  if (best) parts.push("of " + best);
  const count = v(agg.ratingCount) || v(agg.reviewCount) || v(agg.userRatingCount);
  if (count) parts.push("(" + count + " ratings)");
  return parts.join(" ");
}

/**
 * schema.org properties such as `sameAs` legitimately arrive as a single
 * value OR an array (LinkedIn's JSON-LD ships a bare string) — normalize
 * before array methods, or `.slice().map()` throws on a raw string.
 */
function asList(x: any): any[] {
  return Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];
}

function fmt(label: string, value: string): string {
  return value ? label + ": " + value : "";
}

function section(header: string, lines: (string | "")[]): string {
  const body = lines.filter(Boolean);
  return body.length ? header + "\n" + body.join("\n") : "";
}

function formatSchemaItem(item: any): string {
  if (!item || typeof item !== "object") return "";
  const t = typeOf(item);
  const t1 = t.split(",")[0];

  switch (t1) {
    case "JobPosting":
      return section("## Job Posting: " + (v(item.title) || v(item.name) || "posting"), [
        fmt("Company", v(item.hiringOrganization)),
        fmt("Location", v(item.jobLocation?.address) || v(item.jobLocation)),
        fmt("Employment type", v(item.employmentType)),
        fmt("Posted", v(item.datePosted)),
        fmt("Valid through", v(item.validThrough)),
        fmt("Direct apply", v(item.apply)),
        v(item.description)
          ? "Description: " + v(item.description).replace(/\s+/g, " ").slice(0, 800)
          : "",
        fmt("Salary", v(item.baseSalary)),
      ]);
    case "Product":
      return section("## Product: " + (v(item.name) || "unnamed"), [
        ...offersLines(item.offers),
        ratingLine(item.aggregateRating),
        fmt("Description", v(item.description)?.slice(0, 500)),
        fmt("Brand", v(item.brand)),
        fmt("SKU", v(item.sku) || v(item.mpn) || v(item.gtin13)),
        fmt("Availability", v(item.availability)),
      ]);
    case "Article":
    case "NewsArticle":
    case "BlogPosting":
    case "TechArticle":
    case "ReportageNewsArticle":
      return section("## Article: " + (v(item.headline) || v(item.name) || "untitled"), [
        fmt("Author", v(item.author)),
        fmt("Publisher", v(item.publisher)),
        fmt("Published", v(item.datePublished)),
        fmt("Modified", v(item.dateModified)),
        fmt("Section", v(item.articleSection)),
        ratingLine(item.aggregateRating),
        v(item.articleBody)
          ? "Body: " + v(item.articleBody).slice(0, 1500)
          : v(item.description)
            ? "Description: " + v(item.description).slice(0, 600)
            : "",
      ]);
    case "Movie":
    case "TVSeries":
    case "TVEpisode":
    case "MovieSeries":
    case "VideoObject":
      return section("## " + t1 + ": " + (v(item.name) || v(item.headline) || "untitled"), [
        fmt("Type", t),
        fmt("Description", v(item.description)?.replace(/\s+/g, " ").slice(0, 600)),
        fmt("Duration", v(item.duration)),
        fmt("Content rating", v(item.contentRating)),
        fmt("Genre", v(item.genre)),
        fmt("Released", v(item.datePublished) || v(item.uploadDate)),
        fmt("Director", v(item.director)),
        fmt("Cast", v(item.actor)?.slice(0, 400)),
        ratingLine(item.aggregateRating, "IMDb-style rating"),
        fmt("Uploader", v(item.uploadedBy)),
      ]);
    case "FAQPage": {
      const qas = asList(item.mainEntity).slice(0, 8).map((q: any, i: number) => {
        const name = v(q?.name);
        const answer = (q?.acceptedAnswer?.text ?? v(q?.acceptedAnswer) ?? "").toString();
        return name ? `Q${i + 1}: ${name}\nA${i + 1}: ${answer.slice(0, 600)}` : "";
      });
      return qas.filter(Boolean).length
        ? "## FAQ\n" + qas.filter(Boolean).join("\n\n")
        : "";
    }
    case "HowTo": {
      const steps = asList(item.step).slice(0, 8).map((s: any) => {
        const n = v(s?.name) || v(s?.itemListElement);
        const txt = v(s?.text) || v(s);
        return n ? `- ${n}${txt && txt !== n ? ": " + txt.slice(0, 300) : ""}` : txt ? "- " + txt.slice(0, 300) : "";
      });
      return steps.filter(Boolean).length
        ? "## How-To: " + (v(item.name) || "") + "\n" + steps.filter(Boolean).join("\n")
        : "";
    }
    case "Recipe":
      return section("## Recipe: " + (v(item.name) || ""), [
        fmt("Description", v(item.description)?.slice(0, 400)),
        fmt("Prep time", v(item.prepTime)),
        "Ingredients: " + asList(item.recipeIngredient).slice(0, 12).map(v).filter(Boolean).join(", "),
        fmt("Yield", v(item.recipeYield)),
        ratingLine(item.aggregateRating),
      ]);
    case "Event":
      return section("## Event: " + (v(item.name) || ""), [
        fmt("Starts", v(item.startDate)),
        fmt("Ends", v(item.endDate)),
        fmt("Location", v(item.location?.name) || v(item.location)),
        fmt("Organizer", v(item.organizer)),
        ...offersLines(item.offers),
        fmt("Description", v(item.description)?.slice(0, 400)),
      ]);
    case "LocalBusiness":
    case "Restaurant":
    case "Store":
    case "FoodEstablishment":
    case "GovernmentOrganization":
    case "GovernmentService":
      return section("## " + t1 + ": " + (v(item.name) || ""), [
        fmt("Address", v(item.address) || v(item.address?.streetAddress)),
        fmt("Phone", v(item.telephone)),
        fmt("Opening hours", v(item.openingHours)?.slice(0, 300)),
        fmt("Price range", v(item.priceRange)),
        ratingLine(item.aggregateRating),
        fmt("Description", v(item.description)?.slice(0, 400)),
      ]);
    case "Person":
    case "ProfilePage":
      return section("## Person: " + (v(item.name) || (t1 === "ProfilePage" ? v(item.mainEntity?.name) : "")), [
        fmt("Job title", v(item.jobTitle) || v(item.mainEntity?.jobTitle)),
        fmt("Works for", v(item.worksFor) || v(item.mainEntity?.worksFor)),
        fmt("Email", v(item.email)?.slice(0, 120)),
        fmt("Address", v(item.address)),
        "Same as: " + asList(item.sameAs ?? item.mainEntity?.sameAs).slice(0, 5).map(v).filter(Boolean).join(", "),
        fmt("Description", v(item.description) || v(item.mainEntity?.description))?.slice(0, 500),
      ]);
    case "Organization":
      return section("## Organization: " + (v(item.name) || ""), [
        fmt("URL", v(item.url)),
        fmt("Description", v(item.description)?.slice(0, 400)),
        fmt("Founded", v(item.foundingDate)),
        "Same as: " + asList(item.sameAs).slice(0, 5).map(v).filter(Boolean).join(", "),
      ]);
    case "WebSite":
    case "WebPage":
    case "ImageObject":
    case "BreadcrumbList":
    case "SearchAction":
    case "Audience":
    case "DefinativeDescription":
      return "";
    case "SoftwareApplication":
    case "WebApplication":
      return section("## " + t1 + ": " + (v(item.name) || ""), [
        fmt("Operating system", v(item.operatingSystem)),
        fmt("Version", v(item.softwareVersion)),
        ...offersLines(item.offers),
        ratingLine(item.aggregateRating),
        fmt("Description", v(item.description)?.slice(0, 400)),
      ]);
    case "Dataset":
      return section("## Dataset: " + (v(item.name) || ""), [
        fmt("Creator", v(item.creator)),
        fmt("Published", v(item.datePublished)),
        fmt("Description", v(item.description)?.slice(0, 500)),
      ]);
    default:
      return formatGeneric(item, t);
  }
}

function offersLines(offers: any): string[] {
  if (!offers) return [];
  const arr = Array.isArray(offers) ? offers : [offers];
  return arr.slice(0, 4).map((o: any) => {
    const price = v(o?.price) || v(o?.lowPrice) || v(o?.minPrice);
    const cur = v(o?.priceCurrency);
    const parts: string[] = [];
    if (price) parts.push("Price: " + price + (cur ? " " + cur : ""));
    const avail = v(o?.availability);
    if (avail) parts.push("Availability: " + avail.replace(/^https:\/\/schema.org\//, ""));
    if (o?.url && parts.length === 0) parts.push("Offer: " + String(o.url).slice(0, 200));
    return parts.join(" · ");
  });
}

/** Unknown @type: compact key/value so no schema block is wasted. */
function formatGeneric(item: any, t: string): string {
  const skip = new Set(["@type", "@id", "@context", "@graph", "image", "logo", "potentialAction", "mainEntityOfPage", "dateModified", "inLanguage", "keywords"]);
  const lines: string[] = [];
  for (const [k, val] of Object.entries(item)) {
    if (skip.has(k)) continue;
    const s = v(val) || (typeof val === "object" ? JSON.stringify(val) : "");
    if (s) lines.push("- " + k + ": " + s.slice(0, 400));
    if (lines.length >= 14) break;
  }
  if (lines.length < 2) return "";
  const name = v(item.name) || v(item.headline) || v(item.title) || t;
  return section("## " + (t || "Schema") + (name ? ": " + name : ""), lines);
}
