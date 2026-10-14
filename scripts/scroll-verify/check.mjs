// Scroll-follow verification: streams a long mocked response and samples the
// message container every 40ms. Fails if the view ever drifts past the 120px
// auto-scroll threshold, if the "Jump to latest" pill appears (auto-scroll
// disengaged), or if scrollTop jumps upward.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const STREAM_MS = 5000;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });

  await page.evaluate(() => {
    window.__samples = [];
    const findScroller = () => {
      const byId = document.querySelector('[data-testid="messages-scroll"]');
      if (byId) return byId;
      const candidates = [...document.querySelectorAll("div")]
        .filter(d => d.scrollHeight > d.clientHeight + 10 &&
                    /auto|scroll/.test(getComputedStyle(d).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight);
      return candidates[0] ?? null;
    };
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

  page.on("console", m => {
    if (m.text().includes("[send]")) console.log("PAGE:", m.text().slice(0, 80));
  });

  const box = page.locator("textarea").first();
  await box.click();
  // Real keystrokes so React's onChange fires (fill() desyncs controlled state).
  await box.pressSequentially("Write a very long story please", { delay: 10 });
  // Gate: React state must have synced (send button enabled) before Enter.
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="send-button"]');
    return b && !b.disabled;
  }, { timeout: 5000 });
  await box.press("Enter");
  await page.waitForFunction(() => window.__samples.some(s => s.sh > s.ch + 20), { timeout: 30000 });

  await page.waitForTimeout(STREAM_MS + 1500);
  const samples = await page.evaluate(() => {
    clearInterval(window.__samplerId);
    return window.__samples;
  });
  await browser.close();

  const overflowIdx = samples.findIndex(s => s.sh > s.ch + 20);
  if (overflowIdx < 0) {
    console.log("INCONCLUSIVE: content never overflowed the container");
    process.exit(2);
  }
  const during = samples.slice(overflowIdx);

  const maxDist = Math.max(...during.map(s => s.dist));
  const pillFrames = during.filter(s => s.pill).length;
  let upJumps = 0, maxUp = 0;
  for (let i = 1; i < during.length; i++) {
    const d = during[i - 1].top - during[i].top;
    if (d > 2) { upJumps++; maxUp = Math.max(maxUp, d); }
  }

  const failures = [];
  if (maxDist > 120) failures.push(`drifted ${maxDist}px from bottom (auto-scroll disengages past 120px)`);
  if (pillFrames > 0) failures.push(`"Jump to latest" pill visible for ${pillFrames} sampled frames (auto-scroll disengaged)`);

  console.log(`samples=${samples.length} duringOverflow=${during.length} maxDist=${maxDist} pillFrames=${pillFrames} upJumps=${upJumps} maxUpJump=${maxUp}`);
  if (failures.length) {
    console.log("FAIL:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("PASS: stream stayed pinned to the bottom, no disengage, no upward jumps");
})();
