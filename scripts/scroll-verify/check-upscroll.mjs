// Free-scroll verification: mid-stream, wheel up a SMALL amount (60px — the old
// 120px dead zone re-pinned anything closer) and assert the view stays where the
// user put it: no downward yank-back, distance grows as content streams, and the
// "Jump to latest" pill appears. Companion to check.mjs (auto-follow proof).
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });

  await page.evaluate(() => {
    window.__samples = [];
    const findScroller = () => document.querySelector('[data-testid="messages-scroll"]');
    window.__samplerId = setInterval(() => {
      const c = findScroller();
      if (!c) return;
      const pill = [...document.querySelectorAll("button")]
        .some(b => (b.textContent || "").includes("Jump to latest"));
      window.__samples.push({
        t: Date.now(),
        dist: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight),
        top: Math.round(c.scrollTop),
        sh: c.scrollHeight,
        ch: c.clientHeight,
        pill,
      });
    }, 40);
  });

  const box = page.locator("textarea").first();
  await box.click();
  await box.pressSequentially("Write a very long story please", { delay: 10 });
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="send-button"]');
    return b && !b.disabled;
  }, { timeout: 5000 });
  await box.press("Enter");
  await page.waitForFunction(() => window.__samples.some(s => s.sh > s.ch + 20), { timeout: 30000 });

  await page.waitForTimeout(1200);
  const wheelAt = await page.evaluate(() => window.__samples.length);
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(2500);

  const samples = await page.evaluate(() => {
    clearInterval(window.__samplerId);
    return window.__samples;
  });
  await browser.close();

  const after = samples.slice(wheelAt);
  if (after.length < 20) { console.log("INCONCLUSIVE: too few samples after wheel"); process.exit(2); }

  let downYanks = 0, maxDown = 0;
  for (let i = 1; i < after.length; i++) {
    const d = after[i].top - after[i - 1].top;
    if (d > 20) { downYanks++; maxDown = Math.max(maxDown, d); }
  }
  const settled = after.slice(10);
  const minDist = Math.min(...settled.map(s => s.dist));
  const pillFrames = after.filter(s => s.pill).length;

  const failures = [];
  if (downYanks > 0) failures.push(`view yanked back down ${downYanks}x (max ${maxDown}px) after wheel-up`);
  if (minDist < 40) failures.push(`view re-pinned: min distance after wheel was only ${minDist}px`);
  if (pillFrames === 0) failures.push('"Jump to latest" pill never appeared after wheel-up');

  console.log(`afterWheelSamples=${after.length} downYanks=${downYanks} maxDown=${maxDown} minDist=${minDist} pillFrames=${pillFrames}`);
  if (failures.length) {
    console.log("FAIL:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("PASS: 60px wheel-up mid-stream unpinned and stayed free — no yank-back");
})();
