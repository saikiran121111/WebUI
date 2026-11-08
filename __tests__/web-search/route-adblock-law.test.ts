/**
 * Filter-list ad vectors for the page-route law (user report 2026-11-08:
 * ad-caption bleed — the stealth pool loaded YouTube ads (only 5 analytics
 * domains were aborted), the ad played in-page, and the ad player's OWN
 * caption track was harvested by the universal probe and served as the
 * video's transcript).
 *
 * The fix threads a real filter-list verdict (EasyList/EasyPrivacy +
 * AdGuard-style rules, computed async by lib/web-search/adblock.ts at the
 * route call site) into routeDecision as an optional fourth argument —
 * routeDecision itself stays pure and synchronous so the §12 vectors keep
 * running byte-for-byte.
 *
 * Law pinned here, in order:
 *   1. SSRF line runs first, match or no match.
 *   2. A filter-list match is an ad-abort — checked at the SAME position
 *      as the legacy AD family (before the WAF-challenge allowance).
 *   3. Without a match, every pre-existing fast-load/continue rule is
 *      byte-for-byte unchanged.
 */
import { describe, expect, it } from "vitest";
import { routeDecision } from "@/lib/web-search/agentBrowser";

describe("routeDecision filter-list verdict (4th arg, ad-caption-bleed fix)", () => {
  it("SSRF runs FIRST even when the filter list also matches", () => {
    for (const u of ["http://169.254.169.254/pagead/ad.js", "http://127.0.0.1:8080/get_midroll_info"]) {
      expect(routeDecision(u, "script", false, true), u).toBe("ssrf-abort");
    }
  });

  it("a filter-list match aborts at every resource type, and outranks fast-load", () => {
    const cases: [string, string][] = [
      ["https://youtube.com/get_midroll_info?signature=x", "xhr"],
      ["https://youtube.com/api/stats/ads?cpn=abc", "xhr"],
      ["https://pagead2.googlesyndication.com/pagead/lvz", "script"],
      ["https://static.doubleclick.net/ad-player.js", "script"],
      ["https://securepubads.g.doubleclick.net/pcs/view", "image"],
      ["https://googlevideo.com/videoplayback?sq=2&nc=1&itag=18", "media"],
    ];
    for (const [u, rt] of cases) {
      const r = routeDecision(u, rt, false, true);
      expect(r, `${u} (${rt})`).toBe("ad-abort");
      // The ad rule sits BEFORE the fast-load family: an ad media URL is
      // an ad-abort even where plain media would be a fastload-abort.
      if (rt === "media") expect(r).not.toBe("fastload-abort");
    }
  });

  it("the WAF-challenge allowance never admits a filter-list-matched request", () => {
    expect(routeDecision("https://youtube.com/api/stats/ads?cpn=abc", "xhr", true, true)).toBe(
      "ad-abort",
    );
    expect(routeDecision("https://static.doubleclick.net/instream/ad_status.js", "script", true, true)).toBe(
      "ad-abort",
    );
  });

  it("NO match keeps every pre-existing rule byte-for-byte", () => {
    expect(routeDecision("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "document", false, false)).toBe(
      "continue",
    );
    expect(routeDecision("https://o1234567890000000.googlevideo.com/videoplayback?itag=18&source=youtube", "media", false, false)).toBe(
      "fastload-abort",
    );
    expect(
      routeDecision("https://o1234567890000000.googlevideo.com/videoplayback?itag=18&source=youtube", "media", true, false),
    ).toBe("continue");
    expect(routeDecision("https://r1---sn-abc.googlevideo.com/generate_204", "xhr", false, false)).toBe(
      "continue",
    );
    // Legacy family rules survive when the engine has no opinion.
    expect(routeDecision("https://www.google-analytics.com/collect", "script", false, false)).toBe(
      "ad-abort",
    );
  });

  it("the 3-arg call shape (existing vectors) still compiles and behaves", () => {
    expect(routeDecision("https://cdn.example/app.js", "script", false)).toBe("continue");
    expect(routeDecision("https://adn.adsystem.com/bid", "xhr", false)).toBe("ad-abort");
  });
});
