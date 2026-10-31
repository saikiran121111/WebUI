/**
 * Browser-panel keyboard shortcuts (Browser Use, Phase 14).
 *
 * The reference desktop app wires its browser shortcuts through Electron
 * global accelerators. Ruke's panel is a DOM surface inside a web page,
 * so accelerators are not applicable [CLOSED-contract adaptation]: the
 * equivalent is a PANEL-SCOPED keydown subset — the shortcut only acts
 * while the panel owns focus, and it never claims a chord it does not
 * implement (anything else falls through to the app/browser untouched).
 *
 * This leaf is pure (no DOM, no React) so the modifier matrix is
 * unit-testable in the node vitest env. The panel passes the raw
 * KeyboardEvent fields in and performs the command the action names.
 */

export interface PanelShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What the panel should do — the panel maps each to its own handler. */
export type PanelShortcutAction =
  | "focus_omnibox"
  | "reload"
  | "new_tab"
  | "close_tab"
  | "nav_back"
  | "nav_forward";

/**
 * Ctrl/Cmd chords (primary modifier on either platform; Ctrl on
 * Windows/Linux, Cmd on macOS — same semantics the reference uses).
 * Shift-variants (Ctrl+Shift+R hard reload, Ctrl+Shift+T restore) are
 * deliberately NOT claimed: the panel has no equivalent command, so it
 * leaves the chord to the host instead of faking one.
 */
const PRIMARY_CHORDS: Record<string, PanelShortcutAction> = {
  l: "focus_omnibox",
  r: "reload",
  t: "new_tab",
  w: "close_tab",
};

/** Alt chords (navigation — matches browser back/forward convention). */
const ALT_CHORDS: Record<string, PanelShortcutAction> = {
  ArrowLeft: "nav_back",
  ArrowRight: "nav_forward",
};

/**
 * Resolve one keydown into a panel action, or null when the panel must
 * not intercept. Exact-chord law: a chord fires only when it matches
 * the required modifier set EXACTLY (no extra modifiers), so
 * Ctrl+Alt+T, Ctrl+Shift+L, bare "t" while typing, etc. all pass
 * through untouched.
 */
export function resolvePanelShortcut(ev: PanelShortcutInput): PanelShortcutAction | null {
  if (ev.shiftKey) return null;
  const primary = ev.ctrlKey || ev.metaKey;
  if (primary) {
    // Alt held alongside Ctrl/Cmd is a different chord (browser tab
    // grouping etc.) — never claim it.
    if (ev.altKey) return null;
    // Single-character keys only; key case is irrelevant once shift is
    // excluded (CapsLock aside, normalize anyway).
    const action = PRIMARY_CHORDS[ev.key.length === 1 ? ev.key.toLowerCase() : ""];
    return action ?? null;
  }
  if (ev.altKey) {
    return ALT_CHORDS[ev.key] ?? null;
  }
  return null;
}
