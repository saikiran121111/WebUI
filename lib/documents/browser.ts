/**
 * Shared headless Chromium singleton for document rendering (PDF export,
 * DOCX chart screenshots). Browser binaries live in-repo at
 * .data/ms-playwright — the env var MUST be set before playwright resolves
 * its registry, hence the dynamic import.
 *
 * F21: the singleton is now an OWNED resource (lib/lifecycle/ownedResource.ts)
 * instead of a bare promise. The old shape had two lifecycle holes:
 *  - `browserPromise` was only cleared when a LAUNCH failed. A browser that
 *    crashed or was closed later kept being handed out, so every subsequent
 *    export failed against a dead handle for the life of the process.
 *  - Chromium stayed resident forever (hundreds of MB) after the last export.
 * Callers must now go through `withRenderBrowser`, which holds a lease for the
 * whole render, so the idle TTL can never fire underneath a running export.
 *
 * Idle TTL is operator-configurable: DOC_BROWSER_IDLE_MS=<ms> overrides it,
 * 0/off releases as soon as an export finishes (memory pressure), and
 * `never` keeps the old always-resident behaviour.
 */
import path from "node:path";
import type { Browser } from "playwright";
import { OwnedResource, parseIdleTtl, type OwnedResourceEvent } from "../lifecycle/ownedResource";

export const DOC_BROWSER_IDLE_MS = parseIdleTtl(process.env.DOC_BROWSER_IDLE_MS, 120_000);

function onBrowserEvent(event: OwnedResourceEvent): void {
  // Telemetry only — a failed render must surface as the export's own error.
  import("../server/logger")
    .then(({ childLogger }) => {
      childLogger("documents/browser").debug(
        { resource: event.name, kind: event.kind, reason: event.reason, failures: event.failures },
        "document render browser lifecycle",
      );
    })
    .catch(() => {
      /* logging must never own the failure path */
    });
}

export const renderBrowser = new OwnedResource<Browser>({
  name: "document-browser",
  idleTtlMs: DOC_BROWSER_IDLE_MS,
  create: async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(process.cwd(), ".data", "ms-playwright");
    const { chromium } = await import("playwright");
    return chromium.launch({ headless: true });
  },
  destroy: (browser) => browser.close(),
  onCreated: (browser) => {
    // Disconnect (crash, manual close, OOM kill) drops the slot immediately:
    // the next export starts a fresh browser instead of reusing a dead one.
    browser.on("disconnected", () => renderBrowser.discard("browser disconnected"));
  },
  onEvent: onBrowserEvent,
});

/**
 * The only supported way to touch the render browser: one lease for the whole
 * operation, released on every outcome (success, throw, cancellation).
 */
export function withRenderBrowser<R>(fn: (browser: Browser) => Promise<R> | R): Promise<R> {
  return renderBrowser.use(fn);
}

/** Capability reporting without launching anything (is Chromium resident?). */
export function documentBrowserState() {
  return renderBrowser.state();
}

/** Reclaim Chromium now, if nothing is rendering (memory pressure / tests). */
export function releaseDocumentBrowser(): Promise<boolean> {
  return renderBrowser.releaseIdle({ force: true });
}

/** Shutdown hook: close the owned browser exactly once. */
export function closeDocumentBrowser(): Promise<void> {
  return renderBrowser.close();
}
