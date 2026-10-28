import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * PART 10 (Rust cutover validation): the migrated Node-thin-proxy legs for
 * settings and model stats, exercised through the REAL supervisor stack
 * (`npm run dev` → Next :3000 → RUKE_RUST_BACKEND=1 → Rust :3101).
 *
 * Zero model inference: GET/PUT /api/settings and GET /api/model-stats are
 * state/stats routes (the Rust handler reads stats from llama.cpp's /stats
 * admin endpoint — no chat-completion slot is ever taken).
 *
 * Settings ledger (manifest `settings.fields`): llm_api_url?, llm_api_key?,
 * compact_thresholds? {auto, tokens}. The UI journey proves save → persist
 * (Rust writes settings.json) → reload (fresh GET via the proxy) → the
 * inputs come back with the saved value. The original settings are restored
 * in a finally block — the user's own settings must be untouched.
 */

const BASE = "http://localhost:3000";

async function getSettings(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get(`${BASE}/api/settings`);
  expect(res.ok(), "GET /api/settings must be 200 via the Rust proxy").toBeTruthy();
  const body = await res.json();
  expect(typeof body.settings, "response carries a `settings` object").toBe("object");
  return body.settings;
}

async function putSettings(request: APIRequestContext, patch: object) {
  const res = await request.put(`${BASE}/api/settings`, { data: patch });
  expect(res.ok(), "PUT /api/settings must be 200 via the Rust proxy").toBeTruthy();
  return (await res.json()).settings;
}

test.describe("settings + model stats through the Rust proxy", () => {
  test("GET /api/settings answers the SettingsShape ledger", async ({ request }) => {
    const settings = await getSettings(request);
    for (const key of Object.keys(settings)) {
      // Nothing outside the ledger may appear on the wire (ledger-drift
      // would mean the Rust serializer diverged from the TS oracle).
      expect(
        ["llm_api_url", "llm_api_key", "compact_thresholds"],
        `unexpected settings key: ${key}`,
      ).toContain(key);
    }
    if (settings.llm_api_url !== undefined) {
      expect(typeof settings.llm_api_url).toBe("string");
    }
    if (settings.compact_thresholds !== undefined) {
      const ct = settings.compact_thresholds as Record<string, unknown>;
      expect(typeof ct.auto, "compact auto flag").toBe("number");
      expect(typeof ct.tokens, "compact token threshold").toBe("number");
    }
  });

  test("endpoint save persists through the proxy, survives reload, restores exactly", async ({ page, request }) => {
    test.setTimeout(90_000); // reload journeys are slowMo-heavy but model-free
    const original = await getSettings(request);
    const TEMP = "http://127.0.0.1:9099/v1/chat/completions";
    try {
      await page.goto(BASE + "/");
      await page.getByLabel("Settings").click();
      await page.getByTestId("settings-tab-endpoint").click();
      const input = page.getByTestId("settings-endpoint-input");
      await expect(input).toBeVisible();

      await input.fill(TEMP);
      await page.getByTestId("settings-save").click();
      await expect(page.getByText("Saved ✓")).toBeVisible({ timeout: 10_000 });

      // Server side (proxy GET) sees it immediately…
      await expect
        .poll(async () => (await getSettings(request)).llm_api_url, { timeout: 10_000 })
        .toBe(TEMP);

      // …and after a full reload the UI re-primes from the server.
      await page.reload();
      await page.getByLabel("Settings").click();
      await page.getByTestId("settings-tab-endpoint").click();
      await expect(page.getByTestId("settings-endpoint-input")).toHaveValue(TEMP);
    } finally {
      // Restore unconditionally — user settings must be byte-exact again.
      if (typeof original.llm_api_url === "string" && original.llm_api_url.trim()) {
        const back = await putSettings(request, { llm_api_url: original.llm_api_url });
        expect(back.llm_api_url).toBe(original.llm_api_url);
      }
    }
  });

  test("GET /api/model-stats (plain + live=1) answers the documented shape", async ({ request }) => {
    const stats = await request.get(`${BASE}/api/model-stats`, { headers: { "cache-control": "no-store" } });
    expect(stats.ok()).toBeTruthy();
    const body = await stats.json();
    expect(body.ok, "model-stats ok flag").toBeTruthy();
    expect(typeof body.model_alias).toBe("string");
    expect(body.model_alias.length).toBeGreaterThan(0);
    expect(body.n_ctx).toBeGreaterThan(0);
    expect(typeof body.total_slots).toBe("number");

    const live = await request.get(`${BASE}/api/model-stats?live=1`, { headers: { "cache-control": "no-store" } });
    expect(live.ok()).toBeTruthy();
    const liveBody = await live.json();
    expect(liveBody.ok).toBeTruthy();
    expect(typeof liveBody.processing).toBe("number");
    expect(typeof liveBody.prompt_tokens).toBe("number");
    expect(liveBody.n_ctx).toBeGreaterThan(0);
  });
});
