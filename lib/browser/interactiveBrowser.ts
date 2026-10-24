/**
 * Browser agent session — drives the user's OWN installed OS browser.
 *
 * There is NO built-in WebUI browser, NO right-panel mirror, and NO
 * screencast anywhere. The agent works inside a REAL, visible browser
 * window on the user's desktop (brave/chrome/edge/firefox), launched
 * from the user's installed executable on a dedicated automation profile
 * under `.data/browser-profiles/<engine>/` — never the user's locked
 * daily profile, so a fresh session honestly starts signed out. The user
 * can watch the window and intervene at any time.
 *
 *   • All policy — semantic targeting, the six-layer fallback ladder,
 *     security-challenge parking, server-side consequential gating,
 *     visible AI highlights, telemetry — lives in lib/browser/
 *     browserActions; this module only owns the session.
 *   • NO silent substitution: a missing engine throws
 *     EngineUnavailableError (engineLauncher) — we never launch a
 *     different browser and label it.
 *   • CDP attach happens ONLY via an explicit RUKE_BROWSER_CDP_ENDPOINT
 *     and ONLY after the endpoint's identity is verified to match the
 *     selected engine; Firefox is never CDP.
 *   • `readWithInteractiveProfile(url)` remains the web-search pipeline's
 *     documented fallback: the normal 7-tier waterfall runs FIRST; only
 *     when it cannot fetch a URL (login wall, private feed, auth-gated
 *     docs) does this read open that URL on a persistent profile.
 *
 * Laptop-friendly: an idle session closes itself (the profile persists on
 * disk). Zero paid APIs. Zero screencast, ever.
 */
import {
  chromium,
  firefox,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { isSafeUrl, isFixtureAllowed } from "@/lib/web-search/ssrf";
import { browserEngine } from "@/lib/server/settings";
import type { BrowserEngine } from "./engineConfig";
import {
  buildEngineLaunchPlan,
  engineProfileDir,
  cdpEndpointForEngine,
  cdpIdentityMatches,
} from "./engineLauncher";
import {
  executeBrowserAction,
  type ActionContext,
  type ActionResult,
} from "./browserActions";
import type { BrowserApiAction } from "./browserToolProtocol";
import { childLogger } from "@/lib/server/logger";
import {
  USER_AGENT,
  STEALTH_ARGS,
  chromiumExecPath,
  extractPageInOnePass,
} from "./agentBrowser";
import { profileDirFor, defaultProfileDir, hasSiteAuth } from "./profiles";
import path from "node:path";

const log = childLogger("browser/session");

function basenameOf(dir: string): string {
  return path.basename(dir);
}

const VIEWPORT = { width: 1280, height: 800 };
/** An idle session (no actions) closes after this long. */
const IDLE_MS = 10 * 60_000;

/* ── session state (singleton) ───────────────────────────────────────────── */

let context: BrowserContext | null = null;
let page: Page | null = null;
let launching: Promise<Page> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** The engine the LIVE session launched with (server settings decide). */
let sessionEngine: BrowserEngine = browserEngine();
/** Set only for an explicit CDP attach — close disconnects, never kills. */
let cdpBrowser: Browser | null = null;

/** The engine the session uses (live) or would use (not yet launched). */
export function currentEngineForSession(): BrowserEngine {
  return interactiveSessionLive() ? sessionEngine : browserEngine();
}

/** Arm the idle-close timer (profile state persists on disk). */
function touch(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  idleTimer = setTimeout(() => {
    void closeInteractiveSession("idle timeout");
  }, IDLE_MS);
}

export function interactiveSessionLive(): boolean {
  return !!context && !!page && !page.isClosed();
}

export async function closeInteractiveSession(reason = "closed"): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const ctx = context;
  const cdpConn = cdpBrowser;
  context = null;
  cdpBrowser = null;
  page = null;
  if (ctx) {
    try { await ctx.close(); } catch { /* already gone */ }
  }
  // An explicit CDP attach: closing the connection DISCONNECTS from the
  // user's own browser — it must never kill it.
  if (cdpConn) {
    try { await cdpConn.close(); } catch { /* already gone */ }
  }
  if (ctx || cdpConn) log.info({ reason }, "browser session closed");
}

/* ── launch ──────────────────────────────────────────────────────────────── */

/**
 * Reap orphaned automation-browser processes before a profile-locked
 * launch. The module singleton can die without the browser dying (Next
 * dev-server hot-reload discards this module while the process tree keeps
 * holding the profile's SingletonLock), and then every later
 * launchPersistentContext fails with "Opening in existing browser
 * session". The match keys on the automation profile dir
 * (`browser-profiles`), so the headless extraction pool (ephemeral
 * Playwright profiles) and the user's own daily Chrome are never touched.
 */
function reapOrphanBrowser(): void {
  const cp = require("node:child_process");
  // `taskkill /T /F` on each root tears down the whole subtree
  // (driver + renderer children) in one call — the measured ~40 s
  // sequential teardown is what makes the next launch succeed.
  try {
    const profilesDir = path.join(defaultProfileDir(), "..");
    const { rmSync, readdirSync } = require("node:fs");
    // Remove orphaned SingletonLock symlinks first (fast, no process
    // table) — a dead tree's lock file blocks the next launch even
    // after the processes are gone.
    try {
      for (const slug of readdirSync(profilesDir)) {
        try { rmSync(path.join(profilesDir, slug, "SingletonLock"), { force: true }); } catch { /* not present */ }
      }
    } catch { /* .data/browser-profiles may not exist yet */ }

    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process | Where-Object " +
        "{ ($_.CommandLine -match 'browser-profiles') -or " +
        "($_.CommandLine -match 'ms-playwright' -and $_.CommandLine -match 'browser-profile') } | " +
        "ForEach-Object { $_.ProcessId } | Sort-Object -Unique";
      const res = cp.spawnSync("powershell", ["-NoProfile", "-Command", ps], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
        encoding: "utf8",
      });
      const pids = (res.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .map((s: string) => s.trim())
        .filter((s: string) => /^\d+$/.test(s));
      if (pids.length > 0) {
        log.debug({ count: pids.length }, "reap: killing orphan tree roots");
      }
      for (const pid of pids) {
        cp.spawnSync("powershell", [
          "-NoProfile",
          "-Command",
          `taskkill /T /F /PID ${pid} 2>&1 | Out-Null`,
        ], { stdio: "ignore", timeout: 15_000 });
      }
    } else {
      cp.spawnSync("pkill", ["-f", "browser-profile"], { stdio: "ignore", timeout: 5_000 });
    }
  } catch (e) {
    log.debug({ err: String(e) }, "reap: no match / tool unavailable — best effort");
  }
}

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!launching) {
    launching = launch().finally(() => {
      launching = null;
    });
  }
  return launching;
}

async function launch(): Promise<Page> {
  sessionEngine = browserEngine();
  await launchOsBrowser(sessionEngine);
  return wireContext();
}

/**
 * Drive the user's ACTUAL browser visibly. Policy enforced here
 * (server-side, non-negotiable):
 *  - NO silent substitution — buildEngineLaunchPlan throws when the chosen
 *    browser is missing; nothing else is launched in its place;
 *  - NO stealth args, NO fingerprint spoofing, NO window hiding — this is
 *    a transparent, visible automation window on the user's desktop;
 *  - dedicated automation profile `.data/browser-profiles/<engine>/` — we
 *    never touch or copy the user's locked daily profile;
 *  - CDP attach ONLY via the explicit RUKE_BROWSER_CDP_ENDPOINT, and only
 *    after the endpoint's identity is verified against the chosen engine
 *    (Brave additionally gets the deep navigator.brave.isBrave() probe —
 *    a mismatch tears the attach down rather than driving the wrong one);
 *  - Firefox runs through Playwright's Firefox engine, never CDP.
 */
async function launchOsBrowser(engine: BrowserEngine): Promise<void> {
  const endpoint = cdpEndpointForEngine(engine);
  if (endpoint) {
    let versionJson: unknown = null;
    try {
      const res = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(5_000) });
      if (res.ok) versionJson = await res.json();
    } catch {
      /* endpoint unreachable / not DevTools */
    }
    const probe = cdpIdentityMatches(engine, versionJson);
    if (!probe.matches) {
      throw new Error(
        `the DevTools endpoint ${endpoint} is not ${engine} ` +
          `(detected "${probe.browserField || "unknown"}"). Refusing to drive a ` +
          "different browser than the one selected — unset RUKE_BROWSER_CDP_ENDPOINT " +
          "to launch the selected browser directly instead.",
      );
    }
    const browser = await chromium.connectOverCDP(endpoint);
    cdpBrowser = browser;
    const ctxs = browser.contexts();
    context = ctxs[0] ?? (await browser.newContext());
    log.info({ endpoint, engine, browserField: probe.browserField }, "attached to user-run browser via explicit CDP endpoint");
  } else {
    const plan = buildEngineLaunchPlan(engine); // throws EngineUnavailableError — no substitute
    try {
      require("node:fs").mkdirSync(plan.profileDir, { recursive: true });
    } catch { /* exists */ }
    // Launch on the dedicated automation profile; a dead tree's lock or a
    // hot-reload orphan is reaped with backoff before retrying.
    const opts = {
      headless: false, // the user must SEE the window
      // Playwright defaults chromiumSandbox to FALSE, which injects
      // --no-sandbox and trips Chrome's "unsupported command-line flag"
      // infobar in the user's visible window. Keep the real sandbox.
      chromiumSandbox: true,
      executablePath: plan.executablePath,
      timeout: 60_000,
      args: [], // no stealth — this is the user's own browser, honestly driven
      viewport: VIEWPORT,
      ignoreDefaultArgs: ["--enable-automation"],
    } as unknown as Parameters<typeof chromium.launchPersistentContext>[1];
    const launchOnce = () =>
      plan.browserType === "firefox"
        ? firefox.launchPersistentContext(plan.profileDir, opts as never)
        : chromium.launchPersistentContext(plan.profileDir, opts);
    try {
      context = await launchOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/in use|existing browser session|SingletonLock|profile/i.test(msg)) throw e;
      let launched = false;
      for (let attempt = 1; attempt <= 4 && !launched; attempt++) {
        log.warn({ attempt, err: msg.slice(0, 120) }, "profile lock held — reaping orphan tree, retrying launch");
        reapOrphanBrowser();
        const waitMs = [8_000, 15_000, 25_000, 35_000][attempt - 1] ?? 35_000;
        await new Promise((r) => setTimeout(r, waitMs));
        try {
          require("node:fs").rmSync(path.join(plan.profileDir, "SingletonLock"), { force: true });
        } catch { /* not present / not removable */ }
        try {
          context = await launchOnce();
          launched = true;
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          if (!/in use|existing browser session|SingletonLock|profile/i.test(msg2)) {
            context = null;
            throw e2;
          }
        }
      }
      if (!context) throw e;
    }
    log.info({ engine, exe: plan.executablePath }, "OS browser launched visibly on its dedicated automation profile");
  }

  // Deep identity probe: a Chromium-family endpoint must REALLY be Brave
  // when the user picked Brave. A failing check tears the attach down.
  if (engine === "brave" && endpoint && context) {
    const probePage =
      context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
    let braveOk = false;
    try {
      braveOk = await probePage.evaluate(async () => {
        const nav = navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } };
        return (await nav.brave?.isBrave?.()) === true;
      });
    } catch {
      braveOk = false;
    }
    if (!braveOk) {
      const b = cdpBrowser;
      cdpBrowser = null;
      context = null;
      try {
        await b?.close();
      } catch { /* already gone */ }
      throw new Error(
        "the browser at the CDP endpoint does not identify as Brave " +
          "(navigator.brave.isBrave failed). Refusing to drive a different browser.",
      );
    }
  }
}

/** Wire popup adoption + last-tab cleanup onto the live context. */
async function wireContext(): Promise<Page> {
  const ctx = context!;
  ctx.on("close", () => {
    context = null;
    cdpBrowser = null;
    page = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  });
  // New tabs (popups from login flows) become the live tab the agent acts on.
  ctx.on("page", (p) => void adoptTab(p));

  const existing = ctx.pages().filter((p) => !p.isClosed());
  page = existing[existing.length - 1] ?? (await ctx.newPage());
  page.on("close", () => {
    const rest = context?.pages().filter((p) => !p.isClosed()) ?? [];
    page = rest[rest.length - 1] ?? null;
    if (!page) void closeInteractiveSession("last tab closed");
  });
  touch();
  log.info({ engine: sessionEngine }, "browser session launched (visible window, dedicated automation profile)");
  return page;
}

async function adoptTab(p: Page): Promise<void> {
  page = p;
  touch();
}

/* ── navigation ──────────────────────────────────────────────────────────── */

async function gotoGuarded(p: Page, rawUrl: string): Promise<void> {
  let url = rawUrl.trim();
  if (!url) return;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith("about:")) url = "https://" + url;
  if (url.startsWith("about:")) {
    void p.goto(url).catch(() => {});
    return;
  }
  // Local test fixtures are allowed ONLY through the env-gated exact
  // allow-list (lib/web-search/ssrf.ts) — never a general loopback hole.
  if (!isSafeUrl(url) && !isFixtureAllowed(url)) {
    throw new Error("refused unsafe or non-http(s) URL");
  }
  await p
    .goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => {
      /* timeout / download handler — the live tab shows where it landed */
    });
}

/* ── EXTENDED semantic action surface (```browser_api fence) ─────────────── */

export interface ExtendedResult extends ActionResult {
  engine: BrowserEngine;
}

/**
 * Run one browser_api action (snapshot / ref-click / fill / fill_form /
 * batch / keyboard_nav / resume_task / authorize_…) against the live
 * session. ALL policy — semantic targeting, the six-layer fallback ladder,
 * security-challenge parking, server-side consequential gating, visible
 * AI highlights, telemetry — lives in lib/browser/browserActions; this
 * function only owns the session.
 */
export async function runExtendedAction(a: BrowserApiAction): Promise<ExtendedResult> {
  try {
    const p = await ensurePage();
    touch();
    const ctx: ActionContext = {
      engine: sessionEngine,
      goto: async (u: string) => {
        await gotoGuarded(page ?? p, u);
      },
      // ONE transient screenshot for visual grounding only — never a
      // screencast, never a mirror, never shown in the WebUI.
      screenshot: async (): Promise<string | null> => {
        const buf = await (page ?? p)
          .screenshot({ type: "jpeg", quality: 70 })
          .catch(() => null);
        return buf ? `data:image/jpeg;base64,${buf.toString("base64")}` : null;
      },
      livePage: () => (page && !page.isClosed() ? page : null),
    };
    const res = await executeBrowserAction(p, a, ctx);
    return { ...res, engine: sessionEngine };
  } catch (e) {
    return {
      ok: false,
      action: a.action,
      url: page?.url() ?? "",
      title: "",
      error: e instanceof Error ? e.message : String(e),
      engine: sessionEngine,
    };
  }
}

/* ── live-tab reads (chat context + BrowserTool helpers) ────────────────── */

/** url/title/engine of the live tab for the model's standing context. */
export async function liveTabInfo(): Promise<{ url: string; title: string; engine: BrowserEngine } | null> {
  if (!interactiveSessionLive() || !page) return null;
  const p = page;
  const title = await p.title().catch(() => "");
  return { url: p.url(), title, engine: sessionEngine };
}

/** aria snapshot + url/title of the live tab, or null with no session. */
export async function interactiveSnapshot(): Promise<string | null> {
  if (!interactiveSessionLive() || !page) return null;
  const p = page;
  const aria = await p.locator("body").ariaSnapshot({ timeout: 5_000 }).catch(() => "");
  return `${await p.title().catch(() => "")} — ${p.url()}\n[ARIA snapshot]\n${aria.slice(0, 8_000)}`;
}

export async function interactiveScreenshot(): Promise<string | null> {
  if (!interactiveSessionLive() || !page) return null;
  const buf = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  return buf ? buf.toString("base64") : null;
}

/* ── Pipeline fallback read (web-search login-wall path) ────────────────── */

export interface InteractiveRead {
  ok: boolean;
  /** True when the read rode a site's SAVED sign-in (a real profile dir, not `default`). */
  authenticated: boolean;
  site?: string;
  url: string;
  finalUrl: string;
  title: string;
  bodyText: string;
  ariaSnapshot: string;
  jsonLd: any[];
  meta: Record<string, string>;
  windowState: Record<string, string>;
  /** Set when nothing could be read — callers surface it verbatim, never fabricate. */
  error?: string;
}

/** Launch args for the pipeline fallback read (the stealth-pool persona). */
function readProfileLaunchArgs() {
  return {
    headless: false,
    chromiumSandbox: true, // visible read window — same no-infobar sandbox rule
    executablePath: chromiumExecPath(),
    args: [...STEALTH_ARGS],
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
    locale: "en-IN",
    ignoreDefaultArgs: ["--enable-automation"],
  } as any;
}

/**
 * Read a URL through a persistent browser profile — the web-search
 * pipeline's fallback when the normal 7-tier waterfall (HTTP → stealth
 * pool → Jina → Wayback → snippets) could not fetch it: login walls,
 * private feeds, auth-gated docs. Normal search keeps working exactly as
 * before; this path is consulted ONLY after the standard tiers failed.
 *
 * Launches a persistent context on the URL's own profile
 * (`.data/browser-profiles/<site>/`) when one exists — any saved cookies
 * ride the read — and on the default profile otherwise. The context
 * closes immediately after; per-site auth state is untouched.
 */
export async function readWithInteractiveProfile(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<InteractiveRead> {
  const isHttp = /^https?:\/\//i.test(url.trim());
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const siteSlug = basenameOf(profileDirFor(url));
  const dir = profileDirFor(url);
  const authenticated = isHttp && siteSlug !== "default" && hasSiteAuth(siteSlug);
  let ctx: BrowserContext | null = null;
  try {
    try {
      require("node:fs").mkdirSync(dir, { recursive: true });
    } catch { /* exists */ }
    try {
      ctx = await chromium.launchPersistentContext(dir, readProfileLaunchArgs());
    } catch (launchErr) {
      const msg = launchErr instanceof Error ? launchErr.message : String(launchErr);
      if (/in use|existing browser session|SingletonLock|profile/i.test(msg)) {
        // Orphan tree holds the profile lock — reap the whole tree so the
        // NEXT call launches clean. This read reports a failure (it never
        // blocks the pipeline's waterfall on a dead-locking launch).
        log.warn({ err: msg.slice(0, 120), dir }, "interactive read: profile lock held — reaping orphan tree");
        reapOrphanBrowser();
      }
      throw launchErr;
    }
    // Navigate the target URL in a FRESH page on the persistent context
    // (existing tabs keep their state). Settle briefly, then read.
    const readPage = await ctx.newPage();
    try {
      await readPage
        .goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
        .catch(() => { /* budget exhausted — read whatever landed */ });
      const settleT0 = Date.now();
      while (Date.now() - settleT0 < 4_000) {
        const len = await readPage.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
        if (len > 300) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      const r = await extractPageInOnePass(url, { timeoutMs }).catch(() => null);
      // extractPageInOnePass bails early on data:/file: URLs (isSafeUrl):
      // read the already-navigated page directly.
      const bodyText =
        r && r.ok && r.bodyText.length >= 100
          ? r.bodyText
          : await readPage.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      let finalUrl = url;
      try { finalUrl = readPage.url(); } catch { /* page closing */ }
      const title = r?.title || (await readPage.title().catch(() => ""));
      const out: InteractiveRead = {
        ok: (r?.ok ?? false) || bodyText.length >= 100,
        authenticated,
        ...(authenticated ? { site: siteSlug } : {}),
        url,
        finalUrl,
        title,
        bodyText,
        ariaSnapshot: r?.ariaSnapshot ?? "",
        jsonLd: r?.jsonLd ?? [],
        meta: r?.meta ?? {},
        windowState: r?.windowState ?? {},
        ...(r?.error ? { error: r.error } : {}),
      };
      return out;
    } finally {
      try { await readPage.close(); } catch { /* already gone */ }
    }
  } catch (e) {
    return {
      ok: false,
      authenticated,
      ...(authenticated ? { site: siteSlug } : {}),
      url,
      finalUrl: "",
      title: "",
      bodyText: "",
      ariaSnapshot: "",
      jsonLd: [],
      meta: {},
      windowState: {},
      error: "interactive profile read failed: " + (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    if (ctx) {
      try { await ctx.close(); } catch { /* already gone */ }
    }
  }
}
