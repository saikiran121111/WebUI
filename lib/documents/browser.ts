/**
 * Shared headless Chromium singleton for document rendering (PDF export,
 * DOCX chart screenshots). Browser binaries live in-repo at
 * .data/ms-playwright — the env var MUST be set before playwright resolves
 * its registry, hence the dynamic import.
 */
import path from "node:path";
import type { Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(process.cwd(), ".data", "ms-playwright");
    browserPromise = import("playwright")
      .then(({ chromium }) => chromium.launch({ headless: true }))
      .catch((e) => {
        browserPromise = null; // allow retry after a failed launch
        throw e;
      });
  }
  return browserPromise;
}
