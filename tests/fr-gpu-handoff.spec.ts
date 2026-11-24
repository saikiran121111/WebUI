/**
 * F91 (2026-11-23) — GPU handoff BROWSER rows, LIVE (exclusive Playwright;
 * run ONLY via scripts/run-browser-e2e-exclusive.ps1 with an isolated
 * WEBUI_DATA_DIR=.data/e2e-store, default engine settings = PaddleOCR
 * primary, i.e. the GPU path).
 *
 * What is already proven OFF the browser: docs/overnight/logs/
 * f79-b9-gpu2-p1.json is the Python harness log of a real one-page GPU
 * worker run (job 60918300b06202a4, device cuda:0, 5967 MB peak,
 * pages_read 1, work 45.388 s) with the full handoff phases recorded:
 * plan -> unload -> freed -> work -> restore -> restore_ready ->
 * lease_release. ocr_cascade.py integrates the same run_exclusive
 * (automatic_handoff) in production, and handoff.py owns restore_ready/
 * lease_release. The overnight brief names the MISSING proof: "the
 * browser path, cancellation and failed-restore recovery."
 *
 * Why the browser rows are scoped the way they are:
 *  - /api/ruke/ml-status is answered by the Rust bridge
 *    (rust-backend/crates/ruke-server/src/lib.rs:129 -> ml_bridge::
 *    status_get) behind a server-side bridge secret; no Next relay route
 *    exists (app/api has no ruke/ tree), so the status JSON is NOT
 *    observable from the page under Playwright on :3000.
 *  - The UI milestones ARE observable: the chip's data-status
 *    (pending -> processing -> ready; lib/chat/composerGate.ts) and the
 *    Send gate. The ready law (ChatInput.tsx:245-246, B10) is "the
 *    extract response landed ready = evidence persisted AND restoration
 *    done", so chip-ready IS the browser-visible provider-ready-after-
 *    restore signal, and a completed keyed answer is the chat-side
 *    proof the restored provider serves the turn.
 *  - The brief's "worker exit, reload initiation, provider-ready and
 *    Send-enabled timestamps distinct" is recorded per row: each
 *    milestone carries its own epoch timestamp in the results log
 *    (queued, processing, ready, send-enabled, answer-complete);
 *    worker exit is observed as the abort-and-re-admission journey in
 *    F91.2, and the worker-side phase timings live in the harness log.
 *  - Failed-restore RETRY (evidence kept, retry without re-running OCR/
 *    ASR) stays pinned model-free: the py handoff layer
 *    (handoff.py restore_ready/lease_release, cascade vectors) and the
 *    B10 gate law carry it; forcing a single-page primary failure needs
 *    a fault-injection env the exclusive launcher does not set (same
 *    scoping as tests/ocr-tesseract-only.spec.ts).
 *
 * F91.1 doubles as the F59 primary-acceptance row: it asserts
 * job-correlated PADDLE execution in the delivered provenance (the F90
 * spec proves the zero-Paddle side; no live row proved the GPU-primary
 * side ran Paddle). Key: scan-1.pdf page-1 facts are the F81 frozen d1
 * answer-key ("14 million cubic metres", "31 ppt", "Kandla") — never
 * derived from a model run.
 */
import { test, expect, Locator, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-gpu-handoff.jsonl",
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
  if (!fs.existsSync(p)) throw new Error(`F91 fixture missing: ${p}`);
  return p;
};

/**
 * Poll the chip's data-status, recording every phase transition with its
 * own epoch. The composer Send-gate law (disabled while an attachment is
 * in flight) is graded by the fr-spec gating rows; here the milestones
 * are the handoff: queued -> processing (worker on the slot) -> ready
 * (evidence persisted AND restoration done, B10) -> send-enabled ->
 * answer-complete, each logged with a distinct timestamp.
 */
async function watchChip(chip: Locator, t: { extract: number }): Promise<{ status: string; phases: string[] }> {
  const deadline = Date.now() + t.extract;
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

/** Same reader the F81/F90 provenance law uses: the store persists the
 *  EXACT delivered attachment text, so engine attribution is graded
 *  model-free against the run's own job. */
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

async function sendPrompt(page: Page, prompt: string, t: { model: number }): Promise<string> {
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  record("milestone", { phase: "send-enabled", at: Date.now() });
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
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

test("F91.1 GPU-primary scan-1: chip phases with distinct milestones, gated Send, keyed answer on the restored provider", async ({ page }) => {
  test.setTimeout(1_020_000);
  await page.goto("/");
  await ensureReasoningOff(page);
  record("F91.1", { phase: "queued", at: Date.now(), file: "scan-1.pdf" });
  await page.setInputFiles(FILE_INPUT, FIX("scan-1.pdf"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();

  const { status, phases } = await watchChip(chip, { extract: 660_000 });
  expect(status, `extraction did not reach ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  // The pipeline law: the chip passed through the in-flight phases, and
  // while it was in flight Send was GATED (B10/composerGate: send only
  // once evidence is persisted AND restoration done).
  expect(phases, `no in-flight phase observed before ready: ${phases.join(" -> ")}`).toContain("processing");
  await expect(page.locator(SEND)).toBeEnabled();

  const said = await sendPrompt(page,
    "Page 1 of the attached PDF is a scan — its words exist only as pixels. What aquifer yield (with units) and what downstream salinity (with units and gauge location) appear on that page? Reply with them exactly as printed. Nothing else.",
    { model: 300_000 });
  const n = normalize(said);
  expect(n, `yield fact missing: ${said.slice(0, 200)}`).toContain("14millioncubicmetres");
  expect(n, `salinity fact missing: ${said.slice(0, 200)}`).toContain("31ppt");
  expect(n, `gauge location missing: ${said.slice(0, 200)}`).toContain("kandla");

  // F59 primary-acceptance law: THIS job's own delivered evidence names
  // Paddle (the GPU-primary engine) — the answer is not a fallback pass.
  const prov = storeAttachmentText("scan-1.pdf");
  expect(prov, "scan-1 delivered text not found in the store: provenance UNVERIFIED").not.toBe("");
  expect(prov.toLowerCase(), `job-correlated Paddle execution missing from provenance: ${prov.slice(0, 300)}`)
    .toContain("paddle");
  record("F91.1", { phase: "graded", answerOk: true, phases });
});

test("F91.2 cancellation: Remove mid-extraction aborts the GPU job, the next short upload is re-admitted and answered", async ({ page }) => {
  test.setTimeout(720_000);
  await page.goto("/");
  await ensureReasoningOff(page);

  // Start the long GPU extraction, then remove the chip mid-flight —
  // ChatInput.tsx:302-303 (I15c): a chip removed mid-read ABORTS its
  // queued/running extraction. That abort is the browser-observable
  // worker-exit event.
  record("F91.2", { phase: "queued", at: Date.now(), file: "scan-1.pdf" });
  await page.setInputFiles(FILE_INPUT, FIX("scan-1.pdf"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-status", /pending|processing/, { timeout: 120_000 }).catch(() => undefined);
  const atRemove = Date.now();
  await page.getByRole("button", { name: "Remove scan-1.pdf" }).click();
  await expect(page.locator(CHIP)).toHaveCount(0);
  record("F91.2", { phase: "removed-mid-extraction", at: atRemove });
  // No chat was sent for the cancelled job: zero assistant turns.
  expect(await page.locator(ASSISTANT).count(), "the cancelled extraction produced an answer").toBe(0);

  // Re-admission: a short native upload completes and is answered — the
  // pipeline admits a new job after the aborted one (worker exit +
  // re-admission on the shared slot).
  record("F91.2", { phase: "queued", at: Date.now(), file: "scan-2.pdf" });
  await page.setInputFiles(FILE_INPUT, FIX("scan-2.pdf"));
  const chip2 = page.locator(CHIP).last();
  await expect(chip2).toBeVisible();
  const { status } = await watchChip(chip2, { extract: 180_000 });
  expect(status, "the post-cancel upload never reached ready").toBe("ready");
  const said = await sendPrompt(page, "Reply with the single word READY. Nothing else.", { model: 180_000 });
  expect(normalize(said), `post-cancel answer: ${said.slice(0, 160)}`).toContain("ready");
  expect(await page.locator(ASSISTANT).count(), "the post-cancel turn duplicated the answer").toBe(1);
  record("F91.2", { phase: "graded", reAdmitted: true });
});
