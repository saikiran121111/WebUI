/**
 * Phase 14 — panel keyboard shortcut matrix (lib/browser-client/
 * panelShortcuts.ts). Pins the exact-chord law: only the implemented
 * chords resolve, anything with an extra modifier or a bare key falls
 * through so the panel never fakes a browser shortcut.
 */
import { describe, it, expect } from "vitest";
import {
  resolvePanelShortcut,
  type PanelShortcutInput,
} from "../lib/browser-client/panelShortcuts";

function key(
  keyName: string,
  mods: Partial<Pick<PanelShortcutInput, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {},
): PanelShortcutInput {
  return {
    key: keyName,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

describe("resolvePanelShortcut — claimed chords", () => {
  it("focuses the omnibox on Ctrl+L and Cmd+L", () => {
    expect(resolvePanelShortcut(key("l", { ctrlKey: true }))).toBe("focus_omnibox");
    expect(resolvePanelShortcut(key("L", { metaKey: true }))).toBe("focus_omnibox");
  });

  it("reloads on Ctrl+R / Cmd+R", () => {
    expect(resolvePanelShortcut(key("r", { ctrlKey: true }))).toBe("reload");
    expect(resolvePanelShortcut(key("r", { metaKey: true }))).toBe("reload");
  });

  it("opens a tab on Ctrl+T / Cmd+T", () => {
    expect(resolvePanelShortcut(key("t", { ctrlKey: true }))).toBe("new_tab");
    expect(resolvePanelShortcut(key("t", { metaKey: true }))).toBe("new_tab");
  });

  it("closes a tab on Ctrl+W / Cmd+W", () => {
    expect(resolvePanelShortcut(key("w", { ctrlKey: true }))).toBe("close_tab");
    expect(resolvePanelShortcut(key("w", { metaKey: true }))).toBe("close_tab");
  });

  it("navigates with bare Alt+Arrow chords", () => {
    expect(resolvePanelShortcut(key("ArrowLeft", { altKey: true }))).toBe("nav_back");
    expect(resolvePanelShortcut(key("ArrowRight", { altKey: true }))).toBe("nav_forward");
  });
});

describe("resolvePanelShortcut — never claims what it does not implement", () => {
  it("bare keys while typing pass through", () => {
    for (const k of ["l", "r", "t", "w", "a", "ArrowLeft", "ArrowRight", "Enter", " "]) {
      expect(resolvePanelShortcut(key(k))).toBeNull();
    }
  });

  it("shift-variants are left to the host (no hard-reload / restore-tab fake)", () => {
    expect(resolvePanelShortcut(key("r", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolvePanelShortcut(key("T", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(resolvePanelShortcut(key("L", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("alt alongside a primary modifier is a different chord", () => {
    expect(resolvePanelShortcut(key("t", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolvePanelShortcut(key("l", { metaKey: true, altKey: true }))).toBeNull();
  });

  it("alt+arrow with another modifier passes through", () => {
    expect(resolvePanelShortcut(key("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(resolvePanelShortcut(key("ArrowLeft", { altKey: true, shiftKey: true }))).toBeNull();
  });

  it("unclaimed ctrl/cmd chords pass through (Ctrl+P, Ctrl+D, Ctrl+S…)", () => {
    for (const k of ["p", "d", "s", "n", "q", "F5"]) {
      expect(resolvePanelShortcut(key(k, { ctrlKey: true }))).toBeNull();
      expect(resolvePanelShortcut(key(k, { metaKey: true }))).toBeNull();
    }
  });

  it("multi-key non-chords are not mistaken for single letters", () => {
    expect(resolvePanelShortcut(key("F", { ctrlKey: true }))).toBeNull();
    expect(resolvePanelShortcut(key("Escape", { ctrlKey: true }))).toBeNull();
  });
});
