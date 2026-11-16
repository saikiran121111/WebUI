/**
 * F19 — one following/free controller (lib/ui/scrollFollow.ts).
 *
 * Pins the law that replaces the old two-writer scroll state:
 *   - programmatic writes (the rAF pin) are never read as user intent;
 *   - a browser anchoring/clamp compensation is never read as user intent;
 *   - only genuine reader movement leaves "following";
 *   - park-at-bottom re-engages it, and jump-to-bottom does so synchronously.
 * Node env (no jsdom): the DOM listener layer in app/page.tsx just feeds real
 * geometry into this reducer, so the whole decision is testable here.
 */
import { describe, it, expect } from "vitest";
import {
  initialFollowState,
  reduceFollow,
  distanceFromBottom,
  maxScrollTop,
  pinTarget,
  shouldPin,
  BOTTOM_REPIN_PX,
  type FollowState,
} from "../../lib/ui/scrollFollow";

const g = (scrollTop: number, scrollHeight: number, clientHeight = 400) =>
  ({ scrollTop, scrollHeight, clientHeight });

const seed = (state: FollowState, geo = g(0, 1000)): FollowState =>
  reduceFollow(state, { type: "geometry", geo });

describe("F19 — content growth never breaks following", () => {
  it("streaming growth (no upward movement) keeps the view pinned", () => {
    let s = seed(initialFollowState(), g(600, 1000));
    // content grew by 300 while the reader stayed put
    s = reduceFollow(s, { type: "geometry", geo: g(600, 1300) });
    s = reduceFollow(s, { type: "scroll", geo: g(600, 1300) });
    expect(s.following).toBe(true);
    expect(shouldPin(s)).toBe(true);
    expect(distanceFromBottom(g(600, 1300))).toBe(300);
  });

  it("a viewport resize is intent-free", () => {
    let s = seed(initialFollowState(), g(300, 1200, 400));
    s = reduceFollow(s, { type: "geometry", geo: g(300, 1200, 700) });
    expect(s.following).toBe(true);
    expect(s.lastClientHeight).toBe(700);
  });
});

describe("F19 — programmatic pins are never user intent", () => {
  it("the pin's own scroll event is consumed by the tag", () => {
    let s = seed(initialFollowState(), g(600, 1400));
    const target = pinTarget(g(600, 1400));
    expect(target).toBe(1000); // clamped to what the browser will accept
    s = reduceFollow(s, { type: "pin_request", target });
    s = reduceFollow(s, { type: "scroll", geo: g(target, 1400) });
    expect(s.following).toBe(true);
    expect(s.pendingPinTop).toBeNull();
    expect(s.userIntentUnpins).toBe(0);
  });

  it("pin target is the CLAMPED end, so the tag cannot mismatch the real write", () => {
    expect(pinTarget(g(50, 900, 400))).toBe(500);
    expect(maxScrollTop(g(50, 300, 400))).toBe(0); // content shorter than the viewport
  });

  it("an untagged foreign event invalidates a stale pin tag", () => {
    let s = seed(initialFollowState(), g(1000, 1400));
    s = reduceFollow(s, { type: "pin_request", target: 1000 });
    // reader scrolled up 250 instead of the pin landing
    s = reduceFollow(s, { type: "scroll", geo: g(750, 1400) });
    expect(s.following).toBe(false);
    expect(s.pendingPinTop).toBeNull();
    expect(s.userIntentUnpins).toBe(1);
  });
});

describe("F19 — layout-driven upward movement is not reader intent", () => {
  it("an upward move fully explained by a shrink is absorbed, not reader intent", () => {
    // A revision retracted 300px ABOVE the viewport; the browser compensated by
    // moving scrollTop up 250px (rounding). Nothing was touched by the human.
    let s = seed(initialFollowState(), g(900, 1400));
    s = reduceFollow(s, { type: "geometry", geo: g(900, 1100) });
    s = reduceFollow(s, { type: "scroll", geo: g(650, 1100) }); // up 250, shrink 300, dist 50
    expect(s.following).toBe(true);
    expect(s.anchoringAbsorbed).toBe(1);
    expect(s.userIntentUnpins).toBe(0);
  });

  it("a shrink that parks the reader at the new end keeps following", () => {
    let s = seed(initialFollowState(), g(1000, 1400));
    s = reduceFollow(s, { type: "geometry", geo: g(1000, 1100) });
    s = reduceFollow(s, { type: "scroll", geo: g(700, 1100) });
    expect(distanceFromBottom(g(700, 1100))).toBe(0);
    expect(s.following).toBe(true);
    expect(s.userIntentUnpins).toBe(0);
  });

  it("a RO-driven pin after growth is tagged, so its event stays intent-free", () => {
    // Content grew 300 while the reader stayed; the observer schedules a pin.
    let s = seed(initialFollowState(), g(600, 1000));
    s = reduceFollow(s, { type: "geometry", geo: g(600, 1300) });
    s = reduceFollow(s, { type: "scroll", geo: g(600, 1300) });
    expect(s.following).toBe(true);
    s = reduceFollow(s, { type: "pin_request", target: pinTarget(g(600, 1300)) });
    s = reduceFollow(s, { type: "scroll", geo: g(900, 1300) });
    expect(s.following).toBe(true);
    expect(s.pendingPinTop).toBeNull();
  });

  it("a shrink that only PARTLY explains the movement is reader intent", () => {
    let s = seed(initialFollowState(), g(900, 1400));
    s = reduceFollow(s, { type: "geometry", geo: g(900, 1350) });
    s = reduceFollow(s, { type: "scroll", geo: g(600, 1350) }); // up 300, shrink 50
    expect(s.following).toBe(false);
    expect(s.userIntentUnpins).toBe(1);
  });

  it("a plain upward scroll with unchanged content unpins immediately", () => {
    let s = seed(initialFollowState(), g(900, 1400));
    s = reduceFollow(s, { type: "scroll", geo: g(650, 1400) });
    expect(s.following).toBe(false);
    expect(shouldPin(s)).toBe(false);
  });
});

describe("F19 — explicit intent wins, synchronously", () => {
  it("wheel-up and touch drag unpin without needing a geometry event", () => {
    const s0 = seed(initialFollowState(), g(1000, 1400));
    for (const type of ["wheel_up", "touch_up"] as const) {
      const s = reduceFollow(s0, { type });
      expect(s.following).toBe(false);
      expect(s.userIntentUnpins).toBe(1);
    }
  });

  it("parking near the bottom re-engages following", () => {
    let s = seed(reduceFollow(initialFollowState(), { type: "wheel_up" }), g(650, 1400));
    expect(s.following).toBe(false);
    s = reduceFollow(s, { type: "scroll", geo: g(995, 1400) }); // 5px from the end
    expect(s.following).toBe(true);
  });

  it("jump-to-bottom enables following BEFORE the pin runs", () => {
    let s = seed(reduceFollow(initialFollowState(), { type: "wheel_up" }), g(200, 1400));
    s = reduceFollow(s, { type: "follow" });
    expect(shouldPin(s)).toBe(true); // the rAF write sees this immediately
    s = reduceFollow(s, { type: "pin_request", target: pinTarget(g(200, 1400)) });
    s = reduceFollow(s, { type: "scroll", geo: g(1000, 1400) });
    expect(s.following).toBe(true);
  });

  it("a new turn/conversation reset starts following with clean geometry", () => {
    let s = reduceFollow(seed(initialFollowState(), g(10, 5000)), { type: "wheel_up" });
    s = reduceFollow(s, { type: "reset" });
    expect(s).toEqual(initialFollowState(true));
  });

  it("repeated unpins are not double-counted", () => {
    let s = seed(initialFollowState(), g(900, 1400));
    s = reduceFollow(s, { type: "wheel_up" });
    s = reduceFollow(s, { type: "wheel_up" });
    expect(s.userIntentUnpins).toBe(1);
  });
});
