/**
 * Universal bare-domain + URL detector using `tldts`.
 *
 * tldts carries all 1,440+ IANA TLDs and 9,000+ multi-part public
 * suffixes (.gov.in, .co.uk, .vercel.app, .github.io, .pages.dev).
 * This replaces the regex-based KNOWN_SITE_TOKEN_RE / DOMAIN_TLD_TOKEN_RE
 * in search-gate.ts, which missed .dev, .ai, .sh, .gg, .xyz, .me, etc.
 *
 * Code-filename guard: a bare token like `app.ts`, `index.html`, or
 * `report.pdf` is a file reference, NOT a domain. tldts.parse treats
 * the file extension as the public suffix and reports isIp=false with
 * a single-label domain. We exclude tokens whose "publicSuffix" is a
 * known local file/code extension unless the token is prefixed with
 * http(s):// or www.
 */
// Named import ONLY: `tldts` has no default export in browser ESM builds
// (see the named-import law comment in lib/decision/task-scope.ts — the
// default-import crash the Phase-6 E2E matrix caught applies here too).
import { parse as tldtsParse } from "tldts";
import { FRAGMENT_ROUTE_RE } from "./types";

/**
 * File/code extensions that must never be mistaken for TLDs.
 * If tldts.parse reports publicSuffix === one of these, the token is
 * a local filename, not a domain.
 */
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "txt",
  "css", "scss", "less", "html", "xml", "yml", "yaml", "toml",
  "py", "rb", "java", "c", "cpp", "h", "rs", "go", "cs", "kt",
  // NB: "sh" is deliberately NOT guarded — .sh is the Saint Helena ccTLD
  // (user spec requires site.sh detection); the spec's guard list omits it.
  "swift", "php", "bat", "ps1",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
  "pdf", "zip", "tar", "gz", "rar", "7z",
  "exe", "msi", "dmg", "apk",
  "gguf", "onnx", "bin", "dat", "model",
  "env", "ini", "cfg", "conf",
]);

export interface DetectedUrl {
  /** The original token as it appeared in the prompt. */
  raw: string;
  /** Normalized https:// URL. */
  url: string;
  /** Parsed domain (e.g. "skiran.dev"). */
  domain: string;
  /** True when the token already carried http(s)://. */
  hasScheme: boolean;
}

/**
 * Extract all URLs and bare domains from a prompt string.
 *
 * Returns an empty array when nothing is found.
 *
 * @param prompt  The user's message.
 * @param opts.excludeFileTokens — default true; skip tokens whose
 *   tldts publicSuffix matches a known file/code extension.
 */
export function detectUrlsAndDomains(
  prompt: string,
  opts: { excludeFileTokens?: boolean } = {},
): DetectedUrl[] {
  if (!prompt) return [];
  const { excludeFileTokens = true } = opts;

  const out: DetectedUrl[] = [];
  // 2026-11-04 audit fix: pass-1 URLs dedupe by FULL URL (origin+path+query)
  // — the hostname-only key dropped every second product link on the same
  // site. seenHost keeps the cross-pass suppression (a bare domain token
  // does not re-detect a host already surfaced with a full URL).
  const seenUrl = new Set<string>();
  const seenHost = new Set<string>();

  // Trailing sentence punctuation is not part of a URL path.
  const stripTail = (t: string) => t.replace(/[.,;:!?)\]}'"`]+$/, "");

  // 2026-11-05 audit fix (item 17 / WS17): ONE page-identity law for all
  // three passes. A page is origin + path + query, plus the hash only when
  // it is a fragment ROUTER (SPA route), not a plain anchor — the exact
  // rule pass 1 already used. Passes 2/3 key on this same formula instead
  // of the host, so distinct scheme-less paths on one host survive and
  // the same page written in different forms detects once.
  const pageKeyOf = (u: URL) =>
    u.origin + u.pathname + u.search + (FRAGMENT_ROUTE_RE.test(u.hash) ? u.hash : "");
  const pageKeyOfHref = (href: string): string | null => {
    try {
      return pageKeyOf(new URL(href));
    } catch {
      return null; // unparsable token — caller falls back to host suppression
    }
  };

  // Pass 1: full URLs with scheme.
  const urlRe = /https?:\/\/[^\s"'<>[\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(prompt)) !== null) {
    const raw = stripTail(m[0]);
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host.length < 4) continue; // skip localhost, IP-like short names
      // path/query case preserved; §6: a fragment-router hash IS page
      // identity — two `#/route` pages on one host are distinct targets
      // (pure anchors still collapse onto the page).
      const key = pageKeyOf(u);
      if (seenUrl.has(key)) continue;
      seenUrl.add(key);
      seenHost.add(host);
      out.push({ raw, url: raw, domain: host, hasScheme: true });
    } catch {
      /* malformed URL token — skip */
    }
  }

  // Pass 2: www.-prefixed tokens (no scheme), optional path preserved.
  const wwwRe = /\bwww\.[\w-]+(?:\.[\w-]+)+(?:\/[^\s"'<>[\]]*)?/gi;
  while ((m = wwwRe.exec(prompt)) !== null) {
    const raw = stripTail(m[0]);
    const slash = raw.indexOf("/");
    const hostPart = slash === -1 ? raw : raw.slice(0, slash);
    const pathPart = slash === -1 ? "" : raw.slice(slash);
    const host = hostPart.slice(4).toLowerCase();
    // Host suppression belongs ONLY to the path-less bare-domain form —
    // it stops a bare "example.com" re-detecting a host already surfaced.
    // A scheme-less www token WITH a path is a full page reference and
    // dedupes on the shared full-page key; keying it by host dropped every
    // second distinct path (".../product/A and .../product/B" lost B).
    const key =
      pathPart === "" ? null : pageKeyOfHref("https://" + hostPart.toLowerCase() + pathPart);
    if (pathPart !== "" && key !== null) {
      if (seenUrl.has(key)) continue;
    } else if (seenHost.has(host)) {
      continue; // bare-domain form (or unparsable path) — host law as before
    }
    seenHost.add(host);
    if (key !== null) seenUrl.add(key);
    // Host lowercased, path/query case preserved (case-sensitive product paths).
    out.push({ raw, url: "https://" + hostPart.toLowerCase() + pathPart, domain: host, hasScheme: false });
  }

  // Pass 3: bare domain tokens (skiran.dev, lite.ego.app, rbi.org.in),
  // optional path preserved. Matches word tokens that contain at least
  // one dot and have a valid tldts public suffix.
  const bareRe = /\b((?:[a-z0-9][a-z0-9-]*\.){1,6}[a-z]{2,24})(\/[^\s"'<>[\]]*)?/gi;
  while ((m = bareRe.exec(prompt)) !== null) {
    const host = m[1].toLowerCase();
    const path = stripTail(m[2] ?? "");

    // Skip tokens already found in pass 1/2. Same page-identity law as
    // pass 2: a token WITH a path dedupes on its full page key; only the
    // path-less bare-domain token stays suppressed at host level.
    const key = path === "" ? null : pageKeyOfHref("https://" + host + path);
    if (path !== "" && key !== null) {
      if (seenUrl.has(key)) continue;
    } else if (seenHost.has(host)) {
      continue;
    }

    // Skip tokens that look like file paths or dotted identifiers that
    // are not domains: "v1.2.3", "e.g.", "i.e."
    if (host.length < 5) continue;
    if (/^v?\d+\./.test(host)) continue; // version number
    if (host.endsWith(".e.g") || host.endsWith(".i.e")) continue;

    const parsed = tldtsParse(host);
    // tldts: domain = registrable domain (public suffix + one label),
    // publicSuffix = TLD or multi-part suffix. "skiran.dev" -> domain
    // "skiran.dev" / suffix "dev". "lite.ego.app" -> domain "ego.app" /
    // suffix "app" (the token is a subdomain of the registrable domain —
    // still a valid site); accept host === domain or host ends with
    // "." + domain.
    if (!parsed.domain) continue;
    const reg = parsed.domain;
    if (host !== reg && !host.endsWith("." + reg)) continue;
    const pubSuffix = parsed.publicSuffix ?? "";
    if (pubSuffix === "invalid" || pubSuffix === "unlisted") continue;

    // Code-filename guard: if the host's publicSuffix is a file extension
    // (ts, js, html, pdf, ...), the token is a local filename, not a
    // domain (tldts reads ".rs"/".me"/".io" ccTLDs as valid suffixes, so
    // this guard is load-bearing for "main.rs").
    if (excludeFileTokens && FILE_EXTENSIONS.has(pubSuffix)) continue;

    seenHost.add(host);
    if (key !== null) seenUrl.add(key);
    out.push({
      raw: host + path,
      url: "https://" + host + path,
      domain: host,
      hasScheme: false,
    });
  }

  return out;
}

/**
 * Convenience: return just the normalized https:// URLs (scheme already
 * on, or prepended). Empty array when nothing detected.
 */
export function detectPromptUrls(prompt: string): string[] {
  return detectUrlsAndDomains(prompt).map((d) => d.url);
}
