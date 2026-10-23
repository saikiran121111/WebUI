/**
 * Google Maps deep evidence (Fix 3).
 *
 * A bare Maps SHORT link (maps.app.goo.gl/pDMFF…, g.page/…) is a Firebase
 * dynamic redirect — the place name, address and @lat,lng live behind the
 * redirect chain.  This module:
 *   1. unwraps the chain (HTTP 3xx + meta-refresh, via redirect-unwrap),
 *   2. decodes the place name / address / coordinates from the RESOLVED
 *      URL (/maps/place/<Name>/@lat,lng,?q=, /maps/search/<q>),
 *   3. scrapes the place page for og:title / og:description / <title> /
 *      APP_INITIALIZATION_STATE (the page is often a bare JS shell), and
 *   4. reverse-geocodes the coordinates through Nominatim when the shell
 *      carries nothing — so the model still sees the real place + address.
 */
import { fetchPage, fetchUrl, apiHeaders } from "./tls-client";
import { unwrapShortLink } from "./redirect-unwrap";

export interface MapsEvidence {
  resolvedUrl: string;
  place: string;
  address: string;
  lat: number | null;
  lng: number | null;
  blurb: string;
  markdown: string;
}

/** True when this URL is a Google Maps page or a Maps short link. */
export function isGoogleMapsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "maps.google.com" || host === "maps.app.goo.gl" || host === "g.page") {
      return true;
    }
    if ((host === "google.com" || /google\.[a-z.]{2,7}$/.test(host)) && u.pathname.startsWith("/maps")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function decodeSegment(seg: string): string {
  return decodeURIComponent(seg.replace(/\+/g, " ")).replace(/%2C/gi, ",").trim();
}

/** Pull place + coordinates + query out of a resolved Maps URL. */
function parseMapsUrl(u: URL): { place: string; query: string; lat: number | null; lng: number | null } {
  let place = "";
  let query = "";
  const at = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const lat = at ? Number(at[1]) : null;
  const lng = at ? Number(at[2]) : null;

  const placeSeg = u.pathname.match(/\/maps\/(?:place|search)\/([^/?]+)/);
  if (placeSeg) place = decodeSegment(placeSeg[1]);

  const q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("destination") ?? "";
  if (q) query = decodeSegment(q);

  // /maps/search/<terms> already captured above; /maps/dir/<A>/<B> → use endpoints loosely
  if (!place && !query) {
    const dir = u.pathname.match(/\/maps\/dir\/([^/?]+)/);
    if (dir) place = decodeSegment(dir[1]).replace(/\+/g, " ");
  }
  return { place, query, lat, lng };
}

/** Bracket-scan `window.APP_INITIALIZATION_STATE=[[…` and collect readable strings. */
function scanAppState(html: string): string[] {
  const marker = "APP_INITIALIZATION_STATE=";
  const idx = html.indexOf(marker);
  if (idx < 0) return [];
  const start = html.indexOf("[", idx);
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  const scanEnd = Math.min(html.length, start + 800_000);
  for (let i = start; i < scanEnd; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const blob = html.slice(start, end + 1);
  // Collect quoted, human-looking strings (names/addresses/categories) —
  // skip URLs, coordinate strings, and machine ids.
  const out: string[] = [];
  const seen = new Set<string>();
  const strRe = /"([^"\\]{6,180})"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(blob)) && out.length < 40) {
    const s = m[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    if (/^https?:\/\//.test(s)) continue;
    if (/^[0-9a-zA-Z_\-\[\]{}:.,/+?&=%|@ ]{0,180}$/.test(s) && !/[A-Za-z]{4}/.test(s)) continue;
    if (/\d{5,}/.test(s) && !/[a-z]{4}/i.test(s)) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** Nominatim reverse geocode → human-readable address for bare coords. */
async function reverseGeocode(lat: number, lng: number): Promise<{ name: string; address: string }> {
  const res = await fetchUrl(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`,
    { timeoutMs: 15_000, headers: { ...apiHeaders(), "User-Agent": "LocalAIWebUI/1.0 (personal research assistant)" } },
  );
  if (!res || !res.ok) return { name: "", address: "" };
  try {
    const j = JSON.parse(res.text);
    return {
      name: String(j?.name ?? j?.display_name ?? "").split(",")[0],
      address: String(j?.display_name ?? ""),
    };
  } catch {
    return { name: "", address: "" };
  }
}

/**
 * Full Maps evidence for a place URL OR a Maps short link (unwrapped
 * first). Returns null when the chain failed AND nothing decodable was
 * found (the caller then keeps the raw URL as a snippet).
 */
export async function getGoogleMapsEvidence(url: string): Promise<MapsEvidence | null> {
  let resolvedUrl = url;
  if (isGoogleMapsUrl(url) && !/google(\.[a-z.]{2,7})?\/maps/.test(url)) {
    // short link → follow the redirect chain first
    const r = await unwrapShortLink(url);
    if (r) resolvedUrl = r;
  }

  let u: URL;
  try {
    u = new URL(resolvedUrl);
  } catch {
    return null;
  }
  const parsed = parseMapsUrl(u);
  let place = parsed.place;
  let address = "";
  let blurb = "";
  let { lat, lng } = parsed;

  // Scrape the place page when it IS a maps page (title/og tags carry the
  // real place name even when the body is a JS shell).
  if (/\/maps(\/|$|\?)/.test(u.pathname + u.search)) {
    const page = await fetchPage(resolvedUrl, {
      timeoutMs: 25_000,
      headers: { cookie: "CONSENT=YES+cb", "accept-language": "en-US,en;q=0.9" },
    });
    if (page && page.ok && page.body) {
      const html = page.body;
      const titleM = html.match(/<title[^>]*>([^<]{4,220})<\/title>/i);
      const grab = (prop: string) => {
        const m = html.match(
          new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']{4,300})["']`, "i"),
        ) ?? html.match(
          new RegExp(`<meta[^>]+content=["']([^"']{4,300})["'][^>]+property=["']og:${prop}["']`, "i"),
        );
        return m ? decodeSegment(m[1]) : "";
      };
      const ogTitle = grab("title");
      blurb = grab("description");
      const pageTitle = titleM ? decodeSegment(titleM[1].replace(/[-–] Google Maps.*$/i, "")) : "";
      if (!place) place = ogTitle || pageTitle;
      if (!address && blurb && /,/.test(blurb)) address = blurb;
      if (!place || !address) {
        const stateStrings = scanAppState(html);
        if (!place && stateStrings.length > 0) place = stateStrings[0];
        if (!address && stateStrings.length > 1) address = stateStrings.slice(1, 3).join(" · ");
      }
    }
  }

  // Bare JS shell / bare coordinates → reverse geocode the coords.
  if ((!place || !address) && lat != null && lng != null) {
    const geo = await reverseGeocode(lat, lng);
    if (!place && geo.name) place = geo.name;
    if (!address && geo.address) address = geo.address;
    // q= may BE the coordinates ("19.1136,72.9683") — already handled.
  }
  if (!place && parsed.query) place = parsed.query;

  const parts: string[] = [];
  parts.push(`## Google Maps location`);
  const facts: string[] = [];
  if (place) facts.push(`Place: ${place}`);
  if (address) facts.push(`Address: ${address}`);
  if (lat != null && lng != null) facts.push(`Coordinates: ${lat}, ${lng}`);
  facts.push(`Final URL (redirect chain followed): ${resolvedUrl}`);
  if (resolvedUrl !== url) facts.push(`Original short link: ${url}`);
  parts.push(facts.join("\n"));
  if (blurb && blurb !== address) parts.push(blurb.slice(0, 600));

  if (facts.length <= 1) return null; // nothing real decoded
  const markdown = parts.join("\n\n").slice(0, 4000);
  return { resolvedUrl, place, address, lat, lng, blurb, markdown };
}

/** Companion metasearch query so the SERP corroborates the decoded place. */
export function mapsCompanionQuery(ev: MapsEvidence): string | null {
  if (ev.place) return `"${ev.place}" location map`.slice(0, 200);
  if (ev.lat != null && ev.lng != null) return `${ev.lat}, ${ev.lng} location`.slice(0, 200);
  return null;
}
