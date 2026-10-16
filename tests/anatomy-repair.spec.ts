import { test, expect, type Page } from "@playwright/test";

/**
 * Anatomy fence auto-repair e2e. The model's first reply carries a broken
 * ```anatomy fence; the app must silently feed the exact validation error
 * back to the model and splice the corrected fence into the SAME bubble —
 * the user sees the finished illustration, never a validation error.
 */

const VALID_BODY = JSON.stringify({
  title: "Single-cylinder head",
  fig: "FIG 1",
  label: "Cutaway single-cylinder head with a sliding piston",
  width: 560,
  height: 420,
  parts: [
    { id: "deck", tone: "base", kind: "slab", plan: { x: -40, y: -30, w: 80, d: 60, r: 6 }, z: 0, height: 14, label: "Deck" },
    { id: "barrel", tone: "structure", kind: "cylinder", center: [0, 0], r: 22, z: 14, height: 46, label: "Barrel", on: "deck" },
    { id: "piston", tone: "subject", kind: "cylinder", center: [0, 0], r: 20, z: 18, height: 16, label: "Piston", on: "deck", slide: { axis: "z", from: 2, to: 26, state: "stroke" } },
    { id: "plug", tone: "accent", kind: "cylinder", center: [0, 0], r: 3, z: 60, height: 8, label: "Plug", on: "deck" },
  ],
  controls: [{ id: "stroke", kind: "slider", label: "Piston position", min: 0, max: 1, step: 0.01, value: 0.5 }],
  readouts: [{ id: "pos", label: "Piston height", unit: "mm", decimals: 1, formula: "18 + 24 * stroke" }],
  explode: { label: "Explode" },
  export: { filename: "repair-head" },
});

// The user's real-world failure mode: a dropped colon inside the fence.
const BROKEN_BODY = VALID_BODY.replace('"r":22', '"r" 22');

async function mockReplies(page: Page, replies: string[]) {
  const requests: any[] = [];
  let calls = 0;
  await page.route("**/api/chat", async (route) => {
    requests.push(route.request().postDataJSON());
    const content = replies[Math.min(calls, replies.length - 1)];
    calls++;
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += 14) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 14) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: frames.join("") });
  });
  return { requests, calls: () => calls };
}

async function sendPrompt(page: Page, text: string) {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

test("a broken anatomy fence is silently repaired and the figure renders", async ({ page }) => {
  const brokenReply = "Here is the cutaway:\n\n```anatomy\n" + BROKEN_BODY + "\n```\n\nDone.";
  const correctedReply = "```anatomy\n" + VALID_BODY + "\n```";
  const mock = await mockReplies(page, [brokenReply, correctedReply]);

  await page.goto("http://localhost:3000/");
  await sendPrompt(page, "draw the head");

  // The figure renders — the error fallback never appears.
  await expect(page.locator("svg.anatomy-svg")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="anatomy-error"]')).toHaveCount(0);

  // Exactly one exchange on screen: the repair turn never becomes visible.
  await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="assistant-message"]')).toHaveAttribute("data-state", "complete");

  // The repair request carried the exact validation error back to the model.
  await expect.poll(() => mock.calls(), { timeout: 20_000 }).toBe(2);
  const repairReq = mock.requests[1];
  const repairTurn = repairReq.messages[repairReq.messages.length - 1];
  expect(repairTurn.role).toBe("user");
  expect(repairTurn.content).toContain("failed validation");
  expect(repairTurn.content).toContain("Expected ':' after property name");
  // The broken fence itself rode in the replayed assistant turn.
  const assistantTurn = repairReq.messages[repairReq.messages.length - 2];
  expect(assistantTurn.role).toBe("assistant");
  expect(assistantTurn.content).toContain(BROKEN_BODY);
});

test("a fence that stays broken falls back honestly after exactly two repair rounds", async ({ page }) => {
  const brokenReply = "```anatomy\n" + BROKEN_BODY + "\n```";
  const mock = await mockReplies(page, [brokenReply]); // every reply stays broken

  await page.goto("http://localhost:3000/");
  await sendPrompt(page, "draw the head");

  // Last resort: the honest error note with the exact problem, plus source.
  await expect(page.locator('[data-testid="anatomy-error"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="anatomy-error"]')).toContainText("Expected ':' after property name");
  // 1 original generation + MAX 2 silent repair rounds — never more.
  await expect.poll(() => mock.calls(), { timeout: 20_000 }).toBe(3);
});
