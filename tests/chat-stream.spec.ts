import { test, expect } from "@playwright/test";

test.describe("chat streaming", () => {
  test("receives content after reasoning", async ({ page }) => {
    const logs: string[] = [];
    const errors: string[] = [];

    page.on("console", msg => {
      const text = msg.text();
      logs.push(text);
      if (msg.type() === "error" || msg.type() === "warning") errors.push(text);
    });

    page.on("pageerror", err => errors.push(err.message));

    await page.goto("http://localhost:3000/");
    await page.waitForTimeout(2000);

    // Type a message
    const textarea = page.locator("textarea").first();
    await textarea.click();
    await textarea.fill("Hey");

    // Submit
    await textarea.press("Enter");

    // Wait up to 30s for streaming to complete
    const start = Date.now();
    const TIMEOUT = 30000;

    // Collect the "Reasoning" label changes and content updates
    let contentText = "";
    let reasoningText = "";

    // Poll for content appearing
    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(200);

      // Check for error toast
      const errorEl = page.locator('[data-testid="error"]');
      if (await errorEl.isVisible({ timeout: 200 }).catch(() => false)) {
        console.log("ERROR VISIBLE:", await errorEl.innerText());
      }

      // Grab current state
      const bubbles = page.locator('[class*="message"], [class*="bubble"]');
      const count = await bubbles.count();

      // Check reasoning panel
      const reasoningEl = page.locator('text=THINKING').first();
      if (await reasoningEl.isVisible({ timeout: 100 }).catch(() => false)) {
        const parent = reasoningEl.locator("xpath=ancestor::*[contains(@class,'reasoning') or contains(@class,'think') or contains(@class,'border')]");
      }

      // Get all text content visible on page
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log(`[t=${Date.now()-start}ms] ${JSON.stringify(bodyText.slice(-200))}`);

      // Check if we have a complete assistant message (not just streaming)
      const hasCompleteAssistant = await page.locator('[data-state="complete"]').count();
      const isStreaming = await page.locator('[data-status="streaming"]').count();

      if (bodyText.includes("Local Intelligence") === false && bodyText.length > 500) {
        // Page has chat content, check if reasoning cleared
        if (bodyText.includes("THINKING") || bodyText.includes("Reasoning:")) {
          // Still thinking — that's OK if streaming is active
          if (Date.now() - start > 8000) {
            console.log("STUCK in reasoning after 8s");
            break;
          }
        } else {
          console.log("Reasoning cleared — response complete");
          break;
        }
      }

      if (Date.now() - start > TIMEOUT) {
        console.log("TIMEOUT after 30s");
        break;
      }
    }

    console.log("=== PAGE TITLE:", await page.title());
    const finalText = await page.evaluate(() => document.body.innerText);
    console.log("=== FINAL BODY TEXT (last 500 chars):", JSON.stringify(finalText.slice(-500)));
    console.log("=== CONSOLE LOGS:", JSON.stringify(logs));
    console.log("=== ERRORS:", JSON.stringify(errors));
  });

  test("direct API call to /api/chat", async ({ request }) => {
    // First check what the API actually returns
    const resp = await request.post("http://localhost:3000/api/chat", {
      headers: { "Content-Type": "application/json" },
      data: {
        model: "test",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      },
    });

    console.log("Status:", resp.status());
    const body = await resp.text();
    console.log("Body (first 1000 chars):", body.slice(0, 1000));
    console.log("Body length:", body.length);

    // Check if it's a proper SSE stream
    if (body.includes("data:")) {
      const lines = body.split("\n").filter(l => l.startsWith("data:"));
      console.log("Number of SSE events:", lines.length);
      lines.slice(0, 5).forEach(l => console.log("  Event:", l.slice(0, 100)));
      lines.slice(-3).forEach(l => console.log("  Last event:", l.slice(0, 100)));
    }
  });
});
