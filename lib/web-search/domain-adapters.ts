/**
 * Domain-specific smart extractors for hard-target sites that serve
 * structured data via JSON-LD, hydration state, or keyless JSON APIs.
 *
 * Every adapter returns a clean, high-signal markdown block (or null when
 * it can't help) that the extractor prepends to whatever DOM extraction
 * managed to produce — structured metadata is NEVER discarded in favor
 * of DOM text.
 *
 * All adapters are zero-key and stay within the 2MB body / 3500ms ceiling
 * inherited from tls-client.ts. When a hard target (LinkedIn, Instagram,
 * Amazon, YouTube) blocks the DOM but still serves its link-preview
 * metadata, the adapter recovers that data.
 */
import { fetchPage, fetchUrl } from "./tls-client";
import { parseHTML } from "linkedom";
import { getYouTubeEvidence } from "./youtube";
import { getGoogleMapsEvidence, isGoogleMapsUrl } from "./google-maps";
import { isShortLinkUrl, unwrapShortLink } from "./redirect-unwrap";

/**
 * Extract JSON-LD, OpenGraph, Twitter, and known hydration-state payloads
 * from a raw HTML document. Runs on the SAME body the direct fetcher
 * already paid for — no second network round-trip.
 */
export function extractStructuredMeta(html: string, url?: string): string {
  let doc: any;
  try {
    doc = parseHTML(html);
    doc = doc?.document ?? doc;
  } catch {
    return "";
  }

  const out: string[] = [];
  const title = doc.title?.trim?.() ?? "";
  if (title) out.push("# " + title);

  // ── JSON-LD (Product / JobPosting / Article / VideoObject / FAQPage) ──
  const ldBlocks: any[] = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldBlocks) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON-LD — skip, never crash
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const t = item?.["@type"];
      if (typeof t === "string" && t === "Product") out.push(formatProduct(item));
      if (typeof t === "string" && t === "JobPosting") out.push(formatJob(item));
      if (typeof t === "string" && t === "Article") out.push(formatArticle(item));
      if (typeof t === "string" && t === "VideoObject") out.push(formatVideo(item));
      if (typeof t === "string" && t === "WebPage") out.push(formatWebPage(item));
    }
  }

  // ── OpenGraph / Twitter meta tags (link-preview data) ──
  const metaTags: string[] = [
    "og:title", "og:description", "og:site_name", "og:url",
    "og:image", "twitter:title", "twitter:description",
  ];
  const metaLines: string[] = [];
  const metas: any[] = doc.querySelectorAll("meta");
  for (const m of metas) {
    const prop = m.getAttribute("property") ?? m.getAttribute("name");
    const content = m.getAttribute("content");
    if (!prop || !content) continue;
    if (metaTags.includes(prop)) {
      metaLines.push(prop + ": " + content.slice(0, 300));
    }
  }
  if (metaLines.length > 0) out.push("## Page Metadata\n" + metaLines.join("\n"));

  return out.join("\n\n").trim();
}

/* ── JSON-LD formatters ───────────────────────────────────────────────── */

function formatProduct(p: any): string {
  const lines: string[] = [];
  lines.push("## Product: " + (p.name ?? "unnamed"));
  const offers = p.offers ?? p.price;
  if (offers) {
    if (offers.price) lines.push("Price: " + offers.price + " " + (offers.priceCurrency ?? ""));
    if (offers.availability) lines.push("Availability: " + offers.availability);
  }
  const agg = p.aggregateRating;
  if (agg?.ratingValue) lines.push("Rating: " + agg.ratingValue + " (" + (agg.reviewCount ?? "?") + " reviews)");
  if (p.description) lines.push("Description: " + p.description.slice(0, 500));
  if (p.brand?.name) lines.push("Brand: " + p.brand.name);
  return lines.join("\n");
}

function formatJob(j: any): string {
  const lines: string[] = [];
  lines.push("## Job: " + (j.title ?? "listing"));
  if (j.hiringOrganization?.name) lines.push("Company: " + j.hiringOrganization.name);
  if (j.jobLocation?.address?.addressLocality) lines.push("Location: " + j.jobLocation.address.addressLocality);
  if (j.baseSalary) {
    const v = j.baseSalary.value;
    if (v) lines.push("Salary: " + v + " " + (j.baseSalary.currency ?? ""));
  }
  if (j.description) lines.push("Description: " + j.description.slice(0, 800));
  return lines.join("\n");
}

function formatArticle(a: any): string {
  const lines: string[] = [];
  lines.push("## Article: " + (a.headline ?? a.name ?? ""));
  if (a.author?.name) lines.push("By: " + a.author.name);
  if (a.datePublished) lines.push("Published: " + a.datePublished);
  if (a.description) lines.push("Summary: " + a.description.slice(0, 400));
  return lines.join("\n");
}

function formatVideo(v: any): string {
  const lines: string[] = [];
  lines.push("## Video: " + (v.name ?? v.headline ?? ""));
  if (v.author?.name) lines.push("Channel: " + v.author.name);
  if (v.uploadDate) lines.push("Uploaded: " + v.uploadDate);
  if (v.duration) lines.push("Duration: " + v.duration);
  if (v.description) lines.push("Description: " + v.description.slice(0, 600));
  return lines.join("\n");
}

function formatWebPage(w: any): string {
  if (!w.description) return "";
  return "Page description: " + w.description.slice(0, 300);
}

/* ── Hydration state extraction ────────────────────────────────────────── */

/**
 * Find and return a JSON serialization of `window.__NEXT_DATA__`,
 * `window.__INITIAL_STATE__`, `window.ytInitialPlayerResponse`, or
 * `window.ytInitialData` when present as a `<script>` payload.
 */
export function extractHydrationState(html: string): string {
  const keys = [
    "window.__NEXT_DATA__",
    "window.__INITIAL_STATE__",
    "window.__NUXT__",
    "window.__remixContext",
    "window.ytInitialPlayerResponse",
    "window.ytInitialData",
    "window.__APOLLO_STATE__",
  ];

  const out: string[] = [];
  for (const key of keys) {
    const needle = key + "=";
    const idx = html.indexOf(needle);
    if (idx === -1) continue;
    // Walk forward from the first `{` after the needle to the matching
    // `}` (or end of script block) — a full JSON parser on a multi-MB
    // page is too expensive for the extraction budget.
    const start = html.indexOf("{", idx);
    if (start === -1) continue;
    let depth = 0;
    let end = start;
    for (let i = start; i < Math.min(start + 500_000, html.length); i++) {
      const c = html[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const payload = html.slice(start, end).slice(0, 40_000);
    let text = payload;
    try {
      // Pretty-print only when the JSON is small enough to be useful
      if (payload.length < 100_000) {
        const parsed = JSON.parse(payload);
        text = JSON.stringify(parsed, null, 1).slice(0, 40_000);
      }
    } catch {
      // leave as raw
    }
    out.push("## Hydration state (" + key.replace("window.", "") + ")\n```json\n" + text + "\n```");
  }
  return out.join("\n\n");
}

/* ── Domain-specific adapters ────────────────────────────────────────── */

export interface AdapterResult {
  /** Clean markdown for this URL (prepend to extraction). */
  markdown: string;
  /** How we got it: "adapter" (keyless JSON rewrite) or "meta" (JSON-LD/OG). */
  kind: "adapter" | "meta";
  /** True when the adapter produced the primary evidence (no DOM needed). */
  isPrimary: boolean;
}

/**
 * Domain adapter dispatcher: for hard-target hosts that ship structured
 * data without a full DOM, rewrite the URL to a keyless JSON endpoint and
 * extract clean content. Falls through to the caller's DOM extraction
 * when the host isn't in the table.
 */
export async function domainAdapter(
  url: string,
  depth = 0,
): Promise<AdapterResult | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/^(?:m|music)\./, "");

  // Short links (maps.app.goo.gl, bit.ly, t.co, …): unwrap the redirect
  // chain FIRST, then dispatch the adapter on the DESTINATION — the stub
  // itself has no extractable content.
  if (depth < 2 && isShortLinkUrl(url)) {
    const resolved = await unwrapShortLink(url);
    if (resolved && resolved !== url) return domainAdapter(resolved, depth + 1);
    return null;
  }

  // Google Maps (place page, /maps?q=, or a Maps short link — the
  // evidence module follows the chain itself).
  if (isGoogleMapsUrl(url)) return mapsAdapter(url);

  switch (host) {
    case "reddit.com":
      return redditAdapter(u);
    case "old.reddit.com":
      return redditAdapter(u);
    case "github.com":
      return githubAdapter(u);
    case "youtube.com":
    case "youtu.be":
    case "youtube-nocookie.com":
      return youtubeAdapter(url);
    case "openstreetmap.org":
      return osmAdapter(u, url);
    default:
      return null;
  }
}

/**
 * Reddit: rewrite `reddit.com/r/<sub>/...` to the keyless `.json`
 * endpoint for a clean post + top-comments tree without HTML bloat.
 * Subreddit-only URLs (no comment depth) hit the listing endpoint.
 */
async function redditAdapter(u: URL): Promise<AdapterResult | null> {
  // https://reddit.com/r/rust/comments/abc/title/ → .json
  // https://reddit.com/r/rust                          → /r/rust.json
  // https://old.reddit.com/...                          → rewrite host to www
  const host = u.hostname.replace(/^old\.|^www\./, "");
  const isOld = u.hostname.startsWith("old.reddit.com");
  const base = isOld ? "https://old.reddit.com" : "https://www.reddit.com";

  let jsonUrl: string;
  // If the URL already points at a comments thread, use its root
  const commentMatch = u.pathname.match(/\/(r\/[^\/]+\/comments\/[^\/]+)/);
  if (commentMatch) {
    jsonUrl = base + "/" + commentMatch[1] + ".json";
  } else if (/^\/r\/[^/]+$/.test(u.pathname)) {
    // Subreddit front page → hit the /r/<sub>.json listing
    jsonUrl = base + u.pathname + ".json";
  } else {
    jsonUrl = base + u.pathname + ".json";
  }

  const res = await fetchUrl(jsonUrl, {
    timeoutMs: 45_000,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res || !res.ok) return null;
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    return null;
  }
  const lines: string[] = [];
  const listing = Array.isArray(data) ? data : data?.[0] ?? data;
  for (const child of listing?.data?.children ?? []) {
    const d = child?.data;
    if (!d) continue;
    const isPost = d.author && (d.selftext || d.title);
    if (isPost && d.title) {
      lines.push("# " + d.title);
      lines.push(
        "By u/" + d.author + " · " + (d.subreddit ? "r/" + d.subreddit : ""),
      );
      if (d.selftext) lines.push(d.selftext.slice(0, 2000));
      if (d.url && !/reddit\.com/.test(d.url)) lines.push("Link: " + d.url);
    }
    if (d.body) lines.push("- " + d.body.slice(0, 500));
  }
  const markdown = lines.join("\n\n");
  return markdown.trim().length >= 100
    ? { markdown, kind: "adapter", isPrimary: true }
    : null;
}

/**
 * GitHub: rewrite `github.com/<owner>/<repo>/blob/<branch>/<path>` to
 * `raw.githubusercontent.com` for the clean file content. For repo roots,
 * issues and PRs, extract the key structured pieces from the DOM instead
 * of the huge HTML.
 */
async function githubAdapter(u: URL): Promise<AdapterResult | null> {
  const segs = u.pathname.split("/").filter(Boolean);
  // /owner/repo/blob/branch/path → raw
  if (segs.length >= 5 && segs[2] === "blob") {
    const [, owner, repo, branch] = segs;
    const path = segs.slice(4).join("/");
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const res = await fetchUrl(rawUrl, { timeoutMs: 45_000 });
    if (res && res.ok && res.text.length > 50) {
      return {
        markdown: `## GitHub file: ${path}\n\`\`\`\n${res.text.slice(0, 8000)}\n\`\`\``,
        kind: "adapter",
        isPrimary: true,
      };
    }
    return null;
  }
  // /owner/repo (root) → README
  if (segs.length === 2) {
    const [owner, repo] = segs;
    const res = await fetchUrl(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      {
        timeoutMs: 2500,
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/vnd.github.v3.raw",
        },
      },
    );
    if (res && res.ok && res.text.length > 50) {
      return {
        markdown: `## GitHub repo: ${owner}/${repo}\n${res.text.slice(0, 6000)}`,
        kind: "adapter",
        isPrimary: true,
      };
    }
    return null;
  }
  // /owner/repo/issues/N or /pull/N — no rewrite, caller's DOM extraction
  // + JSON-LD (if present) handles these.
  return null;
}

/**
 * YouTube: the dedicated evidence module (Fix 1) parses EVERY URL format
 * (youtu.be, /watch?v=, /shorts/, /embed/, /v/, /live/, m./music. hosts),
 * pulls title + channel via keyless oEmbed, the InnerTube ANDROID-client
 * player API, and the watch-page `ytInitialPlayerResponse`, then
 * downloads + parses the timedtext caption track into a timestamped
 * transcript. The whole block is returned as primary adapter evidence.
 */
async function youtubeAdapter(
  originalUrl: string,
): Promise<AdapterResult | null> {
  const ev = await getYouTubeEvidence(originalUrl);
  if (!ev) return null;
  return { markdown: ev.markdown, kind: "adapter", isPrimary: true };
}

/**
 * Google Maps (Fix 3): unwrap the Firebase dynamic short link, decode the
 * place name / address / @lat,lng from the RESOLVED URL, scrape the place
 * page's og:title / og:description / APP_INITIALIZATION_STATE, and fall
 * back to Nominatim reverse geocoding when the page is a bare JS shell.
 */
async function mapsAdapter(
  originalUrl: string,
): Promise<AdapterResult | null> {
  const ev = await getGoogleMapsEvidence(originalUrl);
  if (!ev) return null;
  return { markdown: ev.markdown, kind: "adapter", isPrimary: true };
}

/**
 * OpenStreetMap: extract the place query from URL patterns
 * (`map.html?mlat=...&mlon=...` or `node/N`, `way/N`) and fetch a
 * Nominatim reverse-geocode or search endpoint for clean data instead of
 * the empty WebGL canvas the direct DOM returns.
 */
async function osmAdapter(
  u: URL,
  originalUrl: string,
): Promise<AdapterResult | null> {
  // Nominatim is keyless with rate-limiting; one lookup per URL is fine.
  const lat = u.searchParams.get("mlat");
  const lon = u.searchParams.get("mlon");
  if (lat && lon) {
    const res = await fetchUrl(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=14`,
      { timeoutMs: 45_000 },
    );
    if (res && res.ok) {
      try {
        const data: any = JSON.parse(res.text);
        const lines: string[] = [
          "## OpenStreetMap location",
          "Coordinates: " + lat + ", " + lon,
          "Address: " + (data.display_name ?? "unknown"),
        ];
        const address = data.address ?? {};
        for (const k of ["country", "state", "city", "town", "hamlet", "road"]) {
          if (address[k]) lines.push(k + ": " + address[k]);
        }
        return { markdown: lines.join("\n"), kind: "adapter", isPrimary: true };
      } catch {
        /* fall through */
      }
    }
  }
  // /node/N, /way/N, /relation/N → OSM API
  const m = u.pathname.match(/^\/(node|way|relation)\/(\d+)/);
  if (m) {
    const res = await fetchUrl(
      `https://api.openstreetmap.org/api/0.6/${m[1]}/${m[2]}.json`,
      { timeoutMs: 45_000 },
    );
    if (res && res.ok) {
      try {
        const data: any = JSON.parse(res.text);
        const tags = data[m[1]]?.tags ?? data?.tags ?? {};
        const lines: string[] = [
          "## OSM " + m[1] + " " + m[2],
          "Lat/Lon: " + (data[m[1]]?.lat ?? data.lat) + ", " + (data[m[1]]?.lon ?? data.lon),
        ];
        for (const [k, v] of Object.entries(tags)) {
          lines.push(k + ": " + v);
        }
        return { markdown: lines.join("\n"), kind: "adapter", isPrimary: true };
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}
