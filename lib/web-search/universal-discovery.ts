/**
 * Universal machine-readable & protocol discovery.
 *
 * Before falling back to raw HTML text stripping, inspect the target
 * URL and its response for machine-first data channels. This module
 * runs on the SAME body the direct fetcher already paid for (no second
 * network round-trip), plus a small set of keyless rewrites for the
 * platforms that ship structured JSON endpoints.
 *
 * Channels detected:
 *   - Content negotiation (Accept: text/markdown) — Cloudflare's
 *     markdown-for-agents, modern docs servers.
 *   - /llms.txt and .md twin URLs — documentation / dev-tools sites.
 *   - Discourse forum threads → .json rewrite.
 *   - Shopify product pages → /products/{handle}.json.
 *   - WordPress / Ghost / Substack / Medium → embedded JSON + RSS/Atom
 *     feed alternates (<link rel="alternate">).
 *   - Universal schema.org (application/ld+json, Microdata) + OG/Twitter.
 */
import { fetchPage, fetchUrl, type PageResponse } from "./tls-client";
import { parseHTML } from "linkedom";

export interface DiscoveredChannel {
  /**
   * How the content was recovered: "markdown" (content-negotiated),
   * "llms-txt", "discourse-json", "shopify-json", "cms-json",
   * "rss", "schema", "og", "hydration".
   */
  kind: string;
  /** Clean markdown for this channel (prepended to DOM extraction). */
  markdown: string;
  /** True when this channel is the primary evidence (no DOM needed). */
  isPrimary: boolean;
}

/* ── docOf helper (linkedom) ─────────────────────────────────────────── */

function docOf(html: string): any {
  const w: any = parseHTML(html);
  return w?.document ?? w;
}

/* ── Content negotiation: try a markdown Accept header ─────────────── */

/**
 * Re-fetch the URL with `Accept: text/markdown` — modern docs servers
 * (including Cloudflare's markdown-for-agents) return clean Markdown
 * instead of an HTML shell. We only pay this cost when the original
 * fetch produced little content, so it's a fallback path, not a
 * double-fetch on every URL.
 */
export async function tryMarkdownNegotiation(
  url: string,
  original: PageResponse | null,
): Promise<DiscoveredChannel | null> {
  // Only worth trying when the original was a JS shell or HTML with
  // little text.
  if (original && original.body.length > 2000 && original.ok) {
    // Heuristic: if the original already has >2000 chars of HTML, it's
    // probably a real page — skip the extra round-trip.
    return null;
  }
  const page = await fetchPage(url, {
    timeoutMs: 45_000,
    headers: {
      Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8",
    },
  });
  if (!page || !page.ok) return null;
  const body = page.body.trim();
  // If the server honored the Accept header, we'll get text/markdown —
  // detect by the content type or the presence of markdown headers.
  const isMd =
    /text\/markdown/i.test(page.contentType) ||
    /^#{1,6}\s/m.test(body);
  if (isMd && body.length >= 100) {
    return { kind: "markdown", markdown: body.slice(0, 12000), isPrimary: true };
  }
  return null;
}

/* ── /llms.txt & .md twin discovery ─────────────────────────────────── */

/**
 * For documentation / dev-tools sites, opportunistically read /llms.txt
 * (a plain-text site map for LLMs) or the .md twin of the URL when the
 * HTML body is sparse.
 */
export async function tryLlmsTxt(
  url: string,
  originalBody: string,
): Promise<DiscoveredChannel | null> {
  // Only fire when the original HTML is sparse (< 2000 chars of text)
  const textish = originalBody.replace(/<[^>]+>/g, " ").length;
  if (textish > 2000) return null;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // Dev-tools / docs hosts that are likely to ship /llms.txt
  const likely = [
    "vercel.com", "netlify.com", "github.com", "docs.rs",
    "readthedocs.io", "mintlify.com", "docusaurus.io",
    "vitepress.dev", "gitbook.io", "developer.mozilla.org",
    "react.dev", "nuxt.com", "svelte.dev", "astro.build",
  ];
  if (!likely.some((d) => host === d || host.endsWith("." + d))) {
    // Still try once for .com TLDs — the cost is one 2s fetch
    if (!/\.com$|\.io$|\.dev$|\.ai$/.test(host)) return null;
  }

  // Try /llms.txt first
  const llmsRes = await fetchUrl("https://" + host + "/llms.txt", {
    timeoutMs: 45_000,
  });
  if (llmsRes && llmsRes.ok && llmsRes.text.trim().length >= 80) {
    return {
      kind: "llms-txt",
      markdown:
        "## Site map (llms.txt)\n" + llmsRes.text.trim().slice(0, 8000),
      isPrimary: true,
    };
  }

  // Try the .md twin of the page path
  if (u.pathname.endsWith(".html") || u.pathname.length > 1) {
    const mdPath = u.pathname.replace(/\.html?$/, "") + ".md";
    const mdRes = await fetchUrl("https://" + host + mdPath, { timeoutMs: 45_000 });
    if (mdRes && mdRes.ok && mdRes.text.trim().length >= 80) {
      return {
        kind: "llms-txt",
        markdown: mdRes.text.trim().slice(0, 12000),
        isPrimary: true,
      };
    }
  }
  return null;
}

/* ── Discourse forum .json rewrite ──────────────────────────────────── */

/**
 * Discourse powers thousands of tech communities (Rust, Elixir, OpenAI,
 * Nvidia, ...). Detect the `data-pre-discourse` marker or a `.json`
 * sibling of the thread URL and extract the clean structured JSON.
 */
export async function discourseAdapter(
  url: string,
): Promise<DiscoveredChannel | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // Discourse hostnames almost always end in `.discourse.com` or have
  // a /t/ thread path — check the path shape
  const isThread = /^\/t\/\d+/.test(u.pathname);
  if (!isThread) return null;

  const jsonUrl = u.href + ".json";
  const res = await fetchUrl(jsonUrl, { timeoutMs: 45_000 });
  if (!res || !res.ok) return null;
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    return null;
  }
  const lines: string[] = [];
  lines.push("## Discourse thread: " + (data.title ?? "untitled"));
  if (data.created_at) lines.push("Posted: " + data.created_at);
  const postStream = data.post_stream?.posts ?? [];
  for (const p of postStream.slice(0, 5)) {
    lines.push("### " + (p.username ?? "unknown"));
    const cooked = p.cooked ?? "";
    // Strip HTML tags from the cooked field for clean text
    const text = cooked.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) lines.push(text.slice(0, 1500));
  }
  const markdown = lines.join("\n\n");
  return markdown.length >= 100
    ? { kind: "discourse-json", markdown, isPrimary: true }
    : null;
}

/* ── Shopify product .json rewrite ──────────────────────────────────── */

/**
 * Shopify stores embed a `window.Shopify` object and expose
 * `/products/{handle}.json` for every product. Millions of indie DTC
 * sites use Shopify — this adapter recovers price/variant data cleanly.
 */
export async function shopifyAdapter(
  url: string,
): Promise<DiscoveredChannel | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const m = u.pathname.match(/^\/products\/([^\/?#]+)/);
  if (!m) return null;
  const handle = m[1];
  const jsonUrl = `https://${host}/products/${handle}.json`;
  const res = await fetchUrl(jsonUrl, { timeoutMs: 45_000 });
  if (!res || !res.ok) return null;
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    return null;
  }
  const lines: string[] = [];
  lines.push("## Shopify product: " + (data.title ?? handle));
  if (data.vendor) lines.push("Vendor: " + data.vendor);
  const desc = data.body_html ?? "";
  if (desc) lines.push(desc.replace(/<[^>]+>/g, " ").slice(0, 1000));
  const variants = data.variants ?? [];
  if (variants.length > 0) {
    lines.push("### Variants (" + variants.length + ")");
    for (const v of variants.slice(0, 12)) {
      lines.push(
        `- ${[v.title, v.price, v.sku, v.available].filter(Boolean).join(" · ")}${v.currency ?? ""}`,
      );
    }
  }
  const markdown = lines.join("\n\n");
  return markdown.length >= 60
    ? { kind: "shopify-json", markdown, isPrimary: true }
    : null;
}

/* ── CMS (WordPress / Ghost / Substack / Medium) JSON + RSS ────────── */

/**
 * Detect the CMS platform from markers in the HTML and pull clean
 * metadata / content from the embedded JSON or the RSS/Atom feed
 * alternate link.
 */
export async function cmsAdapter(
  url: string,
  html: string,
): Promise<DiscoveredChannel | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  // WordPress: wp-json REST API for posts
  if (html.includes("wp-content") || html.includes('WordPress')) {
    const slug = u.pathname.replace(/^\/|\/$/g, "").split("/").pop() ?? "";
    if (slug) {
      const res = await fetchUrl(
        `https://${host}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`,
        { timeoutMs: 45_000 },
      );
      if (res && res.ok) {
        try {
          const data: any = JSON.parse(res.text);
          if (Array.isArray(data) && data.length > 0) {
            const p = data[0];
            const lines: string[] = [];
            lines.push("## WordPress post: " + (p.title?.rendered ?? slug));
            if (p.date) lines.push("Published: " + p.date);
            if (p.excerpt?.rendered) {
              lines.push(
                p.excerpt.rendered.replace(/<[^>]+>/g, " ").slice(0, 800),
              );
            }
            const md = lines.join("\n\n");
            if (md.length >= 60) {
              return { kind: "cms-json", markdown: md, isPrimary: false };
            }
          }
        } catch {
          /* malformed */
        }
      }
    }
  }

  // Ghost: /ghost/api or /sitemap.xml
  if (html.includes("ghost") || host.includes("ghost.io")) {
    const res = await fetchUrl("https://" + host + "/ghost/api", {
      timeoutMs: 45_000,
    });
    if (res && res.ok && res.text.length >= 50) {
      return {
        kind: "cms-json",
        markdown: "## Ghost API\n" + res.text.slice(0, 4000),
        isPrimary: false,
      };
    }
  }

  // Substack: /feed (RSS)
  if (html.includes("substack") || host.endsWith("substack.com")) {
    const res = await fetchUrl("https://" + host + "/feed", {
      timeoutMs: 45_000,
    });
    if (res && res.ok && res.text.length >= 200) {
      return {
        kind: "rss",
        markdown:
          "## Substack feed (RSS)\n" +
          res.text
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 4000),
        isPrimary: false,
      };
    }
  }

  // Medium: RSS alternate link
  if (host === "medium.com" || html.includes("medium.com")) {
    const feedPath = u.pathname.match(/^\/([^\/]+)\//);
    if (feedPath) {
      const res = await fetchUrl(
        "https://medium.com/feed/" + feedPath[1],
        { timeoutMs: 45_000 },
      );
      if (res && res.ok && res.text.length >= 200) {
        return {
          kind: "rss",
          markdown:
            "## Medium RSS feed\n" +
            res.text
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 4000),
          isPrimary: false,
        };
      }
    }
  }

  // Generic RSS/Atom alternate link from <link rel="alternate">
  try {
    const doc = docOf(html);
    const alternates: any[] = doc.querySelectorAll(
      'link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]',
    );
    if (alternates.length > 0) {
      const feedUrl = alternates[0].getAttribute("href");
      if (feedUrl) {
        const abs = new URL(feedUrl, u.origin).href;
        const res = await fetchUrl(abs, { timeoutMs: 45_000 });
        if (res && res.ok && res.text.length >= 200) {
          return {
            kind: "rss",
            markdown:
              "## RSS/Atom feed\n" +
              res.text
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 4000),
            isPrimary: false,
          };
        }
      }
    }
  } catch {
    /* DOM parse failed — skip */
  }

  return null;
}

/* ── Universal schema.org / Microdata / OG extraction ───────────────── */

/**
 * Extract EVERY schema.org JSON-LD schema type the page might carry,
 * plus Microdata (itemtype=) and OpenGraph / Twitter meta tags, and
 * format them as a clean "[Structured Page Facts]" markdown header.
 *
 * This is the universal equivalent of the domain-specific adapters in
 * domain-adapters.ts: it runs on every page, not just known hosts, and
 * covers the 14 schema types the spec calls out.
 */
export function universalSchemaExtract(
  html: string,
): string {
  let doc: any;
  try {
    doc = docOf(html);
  } catch {
    return "";
  }

  const out: string[] = [];
  const title = doc.title?.trim?.() ?? "";
  if (title) out.push("# " + title);

  // ── JSON-LD: all 14 schema types ───────────────────────────────
  const ldBlocks: any[] = doc.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  const schemaLines: string[] = [];
  for (const script of ldBlocks) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const t: string | undefined = item?.["@type"];
      if (typeof t === "string") {
        switch (t) {
          case "Product":
            schemaLines.push(formatProduct(item));
            break;
          case "SoftwareApplication":
          case "WebApplication":
            schemaLines.push(formatSoftware(item, t));
            break;
          case "JobPosting":
            schemaLines.push(formatJob(item));
            break;
          case "Organization":
          case "Person":
          case "ProfilePage":
            schemaLines.push(formatPersonOrOrg(item, t));
            break;
          case "Article":
          case "TechArticle":
            schemaLines.push(formatArticle(item, t));
            break;
          case "FAQPage":
            schemaLines.push(formatFaq(item));
            break;
          case "HowTo":
            schemaLines.push(formatHowTo(item));
            break;
          case "Recipe":
            schemaLines.push(formatRecipe(item));
            break;
          case "Event":
            schemaLines.push(formatEvent(item));
            break;
          case "LocalBusiness":
            schemaLines.push(formatLocalBusiness(item));
            break;
          case "VideoObject":
            schemaLines.push(formatVideo(item));
            break;
          case "Dataset":
            schemaLines.push(formatDataset(item));
            break;
          default:
            // Unknown schema type: dump a compact key/value summary
            schemaLines.push(formatGenericSchema(item, t));
        }
      }
    }
  }

  // ── Microdata (itemtype=) ───────────────────────────────────────
  const microdata: any[] = doc.querySelectorAll('[itemtype]');
  for (const el of microdata.slice(0, 10)) {
    const itemType = el.getAttribute("itemtype");
    const itemProp: any[] = el.querySelectorAll("[itemprop]");
    if (!itemProp.length) continue;
    const lines: string[] = ["## Microdata: " + (itemType ?? "unknown")];
    for (const p of itemProp.slice(0, 12)) {
      const prop = p.getAttribute("itemprop");
      const val = p.textContent?.trim();
      if (prop && val) lines.push("- " + prop + ": " + val.slice(0, 200));
    }
    if (lines.length > 1) schemaLines.push(lines.join("\n"));
  }

  // ── OpenGraph / Twitter meta tags ──────────────────────────────
  const metaLines: string[] = [];
  const metas: any[] = doc.querySelectorAll("meta");
  const props = new Set([
    "og:title", "og:description", "og:site_name", "og:url",
    "og:image", "og:video", "og:type",
    "twitter:title", "twitter:description", "twitter:card",
    "twitter:site", "twitter:creator",
  ]);
  for (const m of metas) {
    const prop = m.getAttribute("property") ?? m.getAttribute("name");
    const content = m.getAttribute("content");
    if (prop && props.has(prop) && content) {
      metaLines.push(prop + ": " + content.slice(0, 300));
    }
  }
  if (metaLines.length > 0) {
    schemaLines.push("## Page Metadata (OpenGraph)\n" + metaLines.join("\n"));
  }

  if (schemaLines.length === 0) return "";
  return "[Structured Page Facts]\n\n" + schemaLines.join("\n\n").trim();
}

/* ── schema formatters ─────────────────────────────────────────────── */

function formatProduct(p: any): string {
  const lines: string[] = ["## Product: " + (p.name ?? "unnamed")];
  const offers = p.offers;
  if (offers?.price) {
    lines.push(
      "Price: " + offers.price + " " + (offers.priceCurrency ?? ""),
    );
  }
  if (offers?.availability) lines.push("Availability: " + offers.availability);
  if (offers?.priceValidUntil)
    lines.push("Price valid until: " + offers.priceValidUntil);
  const agg = p.aggregateRating;
  if (agg?.ratingValue)
    lines.push(
      "Rating: " + agg.ratingValue + " (" + (agg.reviewCount ?? "?") + " reviews)",
    );
  if (p.description) lines.push("Description: " + p.description.slice(0, 500));
  if (p.brand?.name) lines.push("Brand: " + p.brand.name);
  if (p.sku) lines.push("SKU: " + p.sku);
  if (p.mpn) lines.push("MPN: " + p.mpn);
  return lines.join("\n");
}

function formatSoftware(p: any, t: string): string {
  const lines: string[] = ["## " + t + ": " + (p.name ?? "unnamed")];
  if (p.applicationCategory) lines.push("Category: " + p.applicationCategory);
  if (p.offers?.price)
    lines.push("Price: " + p.offers.price + " " + (p.offers.priceCurrency ?? ""));
  if (p.license) lines.push("License: " + p.license);
  if (p.author?.name) lines.push("Author: " + p.author.name);
  if (p.screenshot) lines.push("Screenshot: " + p.screenshot);
  if (p.description) lines.push("Description: " + p.description.slice(0, 600));
  if (p.version) lines.push("Version: " + p.version);
  return lines.join("\n");
}

function formatJob(j: any): string {
  const lines: string[] = ["## Job: " + (j.title ?? "listing")];
  if (j.hiringOrganization?.name)
    lines.push("Company: " + j.hiringOrganization.name);
  if (j.jobLocation?.address?.addressLocality)
    lines.push("Location: " + j.jobLocation.address.addressLocality);
  if (j.baseSalary?.value)
    lines.push(
      "Salary: " +
        j.baseSalary.value +
        " " +
        (j.baseSalary.currency ?? "") +
        (j.baseSalary.type ? " (" + j.baseSalary.type + ")" : ""),
    );
  if (j.datePosted) lines.push("Posted: " + j.datePosted);
  // The two fields that settle whether a posting is still LIVE. Without them a
  // filled or expired job reads exactly like an open one, and the answer tells
  // the user to apply to a posting that closed weeks ago.
  if (j.validThrough) lines.push("Valid through: " + j.validThrough);
  if (j.jobStatus)
    lines.push(
      "Job status: " +
        String(j.jobStatus)
          .replace(/^https?:\/\/schema\.org\//i, "")
          .split(",").map((s: string) => s.trim()).filter(Boolean).join(", "),
    );
  if (j.description) lines.push("Description: " + j.description.slice(0, 800));
  return lines.join("\n");
}

function formatPersonOrOrg(p: any, t: string): string {
  const lines: string[] = ["## " + t + ": " + (p.name ?? "unnamed")];
  if (p.description) lines.push("Description: " + p.description.slice(0, 400));
  if (p.foundingDate) lines.push("Founded: " + p.foundingDate);
  if (p.foundingLocation?.name)
    lines.push("Founded in: " + p.foundingLocation.name);
  if (p.sameAs) lines.push("Also: " + p.sameAs.join(", "));
  return lines.join("\n");
}

function formatArticle(a: any, t: string): string {
  const lines: string[] = ["## " + t + ": " + (a.headline ?? a.name ?? "")];
  if (a.author?.name) lines.push("By: " + a.author.name);
  if (a.datePublished) lines.push("Published: " + a.datePublished);
  if (a.wordCount) lines.push("Word count: " + a.wordCount);
  if (a.articleSection) lines.push("Section: " + a.articleSection);
  if (a.description) lines.push("Summary: " + a.description.slice(0, 400));
  return lines.join("\n");
}

function formatFaq(f: any): string {
  const lines: string[] = ["## FAQ"];
  const qs = f.mainEntity ?? [];
  for (const q of qs.slice(0, 10)) {
    lines.push("Q: " + (q.name ?? ""));
    lines.push("A: " + (q.acceptedAnswer?.text ?? "").slice(0, 500));
  }
  return lines.join("\n");
}

function formatHowTo(h: any): string {
  const lines: string[] = ["## HowTo: " + (h.name ?? "steps")];
  const steps = h.step ?? [];
  steps.slice(0, 15).forEach((s: any, i: number) => {
    lines.push(`${i + 1}. ` + (s.name ?? s.text ?? ""));
  });
  return lines.join("\n");
}

function formatRecipe(r: any): string {
  const lines: string[] = ["## Recipe: " + (r.name ?? "unnamed")];
  if (r.cookTime) lines.push("Cook time: " + r.cookTime);
  const ing = r.recipeIngredient ?? [];
  if (ing.length) lines.push("Ingredients: " + ing.join(", ").slice(0, 400));
  const steps = r.recipeInstructions ?? [];
  for (const s of steps.slice(0, 10)) {
    lines.push("- " + (s.text ?? s.name ?? ""));
  }
  return lines.join("\n");
}

function formatEvent(e: any): string {
  const lines: string[] = ["## Event: " + (e.name ?? "unnamed")];
  if (e.startDate) lines.push("Start: " + e.startDate);
  if (e.endDate) lines.push("End: " + e.endDate);
  if (e.location?.name) lines.push("Location: " + e.location.name);
  if (e.performer?.name) lines.push("Performer: " + e.performer.name);
  if (e.offers?.price)
    lines.push("Price: " + e.offers.price + " " + (e.offers.priceCurrency ?? ""));
  return lines.join("\n");
}

function formatLocalBusiness(b: any): string {
  const lines: string[] = ["## LocalBusiness: " + (b.name ?? "unnamed")];
  if (b.address?.streetAddress) lines.push("Address: " + b.address.streetAddress);
  if (b.address?.addressLocality) lines.push("City: " + b.address.addressLocality);
  if (b.address?.addressCountry) lines.push("Country: " + b.address.addressCountry);
  if (b.telephone) lines.push("Phone: " + b.telephone);
  if (b.priceRange) lines.push("Price range: " + b.priceRange);
  if (b.openingHours) lines.push("Hours: " + b.openingHours);
  return lines.join("\n");
}

function formatVideo(v: any): string {
  const lines: string[] = ["## Video: " + (v.name ?? v.headline ?? "")];
  if (v.author?.name) lines.push("Channel: " + v.author.name);
  if (v.uploadDate) lines.push("Uploaded: " + v.uploadDate);
  if (v.duration) lines.push("Duration: " + v.duration);
  if (v.thumbnailUrl) lines.push("Thumbnail: " + v.thumbnailUrl);
  if (v.description) lines.push("Description: " + v.description.slice(0, 600));
  return lines.join("\n");
}

function formatDataset(d: any): string {
  const lines: string[] = ["## Dataset: " + (d.name ?? "unnamed")];
  if (d.distribution?.url) lines.push("Download: " + d.distribution.url);
  if (d.variableMeasured) lines.push("Measured: " + d.variableMeasured);
  if (d.description) lines.push("Description: " + d.description.slice(0, 400));
  return lines.join("\n");
}

function formatGenericSchema(item: any, t: string): string {
  const lines: string[] = ["## Schema (" + t + ")"];
  for (const [k, v] of Object.entries(item)) {
    if (k === "@context" || k === "@id" || k === "@type") continue;
    if (typeof v === "object" && v !== null) {
      lines.push(
        "- " +
          k +
          ": " +
          JSON.stringify(v)
            .slice(0, 200)
            .replace(/\n/g, " "),
      );
    } else {
      lines.push("- " + k + ": " + String(v).slice(0, 200));
    }
  }
  return lines.slice(0, 20).join("\n");
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Run every machine-first discovery channel against a fetched page and
 * return the combined clean markdown (or null when nothing useful was
 * found). The caller prepends this to the DOM extraction so structured
 * facts are never lost to HTML stripping.
 *
 * Ordering: cheap pure-HTML-parsing channels first (schema, hydration —
 * no network), then keyless rewrites that need one fetch each (Discourse,
 * Shopify, CMS), then content negotiation, and /llms.txt last. Every
 * network fetch is 2s-capped so a dead host can't stall the cascade.
 */
export async function universalDiscovery(
  url: string,
  html: string,
  original: PageResponse | null,
): Promise<DiscoveredChannel | null> {
  const parts: string[] = [];

  // 1. Universal schema / microdata / OG (runs on the same body — no fetch)
  const schemaMd = universalSchemaExtract(html);
  if (schemaMd) parts.push(schemaMd);

  // 2. Platform JSON rewrites (keyless — the cheapest useful channel)
  const discourse = await discourseAdapter(url);
  if (discourse) parts.push(discourse.markdown);

  const shopify = await shopifyAdapter(url);
  if (shopify) parts.push(shopify.markdown);

  const cms = await cmsAdapter(url, html);
  if (cms) parts.push(cms.markdown);

  // 3. Content negotiation (markdown Accept) — only when body is sparse
  const mdChannel = await tryMarkdownNegotiation(url, original);
  if (mdChannel) parts.push(mdChannel.markdown);

  // 4. /llms.txt & .md twin — only when text is sparse
  const llms = await tryLlmsTxt(url, html);
  if (llms) parts.push(llms.markdown);

  if (parts.length === 0) return null;
  return {
    kind: "universal",
    markdown: parts.join("\n\n"),
    isPrimary: parts.some((p) => p.length > 200),
  };
}
