import { test, expect } from "@playwright/test";

/**
 * Live-UI checks for the skill engine: the "Used skill" pill, the SkillsModal
 * (install + installed tabs, badges), and the slash-command autocomplete menu.
 * The chat round-trip is fulfilled locally so no llama.cpp is required; the
 * skills list comes from the real GET /api/skills (humanizer is installed).
 */

test.describe("skill engine UI", () => {
  test("assistant message shows the used-skill pill from X-Used-Skill", async ({ page }) => {
    const sse =
      [
        { choices: [{ delta: { content: "Humanized! " } }] },
        { choices: [{ delta: { content: "Here is the rewrite." } }] },
      ]
        .map((obj) => "data: " + JSON.stringify(obj) + "\n\n")
        .join("") + "data: [DONE]\n\n";

    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Used-Skill": "humanizer" },
        body: sse,
      })
    );

    await page.goto("/");
    const textarea = page.locator("textarea").first();
    await textarea.click();
    await textarea.fill("humanize this paragraph");
    await textarea.press("Enter");

    const pill = page.locator('[data-testid="used-skill-pill"]').first();
    await expect(pill).toBeVisible({ timeout: 15000 });
    await expect(pill).toContainText("humanizer");
  });

  test("skills modal lists the installed humanizer with its auto badge", async ({ page }) => {
    await page.goto("/");
    await page.locator('[aria-label="Skills"]').first().click();

    const modal = page.locator('[data-testid="skills-modal"]');
    await expect(modal).toBeVisible();
    await expect(page.locator('[data-testid="install-repo-input"]')).toBeVisible();

    await page.locator('[data-testid="skills-tab-installed"]').click();
    const row = page.locator('[data-testid="skill-row-humanizer"]');
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText("Auto-Scenario");
    await expect(page.locator('[data-testid="autouse-toggle-humanizer"]')).toBeVisible();
    await expect(page.locator('[data-testid="whentouse-humanizer"]')).not.toBeEmpty();
  });

  test("typing / opens the slash menu and Escape dismisses it", async ({ page }) => {
    await page.goto("/");
    const textarea = page.locator("textarea").first();
    await textarea.click();
    await textarea.fill("/");

    const menu = page.locator('[data-testid="slash-skill-menu"]');
    await expect(menu).toBeVisible({ timeout: 10000 });
    await expect(menu).toContainText("/humanizer");

    await textarea.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("Enter on a filtered slash candidate inserts the skill, not sends", async ({ page }) => {
    await page.goto("/");
    const textarea = page.locator("textarea").first();
    await textarea.click();
    await textarea.fill("/huma");

    const menu = page.locator('[data-testid="slash-skill-menu"]');
    await expect(menu).toBeVisible({ timeout: 10000 });
    await textarea.press("Enter");

    await expect(textarea).toHaveValue("/humanizer ");
    await expect(menu).toHaveCount(0);
  });
});
