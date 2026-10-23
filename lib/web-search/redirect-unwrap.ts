/**
 * Stage-0 redirect unwrapper (Fix 3).
 *
 * Short links (Google Maps Firebase dynamic links, bit.ly, t.co, …) are
 * HTTP 301/302/303/307/308 stubs — the REAL content lives behind the
 * Location chain, sometimes followed by a <meta http-equiv="refresh">
 * hop. This module follows the full chain and returns the resolved URL
 * so the pipeline extracts the DESTINATION page (a Maps place, a video,
 * a job board) instead of the worthless redirect shell.
 */
import { fetchPage } from "./tls-client";

/** Hosts that are (almost) always redirect stubs, never final content. */
export const SHORTLINK_HOSTS: ReadonlySet<string> = new Set([
  // Google / Firebase dynamic links
  "maps.app.goo.gl",
  "g.page",
  "goo.gl",
  "page.link",
  "app.link",
  // generic shorteners named in the spec + common siblings
  "bit.ly",
  "t.co",
  "lnkd.in",
  "redd.it",
  "amzn.to",
  "amzn.eu",
  "buff.ly",
  "tinyurl.com",
  "ow.ly",
  "is.gd",
  "cutt.ly",
  "s.id",
  "shorturl.at",
]);

/** True when the URL's host is a known short-link / dynamic-link stub. */
export function isShortLinkUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (SHORTLINK_HOSTS.has(host)) return true;
    // Firebase dynamic-link subdomains: <project>.page.link / <x>.app.link
    for (const suffix of [".page.link", ".app.link"]) {
      if (host.endsWith(suffix)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** <meta http-equiv="refresh" content="0;url=https://…"> (the hop HTTP can't see). */
const META_REFRESH_RE =
  /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*([^"'\s>]+)/i;

/**
 * Follow the redirect chain for ANY URL (short links first, but generic
 * on purpose):
 *   1. impit follows HTTP 3xx Location chains automatically — the final
 *      URL arrives on PageResponse.resolvedUrl (and the body we get is
 *      already the final page, so the hop is free).
 *   2. If the fetched page then carries a <meta http-equiv="refresh">,
 *      hop to its target and repeat (maxHops bounds this loop).
 *
 * Returns { finalUrl, hops } once the chain settles (finalUrl === the
 * starting URL when the URL was NOT a redirect), or null when the chain
 * could not be resolved at all (network failure on hop 0).
 */
export async function unwrapRedirect(
  url: string,
  opts: { maxHops?: number; timeoutMs?: number } = {},
): Promise<{ finalUrl: string; hops: number } | null> {
  const maxHops = opts.maxHops ?? 5;
  let current = url;
  let hops = 0;

  while (hops <= maxHops) {
    const page = await fetchPage(current, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      retryOnBlock: true,
    });
    if (!page) {
      // Chain broke mid-flight: keep whatever destination we reached.
      return hops > 0 ? { finalUrl: current, hops } : null;
    }

    let next = "";
    if (page.resolvedUrl && page.resolvedUrl !== current) {
      // HTTP 3xx chain already followed by the TLS layer.
      next = page.resolvedUrl;
    } else {
      // meta-refresh hop.
      const m = META_REFRESH_RE.exec(page.body ?? "");
      if (m) {
        try {
          next = new URL(decodeURIComponent(m[1].trim()), current).toString();
        } catch {
          next = "";
        }
      }
    }

    if (!next || next === current) {
      // Settled: `current` is the real destination (possibly == the input).
      return { finalUrl: current, hops };
    }
    current = next;
    hops++;
  }
  return { finalUrl: current, hops };
}

/** Convenience: the resolved URL string, or null (never throws). */
export async function unwrapShortLink(url: string): Promise<string | null> {
  const r = await unwrapRedirect(url);
  return r ? r.finalUrl : null;
}
