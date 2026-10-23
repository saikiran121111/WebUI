/**
 * Keyless platform JSON APIs — the "adapter" tier of the extractor.
 *
 * For hard-target hosts that ship structured data without a full DOM,
 * rewrite the URL to a free, keyless JSON endpoint and extract clean
 * content instead of parsing hostile HTML:
 *
 *   Reddit        → /r/<sub>/comments/<id>.json (post + top-comments tree)
 *   GitHub        → raw.githubusercontent.com / api.github.com README
 *   YouTube       → youtubei.js evidence stack (lib/web-search/youtube.ts)
 *   Google Maps   → short-link unwrap + place evidence (lib/web-search/google-maps.ts)
 *   OpenStreetMap → Nominatim reverse-geocode / OSM element API
 *
 * Short links (maps.app.goo.gl, bit.ly, t.co, …) are unwrapped FIRST and
 * the adapter dispatches on the DESTINATION — the stub itself has no
 * extractable content.
 *
 * Replaces the deleted custom domain-adapters.ts spaghetti; every fetch
 * here goes through net.ts (got-scraping primary, impit TLS fallback).
 */
import { fetchUrl } from "./net";
import { isShortLinkUrl, unwrapShortLink } from "./redirect-unwrap";
import { isGoogleMapsUrl, getGoogleMapsEvidence } from "./google-maps";
import { getYouTubeEvidence } from "./youtube";

export interface AdapterResult {
  /** Clean markdown for this URL (prepend to extraction). */
  markdown: string;
  /** How we got it: "adapter" (keyless JSON rewrite). */
  kind: "adapter";
  /** True when the adapter produced the primary evidence (no DOM needed). */
  isPrimary: boolean;
}

/**
 * Platform-API dispatcher. Returns null when the host is not in the
 * table — the caller's DOM extraction then proceeds as usual.
 */
export async function platformAdapter(
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

  // Short links: unwrap the redirect chain FIRST, then dispatch on the
  // resolved destination.
  if (depth < 2 && isShortLinkUrl(url)) {
    const resolved = await unwrapShortLink(url);
    if (resolved && resolved !== url) return platformAdapter(resolved, depth + 1);
    return null;
  }

  // Google Maps (place page, /maps?q=, or a Maps short link — the
  // evidence module follows the chain itself).
  if (isGoogleMapsUrl(url)) return mapsAdapter(url);

  switch (host) {
    case "reddit.com":
    case "old.reddit.com":
      return redditAdapter(u);
    case "github.com":
      return githubAdapter(u);
    case "youtube.com":
    case "youtu.be":
    case "youtube-nocookie.com":
      return youtubeAdapter(url);
    case "openstreetmap.org":
      return osmAdapter(u);
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
  const isOld = u.hostname.startsWith("old.reddit.com");
  const base = isOld ? "https://old.reddit.com" : "https://www.reddit.com";

  let jsonUrl: string;
  const commentMatch = u.pathname.match(/\/(r\/[^\/]+\/comments\/[^\/]+)/);
  if (commentMatch) {
    jsonUrl = base + "/" + commentMatch[1] + ".json";
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
 * fetch the README via the keyless api.github.com endpoint.
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
  // /owner/repo/issues/N or /pull/N — no rewrite, caller's DOM
  // extraction + JSON-LD (if present) handles these.
  return null;
}

/**
 * YouTube: the youtubei.js evidence module parses EVERY URL format
 * (youtu.be, /watch?v=, /shorts/, /embed/, /v/, /live/, m./music. hosts)
 * and returns title/channel/description + transcript + top comments as
 * primary adapter evidence.
 */
async function youtubeAdapter(originalUrl: string): Promise<AdapterResult | null> {
  const ev = await getYouTubeEvidence(originalUrl);
  if (!ev) return null;
  return { markdown: ev.markdown, kind: "adapter", isPrimary: true };
}

/**
 * Google Maps: unwrap the Firebase dynamic short link, decode the place
 * name / address / @lat,lng from the RESOLVED URL, scrape the place
 * page's og tags / APP_INITIALIZATION_STATE, and fall back to Nominatim
 * reverse geocoding when the page is a bare JS shell.
 */
async function mapsAdapter(originalUrl: string): Promise<AdapterResult | null> {
  const ev = await getGoogleMapsEvidence(originalUrl);
  if (!ev) return null;
  return { markdown: ev.markdown, kind: "adapter", isPrimary: true };
}

/**
 * OpenStreetMap: `map.html?mlat=...&mlon=...` → Nominatim reverse
 * geocode; `/node/N`, `/way/N`, `/relation/N` → the OSM element API —
 * clean data instead of the empty WebGL canvas the DOM returns.
 */
async function osmAdapter(u: URL): Promise<AdapterResult | null> {
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
