/**
 * Owned temp-file naming for the document RENDER engines (chart HTML + chart
 * PNG). Both engines must share one root so `DOC_TEMP_DIR` really isolates
 * every render artifact (it used to be honored by pdfEngine only, which made
 * the docx engine's "no leftovers" test trivially true).
 *
 * WHY the indirection here is load-bearing, not stylistic: Next's build-time
 * dependency tracer (@vercel/nft, via `next build`) statically evaluates
 * `path.join(os.tmpdir(), \`temp_chart_${id}.png\`)` into the GLOB PATTERN
 * `<OS temp>/temp_chart_*.png` and walks that directory during the compile.
 * On Windows that walk climbs into the user profile and dies on the
 * protected `Application Data` junction (EPERM) — the production build fails
 * with `Failed to compile. Error: EPERM ... scandir`. Composing the name
 * from runtime values (a function parameter + a non-inlined prefix + a
 * helper call) keeps the tracer out of the OS temp tree while leaving the
 * runtime path byte-identical.
 */
import os from "node:os";
import path from "node:path";

const FILE_PREFIX = "temp_chart_";

/** The directory the render engines may write into (bounded, caller-owned). */
export function docTempDir(): string {
  const configured = process.env.DOC_TEMP_DIR;
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  return trimmed.length > 0 ? trimmed : os.tmpdir();
}

/** One unique render file inside `docTempDir()`. `ext` must start with ".". */
export function docTempPath(id: string, ext: string): string {
  return path.join(docTempDir(), FILE_PREFIX + id + ext);
}
