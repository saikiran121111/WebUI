/**
 * Server-side per-turn cache — REMOVED with the web-verify ledger
 * (2026-10-22).
 *
 * The old version stored the turn's verification ledger (and its verbatim
 * quotes) so a later POST /api/verify-claims audit could re-adjudicate what
 * the answer actually asserted. The user's decision: no per-claim
 * adjudication. The turn now carries only its citation map (in-memory, in
 * `X-Web-Citations`), so this module is an empty no-op kept for import
 * compatibility.
 */
export interface CachedResearchTurn {
  turnId: string;
  prompt: string;
  sourceUrls: Record<string, string>;
  at: number;
}

export function rememberTurn(_turnId: string, _entry: Omit<CachedResearchTurn, "turnId" | "at">): void {
  // no-op: the claim audit is gone. Kept so older callers still compile.
}

export function recallTurn(_turnId: string): CachedResearchTurn | null {
  return null;
}

export function forgetTurn(_turnId: string): void { /* no-op */ }
export function cachedTurnCount(): number { return 0; }
export function clearTurnCache(): void { /* no-op */ }
