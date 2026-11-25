/**
 * F153 (2026-11-24) — the §1/§2/§4b laws that the deterministic suites pin
 * but the live batch never walked. Run ONLY through
 * scripts/run-browser-e2e-exclusive.ps1 (exclusive lock, isolated store,
 * capture proxy; handoff rows require -AuthorizeHandoff).
 *
 * Rows (the brief's "the live batch must include" list, deterministic part):
 *
 *  fr-F153a/3b — fenceRepair TERMINAL-OUTCOME law (§2, useChat.ts
 *  runRepairRounds): the "Auto-repairing…" badge must resolve at the
 *  terminal, never spin on a finished turn. 3a streams a truncated
 *  ```xlsx fence; the repair round (real UI + real repair request,
 *  fenceRepairRequest prompt observed on the wire) returns a valid fence:
 *  the viewer renders and the badge is GONE. 3b: repair rounds return
 *  prose; after MAX_FENCE_REPAIRS the badge resolves to the honest
 *  terminal notice — visible, worded, and the card keeps the exact error.
 *  The model transport is route-mocked (the pattern of
 *  tests/regression_modalities.spec.ts: the UI, fence router, repair
 *  rounds, badge state machine, export and download legs are the REAL
 *  product; only the upstream bytes are scripted, which is what makes the
 *  terminal outcome deterministic).
 *
 *  fr-F153c — PARTIAL-EXPORT law (§2): a table with a non-numeric cell in
 *  a currency column exports with the F11 decision count in the response
 *  headers, and the download UI must show it (doc-card-warning,
 *  exportWarningFromHeaders) — the moment the user experiences the export
 *  is the download, and a silently-truncated workbook must never land as
 *  a plain success. Then the REAL reopen: ExcelJS loads the saved file
 *  (the decision cell is BLANK — 1200/300 kept, nothing fabricated), and
 *  the SAME downloaded file is uploaded back through the real chat path
 *  (real model after unroute) and answered from its contents.
 *
 *  fr-F153d — NAVIGATION-OWNERSHIP law (§1, lib/chat/navOwner.ts): the
 *  audit race was "open slow A, then fast B — B paints, then A's late
 *  resolve overwrites it". A is a real conversation built with a ~26 KB
 *  answer, B a tiny one; A is clicked, then B IMMEDIATELY (A's load
 *  starts first and, being bigger, resolves LAST — exactly the audit
 *  shape). The screen must end on B and the sidebar must agree; a New
 *  clicked during A's load must keep the fresh screen. The unit suite
 *  __tests__/nav-ownership.test.ts pins the owner; this row walks the
 *  journey through the real sidebar and the real async IndexedDB loads.
 *
 *  fr-F153e — handoff case (b) (§4b): the AUTHORIZED handoff-ON journey
 *  (launcher -AuthorizeHandoff, recorded in launcher-identity.json) —
 *  real Parakeet GPU extraction of au-1.mp3 with a real
 *  unload/restore, keyed spoken fact "sweat" answered through the
 *  restored provider, and the transcript present DURABLY in the store's
 *  attachment text (the answer is not a model hallucination). Case (a)
 *  (handoff OFF → honest retryable refusal naming the policy) is proven
 *  model-free at python-backend test_memory_policy.py:152.
 *
 * Results: docs/overnight/file-regression-fr-20261122a/results-live-f153.jsonl
 * (its own ledger — never the frozen matrix ledger).
 */
import { test, expect, Page, Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-live-f153.jsonl",
);
const DL_DIR = path.resolve("test-results/e2e-f153");
const LIVE = path.join(process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live");
const STORE = path.join(process.cwd(), ".data", "e2e-store");
const IDENTITY = path.join(STORE, "launcher-identity.json");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const ASSISTANT_DONE = '[data-testid="assistant-message"][data-state="complete"]';
const ANSWER_BODY = '[data-testid="answer-body"]';
const NEW_CHAT = '[data-testid="sidebar-new-chat"]';
const REPAIR_NOTE = '[data-testid="fence-repair-note"]';

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function record(row: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), row, ...obj }) + "\n");
}

const FIX = (name: string): string => {
  const p = path.join(LIVE, name);
  if (!fs.existsSync(p)) throw new Error(`F153 fixture missing: ${p}`);
  return p;
};

/** The launcher's identity record is this batch's wire proof (F152 Part 1
 *  law): isolated store, non-reused app, and — for fr-F153e — the loud,
 *  per-run operator authorization for handoff. Read once; every row records
 *  the runId so the ledger binds to one exclusive window. */
let ID: any = null;
function identity(): any {
  if (ID) return ID;
  const j = JSON.parse(fs.readFileSync(IDENTITY, "utf8"));
  expect(j.schema, `identity schema: ${j.schema}`).toBe("ruke.e2e-launcher-identity.v1");
  expect(j.reusedForeign, "identity: a FOREIGN app owns the ports — this batch proves nothing").toBe(false);
  expect(String(j.storePath).replace(/\\/g, "/")).toContain(".data/e2e-store");
  ID = j;
  return j;
}

/** Respond to every POST /api/chat with `content` streamed in SSE frames.
 *  x-decision-mode is mandatory (the renderer mounts only on a matching
 *  active_mode — zero-collision rule). */
async function streamReply(page: Page, content: string, decisionMode: string, chunkSize = 64): Promise<void> {
  const frames: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-decision-mode": decisionMode },
      body: frames.join(""),
    });
  });
}

async function send(page: Page, text: string, timeout = 180_000): Promise<void> {
  const box = page.locator("textarea").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await page.locator(ASSISTANT_DONE).first().waitFor({ timeout });
}

async function ensureReasoningOff(page: Page): Promise<void> {
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }
}

/** Newest store conversation whose JSON contains `needle`; returns its id
 *  (the file stem — data-conversation-id carries exactly this). */
function storeFind(needle: string): string {
  const recs = fs
    .readdirSync(STORE)
    .filter((f) => /^c_.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(STORE, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of recs) {
    try {
      if (fs.readFileSync(path.join(STORE, f), "utf8").includes(needle)) return f.replace(/\.json$/, "");
    } catch { /* ignore unparseable */ }
  }
  throw new Error(`no store conversation contains ${needle}`);
}

/** Watch the chip's data-status, recording phase transitions with epochs. */
async function watchChip(chip: Locator, timeoutMs: number): Promise<{ status: string; phases: string[] }> {
  const deadline = Date.now() + timeoutMs;
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

async function sendPrompt(page: Page, prompt: string, timeoutMs: number): Promise<string> {
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (state === "complete") {
      const body = reply.locator(ANSWER_BODY);
      return ((await (await body.count() ? body.first().innerText() : reply.innerText()).catch(() => "")) ?? "").trim();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

const XLSX_PARTIAL = JSON.stringify({
  filename: "F153 Partial Export",
  sheets: [{
    name: "Spend",
    columns: [
      { key: "item", label: "Item", format: "text" },
      { key: "spend", label: "Spend", format: "currency" },
    ],
    rows: [
      { item: "Rent", spend: 1200 },
      { item: "Cloud", spend: "N/A" },
      { item: "Tools", spend: 300 },
    ],
  }],
});

// F153b law: ONE serial chain, for two measured reasons. (1) Rows
// fr-F153f2/f3/f4 reopen the chat fr-F153f1 created — the reopen order needs
// f1 first. (2) Every row rides the single Strata slot and the ruke-ml commit
// ceiling; a parallel pool (observed: 5 workers in run 2f483a0f) runs the
// heavy loads concurrently and breaks the reopen order. Serial mode pins the
// whole file to one worker in order, independent of config/CLI worker counts.
// NOTE (run 1ffc4c76 evidence): the f1 failure ("paging file is too small",
// os error 1455) reproduced with "Running 9 tests using 1 worker" — it is the
// ruke-ml job commit ceiling under a single in-job Parakeet load, NOT browser
// parallelism. Serial mode is required; it is not the 1455's fix.
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.mkdirSync(DL_DIR, { recursive: true });
  identity();
  record("batch.identity", { runId: ID.runId, appStartedUtc: ID.appStartedUtc, llmResolved: ID.llmResolved, handoffAuthorized: ID.handoffAuthorized });
});

// ── §2 fenceRepair TERMINAL-OUTCOME law, live ──────────────────────────────

/** The repair turn is identifiable on the wire: fenceFixRequest wording
 *  ("fix that exact problem and re-emit the COMPLETE corrected fence"). */
function repairAwareRoute(page: Page, broken: string, repairReply: string): { calls: () => number } {
  let repairCalls = 0;
  page.route("**/api/chat", async (route) => {
    let body: any = {};
    try { body = JSON.parse(route.request().postData() ?? "{}"); } catch { /* keep {} */ }
    const users = (body.messages ?? []).filter((m: any) => m?.role === "user");
    const last = users[users.length - 1];
    const isRepair = typeof last?.content === "string"
      && last.content.includes("fix that exact problem and re-emit");
    if (isRepair) repairCalls++;
    const content = isRepair ? repairReply : broken;
    const frames: string[] = [];
    for (let i = 0; i < content.length; i += 64) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 64) } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-decision-mode": "excel" },
      body: frames.join(""),
    });
  });
  return { calls: () => repairCalls };
}

test("fr-F153a fenceRepair clean: broken fence repaired by a real repair round, badge resolved (gone) at the terminal", async ({ page }) => {
  test.setTimeout(240_000);
  const id = identity();
  // A real fence truncated mid-JSON with no closing backticks: the viewer
  // fails, findBrokenRenderFences fires, the UI issues its REAL repair turn.
  const broken = "```xlsx\n" + XLSX_PARTIAL.slice(0, 90);
  const rep = repairAwareRoute(page, broken, "```xlsx\n" + XLSX_PARTIAL + "\n```");
  await page.goto("/");
  await ensureReasoningOff(page);
  await send(page, "Show me the spend spreadsheet");
  await page.waitForTimeout(1500); // let any badge settle past DONE
  record("fr-F153a", { runId: id.runId, repairRequests: rep.calls() });
  expect(rep.calls(), "the UI never issued its repair turn").toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-testid="xlsx-preview"]')).toBeVisible();
  expect(await page.locator(REPAIR_NOTE).count(),
    "the repair badge is still on a finished, repaired turn (terminal-outcome law)")
    .toBe(0);
});

test("fr-F153b fenceRepair terminal: rounds exhausted -> honest terminal badge, never a spinning badge", async ({ page }) => {
  test.setTimeout(240_000);
  const id = identity();
  const broken = "```xlsx\n" + XLSX_PARTIAL.slice(0, 90);
  const rep = repairAwareRoute(page, broken, "I am sorry, I cannot reproduce that block.");
  await page.goto("/");
  await ensureReasoningOff(page);
  await send(page, "Show me the spend spreadsheet");
  await page.waitForTimeout(1500);
  const notes = page.locator(REPAIR_NOTE);
  record("fr-F153b", { runId: id.runId, repairRequests: rep.calls() });
  expect(rep.calls(), "repair rounds did not run").toBeGreaterThanOrEqual(1);
  await expect(notes).toBeVisible();
  const txt = (await notes.first().innerText()).toLowerCase();
  expect(txt, `terminal badge wording: ${txt}`).toContain("auto-repair did not produce a valid fence");
});

// ── §2 PARTIAL-EXPORT law, live ────────────────────────────────────────────

test("fr-F153c xlsx partial export: warning line on download, workbook reopens (no fabricated 0), upload-back answered", async ({ page }) => {
  test.setTimeout(900_000);
  const id = identity();
  await streamReply(page, "```xlsx\n" + XLSX_PARTIAL + "\n```", "excel");
  await page.goto("/");
  await ensureReasoningOff(page);
  await send(page, "Show me the spend spreadsheet");
  await expect(page.locator('[data-testid="xlsx-preview"]')).toBeVisible();

  const block = page.locator('[data-testid="xlsx-block"]');
  const [resp, download] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/documents/xlsx"), { timeout: 120_000 }),
    page.waitForEvent("download", { timeout: 120_000 }),
    block.getByRole("button", { name: "Download XLSX file" }).click(),
  ]);
  expect(resp.status(), await resp.text().catch(() => "")).toBe(200);
  const issues = resp.headers()["x-ruke-data-quality-issues"] ?? "";
  record("fr-F153c.headers", { runId: id.runId, issues, summary: resp.headers()["x-ruke-data-quality-summary"] });
  expect(issues, "the F11 decision count never reached the response headers").toBe("1");

  // THE law: the download moment shows the engine's report.
  const warn = page.locator('[data-testid="doc-card-warning"]');
  await expect(warn).toBeVisible();
  const wtxt = await warn.innerText();
  record("fr-F153c.warning", { text: wtxt });
  expect(wtxt).toContain("Partial export");
  expect(wtxt).toContain("1 value decision");
  expect(wtxt.toLowerCase()).toContain("missing_value");

  const file = path.join(DL_DIR, download.suggestedFilename());
  await download.saveAs(file);

  // Real reopen: the saved workbook carries 1200 and 300, and the N/A
  // decision is BLANK — inventing 0 would fabricate a measurement.
  const wb = new ExcelJS.Workbook();
  // Node's readFileSync hands back a NonSharedBuffer; ExcelJS's published
  // signature predates the Buffer<ArrayBufferLike> split — same bytes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(fs.readFileSync(file) as any);
  const ws = wb.getWorksheet("Spend");
  expect(ws, "the saved workbook has no Spend sheet").toBeTruthy();
  const cell = (r: number, c: number) => ws!.getRow(r).getCell(c).value as unknown;
  expect(Number(cell(2, 2)), "Rent spend lost on export").toBe(1200);
  expect(Number(cell(4, 2)), "Tools spend lost on export").toBe(300);
  const cloud = cell(3, 2);
  expect(cloud === null || cloud === undefined || cloud === "",
    `the N/A decision was fabricated into ${JSON.stringify(cloud)} (must stay blank)`).toBe(true);

  // Upload-back through the real chat path (REAL model from here on).
  await page.unroute("**/api/chat");
  await page.setInputFiles(FILE_INPUT, file);
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status } = await watchChip(chip, 180_000);
  expect(status, "the exported workbook never became readable after upload-back").toBe("ready");
  const said = await sendPrompt(page,
    "The attached spreadsheet was exported earlier. List each Item with its Spend value exactly as the file shows them. Three short lines. Nothing else.",
    300_000);
  const n = normalize(said);
  record("fr-F153c.uploadback", { said: said.slice(0, 300) });
  for (const needle of ["rent", "cloud", "tools", "1200", "300"]) {
    expect(n, `upload-back answer missing "${needle}": ${said.slice(0, 200)}`).toContain(needle);
  }
});

// ── §1 NAVIGATION-OWNERSHIP law, live ──────────────────────────────────────

test("fr-F153d navigation: the latest click owns the screen; a late big-chat load never overwrites it; New owns over a load in flight", async ({ page }) => {
  test.setTimeout(420_000);
  const id = identity();
  // Build the audit's shape with REAL conversations: A is big (~26 KB
  // answer → its IndexedDB load resolves LAST), B is tiny.
  const BIG = "ALPHAMARKER section. ".repeat(1100);
  await streamReply(page, BIG, null as any);
  await page.goto("/");
  await ensureReasoningOff(page);
  await send(page, "F153 NAV ALPHA ledger build", 240_000);
  const idA = storeFind("ALPHAMARKER");

  await streamReply(page, "BRAVOMARKER noted.", null as any);
  await page.locator(NEW_CHAT).click();
  await send(page, "F153 NAV BRAVO note", 120_000);
  const idB = storeFind("BRAVOMARKER");
  await page.unroute("**/api/chat");
  record("fr-F153d.setup", { runId: id.runId, idA, idB });

  const row = (cid: string) => page.locator(`[data-testid="conversation-item"][data-conversation-id="${cid}"]`);

  // Phase 1: click slow A, then fast B IMMEDIATELY. With the audit bug the
  // late A resolve owns the screen (and the sidebar's activeId); the law
  // says the latest navigation (B) owns both.
  await page.goto("/");
  await expect(row(idA)).toBeVisible();
  await row(idA).click();
  await row(idB).click();
  await page.waitForTimeout(3000); // far past both IndexedDB loads
  const bodies = page.locator(ANSWER_BODY);
  const shown = await bodies.first().innerText().catch(() => "");
  record("fr-F153d.phase1", { shown: shown.slice(0, 80) });
  expect(shown, "the screen did not end on the latest navigation (B)").toContain("BRAVOMARKER");
  expect(await page.locator(ANSWER_BODY, { hasText: "ALPHAMARKER" }).count(),
    "the late A load overwrote B (navigation-ownership law)").toBe(0);
  const clsB = await row(idB).first().getAttribute("class");
  const clsA = await row(idA).first().getAttribute("class");
  expect(clsB, "the sidebar does not agree with the screen (B active)").toContain("bg-white/[0.07]");
  expect(clsA, "the late A load hijacked the sidebar activeId").not.toContain("bg-white/[0.07]");

  // Phase 2: New during A's load — clear() owns the screen; A's late
  // resolve must not reload the chat the user left.
  await page.goto("/");
  await row(idA).click();
  await page.locator(NEW_CHAT).click();
  await page.waitForTimeout(3000);
  record("fr-F153d.phase2", { bodies: await bodies.count() });
  expect(await bodies.count(), "A's late load reloaded over the fresh New chat").toBe(0);
});

// ── §4b handoff case (b): authorized handoff ON, real Parakeet ─────────────

test("fr-F153e handoff case (b): authorized handoff ON -> real Parakeet transcript of au-1.mp3 + known spoken fact", async ({ page }) => {
  test.setTimeout(1_200_000);
  const id = identity();
  expect(id.handoffAuthorized,
    "fr-F153e is the AUTHORIZED handoff-ON row: launch this batch with -AuthorizeHandoff (the identity record must carry handoffAuthorized=true)").toBe(true);
  await page.goto("/");
  await ensureReasoningOff(page);
  record("fr-F153e", { phase: "queued", at: Date.now(), file: "au-1.mp3" });
  await page.setInputFiles(FILE_INPUT, FIX("au-1.mp3"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status, phases } = await watchChip(chip, 900_000);
  expect(status, `extraction never reached ready (phases: ${phases.join(" -> ")}): the authorized handoff must make the GPU worker admissible`).toBe("ready");
  expect(phases, `no in-flight phase before ready: ${phases.join(" -> ")}`).toContain("processing");
  await expect(page.locator(SEND)).toBeEnabled();
  const said = await sendPrompt(page,
    "In the attached audio chapter, the widow's new clothes make the boy do something unpleasant. What? Reply concisely.",
    300_000);
  const n = normalize(said);
  // The fact is KEYED (fr-U1 key): it exists in the durable transcript the
  // pipeline persisted for this run — not a model guess.
  const recs = fs.readdirSync(STORE).filter((f) => /^c_.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(STORE, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  let attText = "";
  for (const { f } of recs) {
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(STORE, f), "utf8")); } catch { continue; }
    for (const msg of j.messages ?? [])
      for (const a of msg.attachments ?? [])
        if (String(a.name ?? "").includes("au-1") && typeof a.text === "string" && a.text.length > 40)
          attText = a.text;
  }
  record("fr-F153e", { phase: "graded", said: said.slice(0, 200), attTextLen: attText.length, attHasSweat: normalize(attText).includes("sweat") });
  expect(n, `spoken fact missing: ${said.slice(0, 200)}`).toContain("sweat");
  expect(normalize(attText), "the durable transcript for this run does not carry the keyed fact (the answer is not model-side evidence)").toContain("sweat");
});

// ── F153b (2026-11-25): the brief's item-6 hard-acceptance LIVE batch ──────
// Fixtures + answer keys: docs/overnight/fixtures/f153/au-1h-key.json and
// vid-sparse-key.json (SEMANTIC grading law: the FACT, not verbatim wording).
// Every row: real upload → real extraction (watchChip) → real model answer →
// graded on keyed facts PLUS the durable record (chat-store attachment text
// and .data/attach-index meta) — "a plausible answer alone does not pass".
// Handoff rows require the launcher's -AuthorizeHandoff (identity law).

const ATT_ROOT = path.join(process.cwd(), ".data", "attach-index");

/** Durable attachment text the pipeline persisted for the attachment whose
 *  name contains `needle` (newest store record wins). */
function attTextFor(needle: string): string {
  const recs = fs.readdirSync(STORE).filter((f) => /^c_.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(STORE, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  let out = "";
  for (const { f } of recs) {
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(STORE, f), "utf8")); } catch { continue; }
    for (const msg of j.messages ?? [])
      for (const a of msg.attachments ?? [])
        if (String(a.name ?? "").toLowerCase().includes(needle) && typeof a.text === "string" && a.text.length > 40)
          out = a.text;
  }
  return out;
}

/** Newest durable index meta (.data/attach-index/<attId>/meta.json) whose
 *  name contains `needle`. */
function metaFor(needle: string): any {
  if (!fs.existsSync(ATT_ROOT)) throw new Error(`no attach-index root at ${ATT_ROOT}`);
  const dirs = fs.readdirSync(ATT_ROOT)
    .filter((d) => fs.existsSync(path.join(ATT_ROOT, d, "meta.json")))
    .map((d) => ({ d, m: fs.statSync(path.join(ATT_ROOT, d, "meta.json")).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { d } of dirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(ATT_ROOT, d, "meta.json"), "utf8"));
      if (String(meta.name ?? "").toLowerCase().includes(needle)) return meta;
    } catch { /* unparseable meta: not ours */ }
  }
  throw new Error(`no durable index meta names ${needle}`);
}

const one = (cond: boolean[], label: string) =>
  expect(cond.some(Boolean), label).toBe(true);

test("fr-F153f1 one-hour audio: ready with honest coverage record, START fact answered (F153e re-run shape, measured headroom)", async ({ page }) => {
  test.setTimeout(2_100_000);
  const id = identity();
  expect(id.handoffAuthorized, "fr-F153f1 runs real GPU ASR: launch with -AuthorizeHandoff").toBe(true);
  await page.goto("/");
  await ensureReasoningOff(page);
  const t0 = Date.now();
  await page.setInputFiles(FILE_INPUT, FIX("au-1h.mp3"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status, phases } = await watchChip(chip, 1_500_000);
  const readyAt = Date.now();
  record("fr-F153f1", { runId: id.runId, phase: "ready", status, phases, extractMs: readyAt - t0 });
  expect(status, `extraction never reached ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  expect(phases, `no in-flight phase: ${phases.join(" -> ")}`).toContain("processing");
  const said = await sendPrompt(page,
    "F153F1 In the first two minutes of the attached hour of audio, what did the widow say about sweating? Reply concisely.",
    300_000);
  const n = normalize(said);
  const att = normalize(attTextFor("au-1h"));
  const meta = metaFor("au-1h");
  record("fr-F153f1", {
    phase: "graded", said: said.slice(0, 240),
    durationSec: meta.durationSec, chunkCount: meta.chunkCount,
    speech: meta.speech ?? null, attTextLen: att.length, attHasSweat: att.includes("sweat"),
  });
  expect(n, `START fact missing: ${said.slice(0, 200)}`).toContain("sweat");
  expect(att, "the durable transcript does not carry the START fact").toContain("sweat");
  expect(Number(meta.durationSec) > 3000, `durable record lost the hour (durationSec=${meta.durationSec})`).toBe(true);
  expect(meta.speech && meta.speech.complete === true,
    `coverage record is not honest-complete for a fully decoded hour: ${JSON.stringify(meta.speech ?? null)}`).toBe(true);
});

test("fr-F153f2 reopen the hour-chat: MIDDLE fact (graveyard) answered from the same durable record", async ({ page }) => {
  test.setTimeout(900_000);
  const id = identity();
  const cid = storeFind("F153F1");
  await page.goto("/");
  await page.locator(`[data-testid="conversation-item"][data-conversation-id="${cid}"]`).click();
  await expect(page.locator(ASSISTANT_DONE).first()).toBeVisible({ timeout: 30_000 });
  const said = await sendPrompt(page,
    "Later in the recording the boys take a dead cat to a graveyard at midnight. What did they witness there, and who was blamed?",
    300_000);
  const n = normalize(said);
  const att = normalize(attTextFor("au-1h"));
  record("fr-F153f2", { runId: id.runId, cid, said: said.slice(0, 240), attHasPotter: att.includes("potter") });
  expect(n, `MIDDLE fact missing: ${said.slice(0, 200)}`).toContain("graveyard");
  one([n.includes("potter"), n.includes("muff"), n.includes("knife")], `blame fact missing: ${said.slice(0, 200)}`);
  expect(att, "the durable transcript does not carry the MIDDLE fact").toContain("potter");
});

test("fr-F153f3 reopen repeat: END fact + SILENT-INTERVAL honesty (measured silence, never invented speech)", async ({ page }) => {
  test.setTimeout(900_000);
  const id = identity();
  const cid = storeFind("F153F1");
  await page.goto("/");
  await page.locator(`[data-testid="conversation-item"][data-conversation-id="${cid}"]`).click();
  await expect(page.locator(ASSISTANT_DONE).first()).toBeVisible({ timeout: 30_000 });
  const end = await sendPrompt(page,
    "In the last minute of the recording, what did the new judge do for Pap and what happened that night?",
    300_000);
  const ne = normalize(end);
  record("fr-F153f3.end", { runId: id.runId, said: end.slice(0, 240) });
  expect(ne, `END fact missing: ${end.slice(0, 200)}`).toContain("judge");
  one([ne.includes("fireengine"), ne.includes("garden"), ne.includes("snow")], `night fact missing: ${end.slice(0, 200)}`);

  // 30:34-30:54 is a measured-anechoic 20 s insert (-76.9 dB): the honest
  // answer reports silence; naming ANY story content is fabrication.
  const sil = await sendPrompt(page,
    "What is said in the recording between 30:34 and 30:54?",
    300_000);
  const ns = normalize(sil);
  const invented = ["widow", "sweat", "graveyard", "potter", "judge", "corkscrew", "pap", "injun", "robinson"];
  record("fr-F153f3.silence", {
    runId: id.runId, said: sil.slice(0, 240),
    honest: one0(ns), inventedHits: invented.filter((w) => ns.includes(w)),
  });
  one0(ns);
  expect(invented.filter((w) => ns.includes(w)), `silence interval answered with invented speech: ${sil.slice(0, 200)}`).toEqual([]);
});

function one0(ns: string): boolean {
  return ["silence", "silent", "nothingissa", "nospeech", "noaudio", "nosound", "nobehit", "notsaid", "nothingissaid", "nopart", "gap"].some((w) => ns.includes(w));
}

test("fr-F153f4 quiet passage (corkscrew under 13.9 dB) + phrase spanning the chapter boundary", async ({ page }) => {
  test.setTimeout(900_000);
  const id = identity();
  const cid = storeFind("F153F1");
  await page.goto("/");
  await page.locator(`[data-testid="conversation-item"][data-conversation-id="${cid}"]`).click();
  await expect(page.locator(ASSISTANT_DONE).first()).toBeVisible({ timeout: 30_000 });
  const quiet = await sendPrompt(page,
    "Around 42:40 Pap gives a temperance speech. What remark ruined it?",
    300_000);
  const nq = normalize(quiet);
  const att = normalize(attTextFor("au-1h"));
  record("fr-F153f4.quiet", { runId: id.runId, said: quiet.slice(0, 240), attHasCorkscrew: att.includes("corkscrew") });
  one([nq.includes("corkscrew"), nq.includes("temperance")], `quiet-passage fact missing (13.9 dB-quiet speech must survive): ${quiet.slice(0, 200)}`);
  expect(att, "the durable transcript lost the quiet passage").toContain("corkscrew");

  const bnd = await sendPrompt(page,
    "At the boundary around 30:30 one chapter ends and the next begins: what did Pap threaten, and what legal action was filed in the widow's name?",
    300_000);
  const nb = normalize(bnd);
  record("fr-F153f4.boundary", { runId: id.runId, said: bnd.slice(0, 240) });
  one([nb.includes("setthelaw"), nb.includes("law"), nb.includes("court")], `Pap threat missing: ${bnd.slice(0, 200)}`);
  one([nb.includes("suit"), nb.includes("lawsuit")], `lawsuit fact missing across the boundary: ${bnd.slice(0, 200)}`);
});

test("fr-F153g container matrix: WAV/M4A/AAC/OGG/FLAC each reach ready and answer the same keyed fact", async ({ page }) => {
  test.setTimeout(2_400_000);
  const id = identity();
  const fmts = ["wav", "m4a", "aac", "ogg", "flac"];
  const verdicts: Record<string, any> = {};
  for (const fmt of fmts) {
    await page.locator(NEW_CHAT).click();
    await page.setInputFiles(FILE_INPUT, FIX(`au-clip.${fmt}`));
    const chip = page.locator(CHIP).last();
    await expect(chip).toBeVisible();
    const { status, phases } = await watchChip(chip, 420_000);
    if (status !== "ready") { verdicts[fmt] = { status, phases }; continue; }
    const said = await sendPrompt(page,
      "In the attached audio clip, what did the widow say about sweating? One short line.",
      300_000);
    const n = normalize(said);
    const att = normalize(attTextFor(`au-clip.${fmt}`));
    verdicts[fmt] = { status, said: said.slice(0, 160), attHasSweat: att.includes("sweat") };
    record("fr-F153g", { runId: id.runId, fmt, ...verdicts[fmt] });
    expect(n, `${fmt}: START fact missing from the answer: ${said.slice(0, 160)}`).toContain("sweat");
    expect(att, `${fmt}: durable transcript does not carry the fact`).toContain("sweat");
  }
  record("fr-F153g", { runId: id.runId, phase: "matrix", verdicts });
  for (const fmt of fmts) {
    expect((verdicts[fmt] as any).status, `${fmt} never reached ready`).toBe("ready");
  }
});

test("fr-F153h1 sparse-speech video: early/middle/late speech + on-screen labels + color + 10s MARK-27 event", async ({ page }) => {
  test.setTimeout(2_400_000);
  const id = identity();
  expect(id.handoffAuthorized, "fr-F153h1 runs real GPU ASR over a 32-min track: -AuthorizeHandoff required").toBe(true);
  await page.locator(NEW_CHAT).click();
  const t0 = Date.now();
  await page.setInputFiles(FILE_INPUT, FIX("vid-sparse.mp4"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status, phases } = await watchChip(chip, 1_500_000);
  record("fr-F153h1", { runId: id.runId, phase: "ready", status, phases, extractMs: Date.now() - t0 });
  expect(status, `video extraction never reached ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  const meta = metaFor("vid-sparse");
  record("fr-F153h1.meta", {
    durationSec: meta.durationSec, frames: (meta.frames ?? []).length,
    hasAudioTrack: meta.timeline?.hasAudioTrack, coverage: meta.timeline?.coverage ?? null,
    speech: meta.speech ?? null,
  });
  expect((meta.frames ?? []).length > 0, "the durable video record carries no keyframes (coverage law)").toBe(true);

  const early = await sendPrompt(page,
    "In the first three minutes of this video's audio, what did the speaker say about sweating?", 300_000);
  const ne = normalize(early);
  record("fr-F153h1.early", { said: early.slice(0, 200) });
  expect(ne, `early speech fact missing: ${early.slice(0, 200)}`).toContain("sweat");

  const label = await sendPrompt(page,
    "What on-screen text appears during the first ten minutes, and on what background color?", 300_000);
  const nl = normalize(label);
  record("fr-F153h1.label", { said: label.slice(0, 200) });
  expect(nl, `blue-phase label missing: ${label.slice(0, 200)}`).toContain("alpha");
  expect(nl, `blue color missing (pixel path): ${label.slice(0, 200)}`).toContain("blue");

  const mark = await sendPrompt(page,
    "Around 16:30 a brief on-screen text appears for a few seconds. What is it?", 300_000);
  const nm = normalize(mark);
  record("fr-F153h1.mark", { said: mark.slice(0, 200) });
  expect(nm, `10-second MARK-27 visual event missed (sparse event must survive frame budgets): ${mark.slice(0, 200)}`).toContain("mark27");

  const color = await sendPrompt(page,
    "What color is the screen at 25 minutes in?", 300_000);
  const nc = normalize(color);
  record("fr-F153h1.color", { said: color.slice(0, 200) });
  expect(nc, `late color missing (pixel-only fact): ${color.slice(0, 200)}`).toContain("green");

  const late = await sendPrompt(page,
    "Near the end, what happened at the new judge's house in the audio?", 300_000);
  const nla = normalize(late);
  const att = normalize(attTextFor("vid-sparse"));
  record("fr-F153h1.late", { said: late.slice(0, 200), attHasFire: att.includes("fireengine") || att.includes("fireenginecalled") });
  one([nla.includes("fire"), nla.includes("drunk"), nla.includes("garden")], `late speech fact missing: ${late.slice(0, 200)}`);
  expect(att.includes("fire") || att.includes("garden") || att.includes("judge"),
    "the durable video transcript lacks the late speech (evidence law)").toBe(true);
});

test("fr-F153h2 video with NO audio track: honest no-track reporting, never an invented transcript", async ({ page }) => {
  test.setTimeout(900_000);
  const id = identity();
  await page.locator(NEW_CHAT).click();
  await page.setInputFiles(FILE_INPUT, FIX("vid-quiet.mp4"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status, phases } = await watchChip(chip, 420_000);
  record("fr-F153h2", { runId: id.runId, status, phases });
  expect(status, `no-audio video never reached ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  const meta = metaFor("vid-quiet");
  record("fr-F153h2.meta", { hasAudioTrack: meta.timeline?.hasAudioTrack, frames: (meta.frames ?? []).length, speech: meta.speech ?? null });
  expect(meta.timeline?.hasAudioTrack === false, "durable record claims an audio track that does not exist").toBe(true);
  const said = await sendPrompt(page,
    "Summarize what is SAID in this video. If nothing is said, say so.", 300_000);
  const ns = normalize(said);
  const invented = ["widow", "sweat", "graveyard", "potter", "judge", "injun"];
  record("fr-F153h2.answer", { said: said.slice(0, 240), inventedHits: invented.filter((w) => ns.includes(w)) });
  one(["noaudio", "nospeech", "notspeak", "nosound", "silent", "nothing", "notcontain", "withoutaudio", "notrack", "noaudiotrack", "nospoken"].map((w) => ns.includes(w)),
    `no-track video answered with invented speech: ${said.slice(0, 200)}`);
  expect(invented.filter((w) => ns.includes(w)), `no-audio transcript invented: ${said.slice(0, 200)}`).toEqual([]);
});

test("fr-F153i engine-use proof: the answering model can disclose the speech engine + recognition clock from the durable record", async ({ page }) => {
  test.setTimeout(1_200_000);
  const id = identity();
  expect(id.handoffAuthorized, "fr-F153i runs real GPU ASR: -AuthorizeHandoff required").toBe(true);
  await page.locator(NEW_CHAT).click();
  await page.setInputFiles(FILE_INPUT, FIX("au-clip.wav"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status } = await watchChip(chip, 420_000);
  expect(status, "clip extraction never reached ready").toBe("ready");
  const said = await sendPrompt(page,
    "Which speech recognition engine transcribed the attached audio, and when did recognition run? One line, from the record.",
    300_000);
  const n = normalize(said);
  record("fr-F153i", { runId: id.runId, said: said.slice(0, 300) });
  expect(n, `engine-use proof missing (expect the Parakeet engine + recognition clock): ${said.slice(0, 240)}`).toContain("parakeet");
  one([/\d{4}-\d{2}-\d{2}/.test(said), /\d{1,2}:\d{2}/.test(said), n.includes("utc")],
    `recognition clock missing: ${said.slice(0, 240)}`);
});

test("fr-F153j second recording (au-2.mp3): fresh-chat fact + durable record, repeat of the admission path", async ({ page }) => {
  test.setTimeout(1_800_000);
  const id = identity();
  expect(id.handoffAuthorized, "fr-F153j runs real GPU ASR: -AuthorizeHandoff required").toBe(true);
  await page.locator(NEW_CHAT).click();
  await page.setInputFiles(FILE_INPUT, FIX("au-2.mp3"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const { status, phases } = await watchChip(chip, 900_000);
  expect(status, `au-2 extraction never reached ready (phases: ${phases.join(" -> ")})`).toBe("ready");
  const said = await sendPrompt(page,
    "What group do the boys form in this chapter, and what do they swear to?", 300_000);
  const n = normalize(said);
  const att = normalize(attTextFor("au-2"));
  record("fr-F153j", { runId: id.runId, said: said.slice(0, 240), attLen: att.length });
  one([n.includes("band"), n.includes("gang"), n.includes("robber")], `band fact missing: ${said.slice(0, 200)}`);
  one([n.includes("swear"), n.includes("murder"), n.includes("secrecy")], `oath fact missing: ${said.slice(0, 200)}`);
  expect(att.length > 40, "no durable transcript for au-2").toBe(true);
});
