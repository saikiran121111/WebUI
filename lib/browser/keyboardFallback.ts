/**
 * Level-4 fallback: keyboard interaction for widgets with no usable DOM
 * targets (custom listboxes, sliders, menus). Drives the page's real
 * focus order — no coordinate guessing, no screenshots.
 *
 * Keys are validated against an allow-list so a malformed fence can never
 * inject an OS-level key chord (the press goes to page.keyboard, which is
 * browser-scoped anyway, but validation keeps the protocol honest).
 */
import type { Page } from "playwright";

const ALLOWED_KEYS = new Set([
  "Tab",
  "Enter",
  "Space",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Single printable characters are allowed (type into the focused field). */
function isAllowedKey(k: string): boolean {
  if (ALLOWED_KEYS.has(k)) return true;
  return k.length === 1 && !/[\s]/.test(k);
}

export interface KeySequenceResult {
  ok: boolean;
  pressed: string[];
  rejected?: string[];
  error?: string;
}

export async function runKeySequence(
  page: Page,
  keys: string[],
): Promise<KeySequenceResult> {
  const pressed: string[] = [];
  const rejected: string[] = [];
  for (const k of keys) {
    if (!isAllowedKey(k)) {
      rejected.push(k.slice(0, 20));
      continue;
    }
    try {
      await page.keyboard.press(k);
      pressed.push(k);
      // Let small widget re-renders settle between keys.
      await page.waitForTimeout(80);
    } catch (e) {
      return {
        ok: false,
        pressed,
        ...(rejected.length ? { rejected } : {}),
        error: String(e).slice(0, 200),
      };
    }
  }
  if (pressed.length === 0 && rejected.length > 0) {
    return { ok: false, pressed, rejected, error: "all keys rejected" };
  }
  return { ok: true, pressed, ...(rejected.length ? { rejected } : {}) };
}
