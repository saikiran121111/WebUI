import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:3000";

async function waitForStreamDone(page: Page) {
  await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 60000 });
}

test("inspect what 3 matches are", async ({ page }) => {
  const original = "E2EInspect" + Date.now();
  await page.goto(BASE + "/");

  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(original);
  await box.press("Enter");
  await waitForStreamDone(page);

  // What elements contain this text?
  const matches = await page.evaluate((text) => {
    const all = Array.from(document.querySelectorAll("*"));
    const found = all.filter((el: any) => el.innerText === text && el.children.length === 0);
    return found.map((el: any) => ({
      tag: el.tagName,
      className: el.className,
      parent: el.parentElement?.className,
      grandparent: el.parentElement?.parentElement?.className,
    }));
  }, original);
  console.log("=== Leaf elements with exact text:", JSON.stringify(matches, null, 2));

  // Get all parent containers up the tree
  const containers = await page.evaluate((text) => {
    const all = Array.from(document.querySelectorAll("*"));
    const found = all.filter((el: any) => el.textContent === text);
    return found.map((el: any) => ({
      tag: el.tagName,
      className: el.className,
    }));
  }, original);
  console.log("=== Exact match containers:", JSON.stringify(containers, null, 2));
});