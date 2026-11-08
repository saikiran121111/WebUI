/**
 * Real filter-list ad blocking for the stealth pool (user report 2026-11-08:
 * ad-caption bleed — the pool's 5-domain regex stub never knew YouTube's ad
 * manifest endpoints (get_midroll_info, /api/stats/ads, pagead), so the ad
 * played inside the watch page and its OWN caption track was harvested by
 * the universal caption probe and served as the video's transcript).
 *
 * Engine: @ghostery/adblocker — Ghostery's production blocker, the #1
 * ad-blocking engine in Node, speaking the same ABP/uBlock filter syntax
 * that EasyList/EasyPrivacy and AdGuard's lists are written in. The prebuilt
 * "ads + tracking" pack loads EasyList + EasyPrivacy, plus a small
 * supplemental set for the YouTube ad-manifest endpoints (belt-and-braces;
 * the live probe pins them against the real pack).
 *
 * DECISION-ONLY design (important): we never let the engine install its own
 * Playwright routes. This repo's route law (brief §12) must run FIRST, and
 * Playwright route handlers stack LIFO — a second handler would outrank the
 * SSRF law. Instead the existing route call-sites ask this module for a
 * verdict and routeDecision turns `filterListMatch: true` into "ad-abort".
 *
 * Failure posture: the engine boots lazily (first routed request) and caches
 * to disk (.data/adblock — gitignored); ANY failure — offline, corrupt
 * cache, unreachable list CDN — resolves to "no verdict" and the call-site's
 * legacy AD_BLOCK_RE family still applies. Ad blocking must never sink a
 * page fetch. Kill switch: WEB_SEARCH_ADBLOCK_DISABLED=1 (mirrors the pool
 * switch law).
 */
import fs from "node:fs";
import path from "node:path";

import {
  ENGINE_VERSION,
  FiltersEngine,
  NetworkFilter,
  Request,
  parseFilter,
  type RequestType,
} from "@ghostery/adblocker";
import { PlaywrightBlocker, fetchWithRetry } from "@ghostery/adblocker-playwright";

/** Extra network rules beyond the prebuilt pack, ABP syntax (generic
 *  provider patterns — no per-site one-offs beyond the ad endpoints
 *  themselves). */
const SUPPLEMENTAL_FILTERS = `
||youtube.com/get_midroll_info?
||youtube.com/api/stats/ads?
||youtube.com/ptracking?
||googlevideo.com/videoplayback?*sq=2*
||googlevideo.com/generate_204
`;

const CACHE_DIR = path.join(".data", "adblock");
const CACHE_FILE = path.join(CACHE_DIR, "engine.bin");
const META_FILE = path.join(CACHE_DIR, "meta.json");
/** How stale a disk-cached prebuilt pack may be (upstream cadence is
 *  roughly weekly; 3 days keeps an offline laptop serving fresh rules). */
const LIST_TTL_MS = 3 * 24 * 3600_000;
/** Hard cap on one cold boot (list CDN fetch): when it blows we give up on
 *  the ENGINE, never on the page. */
const BOOT_TIMEOUT_MS = 45_000;

let enginePromise: Promise<FiltersEngine | null> | null = null;

export function adblockDisabled(): boolean {
  return process.env.WEB_SEARCH_ADBLOCK_DISABLED === "1";
}

function cacheFresh(): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as {
      fetchedAt?: number;
      engineVersion?: number;
    };
    if (meta.engineVersion !== ENGINE_VERSION) return false;
    if (typeof meta.fetchedAt !== "number") return false;
    if (Date.now() - meta.fetchedAt > LIST_TTL_MS) return false;
    return Date.now() - fs.statSync(CACHE_FILE).mtimeMs <= LIST_TTL_MS;
  } catch {
    return false;
  }
}

async function buildEngine(): Promise<FiltersEngine | null> {
  if (adblockDisabled()) return null;
  try {
    if (cacheFresh()) {
      try {
        return PlaywrightBlocker.deserialize(fs.readFileSync(CACHE_FILE));
      } catch {
        /* Cache stale (engine build changed, corrupt) — rebuild below. */
      }
    }
    const engine = await Promise.race([
      // fetchWithRetry(fetch, url) is a wrapper, not a Fetch itself.
      PlaywrightBlocker.fromPrebuiltAdsAndTracking((url) =>
        fetchWithRetry((u) => fetch(u), url),
      ),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), BOOT_TIMEOUT_MS);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
    if (!engine) return null;
    const supplemental = SUPPLEMENTAL_FILTERS.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseFilter(line))
      .filter((f): f is NetworkFilter => f instanceof NetworkFilter);
    if (supplemental.length > 0) engine.update({ newNetworkFilters: supplemental });
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, engine.serialize());
      fs.writeFileSync(
        META_FILE,
        JSON.stringify({ fetchedAt: Date.now(), engineVersion: ENGINE_VERSION }),
      );
    } catch {
      /* Cache write is best-effort (read-only disk, concurrent boot). */
    }
    return engine;
  } catch {
    return null;
  }
}

export function getAdBlockEngine(): Promise<FiltersEngine | null> {
  if (!enginePromise) {
    enginePromise = buildEngine().then((engine) => {
      // A failed boot (offline first launch) must not disable the engine
      // for the process lifetime — the next request retries.
      if (!engine && !adblockDisabled()) enginePromise = null;
      return engine;
    });
  }
  return enginePromise;
}

const PLAYWRIGHT_RESOURCE_TYPES = new Set<string>([
  "document", "stylesheet", "image", "media", "font", "script",
  "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other",
]);

function normalizeType(resourceType: string): RequestType {
  return (PLAYWRIGHT_RESOURCE_TYPES.has(resourceType) ? resourceType : "other") as RequestType;
}

/**
 * Synchronous verdict function for one engine instance. Exported so the
 * offline regression vectors (literal rule strings parsed straight into the
 * engine via `parse()`) pin BOTH ends of the law: the ad endpoints abort,
 * AND the player's own media + caption traffic is left alone. Third-party
 * context is derived by the engine from url+sourceUrl — no hand-rolled
 * host heuristic.
 */
export function adVerdict(
  engine: FiltersEngine,
): (url: string, sourceUrl: string, resourceType: string) => boolean {
  return (url, sourceUrl, resourceType) => {
    try {
      const request = Request.fromRawDetails({
        url,
        sourceUrl: sourceUrl || url,
        type: normalizeType(resourceType),
        tabId: 0,
      });
      return engine.match(request).match === true;
    } catch {
      return false;
    }
  };
}

/**
 * The call-site convenience used by every routed page in the retrieval
 * pipeline: engine absent or engine undecided → false; NEVER rejects.
 * The first call pays the cold-boot cost (disk cache afterwards).
 */
export async function adBlockMatch(
  url: string,
  sourceUrl: string,
  resourceType: string,
): Promise<boolean> {
  const engine = await getAdBlockEngine();
  if (!engine) return false;
  return adVerdict(engine)(url, sourceUrl, resourceType);
}
