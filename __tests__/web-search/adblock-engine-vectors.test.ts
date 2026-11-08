/**
 * Offline filter-list vectors (zero network): EasyList/EasyPrivacy-SHADED
 * rules + the supplemental set (lib/web-search/adblock.ts) parsed straight
 * into the real Ghostery engine via `parse()`, then pushed through
 * adVerdict(). This is the non-regression shield for the whole caption
 * tier: the player's own media (`videoplayback`), its caption endpoint
 * (`api/timedtext`) and the watch document MUST sail through, while the ad
 * endpoints — the exact requests whose survival produced the user's
 * ad-caption-bleed transcript — abort. Also pins that first/third-party
 * context is derived by the engine itself (a $third-party rule fires from a
 * foreign page and NOT from the tracker's own origin).
 */
import { describe, expect, it } from "vitest";
import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import { adVerdict } from "@/lib/web-search/adblock";

const RULES = [
  "||doubleclick.net^",
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||googletagservices.com^",
  "||youtube.com/get_midroll_info?",
  "||youtube.com/api/stats/ads?",
  "||youtube.com/pagead/",
  "||googlevideo.com/videoplayback?*sq=2*",
  "||tracker.example^$third-party",
].join("\n");

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const verdict = adVerdict(PlaywrightBlocker.parse(RULES));

describe("adVerdict filter-list law (offline engine, ad-caption-bleed fix)", () => {
  it("aborts the ad endpoints that produced the ad caption track", () => {
    const cases: [string, string][] = [
      ["https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "script"],
      ["https://securepubads.g.doubleclick.net/gampad/ads?url=" + encodeURIComponent(WATCH), "xhr"],
      ["https://www.googleadservices.com/pagead/conversion/1234567890", "script"],
      ["https://www.googletagservices.com/tag/js/gpt.js", "script"],
      ["https://www.youtube.com/get_midroll_info?c=WEB&cver=2.0&id=dQw4w9WgXcQ", "xhr"],
      ["https://www.youtube.com/api/stats/ads?cpn=abcdefghijkl&el=atari", "xhr"],
      ["https://www.youtube.com/pagead/lvz?url=" + encodeURIComponent(WATCH), "xhr"],
      // Ad segment media carries sq=2; main media never does (next test).
      ["https://s0.googlevideo.com/videoplayback?sq=2&nc=1&cpn=abc&itag=18", "media"],
    ];
    for (const [u, rt] of cases) {
      expect(verdict(u, WATCH, rt), u).toBe(true);
    }
  });

  it("NEVER blocks the content traffic the caption tier depends on", () => {
    const keep: [string, string][] = [
      [WATCH, "document"],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "document"],
      // The video's OWN caption endpoint — the whole point of this tier.
      ["https://www.youtube.com/api/timedtext?lang=en&v=dQw4w9WgXcQ&fmt=json3&caps=vit", "xhr"],
      // Main media stream (no ad params): the Proof-of-Origin player needs it.
      [
        "https://o1234567890123456.googlevideo.com/videoplayback?itag=18&source=youtube&ip=1.2.3.4&ipbits=0&signature=ABCDEF&algor=1&sparams=ip",
        "media",
      ],
      ["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "image"],
      ["https://www.youtube.com/s/player/abc123/player_ias.vflset/en_BASEJS.js", "script"],
      ["https://jnn-pa.googleapis.com/batch/xyz", "xhr"],
    ];
    for (const [u, rt] of keep) {
      expect(verdict(u, WATCH, rt), u).toBe(false);
    }
  });

  it("third-party context is engine-derived, not guessed", () => {
    // Same tracker URL: a verdict from a foreign page, silence from its own origin.
    expect(verdict("https://tracker.example/pixel.gif", WATCH, "image")).toBe(true);
    expect(
      verdict("https://tracker.example/pixel.gif", "https://tracker.example/settings", "image"),
    ).toBe(false);
  });
});
