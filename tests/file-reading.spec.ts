/**
 * Attachment reading, end to end.
 *
 * Layer 1 — extraction: every fixture goes straight to /api/files/extract and
 *   must come back with its marker in hand. This is the fast half, and it tells
 *   us whether a failure belongs to the extractor or to the model.
 * Layer 2 — the model actually reads it: upload through the real UI, send a
 *   prompt, and require the reply to contain that fixture's own marker string.
 *   A model that never saw the file cannot guess a per-extension marker, so a
 *   pass is proof the bytes reached it.
 *
 * Fixtures come from scripts/make-fixtures.mjs. Run the suite where you can
 * watch it:  npx playwright test tests/file-reading.spec.ts --headed
 */
import { test, expect, Locator, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

interface Fixture {
  file: string | null;
  name?: string;
  category: string;
  expect?: string;
  skip?: boolean;
  note?: string;
}

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures");
const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");

if (!fs.existsSync(MANIFEST_PATH)) {
  throw new Error("tests/fixtures/manifest.json is missing — run: node scripts/make-fixtures.mjs");
}

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Fixture[];
const READABLE = MANIFEST.filter(f => f.file && !f.skip);
const SKIPPED = MANIFEST.filter(f => !f.file || f.skip);

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';

/** Marker strings survive lowercasing and punctuation drift ("MARKER - ICO"). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function promptFor(fx: Fixture, marker: string): string {
  switch (fx.category) {
    case "image":
      return `Read the text written in the attached image. Reply with exactly YES followed by that text, or NO if the image is unreadable. Nothing else.`;
    case "video":
      return `Read the text burned into the attached video. Reply with exactly YES followed by that text, or NO if you cannot see any text. Nothing else.`;
    case "audio":
      return `Listen to the attached audio and reply with exactly YES followed by the codeword that is spoken, or NO if you cannot hear it. Nothing else.`;
    default:
      return `Read the attached file and reply with exactly YES followed by its marker string, or NO if the file is unreadable. Nothing else.`;
  }
}

/** Per-category patience: whisper on first use and video frame sampling are slow.
 *  Model deadlines also cover the bounded retry (2 attempts), and the local
 *  model occasionally streams a pathologically long turn under suite load
 *  (observed: text turn >120 s, video turn >150 s — stream still healthy,
 *  just slow). Budgets below are 2x model deadline + extraction + slack. */
function timeoutsFor(fx: Fixture) {
  if (fx.category === "audio") return { extract: 300_000, model: 180_000, test: 600_000 };
  if (fx.category === "video") return { extract: 120_000, model: 180_000, test: 520_000 };
  if (fx.category === "image") return { extract: 60_000, model: 150_000, test: 380_000 };
  return { extract: 60_000, model: 150_000, test: 380_000 };
}

/**
 * Wait for the chip to leave "pending"/"processing". An errored chip reports its
 * own reason immediately instead of sitting out the whole timeout.
 */
async function waitChipReady(chip: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const status = await chip.getAttribute("data-status").catch(() => null);
    last = status ?? "(no chip)";
    if (status === "ready") return;
    if (status === "error") {
      throw new Error(`extraction failed: ${await chip.getAttribute("title")}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`attachment never became ready (last status: ${last})`);
}

/** Fresh chat, reasoning off, file attached and read, prompt sent. */
async function sendWithAttachment(page: Page, fx: Fixture, file: string, marker: string, t: { extract: number; model: number }) {
  await page.goto("/");

  // Reasoning off keeps each turn a few seconds instead of a minute.
  const effort = page.getByLabel("Reasoning effort");
  if ((await effort.getAttribute("title")) !== "Reasoning: Off") {
    await effort.click();
    await page.getByRole("button", { name: "Off", exact: true }).click();
  }

  await page.setInputFiles(FILE_INPUT, file);
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  await waitChipReady(chip, t.extract);

  await page.locator("textarea").first().fill(promptFor(fx, marker));
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();

  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") return reply;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

test.describe("extraction API", () => {
  for (const fx of READABLE) {
    const file = path.join(FIXTURE_DIR, fx.file!);
    const t = timeoutsFor(fx);
    test.setTimeout(t.test);

    test(`${fx.file} → text reaches the server`, async ({ request }) => {
      // Raw-bytes contract: filename via ?name=, body is the file itself.
      const resp = await request.post(
        `/api/files/extract?name=${encodeURIComponent(fx.file!)}`,
        {
          data: fs.readFileSync(file),
          headers: { "content-type": "application/octet-stream" },
          timeout: t.extract,
        },
      );

      const body = await resp.json().catch(() => null);
      expect(resp.status(), `extract failed: ${body?.error ?? "(no response body)"}`).toBe(200);
      expect(body, "no JSON from the extract route").not.toBeNull();

      switch (fx.category) {
        case "image":
          expect(body.dataUrl, "image produced no data url").toMatch(/^data:image\//);
          break;
        case "video":
          expect(body.frames?.length, "video produced no frames").toBeGreaterThan(0);
          expect(body.frames[0].dataUrl, "frame had no image data").toMatch(/^data:image\//);
          break;
        case "audio":
          expect(body.transcript, "audio produced no transcript").toBeTruthy();
          expect(normalize(body.transcript)).toContain(normalize(fx.expect!));
          break;
        default:
          expect(body.text, "file produced no text").toBeTruthy();
          expect(normalize(body.text)).toContain(normalize(fx.expect!));
      }
    });
  }
});

test.describe("the model reads the file", () => {
  for (const fx of READABLE) {
    const file = path.join(FIXTURE_DIR, fx.file!);
    const t = timeoutsFor(fx);
    test.setTimeout(t.test);

    test(`${fx.file} → the reply contains its own marker`, async ({ page }) => {
      // The extraction API test above proves the server-side text is exact.
      // The local model occasionally truncates the tail of a reply and drops
      // the marker's last characters (observed: "…RTF-7Q" for "…RTF-7QX9") —
      // genuine LLM nondeterminism, not an app defect. Give the journey one
      // bounded retry before declaring failure.
      let said = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        // A slow turn (deadline expired, stream healthy but unfinished) is the
        // same nondeterminism family as a truncated marker — retry it once.
        // Genuine failures ("chat failed", "extraction failed") still throw.
        let reply;
        try {
          reply = await sendWithAttachment(page, fx, file, fx.expect!, t);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "the assistant never finished answering" && attempt < 2) continue;
          throw err;
        }
        said = (await reply.innerText()).trim();
        // Visible in the terminal as the run goes by.
        console.log(`  ${fx.file!.padEnd(26)} ${attempt === 2 ? "(retry) " : ""}${said.replace(/\s+/g, " ").slice(0, 90)}`);
        if (normalize(said).includes(normalize(fx.expect!))) break;
      }
      expect(
        normalize(said),
        `the model did not produce the marker from ${fx.file}. It replied: ${said.slice(0, 300)}`,
      ).toContain(normalize(fx.expect!));
    });
  }
});

test.describe("formats that cannot be tested", () => {
  for (const fx of SKIPPED) {
    test(`skipped: ${fx.name ?? fx.file} — ${fx.note}`, () => {
      // Documented, not silently missing: the manifest records why each of
      // these has no fixture.
      expect(fx.note).toBeTruthy();
    });
  }
});
