/**
 * Visible "AI is doing this" highlight inside the browser page itself.
 *
 * A fixed-position, pointer-events-none overlay div (id
 * `__ruke_ai_highlight__`) ringed around the action target with a small
 * label ("AI Click" / "AI Fill" / "AI Focus"), removed from the DOM
 * ~50 ms after insertion. Server-side action executor calls this
 * BEFORE performing each action (via the target's bounding box).
 *
 * TIMING IS A CONTRACT: the whole insert→remove cycle must complete
 * BEFORE the real action lands (the dom-basic fixture's MutationObserver
 * asserts `gone=yes` inside its click handler), but it must not waste
 * inference-loop latency — a 10-field fill_form used to burn 11+ s on
 * CSS fade waits alone, so both waits are 25 ms (50 ms total, ~22x
 * faster) while every DOM invariant stays identical.
 *
 * Guarantees: never appears in the visual-grounding screenshot (that is a
 * single transient capture taken when no action highlight is showing, and
 * this overlay is transient anyway); never shifts layout (position:
 * fixed, outside normal flow); labels NEVER contain typed values, ref
 * maps, or anything sensitive — only the fixed action word.
 */
import type { Page } from "playwright";

export type HighlightKind = "click" | "fill" | "focus" | "key";

const LABELS: Record<HighlightKind, string> = {
  click: "AI Click",
  fill: "AI Fill",
  focus: "AI Focus",
  key: "AI Key",
};

export interface HighlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Total ~50 ms per highlight (was 1,100 ms): long enough for the
// MutationObserver / rAF to observe the overlay, short enough that the
// agent loop never waits on CSS fades (see the timing contract above).
const FADE_MS = 25;
const REMOVE_WAIT_MS = 25;

/**
 * Best-effort: an unreachable/closed page must never fail the underlying
 * action, so all errors are swallowed. Coordinates are viewport-relative
 * (Playwright boundingBox), clamped to sane ranges inside the page.
 */
export async function showAiHighlight(
  page: Page,
  kind: HighlightKind,
  box: HighlightBox,
): Promise<void> {
  try {
    await page.evaluate(
      async ({ kind, x, y, w, h, fadeMs, removeWaitMs }: {
        kind: string; x: number; y: number; w: number; h: number; fadeMs: number; removeWaitMs: number;
      }) => {
        const LABELS: Record<string, string> = {
          click: "AI Click", fill: "AI Fill", focus: "AI Focus", key: "AI Key",
        };
        const ID = "__ruke_ai_highlight__";
        document.getElementById(ID)?.remove();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.max(0, Math.min(vw - 8, x));
        const top = Math.max(0, Math.min(vh - 8, y));
        const width = Math.max(8, Math.min(w || 24, vw - left));
        const height = Math.max(8, Math.min(h || 24, vh - top));

        const el = document.createElement("div");
        el.id = ID;
        el.style.cssText = [
          "position:fixed",
          `left:${left}px`,
          `top:${top}px`,
          `width:${width}px`,
          `height:${height}px`,
          "box-sizing:border-box",
          "border:3px solid #38bdf8",
          "border-radius:6px",
          "box-shadow:0 0 0 2px rgba(56,189,248,.35),0 0 18px rgba(56,189,248,.55)",
          "pointer-events:none",
          "z-index:2147483647",
          "transition:opacity .45s ease",
          "opacity:1",
        ].join(";");

        const label = document.createElement("div");
        label.textContent = LABELS[kind] ?? "AI Action";
        label.style.cssText = [
          "position:absolute",
          "left:-3px",
          "top:-22px",
          "background:#0ea5e9",
          "color:#fff",
          "font:600 12px/1.4 system-ui,sans-serif",
          "padding:2px 8px",
          "border-radius:4px",
          "white-space:nowrap",
        ].join(";");
        // Flip below when the label would clip the viewport top.
        if (top < 24) label.style.top = `${height + 6}px`;
        el.appendChild(label);
        document.body.appendChild(el);

        await new Promise((r) => setTimeout(r, fadeMs));
        el.style.opacity = "0";
        await new Promise((r) => setTimeout(r, removeWaitMs));
        el.remove();
      },
      {
        kind,
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
        fadeMs: FADE_MS,
        removeWaitMs: REMOVE_WAIT_MS,
      },
    );
  } catch {
    /* page closing/navigating — the action itself carries the outcome */
  }
}

/** Clear any lingering highlight (navigation, handoff, test cleanup). */
export async function clearAiHighlight(page: Page): Promise<void> {
  try {
    await page.evaluate(() => document.getElementById("__ruke_ai_highlight__")?.remove());
  } catch {
    /* not attached — nothing to clear */
  }
}
