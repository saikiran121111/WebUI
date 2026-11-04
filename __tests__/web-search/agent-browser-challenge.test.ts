/**
 * Vectors for the 2026-11-04 Cloudflare fix (user: "model literally said
 * it gets 403 forbidden unable to access the website ... its a cloudflare
 * block and we have bypassed it via some code or library").
 *
 * The defect: the browser-tier settle loop early-exited on
 * "bodyText > 300 chars" — and Cloudflare's OWN challenge/block page
 * exceeds 300 chars, so the block page was returned as page content and
 * the model dutifully reported "403 Forbidden". The fix gates the settle
 * exit on this passive, site-agnostic marker predicate (we never
 * interact with a challenge widget — detection only).
 */
import { describe, expect, it } from "vitest";
import { challengeMarkersPresent } from "../../lib/web-search/agentBrowser";

describe("passive WAF interstitial detection (agentBrowser settle law)", () => {
  it("Cloudflare managed-challenge interstitial is NOT content", () => {
    expect(
      challengeMarkersPresent(
        "Just a moment...\nChecking your browser before accessing zepto.com. This process is automatic.",
      ),
    ).toBe(true);
  });

  it("Cloudflare block/error pages are NOT content", () => {
    expect(challengeMarkersPresent("Attention Required! | Cloudflare")).toBe(true);
    expect(challengeMarkersPresent("Error 1020\nAccess forbidden by network policy")).toBe(true);
    expect(challengeMarkersPresent("403 Forbidden\nRequest blocked")).toBe(true);
  });

  it("AWS WAF / DataDome interstitials are NOT content", () => {
    expect(challengeMarkersPresent("ERROR The reference ID #a1b2 is logged. DDoS-Guard")).toBe(true);
    expect(
      challengeMarkersPresent("Pardon Our Interruption — Enable JavaScript and cookies to continue"),
    ).toBe(true);
  });

  it("a real product page's text never trips the markers", () => {
    expect(
      challengeMarkersPresent(
        "Kingfisher Premium Beer 650 ml\n₹175 ₹185\nIn stock · delivered in 9 minutes\nAdd to cart",
      ),
    ).toBe(false);
  });

  it("generic long-form content that merely mentions blocking is still content", () => {
    // A news article ABOUT block pages must not be treated as a wall —
    // worst case the loop waits its bounded settle budget, then accepts.
    expect(
      challengeMarkersPresent(""),
    ).toBe(false);
    const article =
      "Cloudflare's 403 error page appears when a firewall rule denies the request.";
    // Contains "403" but not the standalone block-page signature "403 forbidden".
    expect(challengeMarkersPresent(article)).toBe(false);
  });
});
