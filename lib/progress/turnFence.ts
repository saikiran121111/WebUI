/**
 * TURN OWNERSHIP FENCE — pure, unit-pinnable (F18, brief 2026-11-15).
 *
 * Problem it removes: every stream callback used to resolve the message to
 * write from SHARED hook state (`assistantIdRef.current`). A frame that
 * arrived late — from a turn the user already abandoned by switching chats,
 * stopping, retrying or superseding with a newer send — therefore landed on
 * whatever turn happened to be current at arrival time. That is how a stale
 * turn could open/close activity entries, mint citations or stamp usage on a
 * DIFFERENT turn, and how "sources as history" reappeared as current work.
 *
 * Law: a frame is bound to the turn that created it. It is applied only while
 * that turn is the current one; anything older is counted and dropped. The
 * fence holds no timers and no I/O, so the law lives outside React and can be
 * tested directly (this repo has no DOM test infrastructure).
 */

export interface TurnRef {
  /** Assistant message id of the turn this frame belongs to. */
  id: string;
  /** Monotonic generation token; a turn is current iff the token still matches. */
  token: number;
}

export interface TurnFence {
  /** Start a new turn; every previously captured TurnRef becomes stale. */
  begin(id: string): TurnRef;
  /** The user switched/abandoned chats: no turn is current any more. */
  invalidate(): void;
  /** True only for the turn that is current right now. Narrows for callers. */
  owns(turn: TurnRef | null | undefined): turn is TurnRef;
  currentToken: number;
  /** Telemetry: frames dropped because their turn had been superseded. */
  droppedStale: number;
}

export function createTurnFence(): TurnFence {
  return {
    currentToken: 0,
    droppedStale: 0,
    begin(id: string): TurnRef {
      this.currentToken += 1;
      return { id, token: this.currentToken };
    },
    invalidate(): void {
      this.currentToken += 1;
    },
    owns(turn: TurnRef | null | undefined): turn is TurnRef {
      // Token 0 is reserved for "no turn has begun yet", so a default/zero
      // token can never masquerade as the current turn before the first send.
      if (!turn || this.currentToken === 0 || turn.token !== this.currentToken) {
        this.droppedStale += 1;
        return false;
      }
      return true;
    },
  };
}
