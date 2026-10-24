/**
 * Last-executed browser_api fence state — the model's feedback loop.
 *
 * When the app executes a ```browser_api fence emitted by the model
 * (components/render/BrowserApiBlock.tsx → POST /api/browser), the
 * outcome (or its failure) lands here. The next chat turn's standing
 * system block (app/api/chat/route.ts step 5b, via
 * lib/browser/authContext.ts) reports it back, so the model can act →
 * see → act again on the fly. One line, capped: the mirror's live
 * url/title is read from the same source the panel itself shows.
 */

export interface BrowserApiOutcome {
  /** The action the fence requested (as the model wrote it). */
  action: string;
  url?: string;
  text?: string;
  /** True when POST /api/browser reported ok. */
  ok: boolean;
  error?: string;
  when: number;
}

/**
 * State lives on `globalThis`, NOT a module-local: in Next.js dev mode
 * `/api/browser` and `/api/chat` compile into SEPARATE server bundles in
 * the same Node process, so a module-level `let` would give the chat
 * route its own (always-empty) copy and the act→see→act loop would never
 * close. globalThis is shared across every route bundle in the process.
 * No `fs` import here — this module is also loaded on the CLIENT by
 * BrowserApiBlock.tsx (the client write lands in browser memory; the
 * authoritative write happens server-side in browserActions.ts).
 */
const OUTCOME_GLOBAL = "__ruke_last_browser_outcome__";
type OutcomeSlot = { last: BrowserApiOutcome | null };

const slot = (
  globalThis as typeof globalThis & { [OUTCOME_GLOBAL]?: OutcomeSlot }
)[OUTCOME_GLOBAL] ??= { last: null };

export function recordBrowserApiOutcome(o: Omit<BrowserApiOutcome, "when">): void {
  slot.last = { ...o, when: Date.now() };
}

export function lastBrowserApiOutcome(): BrowserApiOutcome | null {
  return slot.last;
}
