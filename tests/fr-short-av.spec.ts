/**
 * F123 / section-5 acceptance row (2026-11-23, user brief 3): the pinned
 * Parakeet job is the SOLE speech engine for a VIDEO's audio track, live in
 * the browser. The deterministic layer is shipped (routing seam, device
 * propagation, blocked-path honesty); the missing proof was named by the
 * brief: a cold short-video upload whose delivered evidence shows
 *  - the KEYED speech fact (the answer states the verified opening sentence
 *    of au-1.mp3 — proven independently by the two passing fr-U1 live runs),
 *  - the pinned engine attribution (the delivery names the model that RAN,
 *    never Whisper — "remove every reachable Whisper substitution"),
 *  - the worker-REPORTED runtime device (this host is CUDA-capable; a planned
 *    "gpu" label alone does not pass — the note carries what the run reported),
 *  - usable segment timestamps ([HH:MM:SS - HH:MM:SS] headers ride the
 *    delivery — the citation law),
 *  - ZERO Whisper invocations (the delivered provenance names none).
 *
 * Fixture: short-av.mp4 is 12 s of frames + the first 12 s of au-1.mp3
 * (staged by .data/tmp/file-regression/f91-accept-4/stage-short-av.mjs).
 * Run ONLY via scripts/run-browser-e2e-exclusive.ps1 (isolated
 * WEBUI_DATA_DIR=.data/e2e-store, PaddleOCR default).
 */
import { test, expect, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-short-av.jsonl",
);
const STORE = path.join(process.cwd(), ".data", "e2e-store");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const ANSWER_BODY = '[data-testid="answer-body"]';

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function record(row: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), row, ...obj }) + "\n");
}

const FIX = (name: string): string => {
  const p = path.join(LIVE, name);
  if (!fs.existsSync(p)) throw new Error(`short-av fixture missing: ${p}`);
  return p;
};

async function watchChip(chip: import("@playwright/test").Locator, extractMs: number) {
  const deadline = Date.now() + extractMs;
  const phases: string[] = [];
  let last = "";
  while (Date.now() < deadline) {
    const status = (await chip.getAttribute("data-status").catch(() => null)) ?? "";
    if (status !== last) {
      last = status;
      phases.push(status);
      record("milestone", { phase: status, at: Date.now() });
    }
    if (status === "ready" || status === "error") return { status, phases };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { status: "timeout", phases };
}

/** The store persists the EXACT delivered attachment text, so engine/device/
 *  timestamp provenance is graded model-free against this run's own job. */
function storeAttachmentText(fixtureName: string): string {
  const recs = fs
    .readdirSync(STORE)
    .filter((f) => /^c_.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(STORE, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of recs) {
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(STORE, f), "utf8")); } catch { continue; }
    for (const msg of j.messages ?? [])
      for (const a of msg.attachments ?? [])
        if (String(a.name ?? "").includes(fixtureName) && typeof a.text === "string" && a.text.length)
          return a.text as string;
  }
  return "";
}

async function ensureReasoningOff(page: Page): Promise<void> {
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }
}

async function sendPrompt(page: Page, prompt: string, modelMs: number): Promise<string> {
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  record("milestone", { phase: "send-enabled", at: Date.now() });
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + modelMs;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") {
      const body = reply.locator(ANSWER_BODY);
      const said = (await (await body.count() ? body.first().innerText() : reply.innerText()).catch(() => "")).trim();
      record("milestone", { phase: "answer-complete", at: Date.now(), said: said.slice(0, 160) });
      return said;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

test("fr-F123 short-video speech: cold Parakeet run on the audio track, keyed fact, timed segments, worker-reported device, zero Whisper", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await ensureReasoningOff(page);
  record("fr-F123-shortav", { phase: "queued", at: Date.now(), file: "short-av.mp4" });
  await page.setInputFiles(FILE_INPUT, FIX("short-av.mp4"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();

  const { status, phases } = await watchChip(chip, 300_000);
  expect(status, `extraction did not reach ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  expect(phases, `no in-flight phase observed before ready: ${phases.join(" -> ")}`).toContain("processing");
  await expect(page.locator(SEND)).toBeEnabled();

  const said = await sendPrompt(page,
    "In the first seconds of the attached clip the speaker describes what the new clothes do to him. In his exact words, what does he say he couldn't do? Reply with the exact phrase. Nothing else.",
    240_000);
  const n = normalize(said);
  expect(n, `keyed speech fact missing: ${said.slice(0, 200)}`).toContain("couldntdonothingbutsweat");

  const prov = storeAttachmentText("short-av.mp4").toLowerCase();
  expect(prov, "short-av delivered text not found in the store: provenance UNVERIFIED").not.toBe("");
  // Pinned engine attribution: the delivery names the Parakeet model that ran.
  expect(prov, `pinned engine attribution missing: ${prov.slice(0, 300)}`).toContain("parakeet");
  // Worker-REPORTED runtime device (F123: record the ACTUAL device; this host
  // is CUDA-capable — a planned label alone never passes).
  expect(prov, `worker-reported device missing: ${prov.slice(0, 300)}`).toMatch(/cuda|cpu/);
  // Usable timestamps ride the delivered record (citation law).
  expect(prov, `segment timestamps missing: ${prov.slice(0, 300)}`).toMatch(/\[\d\d:\d\d:\d\d - \d\d:\d\d:\d\d\]/);
  // F123 removal law: NO Whisper substitution anywhere in the provenance.
  expect(prov, `Whisper appears in the provenance: ${prov.slice(0, 300)}`).not.toContain("whisper");

  record("fr-F123-shortav", { phase: "graded", answerOk: true, phases });
});
