/**
 * Universal media-transcript fetcher: ANY page URL hosting a video
 * player (YouTube, Dailymotion, Vimeo, Twitch VOD, HTML5 embeds — the
 * probe tiers are format/ARIA-based, never domain-based) through the
 * stealth browser pool.
 *
 * The dedicated watch-page flow (unlike the one-pass text extractor
 * which route-ABORTS media and never observes responses): media stays
 * ALLOWED because the player must load its media before it will fetch
 * its caption tracks, and only the player's own requests carry the
 * provider's request-scoped anti-abuse token (the Proof-of-Origin
 * finding that made plain-HTTP caption fetching return 200-with-empty
 * bodies everywhere — see captionFormats.ts header).
 *
 * Infallible by design: every failure tier (kill switch, pool
 * exhausted, unsafe/unparseable URL, nav error, no captions) returns
 * null/"" — callers degrade exactly like the existing InnerTube
 * `catch` arms. Whisper is NOT involved: audio.ts only handles uploaded
 * attachments, never streamed URLs.
 */
import { acquirePoolContext, browserPoolDisabled, releasePoolContext } from "./agentBrowser";
import { isSafeUrl } from "./ssrf";
import { adBlockMatch } from "./adblock";
import { type CaptionParseMeta, type CaptionSegment, formatCaptionSegments } from "./captionFormats";
import { attachCaptionListener, probeCaptionSegments, type CaptionCaptureStore } from "./captionProbe";

const GOTO_BUDGET_MS = 30_000;
const VIDEO_WAIT_MS = 8_000;
const PROBE_BUDGET_MS = 20_000;
/* Some players (proven live on a major video site) intermittently serve
   a hydrated-looking page whose PLAYER never mounts — same URL, blank
   shell, no <video> ever. A fresh navigation fixes it. Retry is fully
   generic: "did the media element appear?" is a DOM fact, not a
   provider heuristic. */
const MAX_NAV_ATTEMPTS = 3;

export async function getCaptionSegmentsViaBrowser(
  pageUrl: string,
  meta?: CaptionParseMeta,
): Promise<CaptionSegment[] | null> {
  if (browserPoolDisabled()) return null;
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!isSafeUrl(pageUrl)) return null;

  let ctx: Awaited<ReturnType<typeof acquirePoolContext>>;
  try {
    ctx = await acquirePoolContext();
  } catch {
    return null; // pool exhaustion — degrade like the TS catch arms
  }
  let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null;
  try {
    page = await ctx.newPage();
    const routePage = page; // narrowed non-null for the route closure
    /* (2026-11-08, ad-caption-bleed root cause) This used to be a 5-domain
       regex stub — YouTube's ad manifests sailed through, an ad played in
       the page, and the ad player's OWN caption track was harvested below
       as "the video's transcript". Now: §12 SSRF gate first, then the real
       filter-list engine (lib/web-search/adblock), with the legacy regex
       family OR'd in as the engine-offline fallback. MAIN media and the
       caption endpoint stay allowed on purpose — the player must run to
       fetch its own tokened caption XHRs (Proof-of-Origin tier). */
    await page
      .route("**/*", async (route) => {
        const req = route.request();
        const r = req.url();
        if (!isSafeUrl(r)) return route.abort("blockedbyclient").catch(() => {});
        if (
          /doubleclick|google-analytics|googletagmanager|adsystem|facebook\.com\/tr\//i.test(r) ||
          (await adBlockMatch(r, routePage.url(), req.resourceType()))
        ) {
          return route.abort().catch(() => {});
        }
        return route.continue();
      })
      .catch(() => {});
    const store: CaptionCaptureStore = { bodies: [] };
    attachCaptionListener(page, store);

    for (let attempt = 1; ; attempt++) {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: GOTO_BUDGET_MS });
      const hasVideo = await page
        .waitForSelector("video", { timeout: VIDEO_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      if (hasVideo || attempt >= MAX_NAV_ATTEMPTS) break;
    }

    const segs = await probeCaptionSegments(page, store, PROBE_BUDGET_MS, meta);
    return segs && segs.length > 0 ? segs : null;
  } catch {
    return null;
  } finally {
    try {
      await page?.close();
    } catch {
      /* already closed */
    }
    releasePoolContext(ctx);
  }
}

/** Segments fetched + formatted to the shared "[mm:ss] line" transcript.
 *  I19: the parse meta rides through to the formatter so a wire-capped
 *  track closes with the coverage honesty line INSIDE the transcript —
 *  downstream tiers cannot tell a partial transcript from a complete one
 *  otherwise, and the model happily invents endings. */
export async function getBrowserTranscript(pageUrl: string): Promise<string> {
  const meta: CaptionParseMeta = {};
  const segs = await getCaptionSegmentsViaBrowser(pageUrl, meta);
  return segs ? formatCaptionSegments(segs, meta) : "";
}
