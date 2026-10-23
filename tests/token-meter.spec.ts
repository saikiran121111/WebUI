import { test, expect, Page, APIRequestContext } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Composer footer token meter ("Speed: 42.50 tk/s · Context: 4542/100000").
 *
 * Model-free by design: the shared inference backend is never touched.
 *   • POST /api/chat is rewritten (route.continue) to a paced fake SSE
 *     upstream that ends with a real-shaped usage+timings frame — exactly
 *     what llama.cpp emits with stream_options.include_usage.
 *   • GET /api/model-stats (+?live=1) is fulfilled with canned JSON in the
 *     exact shape app/api/model-stats/route.ts returns.
 * The hook, endpoint contract, formatters, and wiring under test are all
 * real app code. Same mock pattern as tests/auto-compact.spec.ts.
 *
 * NOTE: this spec never writes /api/settings (compact_thresholds and every
 * other user setting must stay untouched).
 */

const BASE = "http://localhost:3000";
const METER = '[data-testid="token-meter"]';

const FAKE_MAX_CTX = 100000;      // /props n_ctx substitute
const FAKE_LIVE_PROMPT = 3000;    // /slots n_prompt_tokens substitute
const FAKE_USAGE = { prompt_tokens: 4000, completion_tokens: 542, total_tokens: 4542 };
const FAKE_TIMINGS = { prompt_n: 4000, predicted_n: 542, predicted_per_second: 42.5 };

const REPLY_TEXT = "A live meter test reply. "; // 26 chars
const REPLY_REPEATS = 14;                       // 364 chars ≈ 91 est. tokens

function startMeterUpstream(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      // setTimeout pacing + liveness guard (NOT req.on("close") inside
      // req.on("end")) — see auto-compact.spec.ts for the gotcha.
      const timers: NodeJS.Timeout[] = [];
      const alive = () => !res.writableEnded && !res.destroyed;
      let wait = 80;
      const full = REPLY_TEXT.repeat(REPLY_REPEATS);
      for (let i = 0; i < full.length; i += 52) {
        const chunk = full.slice(i, i + 52);
        timers.push(setTimeout(() => {
          if (alive()) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }, wait));
        wait += 420; // ~3.8 s stream → several 1 Hz live-poll ticks
      }
      // Server-measured usage frame (exact numbers the meter must land on).
      timers.push(setTimeout(() => {
        if (alive()) res.write(`data: ${JSON.stringify({ usage: FAKE_USAGE, timings: FAKE_TIMINGS })}\n\n`);
      }, wait + 100));
      timers.push(setTimeout(() => {
        if (alive()) { res.write("data: [DONE]\n\n"); res.end(); }
      }, wait + 400));
      res.on("close", () => timers.forEach(clearTimeout));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })
    );
  });
}

async function setupRoutes(page: Page, upstreamPort: number) {
  await page.route("**/api/chat", (route) =>
    void route.continue({ url: `http://127.0.0.1:${upstreamPort}/chat` })
  );
  await page.route((url) => url.pathname === "/api/model-stats", (route) => {
    const live = route.request().url().includes("live=1");
    const payload = live
      ? { ok: true, processing: true, prompt_tokens: FAKE_LIVE_PROMPT, n_ctx: FAKE_MAX_CTX }
      : { ok: true, model_alias: "fake-meter-model", n_ctx: FAKE_MAX_CTX, total_slots: 1 };
    void route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function meterText(page: Page): Promise<string> {
  return ((await page.locator(METER).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
}

test.describe("composer token meter (Speed tk/s · Context)", () => {
  test.setTimeout(90_000);

  let upstream: { port: number; close: () => void };

  test.beforeAll(async () => { upstream = await startMeterUpstream(); });
  test.afterAll(async () => { upstream.close(); });

  test("shows max context, updates live during generation, lands exact server numbers after", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await setupRoutes(page, upstream.port);
    await page.goto(BASE);
    await page.waitForSelector("textarea", { timeout: 15_000 });

    // Empty chat = hero composer, which has no meta row → no meter.
    await expect(page.locator(METER)).toHaveCount(0);

    await page.locator("textarea").first().fill("ping the meter");
    await page.locator("textarea").first().press("Enter");

    // Bar composer mounts with the first message → meter appears.
    await expect(page.locator(METER)).toBeVisible({ timeout: 10_000 });

    // Max context must come from /api/model-stats (never hardcoded).
    let text = await meterText(page);
    expect(text).toContain(`/${FAKE_MAX_CTX}`);

    // Mid-stream: the live endpoint's exact prompt size (3000) plus at most
    // ~91 measured output tokens from the 364-char stream → 3000..3100 band.
    await expect
      .poll(
        async () => {
          const m = /Context: (\d+)\/100000/.exec(await meterText(page));
          if (!m) return -1;
          const used = Number(m[1]);
          return used >= FAKE_LIVE_PROMPT && used <= FAKE_LIVE_PROMPT + 100 ? used : -1;
        },
        { timeout: 15_000, intervals: [400] }
      )
      .toBeGreaterThan(-1);

    // Provenance tooltip is honest mid-stream, too.
    expect(await page.locator(METER).first().getAttribute("title")).toBeTruthy();

    // After the usage frame: EXACT server numbers — 42.5 → "42.50",
    // 4000 prompt + 542 completion = 4542 used.
    await expect
      .poll(() => meterText(page), { timeout: 20_000, intervals: [500] })
      .toBe("Speed: 42.50 tk/s · Context: 4542/100000");

    expect(await page.locator(METER).first().getAttribute("title")).toContain("inference server");
  });
});
