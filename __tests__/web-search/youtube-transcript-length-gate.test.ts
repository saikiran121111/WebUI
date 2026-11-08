/**
 * Browser-tier transcript length gate (user report 2026-11-08).
 *
 * A 00:30 video's "transcript" came back as a 00:41+ ad read — the caption
 * probe had harvested the AD player's own caption track inside the watch
 * page. Ad-blocking (lib/web-search/adblock.ts) stops the ad from loading;
 * this gate is the defense-in-depth layer INSIDE the YouTube vertical:
 * a caption track whose cues run PAST the video's own runtime cannot
 * belong to that video, and is rejected instead of served as content.
 * (The user spotted exactly this tell: "the track runs to [00:44] but the
 * video is 00:30 long — a caption track cannot exceed the runtime.")
 *
 * Pure function, network-free: transcriptExceedsVideoLength(transcript, lengthSeconds).
 * Unknown length (0) never gates — the fact is only available when InnerTube
 * metadata resolved; no timestamps in the transcript never gates either
 * (nothing proves an ad), and the coverage-honesty note line must not
 * itself count as a cue.
 */
import { describe, expect, it } from "vitest";
import { transcriptExceedsVideoLength } from "@/lib/web-search/youtube";

const AD_READ = [
  "[00:00] For years being a good software engineer meant one thing. Writing code faster.",
  "[00:12] Then AI showed up. Now you can ship features from a single prompt.",
  "[00:41] It's live, practical and completely free. Register now.",
].join("\n");

const SINGING_VIDEO = [
  "[00:01] [Music]",
  "[00:09] Ba da ba dee da day",
  "[00:28] [Music fades]",
].join("\n");

describe("transcriptExceedsVideoLength (ad-caption-bleed gate)", () => {
  it("rejects a caption track that overshoots the runtime", () => {
    // The exact reported case: 30-second video, ad track running to 41s+.
    expect(transcriptExceedsVideoLength(AD_READ, 30)).toBe(true);
    // Hours-scale overshoot.
    expect(
      transcriptExceedsVideoLength("[00:01] a\n[1:02:03] b", 600),
    ).toBe(true);
  });

  it("keeps tracks that fit inside the runtime", () => {
    expect(transcriptExceedsVideoLength(SINGING_VIDEO, 30)).toBe(false);
    expect(transcriptExceedsVideoLength("[00:00] start\n[00:30] end", 30)).toBe(false);
    expect(transcriptExceedsVideoLength(SINGING_VIDEO, 45)).toBe(false);
    // h:mm:ss cue shape inside a long video.
    expect(transcriptExceedsVideoLength("[0:02:03] ok\n[2:03:04] last", 7400)).toBe(false);
  });

  it("bounded tolerance absorbs rounding, not an ad", () => {
    // 30 s video, final cue clocked a few seconds over (rounding/late cue) — kept.
    expect(transcriptExceedsVideoLength("[00:00] a\n[00:32] b", 30)).toBe(false);
    // An ad read overshooting 0:30 runtime to 0:41 (the real case) is rejected.
    expect(transcriptExceedsVideoLength("[00:00] a\n[00:41] b", 30)).toBe(true);
  });

  it("never gates on missing facts", () => {
    expect(transcriptExceedsVideoLength("", 30)).toBe(false);
    expect(transcriptExceedsVideoLength("no timestamps here at all [lorem]", 30)).toBe(false);
    expect(transcriptExceedsVideoLength(AD_READ, 0)).toBe(false); // unknown length
    expect(transcriptExceedsVideoLength(AD_READ, NaN)).toBe(false);
  });

  it("the coverage-honesty note line does not count as a cue", () => {
    const withNote =
      "[00:00] a\n[00:28] b\n[caption coverage: this transcript stops at 0:28 (2 cue(s) retrieved) — never assume you know how the video ends]";
    expect(transcriptExceedsVideoLength(withNote, 30)).toBe(false);
  });
});
