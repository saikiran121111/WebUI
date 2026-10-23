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
import tldts from "tldts";

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
  const seen = new Set<string>();

  // Trailing sentence punctuation is not part of a URL path.
  const stripTail = (t: string) => t.replace(/[.,;:!?)\]}'"`]+$/, "");

  // Pass 1: full URLs with scheme.
  const urlRe = /https?:\/\/[^\s"'<>[\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(prompt)) !== null) {
    const raw = stripTail(m[0]);
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host.length < 4) continue; // skip localhost, IP-like short names
      const key = host;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ raw, url: raw, domain: host, hasScheme: true });
    } catch {
      /* malformed URL token — skip */
    }
  }

  // Pass 2: www.-prefixed tokens (no scheme), optional path preserved.
  const wwwRe = /\bwww\.[\w-]+(?:\.[\w-]+)+(?:\/[^\s"'<>[\]]*)?/gi;
  while ((m = wwwRe.exec(prompt)) !== null) {
    const raw = stripTail(m[0]);
    const host = raw.slice(4).split("/")[0].toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ raw, url: "https://" + raw.toLowerCase(), domain: host, hasScheme: false });
  }

  // Pass 3: bare domain tokens (skiran.dev, lite.ego.app, rbi.org.in),
  // optional path preserved. Matches word tokens that contain at least
  // one dot and have a valid tldts public suffix.
  const bareRe = /\b((?:[a-z0-9][a-z0-9-]*\.){1,6}[a-z]{2,24})(\/[^\s"'<>[\]]*)?/gi;
  while ((m = bareRe.exec(prompt)) !== null) {
    const host = m[1].toLowerCase();
    const path = stripTail(m[2] ?? "");

    // Skip tokens already found in pass 1/2.
    if (seen.has(host)) continue;

    // Skip tokens that look like file paths or dotted identifiers that
    // are not domains: "v1.2.3", "e.g.", "i.e."
    if (host.length < 5) continue;
    if (/^v?\d+\./.test(host)) continue; // version number
    if (host.endsWith(".e.g") || host.endsWith(".i.e")) continue;

    const parsed = tldts.parse(host);
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

    seen.add(host);
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
