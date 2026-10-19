/**
 * Shared inference-slot registry: the local llama.cpp backend has ONE slot,
 * and the USER's conversation always owns it. The chat route brackets every
 * forwarded turn with beginUserTurn/endUserTurn; background model work
 * (title jobs) checks the registry before starting and gets aborted the
 * moment a real user turn arrives. Without this, a background title call
 * (observed: a cold model load during a Playwright run) held the slot and
 * starved the next user stream for minutes.
 */

let activeUserTurns = 0;
const titleCalls = new Set<AbortController>();

/** A user conversation turn is starting: any in-flight title call yields now. */
export function beginUserTurn(): void {
  activeUserTurns++;
  for (const c of titleCalls) c.abort();
}

export function endUserTurn(): void {
  activeUserTurns = Math.max(0, activeUserTurns - 1);
}

export function userTurnActive(): boolean {
  return activeUserTurns > 0;
}

export function registerTitleCall(ctrl: AbortController): void {
  titleCalls.add(ctrl);
}

export function unregisterTitleCall(ctrl: AbortController): void {
  titleCalls.delete(ctrl);
}

/** Wait until no user turn is active. False = still busy after the cap. */
export async function waitForUserIdle(timeoutMs: number, stepMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (activeUserTurns > 0) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return true;
}

/** Test seam: clear all registry state. */
export function resetInferenceBusy(): void {
  activeUserTurns = 0;
  titleCalls.clear();
}
