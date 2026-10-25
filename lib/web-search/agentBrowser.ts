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
function browserPoolDisabled(): boolean {
  return process.env.WEB_SEARCH_BROWSER_DISABLED === "1" || process.env.AGENT_BROWSER_DISABLED === "1";
}

/* ── configuration ─────────────────────────────────────────────────────── */

const POOL_SIZE = Math.max(
  4,
  Math.min(6, parseInt(process.env.WEB_SEARCH_BROWSER_POOL_SIZE ?? "5", 10) || 5),
);
const BROWSER_PAGE_BUDGET_MS = 40_000;
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
            ...(Object.keys(headers).filter(k =>
              !["user-agent","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform","accept-language"].includes(k)
            ).reduce<Record<string, string>>((acc, k) => { acc[k] = headers[k]; return acc; }, {})),
          },
        });
        /* The proper injector path — full canvas/webgl/audio/fingerprint
           script injection, not the minimal static patch. */
        await applyFingerprintToContext(ctx, suite);
        /* Also keep the static stealth patch as a baseline fallback */
        await ctx.addInitScript({ content: STEALTH_INIT_SCRIPT });
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
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
        /* The challenge cookie was set by the reload's initial response.
           Treat the post-reload state as a fresh navigation: re-read
           status and let the settle loop below fill bodyText. */
        out.status = null; /* will be filled by the post-reload status below */
      } catch {
        /* reload failure — challenge JS may have already set the cookie;
           continue with the current page state */
      }
    }

    // Settle: 2.5s for normal SPAs; 5s when a WAF challenge is active
    // (challenge JS needs time to complete and issue the session cookie,
    // but keep the budget tight so one hostile host can't freeze a pool
    // slot for 10s+ while other URLs queue up behind it).
    const settleLimit = wafChallengeActive ? 5_000 : 2_500;
    const t0 = Date.now();
    while (Date.now() - t0 < settleLimit) {
      const len = await page
        .evaluate(() => document.body?.innerText?.length ?? 0)
        .catch(() => 0);
      if (len > 300) break;
      await new Promise((r) => setTimeout(r, 400));
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

    return out;
  } catch (e: any) {
    out.error = e?.message ?? String(e);
    return out;
  } finally {
    await page.close().catch(() => {});
    freeContext(ctx);
  }
}


export { extractUrlBrowser as browserRead };
