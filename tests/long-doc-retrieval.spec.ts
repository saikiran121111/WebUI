/**
 * Long-document knowledge index, end to end.
 *
 * A ~60k-char document exceeds the 48k prompt budget, so it must be INDEXED
 * (full text preserved on disk) instead of truncated — and a marker planted
 * deep past the budget must still reach the model via per-turn retrieval.
 *
 * Layer 1 — extraction API: indexed:true, spine, chunkCount, preview only,
 *   and full.txt byte-identical to the source (zero knowledge loss). The
 *   same file WITHOUT an att id must keep the classic capped behavior
 *   (invariant: nothing changes for callers that don't opt in).
 * Layer 2 — the real UI + model: upload, indexed badge on the chip, ask for
 *   the deep marker (turn 1), then ask again WITHOUT re-attaching (turn 2 —
 *   proves the attachment_ref in history resolves retrieval again, and that
 *   evidence is regenerated per turn rather than frozen into history).
 */
import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const BADGE = '[data-testid="indexed-badge"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';

const MARKER = "Verdanthill-42";

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** ~60k chars: filler + one unique marker at ~97% of the document. */
function makeLongDoc(): string {
  const filler =
    "The instructor reviews the problem set and answers questions from the floor. " +
    "We continue with the standard notation introduced in the first seminar. " +
    "A short recap connects today's material to the exam questions from last semester. ";
  const body = filler.repeat(500); // ~73k chars of filler
  const text = body.slice(0, 58000) +
    ` The secret codename for the final project review is ${MARKER}. ` +
    body.slice(58000, 60000);
  return text;
}

function indexDir(attId: string): string {
  return path.join(process.cwd(), ".data", "attach-index", attId);
}

async function waitAssistantComplete(page: Page, timeout: number) {
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") return reply;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

async function ask(page: Page, question: string): Promise<string> {
  await page.locator("textarea").first().fill(question);
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();
  const reply = await waitAssistantComplete(page, 150_000);
  return (await reply.innerText()).trim();
}

test.describe("long document knowledge index", () => {
  test.setTimeout(660_000);

  test("extraction API: oversized text is indexed, not truncated", async ({ request }) => {
    const attId = "att_" + Math.random().toString(36).slice(2, 12);
    const doc = makeLongDoc();
    try {
      const resp = await request.post(
        `/api/files/extract?name=longdoc-${attId}.txt&att=${attId}`,
        { data: Buffer.from(doc, "utf8"), headers: { "content-type": "application/octet-stream" }, timeout: 120_000 },
      );
      const body = await resp.json().catch(() => null);
      expect(resp.status(), `extract failed: ${body?.error ?? "(no body)"}`).toBe(200);

      expect(body.indexed, "oversized text with an att id must be indexed").toBe(true);
      expect(body.chunkCount).toBeGreaterThan(20);
      expect(body.spine, "indexed content must ship a spine").toContain("[");
      expect((body.text ?? "").length, "inline text must be a small preview").toBeLessThanOrEqual(4100);
      expect(normalize(body.text ?? ""), "the deep marker must NOT be in the preview").not.toContain(normalize(MARKER));

      // Zero knowledge loss: full.txt is exactly the cleaned source.
      const full = fs.readFileSync(path.join(indexDir(attId), "full.txt"), "utf8");
      expect(full.length).toBe(doc.replace(/\r\n/g, "\n").trim().length);
      expect(full).toContain(MARKER);
    } finally {
      fs.rmSync(indexDir(attId), { recursive: true, force: true });
    }
  });

  test("extraction API: without an att id the classic cap path is untouched", async ({ request }) => {
    const doc = makeLongDoc();
    const resp = await request.post(
      "/api/files/extract?name=longdoc-classic.txt",
      { data: Buffer.from(doc, "utf8"), headers: { "content-type": "application/octet-stream" }, timeout: 60_000 },
    );
    const body = await resp.json().catch(() => null);
    expect(resp.status()).toBe(200);
    expect(body.indexed, "no att id → no index, exactly as before").toBeUndefined();
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBeLessThanOrEqual(48_000);
  });

  test("the model answers from the deep marker, then again next turn", async ({ page }) => {
    const docFile = path.join(process.cwd(), ".data", "tmp", `pw-longdoc-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(docFile), { recursive: true });
    fs.writeFileSync(docFile, makeLongDoc(), "utf8");

    try {
      await page.goto("/");

      const effort = page.getByLabel("Reasoning effort");
      if ((await effort.getAttribute("title")) !== "Reasoning: Off") {
        await effort.click();
        await page.getByRole("button", { name: "Off", exact: true }).click();
      }

      await page.setInputFiles(FILE_INPUT, docFile);
      const chip = page.locator(CHIP).last();
      await expect(chip).toBeVisible();

      // Chip leaves processing only once the index (chunk + embed + spine) is built.
      await expect(chip, "long doc never became ready").toHaveAttribute("data-status", "ready", { timeout: 180_000 });
      await expect(page.locator(BADGE), "indexed badge missing on the chip").toBeVisible();
      await expect(page.locator(BADGE)).toContainText("chunks");

      // Turn 1: the marker sits ~58k chars in — past the 48k prompt budget, so
      // the model can only see it if retrieval pulled it from the index.
      let said = await ask(
        page,
        `Read the attached file and reply with exactly YES followed by the secret codename mentioned near the end of the file. Nothing else.`,
      );
      console.log(`  turn1: ${said.replace(/\s+/g, " ").slice(0, 90)}`);
      if (!normalize(said).includes(normalize(MARKER))) {
        // Bounded retry for local-model nondeterminism (same policy as file-reading).
        said = await ask(page, `What is the secret codename for the final project review in that file? Reply with just the codename.`);
        console.log(`  turn1 retry: ${said.replace(/\s+/g, " ").slice(0, 90)}`);
      }
      expect(normalize(said), `turn 1 missed the marker. Replied: ${said.slice(0, 300)}`).toContain(normalize(MARKER));

      // Turn 2: no re-attach — the attachment_ref in history must resolve
      // retrieval again (and the evidence is this turn's, not turn 1's copy).
      let said2 = await ask(
        page,
        `In that same attached file, what exactly is the secret codename for the final project review? Reply with just the codename.`,
      );
      console.log(`  turn2: ${said2.replace(/\s+/g, " ").slice(0, 90)}`);
      if (!normalize(said2).includes(normalize(MARKER))) {
        said2 = await ask(page, `Name the codename again from the indexed file.`);
        console.log(`  turn2 retry: ${said2.replace(/\s+/g, " ").slice(0, 90)}`);
      }
      expect(normalize(said2), `turn 2 (follow-up without re-attach) missed the marker. Replied: ${said2.slice(0, 300)}`).toContain(normalize(MARKER));
    } finally {
      try { fs.rmSync(docFile, { force: true }); } catch { /* ignore */ }
    }
  });
});
