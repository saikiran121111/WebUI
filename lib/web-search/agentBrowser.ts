/**
 * Playwright stealth Chromium pool — replaces the old `agent-browser` CLI
 * shelling (which shelled out to a non-existent binary and always failed).
 *
 * Design goals:
 *   - Real Chromium from the `playwright` package, pointed at the local
 *     `.data/ms-playwright` browser cache (PLAYWRIGHT_BROWSERS_PATH).
 *   - A singleton Browser Context pool (max 4–6 concurrent pages, sized
 *     via WEB_SEARCH_BROWSER_POOL_SIZE) so parallel extraction reuses one
 *     browser instance instead of spawning one per URL.
 *   - Per-context fingerprint rotation: each context gets a fresh
 *     `fingerprint-generator` fingerprint (UA, sec-ch-ua, platform, viewport,
 *     locale, canvas/webgl fingerprints) injected via `fingerprint-injector`
 *     so Zepto / Cloudflare / DataDome WAFs see a consistent, realistic
 *     browser persona per context instead of a single hardcoded identity.
 *   - Fast resource routing: abort images/media/fonts/analytics/doubleclick
 *     so pages load in under ~3s when only text is needed.
 *   - Extraction surface: live-rendered DOM (title, final URL, JSON-LD,
 *     OpenGraph/Twitter meta, cleaned body innerText, plus any well-known
 *     `window` global hydration state objects such as `__NEXT_DATA__`,
 *     `__NUXT__`, `__INITIAL_STATE__`, `__PRELOADED_STATE__`, `__myx`,
 *     `__remixContext`, `ytInitialData`, etc.).
 *
 * The pool self-limits: acquire() waits when every context is busy
 * (WEB_SEARCH_BROWSER_ACQUIRE_TIMEOUT_MS), and a page stuck on a hard
 * WAF challenge gets abandoned after BROWSER_PAGE_BUDGET_MS so one hostile
 * host cannot freeze the whole extraction tier.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { isSafeUrl } from "@/lib/web-search/ssrf";
import {
  attachCaptionListener,
  probeCaptionSegments,
  type CaptionCaptureStore,
} from "@/lib/web-search/captionProbe";
import { formatCaptionSegments } from "@/lib/web-search/captionFormats";
import { childLogger } from "@/lib/server/logger";

/* fingerprint-suite: each pooled context gets a fresh, consistent
 * fingerprint (canvas, webgl, audio, navigator, screen, headers) via
 * fingerprint-generator + fingerprint-injector so WAFs see realistic,
 * non-identical browser personas instead of one static hardcoded
 * persona that fingerprint-based anti-bot systems tag quickly.
 * No new packages — both are already in package.json. */
let _fpGenerator: any = null;
let _fpInjector: any = null;

async function getFingerprintSuite() {
  if (!_fpGenerator || !_fpInjector) {
    try {
      const fgMod: any = await import("fingerprint-generator");
      const fiMod: any = await import("fingerprint-injector");
      // CJS/ESM interop: the package may export the class as a named
      // export, a default export, or the module itself.
      _fpGenerator = new (fgMod?.FingerprintGenerator ?? fgMod?.default ?? fgMod)();
      _fpInjector = new (fiMod?.FingerprintInjector ?? fiMod?.default ?? fiMod)();
    } catch {
      /* package missing or broken — fall back to the static persona */
    }
  }
  if (!_fpGenerator || !_fpInjector) return null;
  try {
    const fp = _fpGenerator.getFingerprint();
    return { fp, injector: _fpInjector };
  } catch {
    return null;
  }
}

async function applyFingerprintToContext(
  ctx: BrowserContext,
  suite: { fp: any; injector: any } | null,
): Promise<Record<string, string> | null> {
  if (!suite) return null;
  try {
    /* attachFingerprintToPlaywright adds the full init-script injection:
       canvas fingerprint, webgl renderer, audio fingerprint, navigator.*
       patches, screen/viewport overrides, plugin list, etc.  It is the
       proper way to use fingerprint-injector — not a hand-rolled patch. */
    await suite.injector.attachFingerprintToPlaywright(ctx, suite.fp);
    return suite.fp.headers ?? {};
  } catch {
    /* injector failure — return null so the caller falls back to static */
    return null;
  }
}

// Zero downloads: point Playwright at the repo-local browser cache
// (.data/ms-playwright, already committed per CLAUDE.md §1 / the
// playwright.config.ts precedent) BEFORE the first require of
// playwright's browser registry. The env var is read by the driver at
// launch time, so setting it at module load is the supported hook.
{
  const { join, __dirname: _pj } = require("node:path") as any;
  const { existsSync } = require("node:fs");
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const candidates = [
      join(process.cwd(), ".data", "ms-playwright"),
      join(_pj ?? process.cwd(), "..", "..", ".data", "ms-playwright"),
    ];
    for (const c of candidates) {
      if (c && existsSync(c)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = c;
        break;
      }
    }
  }
}

const log = childLogger("web-search/agent-browser");

/**
 * Pool kill-switch: the 10K audit and other stress runners set this to
 * "1" so the browser tier is skipped entirely (the HTTP + Jina + Wayback
 * + SERP-baseline tiers still run — the waterfall guarantee is intact).
 * Zero browser slots are opened when the flag is set.
 */
export function browserPoolDisabled(): boolean {
  return process.env.WEB_SEARCH_BROWSER_DISABLED === "1" || process.env.AGENT_BROWSER_DISABLED === "1";
}

/* ── configuration ─────────────────────────────────────────────────────── */

const POOL_SIZE = Math.max(
  4,
  Math.min(6, parseInt(process.env.WEB_SEARCH_BROWSER_POOL_SIZE ?? "5", 10) || 5),
);
const BROWSER_PAGE_BUDGET_MS = 40_000;

/* Generic bot-gate interstitial markers — detection is PASSIVE and
 * site-agnostic (no domains hardcoded). These strings appear on
 * Cloudflare managed challenges / block pages, AWS WAF and DataDome
 * interstitials. They exist so the settle loop never mistakes a
 * challenge page's own text (which is >300 chars) for real content.
 * We use them only to know the page has NOT settled on content — we
 * never interact with a CAPTCHA or challenge widget. */
const CHALLENGE_MARKER_RE =
  /just a moment|verifying you are ?(a )?human|verify you are human|checking your browser|enable javascript and cookies|attention required|error 10[0-9]{2}|cf-browser-verification|cf-chl|ddos-guard|403 forbidden|access denied|request blocked|unusual traffic/i;

/** Pure predicate (vector-tested): does this body text look like a
 *  WAF/anti-bot interstitial rather than the page's real content? */
export function challengeMarkersPresent(bodyText: string): boolean {
  return CHALLENGE_MARKER_RE.test(bodyText);
}
const ACQUIRE_TIMEOUT_MS = 60_000;

// Exported so the headless extraction tiers and the 10K audit share one
// consistent browser persona across the pool.
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const SEC_CH_UA = '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"';

export const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--disable-devtool-features=AutomationControlled",
];

export const STEALTH_INIT_SCRIPT = `
try {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  delete navigator.__proto__.webdriver;
} catch (_) {}
try {
  Object.defineProperty(navigator, "languages", { get: () => ["en-IN", "en-US", "en"] });
  Object.defineProperty(navigator, "language", { get: () => "en-IN" });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { app: {}, runtime: {} };
} catch (_) {}
`;

/* The context sends sec-ch-ua/sec-ch-ua-mobile/sec-ch-ua-platform HTTP
   headers AND a Chrome-branded UA, but the underlying Chromium binary
   still reports its own (version-skewed, Chromium-not-Google-Chrome)
   brand list through navigator.userAgentData JS. WAF environment checks
   (Cloudflare Turnstile foremost) cross-compare the JS UA-CH object with
   the HTTP client-hints headers — a mismatch flags the session and the
   managed challenge escalates to interactive mode, which we may never
   satisfy passively. Live audit 2026-11-04: headers said Chrome 131/14x,
   brands said Chromium/153, fullVersions was null. This script makes the
   JS view derive from the exact header values the context sends, so the
   persona is internally consistent. */
function uaMatchInitScript(
  ua: string,
  secChUa: string,
  secChUaMobile: string,
  secChUaPlatform: string,
): string {
  const full = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? "";
  const brands = secChUa
    .split(",")
    .map((p) => {
      const m = /^\s*"?([^";]+)"?\s*;\s*v="?(\d+)"?\s*$/.exec(p);
      return m ? { brand: m[1].trim(), version: m[2] } : null;
    })
    .filter((b): b is { brand: string; version: string } => b !== null);
  const fullVersions = brands.map((b) => ({ brand: b.brand, version: full || b.version }));
  const platform = secChUaPlatform.replace(/^"|"$/g, "");
  const mobile = secChUaMobile.trim() === "?1";
  const payload = JSON.stringify({ brands, fullVersions, mobile, platform });
  return `try {
  const d = ${payload};
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    get: () => ({
      brands: d.brands.slice(),
      mobile: d.mobile,
      platform: d.platform,
      fullVersions: d.fullVersions.slice(),
      getHighEntropyValues: function (hints) {
        var h = {};
        (hints || []).forEach(function (k) {
          if (k === "architecture") h.architecture = "x86";
          else if (k === "bitness") h.bitness = "64";
          else if (k === "model") h.model = "";
          else if (k === "platformVersion") h.platformVersion = "15.1.0";
          else if (k === "uaFullVersion") h.uaFullVersion = ${JSON.stringify(full)};
          else if (k === "fullVersionList") h.fullVersionList = d.fullVersions.slice();
          else if (k === "formFactors") h.formFactors = ["Desktop"];
        });
        h.mobile = d.mobile; h.platform = d.platform;
        return Promise.resolve(h);
      },
    }),
  });
} catch (_) {}`;
}

/* ── lazy browser cache (PLAYWRIGHT_BROWSERS_PATH) ─────────────────────── */

/**
 * Point Playwright at the local `.data/ms-playwright` cache so the pool
 * never downloads or pollutes the user profile. The playwright package
 * is a hard dependency (1.63.0 pinned), so this is a direct import — the
 * path override mirrors playwright.config.ts.
 */
function applyBrowsersPathOverride(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  try {
    const { join } = require("node:path");
    const candidates = [
      join(process.cwd(), ".data", "ms-playwright"),
      join(__dirname, "..", "..", ".data", "ms-playwright"),
    ];
    const { existsSync } = require("node:fs");
    for (const p of candidates) {
      if (p && existsSync(p)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = p;
        break;
      }
    }
  } catch {
    /* fall back to the package's default resolution */
  }
}

/**
 * Resolve the local Chromium executable from `.data/ms-playwright`.
 * Pure filesystem scan — no dependency on playwright-core's internal
 * registry (its exports map blocks deep requires, which dumped 3-5
 * stack traces per request in the Next.js dev server). The scan finds
 * the newest chromium-* revision directory and joins the platform-specific
 * binary path.
 */
export function chromiumExecPath(): string | undefined {
  applyBrowsersPathOverride();

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  const { readdirSync, existsSync } = require("node:fs");
  const { join } = require("node:path");
  const dirs = readdirSync(base)
    .filter((d: string) => d.startsWith("chromium") && !d.includes("_"))
    .sort()
    .reverse(); // newest revision first
  for (const d of dirs) {
    const platform = process.platform;
    const candidates =
      platform === "win32"
        ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome.exe"]
        : platform === "darwin"
          ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome"]
          : ["chrome-linux/chrome", "chrome"];
    for (const c of candidates) {
      const p = join(base, d, c);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/* ── pool state (singleton) ────────────────────────────────────────────── */

interface PoolState {
  browser: Browser | null;
  contexts: BrowserContext[];
  inUse: Set<BrowserContext>;
  launching: Promise<void> | null;
}

const pool: PoolState = {
  browser: null,
  contexts: [],
  inUse: new Set(),
  launching: null,
};


/**
 * Ensure the pool is launched and sized. Idempotent: concurrent callers
 * share the single launching promise, and extra contexts are created only
 * when the pool has fewer than POOL_SIZE.
 */
async function ensurePool(): Promise<void> {
  if (pool.contexts.length >= POOL_SIZE && pool.browser) return;
  if (!pool.launching) {
    pool.launching = (async () => {
      if (!pool.browser) {
        applyBrowsersPathOverride();
        pool.browser = await chromium.launch({
          headless: true,
          args: STEALTH_ARGS,
          executablePath: chromiumExecPath(),
          // The playwright package resolves its own install location for
          // the driver; the browser binaries come from the cache dir.
        } as any);
        pool.browser.on("disconnected", () => {
          // A crashed browser invalidates every context — reset so the
          // next ensurePool() relaunches a clean instance.
          pool.contexts.length = 0;
          pool.inUse.clear();
          pool.browser = null;
        });
      }
      while (pool.contexts.length < POOL_SIZE) {
        /* Fresh fingerprint per context — WAFs that fingerprint the
           UA/sec-ch-ua/viewport/screen/locales tuple see a consistent,
           realistic, non-identical persona per slot instead of one
           hardcoded identity. The injector adds canvas/webgl/audio/
           navigator patches that the static STEALTH_INIT_SCRIPT cannot. */
        const suite = await getFingerprintSuite();
        const headers = suite ? (suite.fp.headers ?? {}) : {};
        /* fingerprint-generator emits a document-navigation header
           TEMPLATE (sec-fetch-*, accept, accept-encoding,
           upgrade-insecure-requests...).  Spreading it as static
           context-wide extra headers makes Chromium send those
           browser-managed/request-scoped values on EVERY subresource:
           live audit 2026-11-04 — cross-origin WAF challenge scripts
           (AWS WAF token endpoints) died with net::ERR_INVALID_ARGUMENT
           and the beacon fetches with net::ERR_FAILED, so the WAF
           never issued its clearance cookie and the read walled
           honestly.  fingerprint-injector's own onlyInjectableHeaders
           strips exactly this family set; mirror it here (families,
           not sites — fully generic).  The sec-ch-ua quartet and
           accept-language are managed separately below. */
        const REQUEST_SCOPED = new Set([
          "accept",
          "accept-encoding",
          "cache-control",
          "pragma",
          "upgrade-insecure-requests",
          "sec-fetch-dest",
          "sec-fetch-mode",
          "sec-fetch-site",
          "sec-fetch-user",
          "te",
        ]);
        const safeHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          const kl = k.toLowerCase();
          if (kl === "user-agent" || kl === "accept-language" || kl.startsWith("sec-ch-ua")) continue;
          if (REQUEST_SCOPED.has(kl)) continue;
          safeHeaders[kl] = String(v);
        }
        const ua = headers["user-agent"] ?? USER_AGENT;
        const secChUa = headers["sec-ch-ua"] ?? SEC_CH_UA;
        const secChUaMobile = headers["sec-ch-ua-mobile"] ?? "?0";
        const secChUaPlatform = headers["sec-ch-ua-platform"] ?? '"Windows"';

        /* Viewport must come from the fingerprint so canvas/webgl
           fingerprints match the declared screen size. */
        const fpViewport = suite?.fp?.fingerprint?.viewport;
        const ctx = await pool.browser!.newContext({
          userAgent: ua,
          viewport: fpViewport
            ? { width: fpViewport.width, height: fpViewport.height }
            : { width: 1366, height: 768 },
          locale: "en-IN",
          extraHTTPHeaders: {
            "accept-language": "en-IN,en-US;q=0.9,en;q=0.8",
            "sec-ch-ua": secChUa,
            "sec-ch-ua-mobile": secChUaMobile,
            "sec-ch-ua-platform": secChUaPlatform,
            ...safeHeaders,
          },
        });
        /* The proper injector path — full canvas/webgl/audio/fingerprint
           script injection, not the minimal static patch.  The injector
           re-applies setExtraHTTPHeaders from this context's options, so
           the clean spread above survives the attach. */
        await applyFingerprintToContext(ctx, suite);
        /* Belt-and-braces: whatever the injector merged, the final
           context header set must stay free of browser-managed
           request-scoped headers (same family law as above). */
        try {
          const pinned: Record<string, string> = {
            "accept-language": "en-IN,en-US;q=0.9,en;q=0.8",
            "sec-ch-ua": secChUa,
            "sec-ch-ua-mobile": secChUaMobile,
            "sec-ch-ua-platform": secChUaPlatform,
            ...safeHeaders,
          };
          await ctx.setExtraHTTPHeaders(pinned);
        } catch {
          /* header pin failed — context still usable with create-time set */
        }
        /* Also keep the static stealth patch as a baseline fallback */
        await ctx.addInitScript({ content: STEALTH_INIT_SCRIPT });
        /* Last init script wins: the UA-CH spoof is generated from THIS
           context's header values, so JS and HTTP client hints agree. */
        await ctx.addInitScript({
          content: uaMatchInitScript(ua, secChUa, secChUaMobile, secChUaPlatform),
        });
        pool.contexts.push(ctx);
      }
    })();
    pool.launching.finally?.(() => {
      pool.launching = null;
    });
  }
  await pool.launching;
}

function freeContext(ctx: BrowserContext): void {
  pool.inUse.delete(ctx);
}

async function acquireContext(): Promise<BrowserContext> {
  await ensurePool();
  // Pick the first context not currently in use.
  for (const c of pool.contexts) {
    if (!pool.inUse.has(c)) {
      pool.inUse.add(c);
      return c;
    }
  }
  // All busy — wait for one to free up, bounded by ACQUIRE_TIMEOUT_MS.
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const free = pool.contexts.find((c) => !pool.inUse.has(c));
    if (free) {
      pool.inUse.add(free);
      return free;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "agentBrowser: pool exhausted after " + ACQUIRE_TIMEOUT_MS + "ms wait",
      );
    }
  }
}

/** Explicitly release the whole pool (used by tests / process exit). */
export async function closeBrowserPool(): Promise<void> {
  for (const c of pool.contexts) {
    try {
      await c.close();
    } catch {
      /* already closed */
    }
  }
  pool.contexts = [];
  pool.inUse.clear();
  try {
    await pool.browser?.close();
  } catch {
    /* browser may have already disconnected */
  }
  pool.browser = null;
}

/* ── public API ────────────────────────────────────────────────────────── */

/**
 * Raw pool primitives for the YouTube caption interceptor
 * (lib/web-search/youtube-captions.ts): the player must load its media
 * and its own network responses must be observed, so the one-pass text
 * extractor (which route-aborts media and never watches responses)
 * cannot be used. Callers MUST `releasePoolContext` in a finally block —
 * a leaked context permanently shrinks the pool.
 */
export { acquireContext as acquirePoolContext, freeContext as releasePoolContext };

export interface PageExtraction {
  ok: boolean;
  url: string;
  finalUrl: string;
  title: string;
  status: number | null;
  /** Cleaned body text (nav/footer/cookie-banner noise removed). */
  bodyText: string;
  /** JSON-LD blocks, raw (already parsed into the markdown the caller wants). */
  jsonLd: any[];
  /** OpenGraph + Twitter + description meta, flat key → value map. */
  meta: Record<string, string>;
  /** Well-known window global hydration payloads that were found. */
  windowState: Record<string, string>;
  /**
   * ARIA accessibility snapshot of the rendered page (root + same-origin
   * child frames). This is what pierces Shadow DOM, React portals, and
   * cross-origin iframes that `innerText` on the main document misses.
   */
  ariaSnapshot?: string;
  error?: string;
}

/**
 * Single-pass extraction: settle + DOM + meta + JSON-LD + window state
 * + ARIA snapshot in ONE round-trip per page. This is the hot path the
 * extractor's Stage B calls — the whole page is read in one
 * `page.evaluate` so the pool slot is held for as little time as
 * possible. The C++ accessibility-tree snapshot is what lets us pierce
 * shadow DOM and React portals that `innerText` alone misses.
 */
export interface OnePassExtraction {
  url: string;
  finalUrl: string;
  title: string;
  status: number | null;
  bodyText: string;
  ariaSnapshot: string;
  jsonLd: any[];
  meta: Record<string, string>;
  windowState: Record<string, string>;
  /** True when at least one extractable fact was recovered. */
  ok: boolean;
  error?: string;
}

/**
 * The 1-pass engine extraction: domcontentloaded + short settle, then
 * a SINGLE `page.evaluate` that returns title, final URL, JSON-LD,
 * OpenGraph/Twitter/description meta, cleaned body innerText, and the
 * SPA `window` global state. Followed by a single
 * `locator(":root").ariaSnapshot()` call to get the accessibility-tree
 * semantic snapshot (pierces Shadow DOM / React portals).
 *
 * This is the API the extractor's Stage B calls. It differs from
 * `extractUrlBrowser` only in that the ARIA snapshot is produced here
 * and the DOM pass is the single `evaluate` — no re-fetch, no second
 * settle, no second round-trip.
 */
export async function extractPageInOnePass(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<OnePassExtraction> {
  if (browserPoolDisabled()) {
    return {
      url,
      finalUrl: "",
      title: "",
      status: 0,
      bodyText: "",
      ariaSnapshot: "",
      jsonLd: [],
      meta: {},
      windowState: {},
      ok: false,
      error: "browser pool disabled via WEB_SEARCH_BROWSER_DISABLED",
    };
  }
  const r = await extractUrlBrowser(url, opts);
  const out: OnePassExtraction = {
    url,
    finalUrl: r.finalUrl,
    title: r.title,
    status: r.status,
    bodyText: r.bodyText,
    ariaSnapshot: r.ariaSnapshot ?? "",
    jsonLd: r.jsonLd,
    meta: r.meta,
    windowState: r.windowState,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
  };
  return out;
}

/**
 * Google SERP through the stealth pool (2026-11-04). The HTTP tier now
 * receives a JS-required shell from Google (a "Google Search" title plus
 * an enablejs meta-refresh — live-probed: 200 OK, 94 KB, zero organic
 * anchors), so Google is fetched the way its users are: a real Chromium
 * render in a fingerprinted pooled context, parsed from the live DOM.
 * Strictly passive: we never click consent, CAPTCHA or "I'm not a robot"
 * controls — if Google serves its own block page we return an honest
 * zero and the engine breaker does the rest.
 */
export async function readGoogleSerp(
  query: string,
  gl: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ url: string; title: string; snippet: string }[]> {
  if (browserPoolDisabled()) return [];
  const ctx = await acquireContext();
  const page: Page = await ctx.newPage();
  try {
    const res = await page
      .goto(
        "https://www.google.com/search?q=" +
          encodeURIComponent(query) +
          "&num=20&hl=en&gl=" + encodeURIComponent(gl),
        { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 15_000 },
      )
      .catch(() => null);
    if (!res) {
      log.info({ query }, "google SERP browser tier: navigation failed (no response)");
      return [];
    }
    if (res.status() >= 400) {
      /* Booleans/status/URL only — no cookies or headers in logs. */
      log.info(
        { query, status: res.status(), finalUrl: page.url() },
        "google SERP browser tier: blocked status",
      );
      return [];
    }
    // Wait (bounded) for organic anchors to render. Both markup eras
    // count: modern SERPs nest h3 inside the anchor, basic-HTML SERPs
    // nest the anchor inside <h3 class="r">.
    const t0 = Date.now();
    while (Date.now() - t0 < 3_000) {
      const n = await page
        .evaluate(() => document.querySelectorAll("a[href] h3, h3 a[href]").length)
        .catch(() => 0);
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    /* h3 is the organic-title marker in every Google markup era; the
       anchor either wraps it (`<a><h3>t</h3></a>`, the modern form) or is
       wrapped by it (`<h3><a>t</a></h3>`, basic-HTML form). Live probes
       (2026-11-04) proved the real destination is NOT in the DOM: the
       hrefs are signed `google.com/goto?url=<token>` redirectors and the
       SERP's CSP blocks in-page fetch() from following them. The
       user-equivalent passive resolution is navigation itself: open a
       scratch tab, goto() the href, read where the redirect chain
       committed. Tokens that refuse are skipped honestly. */
    const raws = await page
      .evaluate(() => {
        const out: { raw: string; title: string; snippet: string }[] = [];
        const seen = new Set<string>();
        for (const h3 of Array.from(document.querySelectorAll("h3"))) {
          const a =
            (h3.closest("a[href]") as HTMLAnchorElement | null) ??
            (h3.querySelector("a[href]") as HTMLAnchorElement | null);
          if (!a) continue;
          const raw = a.href;
          if (seen.has(raw)) continue;
          seen.add(raw);
          const block = a.closest("div, li");
          const snippet =
            block?.querySelector(".VwiC3b, .IsZvec, span.st, [data-sncf]")?.textContent?.trim() ?? "";
          out.push({ raw, title: h3.textContent?.trim() ?? "", snippet });
          if (out.length >= 15) break;
        }
        return out;
      })
      .catch(() => [] as { raw: string; title: string; snippet: string }[]);

    const isGoogleRedirector = (u: string): boolean => {
      try {
        const x = new URL(u);
        const h = x.hostname.toLowerCase();
        return (h === "google.com" || h.endsWith(".google.com")) && x.pathname === "/goto";
      } catch {
        return false;
      }
    };

    const resolvedByRaw = new Map<string, string>();
    const toResolve = raws.filter((r) => isGoogleRedirector(r.raw)).slice(0, 12);
    if (toResolve.length > 0) {
      /* 3 parallel scratch tabs drain the redirect queue — sequential
         resolution of 12 chains would add ~10s to the SERP tier. Each
         worker carries its own wall guard so a hostile redirect chain
         can never stall the pool slot. */
      const queue = toResolve.slice();
      const tR = Date.now();
      const worker = async (): Promise<void> => {
        const rp: Page = await ctx.newPage();
        try {
          for (;;) {
            if (Date.now() - tR > 12_000) return; // one wall for all workers
            const r = queue.shift();
            if (!r) return;
            try {
              await rp.goto(r.raw, { waitUntil: "commit", timeout: 4_000 });
              const u = rp.url();
              if (u && !isGoogleRedirector(u)) resolvedByRaw.set(r.raw, u);
            } catch {
              /* redirect refused / timed out — honest skip for this row */
            }
          }
        } finally {
          await rp.close().catch(() => {});
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    }

    const rows: { url: string; title: string; snippet: string }[] = [];
    const seenUrls = new Set<string>();
    for (const r of raws) {
      let url = r.raw;
      if (isGoogleRedirector(url)) {
        const dest = resolvedByRaw.get(url);
        if (!dest) continue;
        url = dest;
      }
      try {
        const real = new URL(url);
        if (real.protocol !== "http:" && real.protocol !== "https:") continue;
        const fin = real.hostname.toLowerCase();
        if (
          fin === "google.com" ||
          fin.endsWith(".google.com") ||
          fin.endsWith(".gstatic.com") ||
          fin.endsWith("googleusercontent.com")
        )
          continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
      } catch {
        continue;
      }
      rows.push({ url, title: r.title, snippet: r.snippet });
      if (rows.length >= 15) break;
    }
    if (rows.length === 0) {
      /* Diagnosis only — status/title/counts, never cookies. Tells us
         whether Google served a consent interstitial, its own block
         page, or a JS shell that never rendered organics. */
      const diag = await page
        .evaluate(() => ({
          title: document.title.slice(0, 120),
          anchors: document.querySelectorAll("a[href]").length,
          organic: document.querySelectorAll("a[href] h3, h3 a[href]").length,
          challenged:
            /captcha|unusual traffic|consent\.google|enablejs|not a robot/i.test(
              document.body?.innerText ?? "",
            ),
        }))
        .catch(() => null);
      log.info(
        {
          query,
          status: res.status(),
          finalUrl: page.url(),
          rawAnchors: raws.length,
          tokensResolved: resolvedByRaw.size,
          diag,
        },
        "google SERP browser tier: no organic rows parsed",
      );
    }
    return rows;
  } finally {
    await page.close().catch(() => {});
    freeContext(ctx);
  }
}

/**
 * Open `url` in a pooled stealth context, wait for DOM settle, and pull
 * out every extractable fact in one pass.
 *
 * Heavy media/ads/analytics are aborted via route interception to keep
 * the page under ~3s when only text is needed. The extraction is a single
 * evaluate() on the live-rendered DOM — this is the difference from the
 * HTTP-tier: a JS-only SPA that returns an empty shell to a raw fetch
 * still produces full data here because the page actually executed.
 */
export async function extractUrlBrowser(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<PageExtraction> {
  if (browserPoolDisabled()) {
    return {
      ok: false,
      url,
      finalUrl: "",
      title: "",
      status: 0,
      bodyText: "",
      jsonLd: [],
      meta: {},
      windowState: {},
      error: "browser pool disabled via WEB_SEARCH_BROWSER_DISABLED",
    };
  }
  if (!isSafeUrl(url)) {
    return {
      ok: false,
      url,
      finalUrl: "",
      title: "",
      status: 0,
      bodyText: "",
      jsonLd: [],
      meta: {},
      windowState: {},
      error: "unsafe URL",
    };
  }
  const ctx = await acquireContext();
  const page: Page = await ctx.newPage();
  /* Universal caption probe (no domains — see lib/web-search/captionProbe):
     collect the player's own caption-track responses from the very first
     request; the probe itself only runs later when a <video> rendered. */
  const capStore: CaptionCaptureStore = { bodies: [] };
  attachCaptionListener(page, capStore);
  const out: PageExtraction = {
    ok: false,
    url,
    finalUrl: "",
    title: "",
    status: null,
    bodyText: "",
    jsonLd: [],
    meta: {},
    windowState: {},
  };
  try {
    // Fast-load: abort analytics/media/websockets for the initial load.
    // The handler reads `wafChallengeActive` at request time, so a
    // post-goto flag flip changes behaviour for subsequent requests.
    let wafChallengeActive = false;
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (/doubleclick|google-analytics|googletagmanager|adsystem|ad\.|pixel|facebook\.com\/tr\//i.test(u)) {
        return route.abort().catch(() => {});
      }
      if (wafChallengeActive) {
        /* WAF challenge: every resource (images, fonts, media) must load
           so the challenge JS can complete and issue the session cookie. */
        return route.continue();
      }
      const rt = route.request().resourceType();
      if (rt === "media" || rt === "websocket" || rt === "font") {
        return route.abort().catch(() => {});
      }
      /* Images: allow through — WAF challenge pages embed image-based
         fingerprints, and grocery SPAs ship product thumbnails in JSON.
         The fast-load budget is already met by domcontentloaded + settle. */
      return route.continue();
    });

    let status: number | null = null;
    const response = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: opts.timeoutMs ?? BROWSER_PAGE_BUDGET_MS,
      })
      .catch(() => null);
    status = response ? response.status() : null;
    out.status = status;

    /* WAF challenge detection (GENERIC — no site-specific hardcoding):
       - HTTP 202 with a JS challenge script is AWS WAF / DataDome.
         The challenge page sets a cookie via challenge.js; a reload
         with all resources allowed lets the challenge complete.
       - HTTP 403/429/503 can also carry a JS challenge (Cloudflare).
       The status-code check is site-agnostic: any site whose WAF returns
       these codes gets the same reload + extended-settle treatment. */
    if (status === 202 || status === 403 || status === 429 || status === 503) {
      wafChallengeActive = true;
      log.info({ url, status }, "WAF challenge detected — reloading with full resource allow");
      try {
        const reloadRes = await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
        /* Treat the post-reload state as a fresh navigation: the reload's
           own response carries the post-challenge status, and the settle
           loop below fills bodyText. */
        if (reloadRes) status = reloadRes.status();
        out.status = status;
      } catch {
        /* reload failure — challenge JS may have already set the cookie;
           continue with the current page state */
      }
    }

    // Settle: 2.5s for normal SPAs; up to 12s when a WAF challenge is
    // active (Cloudflare's invisible Turnstile frequently needs ~10s of
    // quiet JS time before it issues cf_clearance; 8s burned the passive
    // window in live testing with clearanceIssued=false). The loop may NOT exit on "body has >300 chars" alone — a
    // Cloudflare challenge page's own text exceeds that, and returning
    // it to the model is how "403 forbidden" answers used to happen.
    // It exits only on real content: >300 chars AND no interstitial
    // marker. Budget stays bounded so one hostile host can't freeze a
    // pool slot indefinitely.
    const settleLimit = wafChallengeActive ? 12_000 : 2_500;
    const pageTextState = () =>
      page
        .evaluate(() => {
          const t = document.body?.innerText ?? "";
          return { len: t.length, head: t.slice(0, 2_000) };
        })
        .catch(() => ({ len: 0, head: "" }));
    const t0 = Date.now();
    let contentCleared = false;
    while (Date.now() - t0 < settleLimit) {
      const st = await pageTextState();
      if (st.len > 300 && !challengeMarkersPresent(st.head)) {
        contentCleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    /* Still behind the interstitial after the passive challenge window:
       check whether the challenge JS already issued the host's session
       cookie (Cloudflare's cf_clearance, AWS WAF's token, DataDome's).
       If it did, re-navigate ONCE — exactly what a normal browser does
       when a managed challenge resolves: the second request carries the
       cookie and returns the real page. This is passive acceptance of a
       challenge the site itself chose to run; we never click, solve or
       route around any CAPTCHA/login wall. If no cookie was issued, the
       wall is structural and we report it honestly. */
    if (wafChallengeActive && !contentCleared) {
      const cookies = await ctx.cookies().catch(() => []);
      const clearanceIssued = cookies.some((c) =>
        /^(cf_clearance|__cf_bm|aws-waf-token|datadome)$/i.test(c.name),
      );
      log.info({ url, clearanceIssued }, "WAF interstitial still up after settle — session cookie issued?");
      if (clearanceIssued) {
        try {
          const re = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
          if (re) {
            status = re.status();
            out.status = status;
          }
          const t1 = Date.now();
          while (Date.now() - t1 < 4_000) {
            const st = await pageTextState();
            if (st.len > 300 && !challengeMarkersPresent(st.head)) {
              contentCleared = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 400));
          }
        } catch {
          /* re-navigation failed — fall through to the honest wall outcome */
        }
      }
    }

    if (wafChallengeActive && !contentCleared) {
      out.finalUrl = page.url();
      out.error = "WAF challenge unresolved after passive wait — reported as a wall, not bypassed";
      return out; /* out.ok stays false; the finally block releases the pool slot */
    }

    out.finalUrl = page.url();
    out.title = await page.title().catch(() => "");

    // JSON-LD: pull raw script blocks and parse locally (linkedom would
    // be a second DOM parse for the same content — the browser already
    // has it in memory, and JSON-LD blocks are small).
    out.jsonLd = await page
      .evaluate(() => {
        const blocks: any[] = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
          const raw = (el as any).textContent?.trim();
          if (!raw) return;
          try {
            const parsed = JSON.parse(raw);
            blocks.push(parsed);
          } catch {
            blocks.push({ _raw: raw.slice(0, 2000) });
          }
        });
        return blocks;
      })
      .catch(() => [] as any[]);

    // Meta tags (og:*, twitter:*, description, keywords).
    out.meta = await page
      .evaluate(() => {
        const map: Record<string, string> = {};
        document.querySelectorAll("meta").forEach((m) => {
          const key = (m as any).getAttribute("property") ?? (m as any).getAttribute("name");
          const val = (m as any).getAttribute("content");
          if (key && val) map[key] = val;
        });
        return map;
      })
      .catch(() => ({}) as Record<string, string>);

    // Cleaned body text: remove script/style/nav/footer/cookie-banner-ish
    // regions, then take innerText of what's left.
    out.bodyText = await page
      .evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script,style,noscript,iframe,svg,nav,footer,header,aside").forEach((el) =>
          el.remove(),
        );
        // Cookie/GDPR banner heuristic: a small fixed-stuck element whose
        // text contains consent keywords — drop it when it's clearly a
        // banner, not real content.
        clone.querySelectorAll('[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[class*="gdpr" i]').forEach((el) => {
          const txt = (el.textContent ?? "").trim();
          if (txt.length < 600) el.remove();
        });
        return (clone.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      })
      .catch(() => "");

    // Well-known window global hydration state (universal, no per-site
    // hardcoding — any site that exposes `window.<name>` matching the
    // pattern is picked up; the extractor's JSON walker handles the rest).
    out.windowState = await page
      .evaluate(() => {
        const keys = [
          "__NEXT_DATA__",
          "__NUXT__",
          "__NUXT_DATA__",
          "__INITIAL_STATE__",
          "__PRELOADED_STATE__",
          "__myx",
          "__remixContext",
          "__reactRouterContext",
          "__APOLLO_STATE__",
          "__sveltekit__",
          "___gatsby",
          "ytInitialPlayerResponse",
          "ytInitialData",
          "__SHOPIFY__",
          "dataLayer",
        ];
        const out: Record<string, string> = {};
        for (const k of keys) {
          const v = (window as any)[k];
          if (v === undefined || v === null) continue;
          try {
            const s = JSON.stringify(v);
            if (s && s.length > 4) out[k] = s.slice(0, 200_000);
          } catch {
            /* circular refs — skip this key */
          }
        }
        // Also scan window for any top-level `window.__<name>__ = {` that
        // isn't in the known list, so a future site can't slip by.
        for (const k of Object.getOwnPropertyNames(window)) {
          if (out[k] !== undefined) continue;
          if (!/^(?:__.*__|__\w+)$/.test(k)) continue;
          const v = (window as any)[k];
          if (typeof v !== "object" || v === null) continue;
          try {
            const s = JSON.stringify(v);
            if (s && s.length > 500 && s.length < 200_000) out[k] = s;
          } catch {
            /* skip */
          }
        }
        return out;
      })
      .catch(() => ({}) as Record<string, string>);

    out.ok = out.bodyText.length > 0 || out.jsonLd.length > 0 || Object.keys(out.windowState).length > 0;
    if (!out.ok && (status === 403 || status === 429 || status === 503)) {
      out.error = "browser HTTP " + status + " (likely WAF challenge)";
    }

    // ARIA semantic snapshot (the "C++ semantic snapshot" from the spec):
    // pierces Shadow DOM, React portals, and same-origin iframes that
    // innerText on the main document misses. Guarded by availability —
    // `locator.ariaSnapshot` exists in playwright >= 1.49 and the pinned
    // 1.63 has it; the try/catch makes an older driver non-fatal.
    try {
      const rootSnap = await page.locator(":root").ariaSnapshot({ timeout: 8_000 });
      const frameSnaps: string[] = [];
      for (const f of page.frames().slice(1, 4)) {
        try {
          const s = await f.locator(":root").ariaSnapshot({ timeout: 4_000 });
          if (s) frameSnaps.push("(frame " + f.url().slice(0, 120) + ")\n" + s);
        } catch {
          /* cross-origin or detached frame — skip */
        }
      }
      out.ariaSnapshot = [rootSnap, ...frameSnaps].filter(Boolean).join("\n\n").slice(0, 40_000);
    } catch {
      /* ariaSnapshot unavailable on this driver — bodyText still covers the main document */
    }

    /* Universal media-caption tier: if the page rendered a <video>
       player, surface its caption track (DOM text tracks → the player's
       own caption XHRs, which carry request-scoped anti-abuse tokens no
       plain-HTTP fetch can reproduce) and append it to bodyText, so
       EVERY downstream consumer — the TS extractor, the web_search/
       read_page loop and destination discovery — sees transcripts for
       any provider.
       Non-video pages pay exactly one evaluate(); the probe can never
       break the page read. */
    if (out.ok && !wafChallengeActive) {
      try {
        const capSegs = await probeCaptionSegments(page, capStore, 9_000);
        const capText = capSegs ? formatCaptionSegments(capSegs) : "";
        if (capText) {
          out.bodyText = `${out.bodyText}\n\n## Captions (player caption track)\n${capText}`;
        }
      } catch {
        /* caption probe is strictly additive — never fails the read */
      }
    }

    return out;
  } catch (e: any) {
    out.error = e?.message ?? String(e);
    return out;
  } finally {
    await page.close().catch(() => {});
    freeContext(ctx);
  }
}
