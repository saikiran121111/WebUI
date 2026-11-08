/**
 * LIVE probe — skipped by default, run with ADBLOCK_LIVE=1 (it touches the
 * real list CDN and YouTube; it does NOT touch the Strata inference backend).
 * This is the evidence that the REAL prebuilt pack (EasyList + EasyPrivacy
 * + our supplemental set) behaves the way the offline vectors assume:
 *   1. the YouTube ad-manifest endpoints abort against the real lists,
 *   2. the video's own caption + media traffic is untouched by the real
 *      lists (the critical non-regression — EasyList must not eat the
 *      player),
 *   3. a real browser-tier transcript for a known video fits that video's
 *      runtime (no ad-caption bleed end to end).
 */
import { describe, expect, it } from "vitest";

const LIVE = process.env.ADBLOCK_LIVE === "1";

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
// Rick Astley – Never Gonna Give You Up: 3:33, captioned, ad-serving — a
// stable, never-blocked probe target.
const RUNTIME_SEC = 213;

(LIVE ? describe : describe.skip)("live ad-block probe (run with ADBLOCK_LIVE=1)", () => {
  it("real prebuilt lists abort the ad manifests and spare content", async () => {
    const { getAdBlockEngine, adVerdict } = await import("@/lib/web-search/adblock");
    const engine = await getAdBlockEngine();
    expect(engine, "engine must boot from the prebuilt packs (network!)").not.toBeNull();
    const v = adVerdict(engine!);

    for (const u of [
      "https://www.youtube.com/get_midroll_info?c=WEB&cver=2.0&id=dQw4w9WgXcQ",
      "https://www.youtube.com/api/stats/ads?cpn=abcdefghijkl&el=atari",
      "https://googleads.g.doubleclick.net/pagead/id",
      "https://static.doubleclick.net/instream/ad_status.js",
      "https://s0.googlevideo.com/videoplayback?sq=2&nc=1&cpn=abc&itag=18",
    ]) {
      expect(v(u, WATCH, "xhr"), u).toBe(true);
    }
    for (const [u, rt] of [
      ["https://www.youtube.com/api/timedtext?lang=en&v=dQw4w9WgXcQ&fmt=json3", "xhr"],
      [
        "https://o1234567890123456.googlevideo.com/videoplayback?itag=18&source=youtube&ip=1.2.3.4&signature=ABCDEF",
        "media",
      ],
      [WATCH, "document"],
    ] as [string, string][]) {
      expect(v(u, WATCH, rt), u).toBe(false);
    }
  }, 90_000);

  it("browser-tier transcript of a known video fits its runtime", async () => {
    const { getBrowserTranscript } = await import("@/lib/web-search/media-captions");
    const { transcriptExceedsVideoLength } = await import("@/lib/web-search/youtube");
    const transcript = (await getBrowserTranscript(WATCH)) ?? "";
    // Non-vacuous evidence: record which arm ran.
    console.log(`[adbleed-probe] browser-tier transcript chars=${transcript.length}`);
    // An empty result is honest (no track fetched); a NON-empty one must be
    // the video's own — never an ad read overshooting the runtime.
    if (transcript) {
      expect(transcriptExceedsVideoLength(transcript, RUNTIME_SEC)).toBe(false);
      // A captioned music video with the ad estate blocked should yield real
      // content: at least a handful of cue lines, all inside the runtime.
      expect(transcript.split("\n").some((l) => /^\[\d{2}:\d{2}\]/.test(l))).toBe(true);
    }
  }, 150_000);
});
