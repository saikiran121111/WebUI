/**
 * Browser Panel store (Browser Use, Phase 3) — a plain external store
 * (`subscribe` / `getSnapshot` + `useSyncExternalStore`), no new
 * dependency. It is the single place UI code learns that the browser
 * exists; the MODEL-side emitter of `browser:*` stage frames lands with
 * the Rust tool loop (Phase 10), and `handleBrowserStage` below is the
 * one seam that consumes them — useChat calls it for every
 * `browser:*` frame before handing the event to the progress tracker.
 *
 * What is deliberately NOT here: the screencast socket itself (owned by
 * BrowserPanel, which the page lazy-mounts), tab mutation RPCs (the
 * panel issues those through browserClient), and any auto-open trigger
 * invented client-side — until Phase 10 emits real `browser:*` frames
 * the panel opens only by explicit user action from a `web:auth_required`
 * style handoff or the panel's own affordances. Faking an auto-open
 * would be a placeholder (Rule 18 law).
 *
 * Frames are kept per-tab (latest JPEG data-URL each) so switching the
 * selected tab paints instantly from the last frame instead of waiting
 * for the next screencast tick.
 */
"use client";

import { useSyncExternalStore } from "react";
import type {
  ApprovalRequestCard,
  AuthHandoffRequestCard,
  BrowserTab,
} from "./browserClient";
import type { AnnotationAnchor } from "./annotationPrompt";

export interface BrowserState {
  /** panel visibility (user-toggled or stage-driven) */
  open: boolean;
  tabs: BrowserTab[];
  selected: string | null;
  /** tab_id -> latest screencast frame as a data: URL */
  frames: Record<string, string>;
  connected: boolean;
  /** true while the model is driving the browser this turn */
  agentActive: boolean;
  error: string | null;
  /** conversation the browser session belongs to (session_id in Rust) */
  conversation: string | null;
  /* ── Phase 9 card + takeover state ──────────────────────────────────── */
  /** parked approvals the engine is waiting on (approval_request) */
  approvals: ApprovalRequestCard[];
  /** parked browser-auth handoffs the human must authorize */
  authHandoffs: AuthHandoffRequestCard[];
  /** tab_id -> takeover reason; presence = the tab is the human's */
  takeovers: Record<string, string>;
  /* ── Phase 12 annotation state ──────────────────────────────────────── */
  /** parked comment cards: human captures (anchor set) and site-initiated
   *  `open_annotation` frames (anchor null, detail set). Parked here —
   *  nothing is sent to the model until the human attaches one. */
  annotations: AnnotationCard[];
}

/** One parked annotation card (Phase 12). */
export interface AnnotationCard {
  id: string;
  tab_id: string;
  /** captured DOM anchor, or null for a site-declared request */
  anchor: AnnotationAnchor | null;
  /** recovered CustomEvent detail for site-initiated cards */
  detail?: unknown;
  source: "human" | "site";
}

const EMPTY: BrowserState = {
  open: false,
  tabs: [],
  selected: null,
  frames: {},
  connected: false,
  agentActive: false,
  error: null,
  conversation: null,
  approvals: [],
  authHandoffs: [],
  takeovers: {},
  annotations: [],
};

let state: BrowserState = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<BrowserState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getBrowserState(): BrowserState {
  return state;
}

export function subscribeBrowserState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserState(): BrowserState {
  return useSyncExternalStore(subscribeBrowserState, getBrowserState, getBrowserState);
}

/* ── mutations (called by the panel / client wiring) ────────────────────── */

export function openBrowserPanel(conversation: string | null): void {
  set({ open: true, conversation: conversation ?? state.conversation });
}

export function closeBrowserPanel(): void {
  set({ open: false });
}

export function setPanelError(error: string | null): void {
  set({ error });
}

export function setConnected(connected: boolean): void {
  set({ connected });
}

/** Replace the tab listing and keep `selected` honest. */
export function setTabs(tabs: BrowserTab[]): void {
  const still = state.selected && tabs.some((t) => t.tab_id === state.selected);
  const selected = still ? state.selected : tabs.length ? tabs[0].tab_id : null;
  // Prune frames for tabs that no longer exist.
  let frames = state.frames;
  if (Object.keys(frames).some((id) => !tabs.some((t) => t.tab_id === id))) {
    frames = {};
    for (const t of tabs) if (state.frames[t.tab_id]) frames[t.tab_id] = state.frames[t.tab_id];
  }
  // Phase 9: card parked on a dead tab is orphaned (the engine forgets
  // parked approvals when the tab goes away) — drop it client-side.
  const approvals = state.approvals.filter((c) => tabs.some((t) => t.tab_id === c.tab_id));
  const authHandoffs = state.authHandoffs.filter((c) => tabs.some((t) => t.tab_id === c.tab_id));
  // Phase 12: an annotation anchored to a dead tab is worthless (the
  // page it pointed at is gone) — drop it with the tab.
  const annotations = state.annotations.filter((c) => tabs.some((t) => t.tab_id === c.tab_id));
  // Mirror the `taken_over` row flag (tab_json) onto the takeover map;
  // the event carries the reason, so a flag-true row keeps the known
  // reason and only defaults when the panel missed the event (e.g. a
  // (re)connect mid-handoff). Claiming resets the flag → banner clears.
  let takeovers = state.takeovers;
  if (tabs.some((t) => t.taken_over !== undefined) || Object.keys(takeovers).length) {
    takeovers = {};
    for (const t of tabs) {
      if (t.taken_over) takeovers[t.tab_id] = state.takeovers[t.tab_id] ?? "handoff";
    }
  }
  set({ tabs, selected, frames, approvals, authHandoffs, takeovers, annotations });
}

/** Merge one tab row (e.g. a `subscribed` ack) into the listing. */
export function mergeTab(tab: BrowserTab): void {
  const exists = state.tabs.some((t) => t.tab_id === tab.tab_id);
  setTabs(
    exists
      ? state.tabs.map((t) => (t.tab_id === tab.tab_id ? tab : t))
      : [...state.tabs, tab],
  );
}

export function selectTab(tabId: string): void {
  if (state.selected !== tabId) set({ selected: tabId });
}

/** Latest frame wins per tab; the panel renders the selected tab's. */
export function setFrame(tabId: string, base64Jpeg: string): void {
  set({ frames: { ...state.frames, [tabId]: `data:image/jpeg;base64,${base64Jpeg}` } });
}

/* ── Phase 9 cards + takeover (parked engine waiters) ───────────────────── */

/** Park an approval card (deduped by id — a replayed frame is a no-op). */
export function addApproval(card: ApprovalRequestCard): void {
  if (state.approvals.some((c) => c.id === card.id)) return;
  set({ approvals: [...state.approvals, card] });
}

export function removeApproval(id: string): void {
  if (!state.approvals.some((c) => c.id === id)) return;
  set({ approvals: state.approvals.filter((c) => c.id !== id) });
}

/** Park an auth-handoff card (deduped by id). */
export function addAuthHandoff(card: AuthHandoffRequestCard): void {
  if (state.authHandoffs.some((c) => c.id === card.id)) return;
  set({ authHandoffs: [...state.authHandoffs, card] });
}

export function removeAuthHandoff(id: string): void {
  if (!state.authHandoffs.some((c) => c.id === id)) return;
  set({ authHandoffs: state.authHandoffs.filter((c) => c.id !== id) });
}

/* ── Phase 12 annotation cards ─────────────────────────────────────────── */

/** Park one annotation card (ids are minted panel-side; a replayed
 *  frame can never collide because each frame mints a fresh id — dedupe
 *  by id still guards same-tick double dispatch). */
export function addAnnotation(card: AnnotationCard): void {
  if (state.annotations.some((c) => c.id === card.id)) return;
  set({ annotations: [...state.annotations, card] });
}

export function removeAnnotation(id: string): void {
  if (!state.annotations.some((c) => c.id === id)) return;
  set({ annotations: state.annotations.filter((c) => c.id !== id) });
}

/** The tab is the human's now (manual handoff / takeover event). */
export function setTakeover(tabId: string, reason: string): void {
  if (state.takeovers[tabId] === reason) return;
  set({ takeovers: { ...state.takeovers, [tabId]: reason } });
}

/** Claimed back ("return to agent") or the engine flag says otherwise. */
export function clearTakeover(tabId: string): void {
  if (!(tabId in state.takeovers)) return;
  const next = { ...state.takeovers };
  delete next[tabId];
  set({ takeovers: next });
}

/* ── model-turn stage frames ────────────────────────────────────────────── */

/**
 * Consume one `browser:*` stage frame from the chat SSE (emitted by the
 * Rust tool loop from Phase 10 on; the seam is wired NOW so the frames
 * land honestly when they arrive). Unknown sub-stages are ignored — the
 * progress tracker still sees every frame (we do not swallow the event).
 */
export function handleBrowserStage(stage: string, session?: string): void {
  switch (stage) {
    case "browser:preparing":
    case "browser:acting":
      set({ open: true, agentActive: true, conversation: session ?? state.conversation });
      break;
    case "browser:handoff":
    case "browser:done":
      set({ agentActive: false, conversation: session ?? state.conversation });
      break;
    default:
      break;
  }
}
