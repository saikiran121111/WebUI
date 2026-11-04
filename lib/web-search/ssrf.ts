/**
 * SSRF guard — the single source of truth for "may we fetch this URL?".
 * Shared by net.ts, agentBrowser.ts, engines.ts, metasearch.ts, media-captions.
 *
 * HARDENED 2026-11-02 (web-search P6 safety); PREFIX REGEX RETIRED
 * 2026-11-04 (audit fix) — the legacy hostname-PREFIX match over-blocked
 * public hosts (`fd.nl`, `fda.gov`, `10.example.com`); hosts are now
 * classified by the exact IPv4/IPv6 literal parsers below, with the
 * precise 16–31 range keeping `172.15.0.1`/`172.32.0.1` allowed. Added on top:
 *  - bracketed IPv6 parsing: `::`, `::1`, ULA fc00::/7 `(g0&0xfe00)==0xfc00`,
 *    link-local fe80::/10 `(g0&0xffc0)==0xfe80`, multicast ff00::/8, and
 *    embedded-IPv4 forms (IPv4-mapped `::ffff:…` incl. hex groups,
 *    6to4 `2002::…`, Teredo `2001:0::…` obfuscated client + server v4).
 *    The old regex's bare `::1|fc|fd` alternatives were dead code because
 *    WHATWG brackets IPv6 hosts (`[::1]`); they were never relied on.
 *  - CGNAT 100.64.0.0/10 (100.63.255.255 stays allowed) and 0.0.0.0/8;
 *  - reserved suffixes: .local / .internal / .localhost / .home.arpa / .invalid;
 *  - userinfo rejection (`http://user:pass@host/` is unsafe — §19);
 *  - `isSafeUrlWithDns`: resolves A/AAAA records and refuses the URL when
 *    ANY record is private — closes the DNS-rebinding TOCTOU a literal-only
 *    check cannot see. Total DNS failure falls back to the literal decision
 *    (a resolver outage must not masquerade as an SSRF denial);
 *  - `firstUnsafeRedirectHop`: per-redirect-chain revalidation helper;
 *  - `scrubQuerySecrets`: deterministic outbound-query secret strip (§14).
 *
 * SOLE OWNER (TS-ownership rollback 2026-11-03): the Rust mirror
 * (crates/ruke-websearch/src/ssrf.rs) was removed. The test vectors were
 * deliberately shared between the two suites; these pins are now the
 * SSRF contract by themselves — do not weaken them.
 */

/* Replaced 2026-11-04 (audit fix). The legacy guard prefix-MATCHED this
   pattern against DNS NAMES, so public sites were "private": fd.nl and
   fda.gov (fd), fcbarcelona.com (fc), 10.example.com (10.). That was only
   ever kept for parity with the Rust mirror (crates/ruke-websearch), which
   was removed on 2026-11-03 — the pins are obsolete and the defect is
   user-visible. Real IP literals are classified by the exact parsers
   below (privateIPv4Octets / parseIPv6Groups), which is the correct rule;
   172.15.0.1 / 172.32.0.1 stay allowed via the precise 16–31 range. */
const PRIVATE_HOST_RE = /^localhost$/i;

/* Reserved / non-routable name suffixes (new, both engines). Note the
   leading-dot requirement: bare `localhost` stays blocked via the legacy
   regex above, while `notlocalhost.example.com` remains allowed. */
const UNSAFE_SUFFIX_RE = /\.(local|internal|localhost|home\.arpa|invalid)$/i;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for loopback / RFC1918 / link-local / CGNAT / "this" networks. */
function privateIPv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a > 255 || b > 255 || c > 255 || d > 255) return false; // malformed — not an address decision
  return (
    a === 0 || // 0.0.0.0/8 "this network" (includes 0.0.0.0)
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
  );
}

function privateIPv4Host(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  return privateIPv4Octets(+m[1], +m[2], +m[3], +m[4]);
}

/**
 * Parse an unbracketed IPv6 literal into exactly 8 16-bit groups.
 * Supports the compressed `::` form once and an optional trailing dotted
 * IPv4 (`::ffff:127.0.0.1`), which is textually converted to its two hex
 * groups (`::ffff:7f00:1`) before splitting — so `[::ffff:7f00:1]` and
 * `[::ffff:127.0.0.1]` land in the same check. Lenient in one documented
 * direction: `x:y:…::` with ≤8 explicit groups is accepted (WHATWG URLs
 * never emit the invalid forms, and being lenient can only ever block
 * more, never less).
 */
function parseIPv6Groups(input: string): number[] | null {
  let s = input;

  // Trailing dotted-quad → two hex groups (keep octets for delegation via
  // the hex-group path — no separate v4 channel needed).
  const m4 = IPV4_RE.exec(s);
  if (m4) {
    const a = +m4[1], b = +m4[2], c = +m4[3], d = +m4[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    const head = s.slice(0, s.length - m4[0].length).replace(/:$/, "");
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    s = `${head}:${hi}:${lo}`;
  }

  const dbl = s.indexOf("::");
  if (dbl !== -1 && s.indexOf("::", dbl + 1) !== -1) return null; // two "::"

  const hexGroup = (t: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(t) ? parseInt(t, 16) : null;

  let left: string[];
  let right: string[] | null;
  if (dbl === -1) {
    left = s.split(":");
    right = null;
  } else {
    left = s.slice(0, dbl) === "" ? [] : s.slice(0, dbl).split(":");
    right = s.slice(dbl + 2) === "" ? [] : s.slice(dbl + 2).split(":");
  }

  const parsed: number[] = [];
  for (const t of left) {
    const v = hexGroup(t);
    if (v === null) return null;
    parsed.push(v);
  }
  if (right !== null) {
    if (parsed.length + right.length > 8) return null;
    while (parsed.length + right.length < 8) parsed.push(0);
    for (const t of right) {
      const v = hexGroup(t);
      if (v === null) return null;
      parsed.push(v);
    }
  } else if (parsed.length !== 8) {
    return null;
  }
  return parsed;
}

/** Private-classification over the 8 parsed groups (see header). */
function privateIPv6Groups(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true; // `::` unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // `::1`

  const g0 = g[0];
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8

  // IPv4-compatible (::/96) and IPv4-mapped (::ffff:/96): delegate the
  // last 32 bits to the IPv4 classifier — this catches `::ffff:7f00:1`
  // (hex) and `::ffff:127.0.0.1` (dotted, normalized to hex upstream).
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return privateIPv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  }

  // 6to4 2002::/16 — embedded v4 in groups 1-2.
  if (g0 === 0x2002) {
    return privateIPv4Octets(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff);
  }

  // Teredo 2001:0000::/32 — server v4 in groups 2-3; the client v4 is
  // obfuscated by XOR with the 16-bit flags field (group 4):
  // client = (g5:g6) XOR (g4:g4).
  if (g0 === 0x2001 && g[1] === 0) {
    if (privateIPv4Octets(g[2] >> 8, g[2] & 0xff, g[3] >> 8, g[3] & 0xff)) return true;
    const obf = ((g[5] << 16) | g[6]) >>> 0;
    const flags32 = ((g[4] << 16) | g[4]) >>> 0;
    const c = (obf ^ flags32) >>> 0;
    return privateIPv4Octets((c >> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  }

  return false;
}

/**
 * True when a URL hostname belongs to a private / reserved / non-routable
 * destination. `host` is the WHATWG `URL.hostname` form (brackets INCLUDED
 * for IPv6, lowercase, no port, no userinfo).
 */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (PRIVATE_HOST_RE.test(host)) return true;
  if (UNSAFE_SUFFIX_RE.test(host)) return true;
  if (host.startsWith("[")) {
    const inner = host.endsWith("]") ? host.slice(1, -1) : host.slice(1);
    const groups = parseIPv6Groups(inner);
    if (!groups) return true; // bracketed but unparseable → refuse
    return privateIPv6Groups(groups);
  }
  if (IPV4_RE.test(host)) return privateIPv4Host(host);
  return false;
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // §19: credentials embedded in a URL are never legitimate scraper
    // traffic and are an exfiltration/log-leak vector — always unsafe.
    if (u.username || u.password) return false;
    return !isPrivateHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Redirect-chain revalidation: given the ordered chain of URLs a fetch
 * traversed (got `res.url`/`redirectUrls`, impit/wreq `res.url`), returns
 * the FIRST hop that is unsafe, or null when the whole chain is safe.
 * Called on every redirect target (got `beforeRedirect`) and on the final
 * response URL (per-pass `res.url()` recheck).
 */
export function firstUnsafeRedirectHop(hops: string[]): string | null {
  for (const h of hops) {
    if (!h) continue;
    if (!isSafeUrl(h)) return h;
  }
  return null;
}

/** Injectable DNS resolver: returns the A/AAAA records for a host, or
 *  null when nothing resolves (→ the caller falls back to the literal
 *  decision). Tests inject fake resolvers; production uses node:dns. */
export type DnsResolver = (
  host: string,
) => Promise<{ v4: string[]; v6: string[] } | null>;

async function defaultDnsResolver(host: string): Promise<{ v4: string[]; v6: string[] } | null> {
  const { promises: dns } = await import("node:dns");
  const [a4, a6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  const v4 = a4.status === "fulfilled" ? a4.value : [];
  const v6 = a6.status === "fulfilled" ? a6.value : [];
  if (v4.length === 0 && v6.length === 0) return null; // unresolvable → literal decision
  return { v4, v6 };
}

function resolvedAddressPrivate(addr: string): boolean {
  const t = addr.trim();
  if (IPV4_RE.test(t)) return privateIPv4Host(t);
  // resolve6 may return scoped/link forms; classify by the bracketless parser.
  const groups = parseIPv6Groups(t.replace(/^\[|\]$/g, ""));
  return groups ? privateIPv6Groups(groups) : true; // garbage from a resolver → refuse
}

/**
 * SSRF guard with DNS-awareness: after the literal host check, resolves
 * A and AAAA records and refuses the URL when ANY resolved address is
 * private. This is what makes DNS rebinding (public name → private A on
 * re-resolution) unreachable from the fetch layer, because the guard and
 * the fetch consult the same name in the same call.
 *
 * Documented failure semantics:
 *  - IP-literal hosts skip DNS (already fully classified);
 *  - total DNS failure (resolver throws / no records at all) falls back to
 *    the LITERAL decision — a resolver outage must not become a false
 *    SSRF denial (documented nuance, both engines);
 *  - any single private record → unsafe.
 */
export async function isSafeUrlWithDns(
  url: string,
  resolver?: DnsResolver,
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if (isPrivateHost(host)) return false;
  if (host.startsWith("[") || IPV4_RE.test(host)) return true; // literal, already classified
  const resolve = resolver ?? defaultDnsResolver;
  let addrs: { v4: string[]; v6: string[] } | null = null;
  try {
    addrs = await resolve(host);
  } catch {
    addrs = null;
  }
  if (!addrs) return true; // literal decision (see docs above)
  for (const a of addrs.v4) if (resolvedAddressPrivate(a)) return false;
  for (const a of addrs.v6) if (resolvedAddressPrivate(a)) return false;
  return true;
}

/* ── Outbound-query secret scrub (§14) ────────────────────────────────────
 * Deterministic, model-free: strips well-known credential shapes from any
 * query string before it leaves this machine via a search-engine request.
 * Conservative patterns — a benign query ("python 3.11 release notes")
 * must survive untouched; pinned by tests in BOTH languages.
 */
const SECRET_RES_CS = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Stripe-style secret keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub OAuth/PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g, // Google OAuth token
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT (header.payload.sig)
];
const SECRET_RES_CI = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // Authorization-style bearer values
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/gi, // key: value pairs
];

export function scrubQuerySecrets(query: string): string {
  if (!query) return query;
  let out = query;
  for (const re of SECRET_RES_CS) out = out.replace(re, " ");
  for (const re of SECRET_RES_CI) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}
