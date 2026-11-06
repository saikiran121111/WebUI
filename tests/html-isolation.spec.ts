import { test, expect, type Page } from "@playwright/test";

/**
 * AUDIT FINDING 6 (2026-11-06) — HTML artifact preview isolation + fullscreen
 * fallback. Deterministic: the ```html fence arrives through a mocked SSE stream
 * with x-decision-mode:html_render (zero model traffic, zero inference load), so
 * the run is fully reproducible and safe to re-run in a fix loop.
 *
 * The vulnerability: a srcDoc iframe inherits its parent's origin, and the
 * viewer ran sandbox="allow-scripts allow-same-origin" — so MODEL HTML had the
 * app's own origin (parent DOM, cookies, storage, authenticated API reads).
 * These tests plant canaries on the app origin and prove from INSIDE the frame
 * that none of them are reachable, that the storage shim keeps interactive
 * artifacts working without touching the app origin, and that the Fullscreen
 * button's documented CSS fallback actually applies (it used to be dead code).
 */

const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';

async function mockStream(page: Page, content: string, decisionMode: string): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    const frames: string[] = [];
    const chunk = 96;
    for (let i = 0; i < content.length; i += chunk) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + chunk) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-decision-mode": decisionMode },
      body: frames.join(""),
    });
  });
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout: 20_000 });
}

/**
 * Artifact that reports what it CAN reach, from inside the sandboxed frame.
 * The `<div id="r">` root is load-bearing for the fixture, not for the finding:
 * isBrokenHtmlFence (lib/documents/schemas.ts) treats an html fence with no
 * recognizable root element (`div|html|body|h1|p|canvas|button|…`) as a fence
 * that is still streaming, and the viewer shows its "spec incomplete" status
 * instead of mounting the iframe. A `<pre>`-only body trips that heuristic.
 */
const PROBE_ARTIFACT = [
  '<div id="r">probing</div>',
  "<script>",
  "function set(k,v){var d=document.createElement('div');d.id='v-'+k;d.textContent=k+'='+v;",
  "document.getElementById('r').appendChild(d);}",
  "try{set('parentdoc',parent.document.body?'REACHABLE':'REACHABLE')}catch(e){set('parentdoc','BLOCKED')}",
  "try{set('parentloc',parent.location.href)}catch(e){set('parentloc','BLOCKED')}",
  "try{set('pstorage',String(parent.localStorage.getItem('app_canary')))}catch(e){set('pstorage','BLOCKED')}",
  "try{set('ownstore',String(localStorage.getItem('app_canary')))}catch(e){set('ownstore','THREW:'+e.name)}",
  "try{set('cookie',document.cookie.length?'HAS_COOKIES':'NO_COOKIES')}catch(e){set('cookie','BLOCKED')}",
  "try{set('fs',!!document.fullscreenEnabled)}catch(e){set('fs','BLOCKED')}",
  "fetch('/api/conversations').then(function(r){return r.text()}).then(function(t){",
  "set('api',t.length>4?'READABLE_'+t.length:'EMPTY')}).catch(function(){set('api','BLOCKED')});",
  "<\/script>",
].join("\n");

test("finding 6: the artifact frame runs in an opaque origin, not the app origin", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockStream(page, "```html\n" + PROBE_ARTIFACT + "\n```", "html_render");
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("app_canary", "APP_ORIGIN_SECRET"));
  await send(page, "html artifact that reports what it can reach");

  const block = page.locator('[data-testid="html-artifact-block"]');
  await expect(block).toBeVisible();
  const iframe = block.locator("iframe");

  // The attribute contract itself.
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const sandbox = await iframe.getAttribute("sandbox");
  expect(sandbox ?? "").not.toContain("allow-same-origin");

  // Origin as the frame itself reports it: opaque, not http://localhost:3000.
  const handle = await iframe.elementHandle();
  const raw = handle ? await handle.contentFrame() : null;
  expect(raw, "the artifact iframe never attached").not.toBeNull();
  const origin = await raw!.evaluate(() => window.origin);
  expect(origin).toBe("null");

  // Every canary answer comes from inside the frame.
  const inner = iframe.contentFrame();
  await expect(inner.locator("#v-parentdoc")).toHaveText("parentdoc=BLOCKED", { timeout: 10_000 });
  await expect(inner.locator("#v-parentloc")).toHaveText("parentloc=BLOCKED");
  await expect(inner.locator("#v-pstorage")).toHaveText("pstorage=BLOCKED");
  // The app's own localStorage entry is invisible: the shim answers null, it
  // never throws (that would break real artifacts) and never leaks the value.
  await expect(inner.locator("#v-ownstore")).toHaveText("ownstore=null");
  // The cookie jar is not merely empty — ACCESS IS DENIED. In a sandboxed frame
  // without allow-same-origin the `document.cookie` getter throws SecurityError,
  // so the frame cannot even enumerate (let alone send) the app's cookies. The
  // probe reports BLOCKED precisely because the throw happened; HAS_COOKIES or a
  // readable empty string would both mean the grant came back.
  await expect(inner.locator("#v-cookie")).toHaveText("cookie=BLOCKED");
  // The artifact cannot read the app's authenticated API as the user.
  await expect(inner.locator("#v-api")).toHaveText(/api=(BLOCKED|EMPTY)/, { timeout: 15_000 });
  // Model HTML may NOT take the user's whole screen: a nested document gets the
  // Fullscreen API only when the embedding element grants it, and this iframe
  // grants none — it had no allowFullScreen before the repair either, so this
  // capability is unchanged, just now pinned. The viewer's own Fullscreen button
  // lives in the chat page (parent document) and is covered by the three tests
  // below, native and fallback paths included.
  await expect(inner.locator("#v-fs")).toHaveText("fs=false", { timeout: 10_000 });

  // And the app itself is untouched by the isolation.
  expect(await page.evaluate(() => window.localStorage.getItem("app_canary"))).toBe("APP_ORIGIN_SECRET");
  expect(errors.filter((e) => /SecurityError|Access denied/i.test(e))).toEqual([]);
});

test("finding 6: an artifact can still remember its own state, off the app origin", async ({ page }) => {
  const artifact = [
    '<button id="go">save</button><div id="out">none</div>',
    "<script>",
    "var n=0;",
    "function save(){try{localStorage.setItem('artifact_note','v'+(++n));sessionStorage.setItem('sess','s'+n);",
    "document.getElementById('out').textContent='saved:'+localStorage.getItem('artifact_note')+':'+sessionStorage.getItem('sess');",
    "}catch(e){document.getElementById('out').textContent='THREW:'+e.name}}",
    "document.getElementById('go').addEventListener('click',save);save();",
    "<\/script>",
  ].join("\n");
  await mockStream(page, "```html\n" + artifact + "\n```", "html_render");
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("app_canary", "APP_ORIGIN_SECRET"));
  await send(page, "html artifact that saves its own state");

  const frame = page.locator('[data-testid="html-artifact-block"] iframe').contentFrame();
  await expect(frame.locator("#out")).toHaveText("saved:v1:s1", { timeout: 10_000 });
  await frame.locator("#go").click();
  await expect(frame.locator("#out")).toHaveText("saved:v2:s2");

  // Nothing crossed into the app origin.
  const appKeys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(appKeys).not.toContain("artifact_note");
  expect(appKeys).not.toContain("sess");
  expect(await page.evaluate(() => window.localStorage.getItem("app_canary"))).toBe("APP_ORIGIN_SECRET");
});

/** Click Fullscreen and report what actually happened, per mode. */
async function fullscreenOutcome(page: Page) {
  const block = page.locator('[data-testid="html-artifact-block"]');
  await expect(block.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
  await block.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect(block).toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });
  await expect(block.getByRole("button", { name: /exit fullscreen/i })).toBeVisible();
  await expect(block.getByText("Press Esc to exit")).toBeVisible();

  await expect
    .poll(
      () =>
        block.locator(".html-artifact-frame").evaluate((el) => {
          const native = document.fullscreenElement !== null;
          return native || el.clientHeight >= window.innerHeight * 0.9 ? "filled" : "small:" + el.clientHeight;
        }),
      { message: "fullscreen never enlarged the viewer frame", timeout: 5_000 },
    )
    .toBe("filled");
  return block;
}

test("finding 6: native fullscreen fills the frame and exits on the second click", async ({ page }) => {
  await mockStream(page, "```html\n<h1 style='color:#fff'>fs probe</h1>\n```", "html_render");
  await page.goto("/");
  await send(page, "fullscreen this html artifact");
  const block = await fullscreenOutcome(page);
  const native = await page.evaluate(() => document.fullscreenElement !== null);
  await block.getByRole("button", { name: /exit fullscreen/i }).click();
  await expect(block).not.toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });
  await expect(block.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
  // In a real browser this turn uses the native API; the CSS mode is covered by
  // the two tests below. Either way the exit click must clear the state.
  test.info().annotations.push({ type: "mode", description: native ? "native" : "css-fallback" });
});

test("finding 6: when requestFullscreen is denied, the CSS fallback applies and Esc exits", async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = function () {
      return Promise.reject(new Error("blocked by policy in this test"));
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockStream(page, "```html\n<h1 style='color:#fff'>denied fs probe</h1>\n```", "html_render");
  await page.goto("/");
  await send(page, "fullscreen this html artifact");
  const block = await fullscreenOutcome(page);

  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });

  // Re-enter, then exit with the same button (the fallback used to have no exit).
  await block.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect(block).toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });
  await block.getByRole("button", { name: /exit fullscreen/i }).click();
  await expect(block).not.toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("finding 6: when requestFullscreen is absent, the button still works (no TypeError)", async ({ page }) => {
  await page.addInitScript(() => {
    delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockStream(page, "```html\n<h1 style='color:#fff'>no fs api probe</h1>\n```", "html_render");
  await page.goto("/");
  await send(page, "fullscreen this html artifact");
  const block = await fullscreenOutcome(page);
  await page.keyboard.press("Escape");
  await expect(block).not.toHaveClass(/html-artifact--fullscreen/, { timeout: 5_000 });
  // The old code chained .then() on undefined → uncaught TypeError per click.
  expect(errors).toEqual([]);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => document.exitFullscreen().catch(() => undefined)).catch(() => undefined);
});
