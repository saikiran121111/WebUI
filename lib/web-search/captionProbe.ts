/**
 * Page-level caption probe — universal (no domain/host/URL keying).
 *
 * Given an already-loaded page, surface its media player's caption track
 * through three provider-agnostic tiers, cheapest first:
 *   1. DOM text tracks — HTML5 players that expose `<track>`/TextTrack
 *      cues read instantly (setting `mode="showing"` also triggers lazy
 *      cue loading).
 *   2. The player's own caption requests — a response listener (attached
 *      BEFORE navigation by the caller) has already collected any eager
 *      texttrack XHRs (Vimeo/Dailymotion fetch them on player init).
 *   3. Toggle captions like a user: click elements whose ARIA label /
 *      title mentions captions|subtitles (the accessible name is the
 *      cross-provider contract), press `c`, force TextTrack modes. The
 *      player then fires its OWN caption request — the only one carrying
 *      whatever anti-abuse token the endpoint demands (this is the tier
 *      that defeated YouTube's Proof-of-Origin gate live: 474 caption
 *      events captured headless).
 *
 * Parsed bodies and DOM cues compete by segment count. Nothing here can
 * break the host page read — every tier swallows its own failure.
 */
import type { Page } from "playwright";
import {
  type CaptionSegment,
  formatCaptionSegments,
  isCaptionCandidateUrl,
  sniffCaptures,
} from "./captionFormats";

export interface CaptionCaptureStore {
  bodies: string[];
}

const MAX_BODIES = 12;
const MAX_BODY_CHARS = 500_000;

/**
 * Listen for caption-track responses on EVERY frame. Body-bearing types
 * that caption endpoints actually use across providers: xhr/fetch
 * (Vimeo/Dailymotion/YouTube player XHRs) AND texttrack — Chromium's
 * resource type for <track>-element loads (proven live 2026-10-28 on an
 * HTML5-native provider: ct=text/vtt arrives as rt=texttrack, which an
 * xhr/fetch-only filter silently drops). Documents/media/scripts stay
 * excluded so a page's HTML never enters the store.
 * Call this BEFORE navigation.
 */
export function attachCaptionListener(page: Page, store: CaptionCaptureStore): void {
  page.on("response", (res) => {
    try {
      if (!isCaptionCandidateUrl(res.url())) return;
      const rt = res.request().resourceType();
      if (rt !== "xhr" && rt !== "fetch" && rt !== "texttrack") return;
      res
        .text()
        .then((t) => {
          if (t && t.length <= MAX_BODY_CHARS) store.bodies.push(t);
        })
        .catch(() => {
          /* body unavailable (navigated away) — skip this response */
        });
    } catch {
      /* listener must never throw into the page pipeline */
    }
  });
}

/**
 * Read every HTML5 TextTrack cue from every <video> on the page,
 * flipping caption/subtitle tracks to `showing` so players that lazily
 * populate cues actually load them (re-read after a wait picks them up).
 */
export async function readDomCaptionSegments(page: Page): Promise<CaptionSegment[]> {
  const cues = await page
    .evaluate(() => {
      const out: { startMs: number; text: string }[] = [];
      const vids = Array.from(document.querySelectorAll("video"));
      for (const v of vids) {
        const tracks = v.textTracks ? Array.from(v.textTracks) : [];
        for (const tr of tracks) {
          if (tr.kind !== "captions" && tr.kind !== "subtitles") continue;
          try {
            if (tr.mode !== "showing") tr.mode = "showing";
          } catch {
            continue;
          }
          const list: any = (tr as any).cues ?? [];
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const text = String(c?.text ?? "").trim();
            if (!text) continue;
            out.push({ startMs: Math.round((Number(c?.startTime) || 0) * 1000), text });
          }
        }
      }
      return out.slice(0, 1200);
    })
    .catch(() => [] as { startMs: number; text: string }[]);
  return cues.map((c) => ({ text: c.text, startMs: c.startMs }));
}

/**
 * Start playback — the universal lazy-load trigger. HTML5 players that
 * attach <track> elements fetch the track resource only once the media
 * element is actually loading (proven live: setting mode="showing"
 * alone fires ZERO requests; a play() fires the texttrack fetch and
 * cues populate). Muted fallback keeps autoplay policies from blocking
 * the trigger.
 */
export async function playNudge(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const v of Array.from(document.querySelectorAll("video"))) {
        const fire = () => {
          const pr = v.play?.();
          if (pr && typeof pr.catch === "function") pr.catch(() => {});
        };
        fire();
        // Autoplay-with-sound may reject — retry muted, which every
        // major browser allows.
        window.setTimeout(() => {
          if (v.paused) {
            try {
              v.muted = true;
            } catch {
              /* ignore */
            }
            fire();
          }
        }, 600);
      }
    })
    .catch(() => {});
}

/**
 * Universal caption-toggle levers (accessible-name contract, not
 * provider selectors): click the first visible control whose label or
 * title mentions captions/subtitles, then press `c` (the shortcut most
 * web players bind to CC), then force TextTrack modes via DOM.
 */
export async function enableCaptions(page: Page): Promise<void> {
  await playNudge(page); // players fetch tracks only once media loads
  for (const sel of [
    '[aria-label*="caption" i]',
    '[aria-label*="subtitle" i]',
    '[title*="caption" i]',
    '[title*="subtitle" i]',
  ]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 600 })) {
        await loc.click({ timeout: 1_500 });
        break;
      }
    } catch {
      /* this lever unavailable — try the next */
    }
  }
  await page.keyboard.press("c").catch(() => {});
  await page
    .evaluate(() => {
      for (const v of Array.from(document.querySelectorAll("video"))) {
        const tracks = v.textTracks ? Array.from(v.textTracks) : [];
        for (const tr of tracks) {
          if (tr.kind === "captions" || tr.kind === "subtitles") {
            try {
              tr.mode = "showing";
            } catch {
              /* track rejected the flip — skip */
            }
          }
        }
      }
    })
    .catch(() => {});
}

/**
 * Full probe for an already-loaded page. `store` must come from
 * `attachCaptionListener` (attached pre-navigation). Returns segments
 * from whichever tier wins, or null when the page has no captionable
 * player. `budgetMs` bounds only the wait-for-captions loop — the
 * caller owns the navigation budget.
 */
export async function probeCaptionSegments(
  page: Page,
  store: CaptionCaptureStore,
  budgetMs: number,
): Promise<CaptionSegment[] | null> {
  const hasVideo = await page.evaluate(() => !!document.querySelector("video")).catch(() => false);
  if (!hasVideo) return null;

  // Kick lazy loading before touching tracks (mode flips alone fire no
  // track requests on HTML5-native players).
  await playNudge(page);

  // Tier 1: cues already exposed in the DOM.
  let dom = await readDomCaptionSegments(page);
  if (dom.length >= 2) return dom;

  // Tier 3 levers (tier 2 bodies are already flowing into `store`):
  // only pay the UI toggle when the player has not fetched tracks eagerly.
  if (store.bodies.length === 0) await enableCaptions(page);

  const deadline = Date.now() + Math.max(0, budgetMs);
  let sawAt = 0;
  let lastNudge = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    // Late-booting players attach their tracks AFTER our initial tiers
    // ran (proven live: a page that had zero tracks + zero requests at
    // toggle time later fired 62 caption fetches on its own boot).
    // Re-nudge on a slow cadence so late mounts get the same trigger.
    if (store.bodies.length === 0 && Date.now() - lastNudge > 2_500) {
      lastNudge = Date.now();
      await playNudge(page);
    }
    dom = await readDomCaptionSegments(page).catch(() => dom);
    if (dom.length >= 2) return dom;
    if (store.bodies.length > MAX_BODIES) store.bodies.splice(0, store.bodies.length - MAX_BODIES);
    if (store.bodies.length && !sawAt) sawAt = Date.now();
    // Let late chunked continuations land before parsing the best body.
    if (sawAt && Date.now() - sawAt > 2_500) break;
  }
  const best = store.bodies.reduce((a, b) => (b.length > a.length ? b : a), "");
  const parsed = sniffCaptures(best);
  if (parsed.length >= dom.length && parsed.length > 0) return parsed;
  return dom.length > 0 ? dom : null;
}

export { formatCaptionSegments };
