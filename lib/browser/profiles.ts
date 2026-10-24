/**
 * Per-site browser profiles under `.data/browser-profiles/`.
 *
 * Every website the login browser has signed in to gets its own persistent
 * Chromium user-data dir (`.data/browser-profiles/<site>/`). Launching the
 * interactive browser for a site reuses that dir, so its cookies/keys/login
 * state survive across sessions — and deleting one site folder wipes
 * exactly that site's auth, nothing else. Nothing ever leaves the project
 * tree: no cloud, no shared global profile.
 *
 * Wipe: `rm -rf .data/browser-profiles` (or per site: remove its folder).
 */
import fs from "node:fs";
import path from "node:path";

const PROFILES_ROOT = path.join(process.cwd(), ".data", "browser-profiles");

const SITE_SLUG_MAX = 48;

/**
 * Derive the stable per-site profile dir from a URL: the registrable
 * domain (eTLD+1, e.g. `linkedin.com`) so `www.`/`m.`/subdomains of the
 * same site share one profile. Falls back to the full host when the TLD
 * is unknown (localhost, IPs, unusual registrable labels).
 */
function domainOf(rawUrl: string): string | null {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    const bare = rawUrl.trim();
    if (!bare || bare === "about:blank" || bare.startsWith("chrome")) return null;
    host = bare.split(/[:/?#]/)[0]?.toLowerCase() ?? "";
    if (!host) return null;
    host = /^https?:$/.test(host) ? "" : host; // bare "https"/"http" — unknown site
  }
  if (!host) return null;
  // IP / localhost: the whole host is the identity.
  if (/^\d+$/.test(host.split(".").pop() ?? "") || host === "localhost") return host;
  try {
    const mod = require("tldts");
    const tldts = mod.default ?? mod;
    const result = tldts.getDomain?.(host, { strict: false });
    if (typeof result === "string" && result) return result;
  } catch {
    /* tldts unavailable — registrable-domain fallback below */
  }
  // Static-table fallback: last two labels (wrong for a few ccTLDs like
  // co.in, but those are covered when tldts resolves).
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

function safeSlug(domain: string): string {
  const s = domain
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .slice(0, SITE_SLUG_MAX);
  return s || "site";
}

/**
 * The persistent profile dir for the site of `url`. Empty/unknown hosts
 * fall back to the generic default profile (first launch before a URL is
 * known, `about:blank`, and panel reopen).
 */
export function profileDirFor(url?: string | null): string {
  const domain = url ? domainOf(url) : null;
  if (!domain || domain === "default") return defaultProfileDir();
  return path.join(PROFILES_ROOT, safeSlug(domain));
}

/** The generic (no-site) profile — used only for the very first launch. */
export function defaultProfileDir(): string {
  return path.join(PROFILES_ROOT, "default");
}

/**
 * A site directory exists when its Chromium profile has actually started
 * (the `SingletonLock` marker). Only those sites carry real auth state.
 */
export function hasSiteAuth(slug: string): boolean {
  try {
    fs.accessSync(path.join(PROFILES_ROOT, slug, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

/** Same marker check for an ABSOLUTE profile directory (from profileDirFor). */
export function hasSiteAuthPath(dir: string): boolean {
  try {
    fs.accessSync(path.join(dir, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

export interface SiteProfileInfo {
  /** e.g. `linkedin.com` — the folder name under `.data/browser-profiles/`. */
  slug: string;
  /** Whether an auth profile actually exists for this site. */
  authenticated: boolean;
  /** The site's profile directory (absolute). */
  dir: string;
}

/** Every site with a stored profile, newest-first, with auth status. */
export function listSiteProfiles(): SiteProfileInfo[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(PROFILES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: SiteProfileInfo[] = [];
  for (const slug of entries.sort()) {
    if (slug === "default") continue;
    const dir = path.join(PROFILES_ROOT, slug);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      /* raced away — still list it */
    }
    out.push({
      slug,
      authenticated: hasSiteAuth(slug),
      dir,
    });
  }
  out.sort((a, b) => {
    const ma = safeMtime(a.dir);
    const mb = safeMtime(b.dir);
    return mb - ma;
  });
  return out;
}

function safeMtime(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}
