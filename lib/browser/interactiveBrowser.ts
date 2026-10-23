/**
 * Interactive login browser session (WebUI right-panel mirror) — Part 3.
 *
 * A HEADFUL persistent Chromium (userDataDir `.data/browser-profile`, never
 * the user's real profile) that the user drives from the chat UI:
 *   • CDP `Page.startScreencast` streams JPEG frames + url/title to the
 *     right panel (`app/api/browser/stream`), input events come back through
 *     the POST endpoint (`app/api/browser/route`).
 *   • `done_login` exports the profile's cookies into the extraction pool
 *     (agentBrowser.applyCookiesToPool) so Pass-B reads see the logged-in
 *     session — LinkedIn / X / Instagram / Workday become AI-readable after
 *     a human sign-in.
 *   • Fingerprinting via fingerprint-generator + fingerprint-injector, with
 *     the pool's proven stealth persona as the fallback.
 *
 * Laptop-friendly: the screencast runs only while a panel is subscribed, and
 * an idle session closes itself (cookies persist in the profile on disk).
 * Zero paid APIs, zero global state.
 */
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { isSafeUrl } from "@/lib/web-search/ssrf";
import { childLogger } from "@/lib/server/logger";
import {
  USER_AGENT,
  SEC_CH_UA,
  STEALTH_ARGS,
  STEALTH_INIT_SCRIPT,
  chromiumExecPath,
  applyCookiesToPool,
} from "./agentBrowser";

const log = childLogger("web-search/interactive-browser");

const PROFILE_DIR = require("node:path").join(process.cwd(), ".data", "browser-profile") as string;
const VIEWPORT = { width: 1280, height: 800 };
/** An idle session (no actions, no panel subscribed) closes after this long. */
const IDLE_MS = 10 * 60_000;

/* ── public surface ──────────────────────────────────────────────────────── */

export interface InteractiveAction {
  action: "start" | "click" | "type" | "scroll" | "navigate" | "back" | "reload" | "done_login";
  x?: number;
  y?: number;
  text?: string;
  dy?: number;
  submit?: boolean;
  url?: string;
}

export interface InteractiveStatus {
  ok: boolean;
  url?: string;
  title?: string;
  error?: string;
  /** done_login: cookies pushed into N pool contexts. */
  cookiesSynced?: number;
}

export interface MirrorFrame {
  /** JPEG base64 (CDP screencast) — absent on status-only frames. */
  frame?: string;
  url: string;
  title: string;
  width: number;
  height: number;
  ts: number;
}

/* ── session state (singleton) ───────────────────────────────────────────── */

let context: BrowserContext | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;
let launching: Promise<Page> | null = null;
let latest: MirrorFrame | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<(f: MirrorFrame) => void>();

/**
 * Arm the idle-close timer. Never closes while a mirror subscriber is
 * attached — a user mid-login in the panel must not lose their session
 * to the timer (measured: the old unconditional arm fired 10 min into
 * an open panel).
 */
function touch(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (subscribers.size === 0) {
    idleTimer = setTimeout(() => {
      void closeInteractiveSession("idle timeout");
    }, IDLE_MS);
  }
}

export function interactiveSessionLive(): boolean {
  return !!context && !!page && !page.isClosed();
}

export function getLatestMirrorFrame(): MirrorFrame | null {
  return latest;
}

/** Ensure the headful session exists (launches it on first panel open). */
export async function ensureInteractiveSession(initialUrl?: string): Promise<void> {
  const p = await ensurePage();
  if (initialUrl) await gotoGuarded(p, initialUrl);
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

/**
 * Subscribe to mirror frames. The screencast only runs while at least one
 * subscriber is attached (saves CPU/GPU when the panel is closed). Returns
 * the unsubscribe function.
 */
export function subscribeMirror(cb: (f: MirrorFrame) => void): () => void {
  subscribers.add(cb);
  touch();
  void (async () => {
    if (interactiveSessionLive() && !cdp) {
      try { await startScreencast(page!); } catch { /* next action retries */ }
    }
  })();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0) {
      void stopScreencast();
      touch(); // nobody is watching anymore — re-arm the idle close
    }
  };
}

export async function closeInteractiveSession(reason = "closed"): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  await stopScreencast();
  const ctx = context;
  context = null;
  page = null;
  latest = null;
  if (ctx) {
    try { await ctx.close(); } catch { /* already gone */ }
    log.info({ reason }, "interactive browser session closed");
  }
}

/* ── launch ──────────────────────────────────────────────────────────────── */

/** Best-effort realistic fingerprint; the pool's stealth persona is the fallback. */
function makeFingerprint(): any | null {
  try {
    const { FingerprintGenerator } = require("fingerprint-generator");
    const gen = new FingerprintGenerator({
      limit: 1,
      browsers: ["chrome"],
      operatingSystems: ["windows"],
    });
    return gen.getFingerprint().fingerprint ?? null;
  } catch (e) {
    log.warn({ err: String(e) }, "fingerprint-generator unavailable — using the pool persona");
    return null;
  }
}

/**
 * Reap orphaned interactive Chromium processes before launching. The
 * module singleton can die without the browser dying (Next dev-server
 * hot-reload discards this module while the process tree keeps holding
 * the `.data/browser-profile` SingletonLock), and then every later
 * launchPersistentContext fails with "Opening in existing browser
 * session". The match requires BOTH the project chromium path and the
 * interactive profile dir in the command line, so the headless
 * extraction pool (ephemeral Playwright profiles) and the user's own
 * Chrome are never touched.
 */
function reapOrphanInteractiveBrowser(): void {
  const cp = require("node:child_process");
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object " +
        "{ $_.CommandLine -match 'ms-playwright' -and $_.CommandLine -match 'browser-profile' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      cp.spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 10_000 });
    } else {
      cp.spawnSync("pkill", ["-f", `--user-data-dir=${PROFILE_DIR}`], { stdio: "ignore", timeout: 5_000 });
    }
  } catch { /* no match / tool unavailable — best effort */ }
}

function launchArgs(fp: any | null) {
  return {
    headless: false,
    executablePath: chromiumExecPath(),
    args: [...STEALTH_ARGS],
    userAgent: (fp?.userAgent as string | undefined) ?? USER_AGENT,
    viewport: VIEWPORT,
    locale: "en-IN",
    ignoreDefaultArgs: ["--enable-automation"],
  } as any;
}

async function launch(): Promise<Page> {
  try {
    require("node:fs").mkdirSync(PROFILE_DIR, { recursive: true });
  } catch { /* exists */ }

  const fp = makeFingerprint();
  reapOrphanInteractiveBrowser(); // module state says no live session — any holder is an orphan
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchArgs(fp));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/in use|existing browser session|SingletonLock|profile/i.test(msg)) throw e;
    // Lock release can lag the reap — one wait-and-retry before surfacing.
    log.warn({ err: msg.slice(0, 160) }, "profile lock still held — reaping again, retrying launch");
    reapOrphanInteractiveBrowser();
    await new Promise((r) => setTimeout(r, 1_500));
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchArgs(fp));
  }

  context.on("close", () => {
    context = null;
    page = null;
    cdp = null;
    latest = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  });
  // New tabs (popups from login flows) become the mirrored tab.
  context.on("page", (p) => void adoptTab(p));

  if (fp) {
    try {
      const { FingerprintInjector } = require("fingerprint-injector");
      // Types reference fingerprint-injector's own playwright-core revision —
      // structurally compatible with ours; cast at the seam.
      await new FingerprintInjector().attachFingerprintToPlaywright(context as any, fp);
    } catch (e) {
      log.warn({ err: String(e) }, "fingerprint-injector attach failed — headers fall back");
    }
  }
  try {
    await context.setExtraHTTPHeaders({
      "accept-language": "en-IN,en-US;q=0.9,en;q=0.8",
      "sec-ch-ua": SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });
  } catch { /* injector may already have set compatible headers */ }
  await context.addInitScript({ content: STEALTH_INIT_SCRIPT });

  const existing = context.pages().filter((p) => !p.isClosed());
  page = existing[existing.length - 1] ?? (await context.newPage());
  page.on("close", () => {
    const rest = context?.pages().filter((p) => !p.isClosed()) ?? [];
    page = rest[rest.length - 1] ?? null;
    if (page) void startScreencast(page).catch(() => {});
    else void closeInteractiveSession("last tab closed");
  });
  await startScreencast(page);
  touch();
  log.info({ profileDir: PROFILE_DIR }, "interactive login browser launched (headful, persistent profile)");
  return page;
}

async function adoptTab(p: Page): Promise<void> {
  page = p;
  await startScreencast(p).catch(() => {});
  touch();
}

/* ── screencast (CDP) ────────────────────────────────────────────────────── */

async function startScreencast(p: Page): Promise<void> {
  await stopScreencast();
  if (!context) throw new Error("interactive session is not open");
  const sess = await context.newCDPSession(p);
  cdp = sess;
  sess.on("Page.screencastFrame", ({ data, sessionId }) => {
    cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    void (async () => {
      let title = "";
      try { title = await p.title(); } catch { /* page mid-navigation */ }
      const f: MirrorFrame = {
        frame: data,
        url: p.url(),
        title,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        ts: Date.now(),
      };
      latest = f;
      for (const cb of subscribers) {
        try { cb(f); } catch { /* consumer gone */ }
      }
    })();
  });
  await sess.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
}

async function stopScreencast(): Promise<void> {
  if (!cdp) return;
  const s = cdp;
  cdp = null;
  try { await s.send("Page.stopScreencast"); } catch { /* session may already be gone */ }
  try { await s.detach(); } catch { /* already detached */ }
}

/* ── actions ─────────────────────────────────────────────────────────────── */

async function gotoGuarded(p: Page, rawUrl: string): Promise<void> {
  let url = rawUrl.trim();
  if (!url) return;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith("about:")) url = "https://" + url;
  if (url.startsWith("about:blank")) { await p.goto(url).catch(() => {}); return; }
  if (!isSafeUrl(url)) {
    throw new Error("refused unsafe or non-http(s) URL");
  }
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {
    /* timeout / download handler — the mirror still shows where the tab landed */
  });
}

/** Run one panel action against the interactive session. */
export async function interact(a: InteractiveAction): Promise<InteractiveStatus> {
  try {
    const p = await ensurePage();
    touch();
    switch (a.action) {
      case "start":
        if (a.url) await gotoGuarded(p, a.url);
        break;
      case "navigate":
        await gotoGuarded(p, a.url ?? "");
        break;
      case "back":
        await p.goBack({ timeout: 15_000 }).catch(() => {});
        break;
      case "reload":
        await p.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        break;
      case "click":
        if (typeof a.x === "number" && typeof a.y === "number") {
          await p.mouse.click(a.x, a.y);
        }
        break;
      case "type":
        if (a.text) await p.keyboard.type(a.text, { delay: 12 });
        if (a.submit) await p.keyboard.press("Enter");
        break;
      case "scroll":
        await p.mouse.wheel(0, a.dy ?? 300);
        break;
      case "done_login": {
        // The login hand-off: profile cookies → extraction pool, so the next
        // web-read of the authenticated tab succeeds (Pass-B browser tier).
        const cookies = context ? await context.cookies() : [];
        const cookiesSynced = await applyCookiesToPool(cookies);
        log.info({ count: cookies.length, contexts: cookiesSynced }, "login hand-off: cookies synced to pool");
        return withStatus(p, { ok: true, cookiesSynced });
      }
    }
    return await withStatus(p, { ok: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function withStatus(p: Page, base: InteractiveStatus): Promise<InteractiveStatus> {
  let title = "";
  try { title = await p.title(); } catch { /* mid-navigation */ }
  return { ...base, url: p.url(), title };
}

/* ── BrowserTool delegation helpers ──────────────────────────────────────── */

/** aria snapshot + url/title of the mirrored tab, or null with no session. */
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
