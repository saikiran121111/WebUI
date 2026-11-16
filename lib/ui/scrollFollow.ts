/**
 * ONE following/free scroll controller — pure, unit-pinnable (F19, brief 2026-11-15).
 *
 * app/page.tsx used to keep the decision in TWO places: React state
 * (`hasScrolledUp`) and a mirror ref (`stickToBottomRef.current = !hasScrolledUp`)
 * written DURING RENDER. That made the mirror the loser of a race: a wheel/touch
 * unpin set the ref synchronously, then an unrelated re-render (a stream delta
 * flush) rewrote it back from the not-yet-flushed state, so a queued rAF pin
 * yanked the reader back to the bottom. It also treated ANY upward scrollTop
 * change as user intent, including the upward changes the browser itself makes
 * when content above the viewport shrinks or a revision retracts text.
 *
 * The law implemented here:
 *   1. One mutable state object owns `following`. React state is a PROJECTION
 *      for rendering the "jump to latest" affordance, never an input.
 *   2. Programmatic writes are tagged (`pin_request`) and their scroll events
 *      are consumed as programmatic — a pin can never unpin the user.
 *   3. A scroll event is only "the user moved up" when the movement is NOT
 *      explained by the content height changing underneath the viewport
 *      (browser scroll anchoring / clamping). Height-driven geometry changes
 *      never create intent.
 *   4. Being within `BOTTOM_REPIN_PX` of the bottom means following, and only
 *      real user input (wheel/touch/keyboard/scrollbar) can leave that state.
 *   5. A new turn / new conversation starts following (explicit `follow()`).
 * No DOM, no timers, no rAF here — the caller owns those; the reducer just says
 * what the human's intent was.
 */

/** Re-engage following once the reader is this close to the bottom (px). */
export const BOTTOM_REPIN_PX = 8;
/** Noise floor for an upward movement (px) — sub-pixel jitter is not intent. */
export const UP_INTENT_PX = 1;
/** How far a tagged programmatic write may be off (clamped by the browser) and still count. */
export const PIN_TOLERANCE_PX = 2;

export interface ScrollerGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowState {
  /** The single source of truth: is the view following the stream? */
  following: boolean;
  lastScrollTop: number;
  lastScrollHeight: number;
  lastClientHeight: number;
  /**
   * Pixels of content height that the layout removed SINCE the last observed
   * scroll event (reported by a geometry/ResizeObserver change). The browser
   * answers such a change by moving scrollTop up by the same amount, so this
   * budget is what makes that movement innocent. A geometry event can arrive
   * before or after the scroll event it caused, so the budget is accumulated
   * here instead of relying on which baseline happens to be current.
   */
  pendingShrinkPx: number;
  /** Target of the programmatic pin we wrote; its scroll event is NOT intent. */
  pendingPinTop: number | null;
  /** Telemetry only: how many unpins the controller attributed to the human. */
  userIntentUnpins: number;
  /** Telemetry only: upward changes attributed to layout, not to the human. */
  anchoringAbsorbed: number;
}

export type FollowAction =
  | { type: "geometry"; geo: ScrollerGeometry }
  | { type: "scroll"; geo: ScrollerGeometry }
  | { type: "wheel_up" }
  | { type: "touch_up" }
  | { type: "pin_request"; target: number }
  | { type: "follow" }
  | { type: "free" }
  | { type: "reset" };

const geom = (g: ScrollerGeometry) => ({
  lastScrollTop: g.scrollTop,
  lastScrollHeight: g.scrollHeight,
  lastClientHeight: g.clientHeight,
});

export function initialFollowState(following = true): FollowState {
  return {
    following,
    lastScrollTop: 0,
    lastScrollHeight: 0,
    lastClientHeight: 0,
    pendingShrinkPx: 0,
    pendingPinTop: null,
    userIntentUnpins: 0,
    anchoringAbsorbed: 0,
  };
}

/** Distance from the bottom of the scroller (0 = parked at the end). */
export function distanceFromBottom(g: ScrollerGeometry): number {
  return g.scrollHeight - g.scrollTop - g.clientHeight;
}

/** The largest scrollTop the browser will actually accept right now. */
export function maxScrollTop(g: ScrollerGeometry): number {
  return Math.max(0, g.scrollHeight - g.clientHeight);
}

/**
 * THE reducer. Returns a new state (never mutates), so the transition law is
 * assertable without a browser: pin/unpin, programmatic writes, anchoring
 * compensation, and content growth each get their own rule.
 */
export function reduceFollow(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case "follow":
      // Programmatic re-engage (jump-to-bottom, new turn, new conversation):
      // synchronous and total — a queued pin must see this immediately.
      return { ...state, following: true, pendingPinTop: null };

    case "free":
      // Explicit human intent (wheel-up / touch drag). Synchronous unpin so a
      // pin already scheduled this frame cannot land after it.
      if (!state.following) return state;
      return { ...state, following: false, pendingPinTop: null, userIntentUnpins: state.userIntentUnpins + 1 };

    case "wheel_up":
    case "touch_up":
      return reduceFollow(state, { type: "free" });

    case "pin_request": {
      // We are about to WRITE scrollTop. Tag it; never change `following` here.
      return { ...state, pendingPinTop: action.target };
    }

    case "geometry": {
      // Pure layout change (viewport resize, RO callback) — intent-free by law.
      // A SHRINK is recorded as an explanation budget rather than dropped: the
      // scroll event it triggers must not be read as the reader moving up.
      const shrink = Math.max(0, state.lastScrollHeight - action.geo.scrollHeight);
      return { ...state, ...geom(action.geo), pendingShrinkPx: state.pendingShrinkPx + shrink };
    }

    case "reset":
      // A new conversation/turn starts a fresh follow with no carried geometry.
      return initialFollowState(true);

    case "scroll": {
      const g = action.geo;
      const pending = state.pendingPinTop;
      if (pending != null && Math.abs(g.scrollTop - pending) <= PIN_TOLERANCE_PX) {
        // Our own pin landing. Consume it: no intent, and re-engage following
        // because a pin only happens while following.
        return { ...state, following: true, pendingPinTop: null, ...geom(g) };
      }
      const dist = distanceFromBottom(g);
      const movedUp = g.scrollTop < state.lastScrollTop - UP_INTENT_PX;
      // Two ways to learn that the layout shrank: the RO told us (budget) or the
      // height simply differs between two scroll observations. Take whichever
      // is larger — they describe the same event in different orders.
      const observedShrink = Math.max(0, state.lastScrollHeight - g.scrollHeight);
      const shrink = Math.max(observedShrink, state.pendingShrinkPx);
      // Browser scroll anchoring / clamping compensates a content change by
      // moving scrollTop by (almost) exactly the height delta. Absorb that
      // instead of inventing intent: an upward move fully explained by a
      // shrink (or by clamping at a new max) is NOT the reader moving up.
      const explainedByLayout =
        shrink > 0 && (state.lastScrollTop - g.scrollTop) <= shrink + UP_INTENT_PX;
      const clampedAtEnd = g.scrollTop >= maxScrollTop(g) - PIN_TOLERANCE_PX;

      let following = state.following;
      let anchoringAbsorbed = state.anchoringAbsorbed;
      if (dist <= BOTTOM_REPIN_PX || clampedAtEnd) {
        following = true;                       // parked at the end = following
      } else if (movedUp) {
        if (explainedByLayout) anchoringAbsorbed += 1;
        else following = false;                 // real reader intent
      }
      const unpinnedByIntent = following === false && state.following === true;
      return {
        ...state,
        following,
        pendingPinTop: null,                    // any foreign event invalidates the tag
        pendingShrinkPx: 0,                     // the explanation window is one event wide
        anchoringAbsorbed,
        userIntentUnpins: state.userIntentUnpins + (unpinnedByIntent ? 1 : 0),
        ...geom(g),
      };
    }
  }
}

/** Should a pinned write happen now? The caller asks this inside its rAF. */
export function shouldPin(state: FollowState): boolean {
  return state.following;
}

/** The write target for a pin, clamped to what the browser will accept. */
export function pinTarget(g: ScrollerGeometry): number {
  return maxScrollTop(g);
}
