/**
 * fr-20261122a — file-reading real-world regression, LIVE batch
 * (exclusive Playwright; run ONLY via scripts/run-browser-e2e-exclusive.ps1).
 *
 * One prepared batch, one submission: every major production reader gets a
 * real-UI live row (picker upload -> extraction chip -> real model reply)
 * against the frozen corpus staged under NEUTRAL names in
 * .data/tmp/file-regression/fr-20261122a/dl/live. Grading key (never fed to
 * the app): docs/overnight/file-regression-fr-20261122a/ANSWER-KEY.md.
 *
 * Every row requires the FACT BYTES inside the model's completed reply
 * (F78 law): upload success, a ready chip, or a plausible sentence cannot
 * pass. Rows log full replies and append structured timings to
 * docs/overnight/file-regression-fr-20261122a/results-live.jsonl
 * (upload->ready, question->first-token, total answer, scroll state).
 * Strengthened F78 laws asserted on every row: exactly one assistant reply
 * per send, no retry/leaked-retry text, no error chrome.
 */
import { test, expect, Locator, Page, Response } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRefusal } from "./helpers/refusal";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-live.jsonl",
);

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const PROGRESS = '[data-testid="progress-chip"]';
const ERRORS = '[data-testid="error"]';
const SCROLL = '[data-testid="messages-scroll"]';
// F84 (2026-11-23): the SEMANTIC answer body only — the assistant card's
// innerText carries UI chrome ("Thought for 4s", "View reasoning", "Copy"),
// which broke exact-match rows (fr-X4's body was exactly `0`, fr-U6's regex
// ran over chrome text). Readers take this element's text; the card remains
// the fallback when no content div exists (error states throw before it).
const ANSWER_BODY = '[data-testid="answer-body"]';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// F93: every h:mm:ss / mm:ss timestamp an answer states, in seconds. Used to
// GRADE timestamp claims (seam window, grounded-summary keys) — evidence
// derivation in docs/overnight/file-regression-fr-20261122a/evidence-f93-keys.txt.
function tsSecs(s: string): number[] {
  return [...s.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g)]
    .map((m) => (m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]));
}

function record(row: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), row, ...obj }) + "\n");
}

// F82: REFUSAL/isRefusal extracted to tests/helpers/refusal.ts (unit-tested
// model-free with a negative control; the C3 fr-P9 answer proved the scorer
// was the first failing layer).

async function waitChipFinal(chip: Locator, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await chip.getAttribute("data-status").catch(() => null);
    if (status === "ready" || status === "error") return status;
    await new Promise(r => setTimeout(r, 250));
  }
  return "timeout";
}

interface Turn {
  said: string; readyMs: number; ttftMs: number; totalMs: number;
  newReplies: number; driving: number; bottomGap: number; chipLabel: string;
  refused: string; // non-empty = product refused at the upload boundary (F75(b))
}

// F75(e): kill-safe evidence. Each test appends a start row, each milestone
// (chip ready, first token) appends its own row, and the end row carries the
// status — a run killed mid-test leaves every milestone it reached.
let currentRow = "";
test.beforeEach(({}, testInfo) => {
  currentRow = testInfo.title;
  record(testInfo.title, { phase: "start" });
});
test.afterEach(({}, testInfo) => {
  record(testInfo.title, { phase: "end", status: testInfo.status, durationMs: testInfo.duration });
});

/** Fresh page, reasoning off, upload -> ready -> prompt -> completed reply,
 *  with layer timings. scrollUpMidStream: exercise the scroll-lock release
 *  law during streaming. */
async function send(
  page: Page, file: string, prompt: string,
  t: { extract: number; model: number }, opts: { scrollUpMidStream?: boolean; allowUploadRefusal?: boolean } = {},
): Promise<Turn> {
  await page.goto("/");
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }

  const tUp = Date.now();
  await page.setInputFiles(FILE_INPUT, file);
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const status = await waitChipFinal(chip, t.extract);
  if (status !== "ready") {
    const title = await chip.getAttribute("title");
    // F75(b): an upload-boundary refusal satisfies "refuse, don't pretend" in
    // its STRICTER form — the app declined before any model turn. Opt-in rows
    // receive it as a PASS path instead of a thrown harness error.
    if (status === "error" && opts.allowUploadRefusal) {
      return { said: "", readyMs: Date.now() - tUp, ttftMs: -1, totalMs: 0,
        newReplies: 0, driving: 0, bottomGap: 0, chipLabel: "", refused: `chip error: ${title}` };
    }
    throw new Error(`extraction not ready (status: ${status}, title: ${title})`);
  }
  const readyMs = Date.now() - tUp;
  record(`${currentRow}.milestone`, { phase: "ready", file: path.basename(file), readyMs });

  const before = await page.locator(ASSISTANT).count();
  const tAsk = Date.now();
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();

  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
  let ttftMs = -1;
  let scrolledUp = false;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    // F84: first-token is CONTENT, not card chrome — the "Thought for…" line
    // can appear seconds before any answer bytes (P1's C3 "682 ms
    // first-token" was the chrome, measured while the web loop still ran).
    if (ttftMs < 0 && (await reply.locator(ANSWER_BODY).first().innerText().catch(() => "")).trim().length > 0) {
      ttftMs = Date.now() - tAsk;
      record(`${currentRow}.milestone`, { phase: "first-token", ttftMs });
      if (opts.scrollUpMidStream) {
        // F62 (2026-11-22): the old shape wrote scrollTop=0 programmatically at
        // TTFT. Two harness defects: (1) a programmatic write is NOT user
        // intent under the reducer law (only wheel/touch/keyboard/scrollbar
        // create it), and (2) on a short answer the content FITS, so the write
        // is a no-op (maxScrollTop=0 → clampedAtEnd keeps following=true) and
        // bottomGap>160 is structurally unmeasurable (fr-20261122b: bottomGap=0
        // on an 81-char answer). Now the real-gesture shape proven live by
        // scripts/scroll-verify/check-upscroll.mjs at F77: wheel UP over the
        // scroller, gated on the content being tall enough that the released
        // gap is measurable.
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-testid="messages-scroll"]') as HTMLElement | null;
          return !!el && el.scrollHeight > el.clientHeight + 200;
        }, { timeout: 120_000 });
        const sbox = await page.locator(SCROLL).boundingBox();
        if (sbox) {
          await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
          await page.mouse.wheel(0, -400);
        }
        scrolledUp = true;
      }
    }
    if (state === "complete") {
      const chipLabel = (await page.locator(PROGRESS).first().innerText().catch(() => "")).trim();
      const driving = await page.getByText("RUKE is driving").count();
      const bottomGap = await page.locator(SCROLL).evaluate((el: Element) => {
        const e = el as HTMLElement;
        return e.scrollHeight - e.scrollTop - e.clientHeight;
      });
      // F84: score the semantic answer body, not the card chrome.
      const body = reply.locator(ANSWER_BODY);
      const said = (await (await body.count()
        ? body.first().innerText()
        : reply.innerText()).catch(() => "")).trim();
      const newReplies = (await page.locator(ASSISTANT).count()) - before;
      void scrolledUp;
      return { said, readyMs, ttftMs, totalMs: Date.now() - tAsk, newReplies, driving, bottomGap, chipLabel, refused: "" };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

/** Follow-up question in the SAME chat (attachment already extracted). */
async function followUp(page: Page, prompt: string, t: { model: number }): Promise<Turn> {
  const before = await page.locator(ASSISTANT).count();
  const tAsk = Date.now();
  await page.locator("textarea").first().fill(prompt);
  await expect(page.locator(SEND)).toBeEnabled();
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + t.model;
  let ttftMs = -1;
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    // F84: first-token is CONTENT, not card chrome — the "Thought for…" line
    // can appear seconds before any answer bytes (P1's C3 "682 ms
    // first-token" was the chrome, measured while the web loop still ran).
    if (ttftMs < 0 && (await reply.locator(ANSWER_BODY).first().innerText().catch(() => "")).trim().length > 0) {
      ttftMs = Date.now() - tAsk;
      record(`${currentRow}.milestone`, { phase: "first-token", ttftMs });
    }
    if (state === "complete") {
      // F84: score the semantic answer body, not the card chrome.
      const body = reply.locator(ANSWER_BODY);
      const said = (await (await body.count()
        ? body.first().innerText()
        : reply.innerText()).catch(() => "")).trim();
      const newReplies = (await page.locator(ASSISTANT).count()) - before;
      const bottomGap = await page.locator(SCROLL).evaluate((el: Element) => {
        const e = el as HTMLElement;
        return e.scrollHeight - e.scrollTop - e.clientHeight;
      });
      return { said, readyMs: 0, ttftMs, totalMs: Date.now() - tAsk, newReplies, driving: 0, bottomGap, chipLabel: "", refused: "" };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

/** F95: text-only opener in a fresh conversation (no attachment), then the
 *  SAME completion loop as followUp. */
async function sendText(page: Page, prompt: string, t: { model: number }): Promise<Turn> {
  await page.goto("/");
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(effort).toHaveAttribute("aria-label", "Reasoning effort: Off");
  }
  return followUp(page, prompt, t);
}

/* ── F80 (2026-11-23): DISPATCH-EVENT capture on the /api/chat wire ──────
 * F80's live acceptance grades DISPATCH events, not UI labels. The web
 * tool loop stamps every action on the stream: `web:activity` frames
 * (kind search/read_page, status started -> completed/failed, real
 * counts; lib/types.ts StageEvent ⇔ stages.rs, key order pinned by the
 * contracts tests) and the server-issued per-turn action ledger on the
 * `web_meta` frame (⇔ web-tool-loop.ts researchLedger ⇔ web_loop.rs
 * mirror). The Playwright page cannot see the server-side outbound
 * fetches themselves, so these frames ARE the dispatch evidence, on the
 * TS loop and the Rust bridge alike. Frames ride as `data: {json}` SSE
 * lines (app/api/chat/route.ts:707); response.body() resolves once the
 * turn's stream closes. A gate REJECTION is ledger-only (ok:false,
 * requested:0 — the lookup never ran), so a REJECTED entry is NOT a
 * dispatch event: it is the gate firing at the dispatch seam, recorded.
 * Grading NEVER depends on public retrieval: the F80 control row grades
 * the ESCAPE (requested>0, no attachment-scope rejection), retrieved is
 * recorded only. */
interface Dispatch { started: number; requested: number; retrieved: number; rejected: string[] }
interface StageFrame { stage?: string; activityStatus?: string; researchLedger?: { actions?: { tool: string; ok: boolean; requested: number; retrieved: number; error?: string }[] } }
function countDispatch(frames: StageFrame[]): Dispatch {
  const d = { started: 0, requested: 0, retrieved: 0, rejected: [] as string[] };
  for (const f of frames) {
    // F147 (2026-11-24): the wire lifecycle key is `activityStatus` (stages.rs
    // ⇔ web-tool-loop.ts, pinned by the contract tests); `status` retired.
    if (f.stage === "web:activity" && f.activityStatus === "started") d.started++;
    for (const a of f.researchLedger?.actions ?? []) {
      d.requested += a.requested;
      d.retrieved += a.retrieved;
      if (!a.ok) d.rejected.push(`${a.tool}:${a.error ?? "?"}`);
    }
  }
  return d;
}

function chatCapture(page: Page): { begin: () => void; collect: () => Promise<Dispatch> } {
  const resps: Response[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/chat") resps.push(r);
  });
  let mark = 0;
  return {
    begin: () => { mark = resps.length; },
    collect: async () => {
      const frames: StageFrame[] = [];
      for (const r of resps.slice(mark)) {
        let body = "";
        try { body = (await r.body()).toString("utf8"); } catch { continue; }
        for (const line of body.split(/\r?\n/)) {
          const m = /^data: (.*)$/.exec(line);
          if (!m || m[1] === "[DONE]") continue;
          // F147 (2026-11-24): stage frames ride WRAPPED as
          // `data: {"ruke_stage":{...}}` (live probe .data/tmp/g147-probe.sse,
          // 2026-11-24: 4 web:activity + 3 web_meta frames, ledger actions
          // web_search req 3/ret 10, read_page req 2/ret 2). The pre-F147
          // capture read top-level keys and saw ONLY zeros — fr-W1 was red in
          // every run since the capture was written; the product wire was
          // correct all along. Unwrap when wrapped; plain frames (TS-direct
          // path) pass through untouched.
          try { const j = JSON.parse(m[1]); frames.push((j.ruke_stage ?? j) as StageFrame); } catch { /* non-JSON keepalive line */ }
        }
      }
      return countDispatch(frames);
    },
  };
}

/** F147 (2026-11-24): B11 composer-gate law (lib/chat/composerGate.ts):
 * Send is DISABLED for an empty draft with no attachments — the retired
 * `toBeEnabled(SEND)` probe on an EMPTY composer fails BY DESIGN since the
 * gate shipped (2026-11-22). "Stage cleared, composer live" is the gate's
 * own contract: generation inactive (no Stop button) AND typing one
 * character enables Send. The draft is restored after probing. */
async function composerLive(page: Page): Promise<void> {
  await expect(page.locator('button[aria-label="Stop generating"]'),
    "composer live: generation still active").toHaveCount(0, { timeout: 30_000 });
  const input = page.locator("textarea").first();
  const prev = await input.inputValue().catch(() => "");
  await input.fill("·");
  await expect(page.locator(SEND), "composer live: typing a char does not enable Send")
    .toBeEnabled({ timeout: 10_000 });
  await input.fill(prev);
}

/** Common strengthened-law assertions on a completed turn (F78). */
function laws(row: string, t: Turn): void {
  expect(t.newReplies, `${row}: more than one assistant reply for one send`).toBe(1);
  expect(t.said.toLowerCase(), `${row}: reply carries retry text`).not.toMatch(/retry|try again/);
}

function log(row: string, t: Turn): void {
  console.log(`[${row}] ready=${t.readyMs}ms ttft=${t.ttftMs}ms total=${t.totalMs}ms :: ${t.said.replace(/\s+/g, " ").slice(0, 140)}`);
  record(row, { ...t, said: t.said.slice(0, 1200) });
}

// F85 (2026-11-23): per-question verdicts for grouped rows. The upload stays
// shared (the journey law needs it), but a shared-fixture/key failure must
// never blend the group's verdict: the old expect-after-expect shape aborted
// the test at the FIRST failing question, so the evidence trail showed only
// one blended signal and the remaining questions' verdicts were lost. Each
// question runs inside q() — its own PASS/FAIL verdict row is recorded, a
// throw (including "the assistant never finished answering": a timeout stays
// a timeout) fails ONLY that question, and gradeGroup() fails the test at the
// END with the full per-question table.
const groupVerdicts: Map<string, { row: string; ok: boolean; reason: string }> = new Map();
async function q(row: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    groupVerdicts.set(row, { row, ok: true, reason: "" });
    record(`${row}.verdict`, { pass: true });
  } catch (e) {
    const reason = (e as Error).message.split("\n")[0].slice(0, 300);
    groupVerdicts.set(row, { row, ok: false, reason });
    record(`${row}.verdict`, { pass: false, reason });
  }
}
function gradeGroup(group: string): void {
  const rows = [...groupVerdicts.values()];
  groupVerdicts.clear();
  record(`${group}.grade`, { rows });
  const bad = rows.filter((r) => !r.ok);
  expect(bad, `per-question verdicts [${group}]: ${rows.map((r) => `${r.row}=${r.ok ? "PASS" : `FAIL(${r.reason})`}`).join(" ")}`).toEqual([]);
}

const FIX = (name: string): string => {
  const p = path.join(LIVE, name);
  if (!fs.existsSync(p)) throw new Error(`fr live fixture missing: ${p}`);
  return p;
};

// Store isolation: the launcher points WEBUI_DATA_DIR at .data/e2e-store.
// STATE-CHATING rows may only run once VERIFIED — fr-Z0 (declared right
// after the first chat) checks that the app's chat persistence changed
// inside the isolated store while the REAL user store stayed untouched.
// (v1 counted files only: the app appends chats to an EXISTING conversation
// file, so the count never grows and the probe false-failed — 2026-11-22
// run, recorded as a harness defect; mtime + real-store probe added.)
const STORE = path.join(process.cwd(), ".data", "e2e-store");
const REAL_STORE = path.join(os.homedir(), ".local-intelligence", "conversations");
function storeSnap(dir: string): { n: number; maxM: number } {
  if (!fs.existsSync(dir)) return { n: -1, maxM: 0 };
  let n = 0, maxM = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { n++; maxM = Math.max(maxM, fs.statSync(p).mtimeMs); }
    }
  }
  return { n, maxM };
}
let storeBaseline: { iso: { n: number; maxM: number }; real: { n: number; maxM: number } };
test.beforeAll(() => { storeBaseline = { iso: storeSnap(STORE), real: storeSnap(REAL_STORE) }; });

// ── text / code ──────────────────────────────────────────────────────────
test("fr-T1 utf16 tail beyond first chunk + streaming scroll-lock release", async ({ page }) => {
  test.setTimeout(420_000);
  // F62 retarget (spec fingerprint change, recorded at C3 freeze): the reply
  // must be TALL so the released scroll gap is measurable — a one-sentence
  // answer fits the viewport and can never show bottomGap > 160. The key
  // assertion (final-sentence tail beyond the first chunk) is unchanged.
  const t = await send(page, FIX("txt-1.txt"),
    "Read the attached text file to its END. Reply with ONLY a code block containing, verbatim and preserving every line break: the file's FIRST 40 LINES, then a blank line, then its FINAL SENTENCE. Nothing else.",
    { extract: 120_000, model: 180_000 }, { scrollUpMidStream: true });
  log("fr-T1", t);
  laws("fr-T1", t);
  expect(t.said.toLowerCase()).toContain("copying conditions");
  // Upward scroll during streaming releases the bottom-follow lock: at
  // completion the viewport must NOT be yanked back to the bottom.
  expect(t.bottomGap, `scroll lock not released (gap ${t.bottomGap})`).toBeGreaterThan(160);
});

test("fr-Z0 store isolation VERIFIED (chat persistence lands in .data/e2e-store)", async () => {
  // Runs immediately after the first chat (fr-T1). The ISOLATED store must
  // have been written (count grew OR a file's mtime advanced — the app
  // appends to an existing conversation file, so mtime is the reliable
  // signal), and the REAL user store must be byte-for-byte untouched since
  // beforeAll. Unverified isolation = BLOCKED for state-changing rows.
  // F147 (2026-11-24): persistence is an ASYNC flush ~1 s after the answer
  // (fixture file mtimes land at chat-end + <1 s); the old single snapshot
  // raced it (recorded n 463->463 with no mtime advance). Bounded poll
  // (20 × 250 ms, real store verified untouched at EVERY sample — the
  // isolation law is sampled MORE strictly, not less).
  let iso = storeSnap(STORE), real = storeSnap(REAL_STORE);
  for (let i = 0; i < 20; i++) {
    iso = storeSnap(STORE); real = storeSnap(REAL_STORE);
    if (iso.n > storeBaseline.iso.n || iso.maxM > storeBaseline.iso.maxM) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const isoActive = storeBaseline.iso.n >= 0 && (iso.n > storeBaseline.iso.n || iso.maxM > storeBaseline.iso.maxM);
  const realUntouched = real.n === storeBaseline.real.n && real.maxM === storeBaseline.real.maxM;
  record("fr-Z0", {
    storeDir: STORE, realStore: REAL_STORE,
    isoBaseline: storeBaseline.iso, isoNow: iso, isoActive,
    realBaseline: storeBaseline.real, realNow: real, realUntouched,
  });
  expect(storeBaseline.iso.n, `isolated store missing: ${STORE}`).toBeGreaterThanOrEqual(0);
  expect(isoActive, `isolated store not written after first chat (n ${storeBaseline.iso.n}->${iso.n}, maxM ${storeBaseline.iso.maxM}->${iso.maxM}): isolation UNVERIFIED`).toBe(true);
  expect(realUntouched, `REAL user store touched during the run (${storeBaseline.real.n}->${real.n} files): isolation VIOLATED`).toBe(true);
});

test("fr-T2 utf32 tail", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("txt-2.txt"),
    "Read the attached text file to its END and reply with the final sentence exactly as written. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-T2", t); laws("fr-T2", t);
  expect(t.said.toLowerCase()).toContain("copying conditions");
});

test("fr-T3 quoted multiline CSV cell (row 50, column b)", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("txt-3.csv"),
    "In the attached CSV, what is the value of column b in the row labelled Row 50 (the file labels its logical rows; a quoted field spanning lines is one row)? Report it exactly, including any line break shown inside it.",
    { extract: 120_000, model: 180_000 });
  log("fr-T3", t); laws("fr-T3", t);
  await q("fr-T3 row 50", async () => {
    const low = t.said.toLowerCase();
    expect(low).toContain("average cost per fte");
    expect(low).toContain("£");
  });
  // F92 (2026-11-23): the quoted-EMBEDDED-NEWLINE record was never graded
  // live — Row 51's column b is ONE logical cell spanning TWO physical
  // lines ("S1.2c\n(multi-line cell)"). Addressing law: the row labelled
  // Row 51 must address the record, not the physical line (physical lines
  // and logical records diverge from Row 51 onward). Key derived from the
  // file bytes by an independent RFC4180 scan, pinned model-free in
  // __tests__/f85-fixture-preflight.test.ts. SEPARATE verdict (F83 law).
  await q("fr-T3b quoted-newline addressing", async () => {
    const t2 = await followUp(page,
      "In the same attached CSV, what is the value of column b in the row labelled Row 51? Report it exactly, including the line break inside the cell. Nothing else.",
      { model: 180_000 });
    log("fr-T3b", t2); laws("fr-T3b", t2);
    expect(normalize(t2.said), `multi-line cell not delivered as one logical row: ${t2.said.slice(0, 300)}`)
      .toContain("s12cmultilinecell");
  });
  gradeGroup("fr-T3/F92");
});

test("fr-T4 JSONL final record marker", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("txt-4.jsonl"),
    "The attached JSONL file records notebook cells in order. Reply with the marker string of the FINAL record and its cells_total value. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-T4", t); laws("fr-T4", t);
  expect(normalize(t.said)).toContain("tail9x7z");
  expect(t.said).toContain("68");
});

test("fr-T5 real Dockerfile version pins", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("txt-5.dockerfile"),
    "In the attached Dockerfile, what are the GO_VERSION and RUST_VERSION (or XX version) build args? Reply with the exact values.",
    { extract: 120_000, model: 180_000 });
  log("fr-T5", t); laws("fr-T5", t);
  expect(t.said).toContain("1.27.4");
});

test("fr-G2 whitespace-padded filename (negative: silent passthrough fails)", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("  README  .txt"),
    "Which distribution is this README for? Reply with the distribution name. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-G2", t); laws("fr-G2", t);
  expect(normalize(t.said)).toContain("gnuhello");
});

test("fr-G1 text content with .pdf extension (negative: must not pretend)", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("neg-1.pdf"),
    "Summarize page 1 of the attached PDF in one sentence.",
    { extract: 120_000, model: 180_000 }, { allowUploadRefusal: true });
  log("fr-G1", t);
  // F75(b): the app's law is "refuse, don't pretend". An upload-boundary
  // refusal satisfies it in the STRICTER form (no model turn at all) — PASS;
  // the old harness threw there and recorded FAIL.
  if (t.refused) {
    record("fr-G1.refused-at-upload", { chip: t.refused.slice(0, 300) });
    return;
  }
  laws("fr-G1", t);
  // Must flag it is not a real PDF (refusal), NOT answer with PDF page 1.
  expect(isRefusal(t.said) || /not a (real )?pdf|plain text|text file/i.test(t.said),
    `fake PDF was answered straight: ${t.said.slice(0, 200)}`).toBe(true);
});

// ── doc ──────────────────────────────────────────────────────────────────
test("fr-D1 footnote-only word", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("notes-1.docx"),
    "The attached document has a footnote. Reply with the exact single word that appears ONLY in the footnote, not in the body. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-D1", t); laws("fr-D1", t);
  expect(normalize(t.said)).toContain("snoska");
});

test("fr-D5/D4 tracked deletion + insertion visible (one upload, two questions; law recorded: accepted-only refusal OK)", async ({ page }) => {
  test.setTimeout(420_000);
  await q("fr-D5", async () => {
    const t = await send(page, FIX("notes-2.docx"),
      "The attached document has tracked changes. Which boiler ID appears ONLY as a tracked DELETION (not in the accepted text)? Reply with the ID. Nothing else.",
      { extract: 120_000, model: 180_000 });
    log("fr-D5", t); laws("fr-D5", t);
    const del = normalize(t.said).includes("meridian7741");
    record("fr-D5.law", { deletionVisible: del, refusal: isRefusal(t.said) });
    expect(del || isRefusal(t.said),
      `neither deletion visible nor clean refusal: ${t.said.slice(0, 200)}`).toBe(true);
  });
  await q("fr-D4", async () => {
    const t4 = await followUp(page,
      "Which boiler number appears in the ACCEPTED text as a tracked INSERTION (refurbished in 2026)? Reply with the ID. Nothing else.",
      { model: 180_000 });
    log("fr-D4", t4); laws("fr-D4", t4);
    const ins = normalize(t4.said).includes("meridian2298");
    record("fr-D4.insertion", { insertionVisible: ins, leakedDeletion: normalize(t4.said).includes("meridian7741") });
    expect(ins || isRefusal(t4.said),
      `insertion neither visible nor cleanly refused: ${t4.said.slice(0, 200)}`).toBe(true);
  });
  gradeGroup("fr-D5/D4");
});

test("fr-D6 macro-enabled docm, macros disabled (Russian facts)", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("macro-1.docm"),
    "The attached document (in Russian) quotes a distance to the Galactic Center with an uncertainty. Reply with the two numbers in light-years. Nothing else.",
    { extract: 180_000, model: 180_000 });
  log("fr-D6", t); laws("fr-D6", t);
  expect(t.said).toContain("25900");
  expect(t.said).toContain("1400");
});

// ── pptx ─────────────────────────────────────────────────────────────────
test("fr-S5 speaker-notes-only fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("deck-3.pptx"),
    "The attached deck has exactly one slide plus a speaker note. Reply with the contingency code that appears ONLY in the speaker notes. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-S5", t); laws("fr-S5", t);
  const got = normalize(t.said).includes("zebra9152");
  record("fr-S5.law", { notesRead: got, refusal: isRefusal(t.said) });
  expect(got || isRefusal(t.said), `notes answer leaked/wrong: ${t.said.slice(0, 200)}`).toBe(true);
});

test("fr-S3 native chart largest value", async ({ page }) => {
  test.setTimeout(420_000);
  // F83 (2026-11-23): fr-S3/fr-S4 split into SEPARATE tests so one blended
  // verdict can never hide the other (the C3 chart answer "Sales / first
  // quarter / 8.2" was CORRECT while the identity code did not exist in the
  // staged deck at all). Chart law unchanged.
  const t = await send(page, FIX("deck-4.pptx"),
    "The attached deck contains a native chart. What is the series name, and which quarter has the largest value and what is it? Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-S3", t); laws("fr-S3", t);
  expect(normalize(t.said)).toContain("sales");
  expect(t.said).toContain("8.2");
});

test("fr-S3b native scatter cached pairs (F94)", async ({ page }) => {
  test.setTimeout(420_000);
  // F94 (2026-11-23): the scatter law (F64 xVal/yVal parser fix) had NO live
  // matrix row — the py frozen vectors proved the body, never the journey.
  // Expectations keyed from the RAW OOXML, model-free (chart1.xml:
  // c:scatterChart, series "Sales", xVal 1st–4th Qtr, yVal
  // 8.200000000000001/3.2/1.4/1.2 — derivation pinned in
  // __tests__/f85-fixture-preflight.test.ts). SEPARATE verdict from fr-S3
  // (F83 law: one blended verdict can never hide the other).
  const t = await send(page, FIX("deck-4.pptx"),
    "The attached deck contains a native scatter chart. List EVERY plotted point exactly as cached: each x label with its y value, one per line. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-S3b", t); laws("fr-S3b", t);
  const n = normalize(t.said);
  // F147 (2026-11-24): the prompt commands "each x label with its y value,
  // one per line. Nothing else." — a series NAME is outside the commanded
  // shape, so the "sales" key contradicts its own prompt. The series-name
  // law is graded by fr-S3 (asserts "sales" on the same deck, PASSING);
  // S3b keeps the PAIRS law (the F94 point: raw-XML cached x/y pairs).
  for (const k of ["1stqtr82", "2ndqtr32", "3rdqtr14", "4thqtr12"])
    expect(n, `cached point ${k} missing (raw-XML key): ${t.said.slice(0, 300)}`).toContain(k);
});

test("fr-S4 slide identity code", async ({ page }) => {
  test.setTimeout(420_000);
  // F83: staged deck-4.pptx regenerated (chart parts preserved byte-for-byte,
  // one txBox added to slide 1) so the keyed identity fact EXISTS in the
  // bytes the browser uploads. New frozen sha256
  // B4688040CEAB20DBFEECA4E81CD059D49BDC6B358E4676DB784260A26DD24461
  // (stage-live-manifest.tsv updated; pre-fix bytes kept as deck-4.pptx.f83-pre).
  const t = await send(page, FIX("deck-4.pptx"),
    "This deck carries a slide identity code. Reply with that code exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-S4", t); laws("fr-S4", t);
  expect(normalize(t.said), `slide identity missing: ${t.said.slice(0, 200)}`).toContain("scalpha4460");
});

test("fr-S1/S2 SEWP slide facts (one upload, two questions)", async ({ page }) => {
  test.setTimeout(700_000);
  await q("fr-S1", async () => {
    const t1 = await send(page, FIX("deck-1.pptx"),
      "In the attached deck, how many Prime Contract Holders are stated? Reply with the number. Nothing else.",
      { extract: 180_000, model: 180_000 });
    log("fr-S1", t1); laws("fr-S1", t1);
    expect(t1.said, `prime holders count missing: ${t1.said.slice(0, 200)}`).toContain("137");
  });
  await q("fr-S2", async () => {
    const t2 = await followUp(page,
      "What annual obligated value for FY25 does the same slide state? Reply with the figure. Nothing else.",
      { model: 180_000 });
    log("fr-S2", t2); laws("fr-S2", t2);
    expect(normalize(t2.said), `FY25 value missing: ${t2.said.slice(0, 200)}`).toContain("122");
  });
  gradeGroup("fr-S1/S2");
});

// ── spreadsheets (sheet, cell, formula, value) ──────────────────────────
test("fr-X2 fcff revenue cell value", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("data-5.xlsx"),
    "In the attached workbook's Input sheet, what number is in the first cell of the most-recent-12-months revenue row (cell B11)? Reply with the exact number. Nothing else.",
    { extract: 300_000, model: 180_000 });
  log("fr-X2", t); laws("fr-X2", t);
  expect(normalize(t.said)).toContain("217654");
});

test("fr-X3/X10 DfE ToC rendered formula + cross-range tuple (one upload, two questions)", async ({ page }) => {
  test.setTimeout(600_000);
  await q("fr-X3", async () => {
    const t = await send(page, FIX("data-6.xlsx"),
      "Cell C3 of the ToC sheet in the attached workbook is a formula. Reply with the exact string that formula renders to. Nothing else.",
      { extract: 300_000, model: 180_000 });
    log("fr-X3", t); laws("fr-X3", t);
    expect(t.said).toContain("FY2026 Finance Record");
  });
  await q("fr-X10", async () => {
    const t2 = await followUp(page,
      "In the ToC sheet, cell B1 is a cross-range formula. Reply with the STORED value it shows and the formula that produces it. Nothing else.",
      { model: 180_000 });
    log("fr-X10", t2); laws("fr-X10", t2);
    // Scored as (sheet, cell, value) tuple: (ToC, B1, 15) from SUM(B9:B19).
    const tuple = /15/.test(t2.said) && /sum\s*\(\s*b9\s*:\s*b19\s*\)/i.test(t2.said.replace(/\s+/g, " "));
    record("fr-X10.tuple", { sheet: "ToC", cell: "B1", value: "15", formulaSeen: /sum/i.test(t2.said), tuple });
    expect(tuple, `cross-sheet tuple (ToC,B1,15)+SUM(B9:B19) not delivered: ${t2.said.slice(0, 200)}`).toBe(true);
  });
  gradeGroup("fr-X3/X10");
});

test("fr-X1/S-X4 fcff cell tuple + cached formula result (one upload, two questions)", async ({ page }) => {
  test.setTimeout(600_000);
  await q("fr-X1", async () => {
    const t1 = await send(page, FIX("data-5.xlsx"),
      "In the attached workbook, which company name is stored in cell B4? Reply with the name. Nothing else.",
      { extract: 300_000, model: 180_000 });
    log("fr-X1", t1); laws("fr-X1", t1);
    expect(t1.said.toLowerCase(), `B4 company missing: ${t1.said.slice(0, 200)}`).toContain("almarai");
  });
  await q("fr-X4", async () => {
    // F72 retarget: the old premise IF(SUM(A9:A19)=0,0,1) is data-6.xlsx ToC A1 —
    // 0 occurrences in data-5.xlsx (evidence-f72-first-layer.txt). The cached-0 law
    // is kept on a formula THIS file uniquely stores (Valuation output B10), verified
    // deliverable through the 382-chunk index + point_qa retrieval.
    const t2 = await followUp(page,
      "One cell's stored formula is IF('Input sheet'!B61=\"Yes\",'Input sheet'!B62,0). What value does that cell STORE? Reply with the number. Nothing else.",
      { model: 180_000 });
    log("fr-X4", t2); laws("fr-X4", t2);
    record("fr-X4.cached", { replied: t2.said.trim().slice(0, 60) });
    expect(t2.said.trim(), `cached result not 0: ${t2.said.slice(0, 200)}`).toMatch(/^0\b|^the value is 0\b/i);
  });
  gradeGroup("fr-X1/S-X4");
});

test("fr-X6 legacy BIFF8 .xls NPV value", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("data-7.xls"),
    "The attached legacy .xls file is a capital budgeting model. What NPV does it compute? Reply with the number as shown. Nothing else.",
    { extract: 300_000, model: 180_000 });
  log("fr-X6", t); laws("fr-X6", t);
  expect(t.said, `NPV not in reply: ${t.said.slice(0, 200)}`).toMatch(/47[,.]?92[78]/);
});

// ── notebooks (stored outputs; never execute) ───────────────────────────
test("fr-N1 stored output array dims", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("nb-1.ipynb"),
    "The attached notebook has a stored output that prints properties of an array x3. Reply with x3's shape and size exactly as the stored output shows them. Do not run any code. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-N1", t); laws("fr-N1", t);
  expect(normalize(t.said)).toContain("345");
  expect(t.said).toContain("60");
});

test("fr-N2 stored regression slope exact digits", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("nb-2.ipynb"),
    "In the attached notebook's stored outputs, what is the 'Model slope' value? Reply with ALL decimal digits exactly as stored. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-N2", t); laws("fr-N2", t);
  expect(t.said).toContain("2.0272088103606953");
});

// ── archives ─────────────────────────────────────────────────────────────
test("fr-A1/A2 nested zip member + identical basenames (one upload, two questions)", async ({ page }) => {
  test.setTimeout(700_000);
  await q("fr-A1", async () => {
    const t1 = await send(page, FIX("pack-1.zip"),
      "The attached archive contains a nested zip with a file deep/secret.txt. Reply with the fact string inside it. Nothing else.",
      { extract: 180_000, model: 180_000 });
    log("fr-A1", t1); laws("fr-A1", t1);
    expect(t1.said).toContain("33071");
  });
  await q("fr-A2", async () => {
    const t2 = await followUp(page,
      "Two members are both named notes.txt (in dirA and dirB). What does the one under dirB say about valve 12? Reply concisely.",
      { model: 180_000 });
    log("fr-A2", t2); laws("fr-A2", t2);
    const low = t2.said.toLowerCase();
    expect(low).toContain("closed");
    expect(low, "basename collision: mixed up dirA/dirB").not.toContain("open per morning");
  });
  gradeGroup("fr-A1/A2");
});

test("fr-A3 content near END of large member", async ({ page }) => {
  test.setTimeout(700_000);
  const t = await send(page, FIX("pack-2.zip"),
    "The attached archive's LAST member has a TAILFACT code near its end and a mail line. Reply with both. Nothing else.",
    { extract: 180_000, model: 180_000 });
  log("fr-A3", t); laws("fr-A3", t);
  expect(normalize(t.said)).toContain("tailfact3q8k");
  expect(t.said.toLowerCase()).toContain("bug-hello@gnu.org");
});

test("fr-A4 truncated archive: clear partial results or refusal, no hang/garbage", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  const tUp = Date.now();
  await page.setInputFiles(FILE_INPUT, FIX("pack-3.zip"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const status = await waitChipFinal(chip, 180_000);
  record("fr-A4", { chipStatus: status, readyMs: Date.now() - tUp });
  expect(status, "truncated archive hung the extraction").not.toBe("timeout");
  if (status === "ready") {
    const t = await send(page, FIX("pack-3.zip"),
      "List what the attached archive contains and flag anything unreadable. Reply concisely.",
      { extract: 180_000, model: 180_000 });
    log("fr-A4", t); laws("fr-A4", t);
    expect(/truncat|corrupt|incomplet|damag|unreadab|partial|error/i.test(t.said),
      `truncation not flagged: ${t.said.slice(0, 200)}`).toBe(true);
  }
});

test("fr-A5 encrypted 7z: clean refusal, no hang, no password guessing", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  const tUp = Date.now();
  await page.setInputFiles(FILE_INPUT, FIX("pack-4.7z"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const status = await waitChipFinal(chip, 180_000);
  record("fr-A5", { chipStatus: status, readyMs: Date.now() - tUp });
  expect(status, "encrypted archive hung the extraction").not.toBe("timeout");
  if (status === "ready") {
    const t = await send(page, FIX("pack-4.7z"),
      "List what the attached archive contains. If you cannot read a member, say so. Reply concisely.",
      { extract: 180_000, model: 180_000 });
    log("fr-A5", t); laws("fr-A5", t);
    expect(isRefusal(t.said) || /encrypt|password|protected/i.test(t.said),
      `encryption not flagged: ${t.said.slice(0, 200)}`).toBe(true);
  }
});

// F81 (2026-11-23): per-page engine provenance, read model-free from the
// store AFTER the row. The product embeds the reader evidence in the
// delivered attachment text ("[page N | read by: <engine>]", "recognised
// per engine: {...}", "OCR did not run: …"), and the e2e-store chat JSON
// persists that exact text. C3 evidence: scan-1 ran ALL SIX pages through
// Tesseract (Paddle = 0) — engine attribution graded separately, key line
// 245: a Tesseract-only success is BLOCKED, never a PASS.
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

// ── OCR ──────────────────────────────────────────────────────────────────
test("fr-P10 scanned PDF via OCR cascade", async ({ page }) => {
  test.setTimeout(900_000);
  // F81: the OLD prompt/key demanded "insulin / 600 mg" from scan-1 page 1 —
  // facts that exist on NO page (scan-1 IS d1_scanned.pdf; its page 1 is the
  // Ground Water section, per the pre-authored d1 answer-key.json). The key
  // layer (spec) was the first failing layer; retargeted to the d1-keyed
  // page-1 facts. Fixture untouched: sha256 85518bfb81ba16bd…, frozen.
  const t = await send(page, FIX("scan-1.pdf"),
    "Page 1 of the attached PDF is a scan — its words exist only as pixels. What aquifer yield (with units) and what downstream salinity (with units and gauge location) appear on that page? Reply with them exactly as printed. Nothing else.",
    { extract: 420_000, model: 240_000 });
  log("fr-P10", t); laws("fr-P10", t);
  // Expected facts from docs/overnight/fixtures/d1/answer-key.json,
  // d1_scanned.pdf page 1 (authored before any engine run).
  const n = normalize(t.said);
  expect(n, `yield fact missing: ${t.said.slice(0, 200)}`).toContain("14millioncubicmetres");
  expect(n, `salinity fact missing: ${t.said.slice(0, 200)}`).toContain("31ppt");
  expect(n, `gauge location missing: ${t.said.slice(0, 200)}`).toContain("kandla");
  // Per-page engine provenance (F81).
  const prov = storeAttachmentText("scan-1.pdf");
  expect(prov, "scan-1 delivered text not found in the store: provenance UNVERIFIED").not.toBe("");
  const readers = [...prov.matchAll(/\[page (\d+) \| read by: ([^\]]+)\]/g)];
  expect(readers.length, `per-page provenance headers incomplete (${readers.length}/6)`).toBeGreaterThanOrEqual(6);
  expect(prov, "OCR never ran on the image-only fixture").toContain("recognised by OCR");
  const engines = prov.match(/recognised per engine: \{[^}]*\}/)?.[0] ?? "recognised per engine: {}";
  expect(engines.toLowerCase(),
    `engine attribution (key line 245): Paddle primary did NOT run — Tesseract-only success is BLOCKED, not PASS: ${engines}`).toContain("paddle");
});

// ── PDF content ──────────────────────────────────────────────────────────
test("fr-P1 SPM figure legend (middle page, chart)", async ({ page }) => {
  test.setTimeout(600_000);
  // F73: retargeted from the FALSE key ("Figure 4.2" legend, 0–7 °C — occurs on NO page of
  // this fixture; the 7 was the B.2.4 per-°C RATE). Model-free text census: physical p17
  // carries Figure SPM.5, precipitation legend end ticks –40…40 (% per °C). EXACT = both
  // end ticks. Evidence: docs/overnight/file-regression-fr-20261122a/evidence-f73-spm-legend.txt
  // F80 live acceptance, dispatch half: a question about a SUPPLIED file
  // must resolve on local attachment evidence — grade the WIRE, not the
  // UI label: zero web:activity started frames and zero requested
  // lookups this turn. A gate REJECTION (ledger ok:false, requested:0)
  // is allowed and recorded — it is the gate firing, not a dispatch.
  const cap = chatCapture(page);
  cap.begin();
  const t = await send(page, FIX("doc-a.pdf"),
    "On page 17 of the attached PDF, Figure SPM.5 has a colour-scale legend for the percentage change in annual mean precipitation. What numeric range (with the percent sign) does that legend cover? Reply with the range. Nothing else.",
    { extract: 180_000, model: 240_000 });
  const d = await cap.collect();
  record("fr-P1.dispatch", { ...d });
  log("fr-P1", t); laws("fr-P1", t);
  // F147 (2026-11-24): recorded natural answers "–40% to +40%" and
  // "Low end: –40%; high end: +40%" state the endpoints WITH units — the
  // old key demanded the contiguous literal "40 to 40". Fact law KEPT
  // (both endpoints, % unit on the high end); endpoint units/separation
  // accepted. Same retarget at fr-W1a (one fact, two keys).
  // F148 (2026-11-24): the separator varies per natural answer — f93 wrote
  // "; high end:", f94 wrote " · High end: " (U+00B7). Key = signed low
  // endpoint, % on the signed high endpoint, same line, low before high,
  // gap bounded to 40 DIGIT-FREE chars (node-checked: all recorded answers
  // match; "–40 to 40 per °C; rainfall 40 %", "40% to 40%", "–40 points,
  // then 40 %" all stay rejected).
  expect(t.said, `legend range missing: ${t.said.slice(0, 200)}`).toMatch(/[-–−]40\s*%?[^\n\d]{0,40}?\+40\s*%/);
  expect(d.started, `file-only turn dispatched ${d.started} web actions: ${JSON.stringify(d)}`).toBe(0);
  expect(d.requested, `file-only turn requested ${d.requested} web lookups: ${JSON.stringify(d)}`).toBe(0);
});

test("fr-W1/F80 paired journey: file-only paraphrase dispatches ZERO web; current-verification follow-up escapes the scope gate and keeps the attachment fact", async ({ page }) => {
  test.setTimeout(900_000);
  // F80 (ISSUES line 23): PAIRED journey on ONE attachment. Turn 1 is a
  // HELD-OUT PARAPHRASE of the fr-P1 question (same independently keyed
  // fact, evidence-f73-spm-legend.txt: ticks -40…40 % per °C, physical
  // page 17) — it must stay local: ZERO dispatch events. Turn 2 is an
  // explicit CURRENT-VERIFICATION follow-up: the scope law's escape
  // route — it must REACH the web boundary (≥1 requested lookup, no
  // attachment-scope rejection) while the ATTACHMENT fact survives in
  // the answer (fails if either source is ignored). Retrieval success is
  // NOT graded (no public-request dependency, no fixture seam in the
  // public SERP engines and the SSRF law bans loopback fixture pages —
  // recorded, not required).
  const cap = chatCapture(page);
  await q("fr-W1a", async () => {
    cap.begin();
    const t1 = await send(page, FIX("doc-a.pdf"),
      "The attached report's Figure SPM.5 colour scale (page 17) shows a range for how annual mean precipitation changes. State the low and high ends of that scale, with units. Nothing else.",
      { extract: 180_000, model: 240_000 });
    const d1 = await cap.collect();
    record("fr-W1a.dispatch", { ...d1 });
    log("fr-W1a", t1); laws("fr-W1a", t1);
    expect(t1.said, `legend range missing: ${t1.said.slice(0, 200)}`).toMatch(/[-–−]40\s*%?[^\n\d]{0,40}?\+40\s*%/); // F148 (see fr-P1: digit-free bounded gap, signed high end)
    expect(d1.started, `file-only paraphrase dispatched ${d1.started} web actions: ${JSON.stringify(d1)}`).toBe(0);
    expect(d1.requested, `file-only paraphrase requested ${d1.requested} web lookups: ${JSON.stringify(d1)}`).toBe(0);
  });
  await q("fr-W1b", async () => {
    cap.begin();
    const t2 = await followUp(page,
      "That range is from the attached report. I've heard the newest public assessment revised it. Check current public sources and tell me what the latest public assessment says, alongside the range in the attached report.",
      { model: 420_000 });
    const d2 = await cap.collect();
    record("fr-W1b.dispatch", { ...d2 });
    log("fr-W1b", t2); laws("fr-W1b", t2);
    expect(d2.requested, `external-verification follow-up never reached the web boundary: ${JSON.stringify(d2)}`).toBeGreaterThan(0);
    expect(d2.rejected.filter((r) => r.includes("attachment_scope")).length,
      `attachment-scope gate rejected an explicit external-verification turn: ${JSON.stringify(d2.rejected)}`).toBe(0);
    expect(t2.said, `attachment fact lost on the web turn: ${t2.said.slice(0, 240)}`).toMatch(/[-–−]40\s*%?\s*(?:to|[-–−–])\s*\+?\s*40\s*%/);
  });
  gradeGroup("fr-W1/F80");
});

test("fr-P5/P6 direction PDF signature block", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("doc-c.pdf"),
    "On page 18 of the attached PDF there is a boxed signature placeholder. Which job title signs that block? Reply with the title. Nothing else.",
    { extract: 180_000, model: 180_000 });
  log("fr-P6", t); laws("fr-P6", t);
  expect(t.said.toLowerCase()).toContain("accounting officer");
});

test("fr-P7/P8/P9 rotated SQL + end fact + unanswerable (one upload, three questions)", async ({ page }) => {
  test.setTimeout(900_000);
  await q("fr-P7", async () => {
    // F74(a): the question asked only column+table while the key demanded
    // (gauge_id, kestrel) — the WHERE filter was never under test. Question extended
    // to the filter; key strictness KEPT. Spec fingerprint change, sha at C3 freeze.
    const t1 = await send(page, FIX("report-m.pdf"),
      "Page 4 of the attached PDF is rotated and shows an SQL statement. Reply with the column it selects, the table it reads from, and the exact value in its WHERE filter. Nothing else.",
      { extract: 300_000, model: 240_000 });
    log("fr-P7", t1); laws("fr-P7", t1);
    expect(normalize(t1.said), `select-column missing: ${t1.said.slice(0, 200)}`).toContain("gaugeid");
    expect(t1.said.toLowerCase(), `WHERE filter value missing: ${t1.said.slice(0, 200)}`).toContain("kestrel");
  });
  await q("fr-P8", async () => {
    const t2 = await followUp(page,
      "On page 7, on what date was the Kestrel weir closure approved? Reply with the date. Nothing else.",
      { model: 240_000 });
    log("fr-P8", t2); laws("fr-P8", t2);
    // F82 (2026-11-23): the footbridge distractor carries the SAME date as the
    // weir closure in this fixture, so a date row cannot prove event
    // discrimination; this row is BASIC EXTRACTION. Event discrimination needs
    // a separate two-dates fixture (testing/ISSUES.md F82).
    expect(t2.said.toLowerCase()).toContain("8 august");
  });
  await q("fr-P9", async () => {
    const t3 = await followUp(page,
      "What is the name of the chief engineer who signed the Kestrel report? Reply with the name. Nothing else.",
      { model: 240_000 });
    log("fr-P9.unanswerable", t3); laws("fr-P9", t3);
    record("fr-P9.hallucination", { refused: isRefusal(t3.said) });
    expect(isRefusal(t3.said), `unanswerable question answered with a name: ${t3.said.slice(0, 200)}`).toBe(true);
  });
  gradeGroup("fr-P7/P8/P9");
});

// ── images ───────────────────────────────────────────────────────────────
test("fr-I1/I2 multipage TIFF: page 2 facts (one upload, per-fact verdicts)", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("img-1.tiff"),
    "The attached TIFF has three pages. On PAGE 2: when did spillway gate 4 fail inspection, and what percent was the actuator fluid logged at? Reply concisely.",
    { extract: 180_000, model: 240_000 });
  log("fr-I1", t); laws("fr-I1", t);
  // F85: the two keyed facts of this ONE answer get their own verdicts.
  await q("fr-I1", async () => { expect(t.said.toLowerCase()).toContain("12 may"); });
  await q("fr-I2", async () => { expect(t.said).toContain("61"); });
  gradeGroup("fr-I1/I2");
});

test("fr-I3 animated GIF: last-frame fact (frame-1 trap)", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("img-2.gif"),
    "The attached animation loops many frames. Describe what appears in the LAST frames of the animation. Reply concisely.",
    { extract: 180_000, model: 240_000 });
  log("fr-I3", t); laws("fr-I3", t);
  const low = t.said.toLowerCase();
  const lastFrame = /notebook|jupyter|df\.head|code|table/.test(low);
  const frame1Trap = /reading from csv/.test(low);
  record("fr-I3.trap", { lastFrame, frame1Trap });
  expect(lastFrame && !frame1Trap,
    `frame-1 trap (${frame1Trap}) or last-frame fact missing: ${t.said.slice(0, 200)}`).toBe(true);
});

test("fr-I4 HEIC dimensions", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("img-3.heic"),
    "What are the pixel dimensions (width x height) of the attached image? Reply with the numbers. Nothing else.",
    { extract: 180_000, model: 180_000 });
  log("fr-I4", t); laws("fr-I4", t);
  expect(t.said).toContain("1280");
  expect(t.said).toContain("720");
});

test("fr-I5 rotated JPEG honoured (orientation)", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("img-4.jpg"),
    "Describe the attached photograph in one short sentence, and state whether it appears upright or sideways as you see it.",
    { extract: 180_000, model: 180_000 });
  log("fr-I5", t); laws("fr-I5", t);
  expect(t.said.toLowerCase()).toContain("cat");
  record("fr-I5.orientation", { uprightClaimed: /upright|normal|up/.test(t.said.toLowerCase()) });
});

// ── audio ────────────────────────────────────────────────────────────────
test("fr-U1 chapter 1 opening scene", async ({ page }) => {
  test.setTimeout(900_000);
  // F89 (2026-11-23) window widening, measured: the C3 run's completed
  // answer carried the keyed fact ("sweat") but the phases nearly burned
  // the window — attachment ready at 166,389 ms (39.6% of the 420 s
  // extract budget) and a model leg of 19,615 ms; an earlier C3 attempt
  // closed the model window before the keyed answer completed
  // (evidence-f89-key-verification.txt). Windows widened to the measured
  // phases with headroom for a slower host; the KEY and acceptance law
  // are unchanged.
  const t = await send(page, FIX("au-1.mp3"),
    "In the attached audio chapter, the widow's new clothes make the boy do something unpleasant. What? Reply concisely.",
    { extract: 600_000, model: 300_000 });
  log("fr-U1", t); laws("fr-U1", t);
  expect(t.said.toLowerCase()).toContain("sweat");
});

test("fr-U6 chapter 2 proper nouns (captains)", async ({ page }) => {
  test.setTimeout(900_000);
  const t = await send(page, FIX("au-2.mp3"),
    "Near the end of the attached audio chapter, a gang elects a first captain and a second captain. Name BOTH boys. Reply with the two names. Nothing else.",
    { extract: 420_000, model: 240_000 });
  log("fr-U6", t); laws("fr-U6", t);
  const low = t.said.toLowerCase();
  expect(low).toContain("tom sawyer");
  // F74(b) PREDECLARED tolerance (2026-11-22): the audio path TRANSCRIBES the name
  // phonetically — Twain's "Jo Harper" arrives as "Joe Harper". Tolerance is
  // spelling-only (jo|Joe), applies to THIS row only, and is recorded in the key.
  // F84 repair (C3 evidence): the old pattern /j[oe]o harper/ matches "joo"/"jeo"
  // — the class eats the 'o' and the literal 'o' demands a third letter, so the
  // CORRECT answer "Joe Harper" could never match. The tolerance is /joe?/.
  expect(low, `second captain name missing: ${t.said.slice(0, 200)}`).toMatch(/joe? harper/);
});

test("fr-U4 chapter 3 middle: the guard number", async ({ page }) => {
  test.setTimeout(900_000);
  const t = await send(page, FIX("au-3.mp3"),
    "In the attached audio chapter, the fictional caravan is said to have a guard of how many soldiers? Reply with the number. Nothing else.",
    { extract: 420_000, model: 240_000 });
  log("fr-U4", t); laws("fr-U4", t);
  expect(t.said.toLowerCase(), `guard number missing: ${t.said.slice(0, 200)}`).toMatch(/four hundred|400/);
});

// ── video ────────────────────────────────────────────────────────────────
test("fr-V2 CS50 middle frame: phone-book line 7", async ({ page }) => {
  // F70: whisper RTF ~0.30 on this host (au-row calibration, evidence-f70-video-profile.txt)
  // puts a full honest vid-1 extract at ~2,300 s; the old 900 s budget expired mid-ASR
  // (fr2 900,791 ms "Transcription cancelled" = budget abort, not a hang).
  test.setTimeout(3_120_000);
  const t = await send(page, FIX("vid-1.mp4"),
    "Around 59 minutes into the attached lecture a phone-book pseudocode slide appears. What does its 7th line say? Reply with that line. Nothing else.",
    { extract: 2_700_000, model: 240_000 });
  log("fr-V2", t); laws("fr-V2", t);
  expect(normalize(t.said), `mid-lecture line missing: ${t.said.slice(0, 200)}`)
    .toContain("opentomiddleoflefthalf");
});

test("fr-V5/V7/V9 3h+ video: begin + end + summary (one upload, three questions)", async ({ page }) => {
  // F70: 4h22m audio x whisper RTF 0.30 ~= 4,725 s ASR (concurrent with the ~800 s scene
  // pass) => ~4,900 s honest extract; old 1,200 s budget was ~4x short (fr2 20.1 m ✘).
  // Tighten from the B12 Parakeet measurements at C3 (projected ~2,400 s extract).
  test.setTimeout(6_900_000);
  await q("fr-V5", async () => {
    const t1 = await send(page, FIX("vid-2.mp4"),
      "What does the title card say in the first two minutes of the attached video? Reply with the exact words. Nothing else.",
      { extract: 5_400_000, model: 240_000 });
    log("fr-V5", t1); laws("fr-V5", t1);
    expect(normalize(t1.said), `title card missing: ${t1.said.slice(0, 200)}`)
      .toContain("dataanalysiswithpython");
  });
  await q("fr-V7", async () => {
    const t2 = await followUp(page,
      "In the LAST minutes of the video, a large heading appears near the end. Reply with the exact words of that heading. Nothing else.",
      { model: 240_000 });
    log("fr-V7", t2); laws("fr-V7", t2);
    expect(normalize(t2.said), `end heading missing: ${t2.said.slice(0, 200)}`).toContain("justgettingstarted");
  });
  await q("fr-V9", async () => {
    const t3 = await followUp(page, "Summarize the attached video in 3 sentences.", { model: 240_000 });
    log("fr-V9.summary", t3); laws("fr-V9", t3);
    expect(t3.said.length).toBeGreaterThan(120);
  });
  await q("fr-V6", async () => {
    const t4 = await followUp(page,
      "Roughly 2 hours and 11 minutes in, a topic heading appears on screen. Reply with its exact words. Nothing else.",
      { model: 240_000 });
    log("fr-V6", t4); laws("fr-V6", t4);
    expect(normalize(t4.said), `2h11m heading missing: ${t4.said.slice(0, 200)}`)
      .toContain("conditionalselection");
  });
  await q("fr-V8", async () => {
    const t5 = await followUp(page,
      "At 3 hours 25 minutes 45 seconds a code cell runs on screen. Reply with the exact text of the heading shown around that moment. Nothing else.",
      { model: 240_000 });
    log("fr-V8.visual", t5); laws("fr-V8", t5);
    expect(normalize(t5.said), `visual-only fact missing: ${t5.said.slice(0, 200)}`)
      .toContain("readingfromcsv");
  });
  gradeGroup("fr-V5/V7/V9/V6/V8");
});

// ── SUPPLEMENT v2 (fr-20261122b): per-reader live coverage + known-weakness
// battery. Grading key: ANSWER-KEY.md SUPPLEMENT v2 rows (model-free ground
// truth: all-readers/plan.json, d1 answer-key.json, F78 wav answer, OOXML
// dumps, direct construction). ────────────────────────────────────────────

test("fr-T7 UTF-16 file past the 48k inline limit: tail fact via index route", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("txt-7.txt"),
    "Read the attached text file to its END and reply with the END CODE it contains. Nothing else.",
    { extract: 240_000, model: 180_000 });
  log("fr-T7", t); laws("fr-T7", t);
  expect(normalize(t.said), `48k+ tail fact missing: ${t.said.slice(0, 200)}`).toContain("walrusboundary9131");
});

test("fr-R1 RTF reader live fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("txt-6.rtf"),
    "What price is quoted in the attached document? Reply with the phrase. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-R1", t); laws("fr-R1", t);
  // F147 (2026-11-24): the fixture phrase is "Visible price 42." and the
  // recorded answer is "42" — the quoted price, a natural short reply to
  // "Reply with the phrase. Nothing else."; the old second key demanded the
  // word "price" in the reply, a premise the prompt itself makes optional.
  // KEPT and STRENGTHENED: the RTF law is that {\v hidden} text NEVER
  // reaches the model — the private alternate "918" must be absent.
  expect(t.said.toLowerCase()).toContain("42");
  expect(t.said, `RTF hidden text leaked: ${t.said.slice(0, 200)}`).not.toMatch(/918|PRIVATE ALTERNATE/i);
});

test("fr-L1 legacy .doc live fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("old-1.doc"),
    "What marker text appears in the attached legacy document? Reply with it exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-L1", t); laws("fr-L1", t);
  expect(normalize(t.said)).toContain("readablemarkerdoc");
});

test("fr-L2 legacy .xls live fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("old-2.xls"),
    "What marker text appears in the attached legacy spreadsheet? Reply with it exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-L2", t); laws("fr-L2", t);
  expect(normalize(t.said)).toContain("readablemarkerxls");
});

test("fr-L3 legacy .ppt live fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("old-3.ppt"),
    "What marker text appears in the attached legacy presentation? Reply with it exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-L3", t); laws("fr-L3", t);
  expect(normalize(t.said)).toContain("readablemarkerppt");
});

test("fr-O1 ODF text live facts", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("doc-b.odt"),
    "In the attached document, how many bars are counted and what operation closes it? Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-O1", t); laws("fr-O1", t);
  expect(t.said).toContain("37");
  expect(t.said.toLowerCase()).toContain("shutdown");
});

test("fr-O2 ODF spreadsheet live facts", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("sheet-1.ods"),
    "Name two line items and the number that appear in the attached spreadsheet. Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-O2", t); laws("fr-O2", t);
  const low = t.said.toLowerCase();
  expect(low).toContain("cash");
  expect(low).toContain("debt");
  expect(t.said).toContain("178");
});

test("fr-O3 ODF presentation live facts", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("deck-5.odp"),
    "Which two flows and which number appear in the attached deck? Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-O3", t); laws("fr-O3", t);
  const low = t.said.toLowerCase();
  expect(low).toContain("intake");
  expect(low).toContain("return");
  expect(t.said).toContain("76");
});

test("fr-O4 epub live facts", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("book-1.epub"),
    "What crate is inventoried in the attached book, and what voltage is cited? Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-O4", t); laws("fr-O4", t);
  expect(t.said.toLowerCase()).toContain("red crate");
  expect(t.said).toContain("341");
});

test("fr-XM1 xlsm live facts, macros not executed", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("data-8.xlsm"),
    "Name the settlement phrase and the terminal phrase stored in the attached workbook. Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-XM1", t); laws("fr-XM1", t);
  const low = t.said.toLowerCase();
  expect(low).toContain("mistral");
  expect(low).toContain("heliotrope");
});

test("fr-M1 .mat live facts", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("mat-1.mat"),
    "What variable name and what two numeric values are in the attached file? Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-M1", t); laws("fr-M1", t);
  expect(t.said.toLowerCase()).toContain("yields");
  expect(t.said).toContain("440.125");
  expect(t.said).toContain("98.75");
});

test("fr-A6 gz member live fact", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("pack-5.gz"),
    "What number appears in the CSV inside the attached compressed file? Reply with the number. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-A6", t); laws("fr-A6", t);
  expect(t.said).toContain("66719");
});

test("fr-A12 RAR: missing decoder must be reported honestly", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  const tUp = Date.now();
  await page.setInputFiles(FILE_INPUT, FIX("pack-6.rar"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  const status = await waitChipFinal(chip, 180_000);
  record("fr-A12.chip", { chipStatus: status, readyMs: Date.now() - tUp });
  expect(status, "rar extraction hung").not.toBe("timeout");
  if (status === "ready") {
    const t = await send(page, FIX("pack-6.rar"),
      "List what the attached archive contains. If you cannot read it, say so plainly. Reply concisely.",
      { extract: 180_000, model: 180_000 });
    log("fr-A12", t); laws("fr-A12", t);
    const honest = /rar|cannot|can't|unable|unsupported|not supported|failed|unreadab|extract/i.test(t.said)
      || isRefusal(t.said);
    const fabricated = t.said.includes("66719") && !honest;
    record("fr-A12.law", { honest, fabricated });
    expect(honest && !fabricated,
      `missing decoder not reported honestly (silent/fabricated): ${t.said.slice(0, 200)}`).toBe(true);
  }
});

test("fr-N3 notebook saved plot style (no execution)", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("nb-3.ipynb"),
    "In the attached notebook, what plotting style is configured in the saved code, and what kind of plot does the saved output show? Do not run any code. Reply concisely.",
    { extract: 120_000, model: 180_000 });
  log("fr-N3", t); laws("fr-N3", t);
  const low = t.said.toLowerCase();
  expect(low, `plot style from saved code missing: ${t.said.slice(0, 200)}`).toMatch(/seaborn|whitegrid/);
});

test("fr-N4 notebook exact integer 9007199254740993", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("nb-4.ipynb"),
    "The attached notebook stores an exact large integer in its output. Reply with that integer exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-N4", t); laws("fr-N4", t);
  expect(t.said, `exact integer fidelity: ${t.said.slice(0, 200)}`).toContain("9007199254740993");
});

test("fr-U7 audio middle: stated weight (F78 transcript law)", async ({ page }) => {
  test.setTimeout(900_000);
  const t = await send(page, FIX("au-4.wav"),
    "In the attached recording, a weight is stated in the middle. What is it? Reply with the statement. Nothing else.",
    { extract: 420_000, model: 240_000 });
  log("fr-U7", t); laws("fr-U7", t);
  const low = t.said.toLowerCase();
  expect(low).toContain("47");
  expect(low).toContain("kg");
});

test("fr-P11 native PDF: table fact + late page (OCR must NOT run)", async ({ page }) => {
  test.setTimeout(900_000);
  const t1 = await send(page, FIX("scan-2.pdf"),
    "On page 3 of the attached PDF there is a table of ports. Which port appears first in it? Reply with the port name. Nothing else.",
    { extract: 300_000, model: 240_000 });
  log("fr-P11", t1); laws("fr-P11", t1);
  expect(t1.said.toLowerCase(), `p3 table port missing: ${t1.said.slice(0, 200)}`).toContain("kandla");
  const t2 = await followUp(page,
    "What amount in rupees and what date appear on page 6? Reply with both. Nothing else.",
    { model: 240_000 });
  log("fr-P11.late", t2); laws("fr-P11.late", t2);
  expect(normalize(t2.said), `p6 late fact missing: ${t2.said.slice(0, 200)}`).toContain("41825000");
  expect(t2.said.toLowerCase()).toContain("nov");
  // F81: assert the key's ocr_must_not_run from the delivered provenance —
  // every page read by the text layer, zero OCR launches for this job.
  const prov = storeAttachmentText("scan-2.pdf");
  expect(prov, "scan-2 delivered text not found in the store: provenance UNVERIFIED").not.toBe("");
  expect(prov, "OCR ran on the native-text fixture (key: ocr_must_not_run)").not.toContain("recognised by OCR");
  expect(prov).toContain("OCR did not run");
  const readers = [...prov.matchAll(/\[page (\d+) \| read by: ([^\]]+)\]/g)];
  expect(readers.length, `per-page provenance headers incomplete (${readers.length}/6)`).toBeGreaterThanOrEqual(6);
  for (const r of readers)
    expect(r[2], `page ${r[1]} read by an OCR engine: ${r[2]}`).toContain("text layer");
});

test("fr-P4 242 MB 3970-page report: late-page glossary citation", async ({ page }) => {
  test.setTimeout(2_700_000);
  const t = await send(page, FIX("doc-d.pdf"),
    "The attached report has a Glossary chapter. Which external glossary does it cite as its source? Reply with the name. Nothing else.",
    { extract: 1_800_000, model: 300_000 });
  log("fr-P4", t); laws("fr-P4", t);
  // F147 (2026-11-24): recorded answer "The American Meteorological Society's
  // Glossary of Meteorology (AMS, 2021; glossary.ametsoc.org)" — the full
  // correct citation; the old key demanded the contiguous literal
  // "AMS Glossary of Meteorology". Fact law KEPT: the AMS attribution AND the
  // glossary name must both be present.
  expect(/AMS|American Meteorological Society/i.test(t.said) && /Glossary of Meteorology/i.test(t.said),
    `late-page glossary citation missing: ${t.said.slice(0, 200)}`).toBe(true);
});

test("fr-P2/P3 SPM chart rate + SMB value/units (one upload, two questions)", async ({ page }) => {
  test.setTimeout(900_000);
  await q("fr-P2", async () => {
    const t1 = await send(page, FIX("doc-a.pdf"),
      "In section B.2.4 of the attached PDF, what is the stated global response per degree Celsius of warming? Reply with the figure and its units. Nothing else.",
      { extract: 180_000, model: 240_000 });
    log("fr-P2", t1); laws("fr-P2", t1);
    const low1 = t1.said.toLowerCase();
    expect(/7\s*%|7\s*°c|7\s*per|about 7/.test(low1), `B.2.4 rate missing: ${t1.said.slice(0, 200)}`).toBe(true);
  });
  await q("fr-P3", async () => {
    const t2 = await followUp(page,
      "What is the reported glacier and ice-sheet mass loss (SMB) in gigatonnes per decade? Reply with the figure and units. Nothing else.",
      { model: 240_000 });
    log("fr-P3", t2); laws("fr-P3", t2);
    expect(t2.said, `SMB value missing: ${t2.said.slice(0, 200)}`).toMatch(/7\.0/);
    expect(t2.said.toLowerCase(), `SMB units missing: ${t2.said.slice(0, 200)}`).toMatch(/gt|gigatonne/);
  });
  gradeGroup("fr-P2/P3");
});

// F69 (2026-11-22): the old wording ("Which month and year does the latest direction ...
// cover?") was a key-vs-fixture defect, not a product defect: "March 2026" exists ONLY on the
// cover (p1); the file's coverage period is literally "financial year ending 31 July 2026" (p3),
// so "July 2026" was a SUPPORTED reading of "cover" — both facts sit in the opening 4,000-char
// preview of the indexed body, so retrieval never failed. Evidence:
// docs/overnight/file-regression-fr-20261122a/evidence-f69-page-month-map.txt. The question now
// uses the ANSWER-KEY P5 cover wording verbatim-in-spirit; EXACT March 2026 stays (its only
// occurrence in the file = the cover). Spec fingerprint change, sha recorded at C3 freeze.
test("fr-P5 direction PDF: cover month", async ({ page }) => {
  test.setTimeout(600_000);
  const t = await send(page, FIX("doc-c.pdf"),
    "What month and year is printed on the cover of the attached PDF? Reply with month and year. Nothing else.",
    { extract: 180_000, model: 180_000 });
  log("fr-P5", t); laws("fr-P5", t);
  expect(/march\s*2026/i.test(t.said), `cover month missing: ${t.said.slice(0, 200)}`).toBe(true);
});

test("fr-D2 endnote vs body", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("doc-f.docx"),
    "The attached document has an endnote. What string appears in the endnote? Reply with it exactly. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-D2", t); laws("fr-D2", t);
  expect(t.said, `endnote string missing: ${t.said.slice(0, 200)}`).toContain("XXX");
});

test("fr-D3 field-code rendered result", async ({ page }) => {
  test.setTimeout(420_000);
  const t = await send(page, FIX("doc-g.docx"),
    "The attached document contains a field. Which name and date does the field render to? Reply with both. Nothing else.",
    { extract: 120_000, model: 180_000 });
  log("fr-D3", t); laws("fr-D3", t);
  expect(t.said.toUpperCase()).toContain("ANTONI");
  expect(t.said.toLowerCase()).toContain("16 june 2010");
});

test("fr-V1/V3/V4/F93 CS50: greeting + between-samples slide + late typo + seam timestamp + unexamined-interval disclosure + grounded summary (one upload, six questions)", async ({ page }) => {
  // F70: same measured vid-1 honest wall as fr-V2 (see evidence-f70-video-profile.txt);
  // 1,500 s frames-complete + 6 model turns (F93 added three; ~720 s of model
  // window). C3: tighten from B12 Parakeet numbers.
  test.setTimeout(4_500_000);
  // F89 (2026-11-23): the old row asked for a "greeting" keyed `Welcome to
  // CS50` — premise FALSE for the staged file (v1-60.jpg black, v1-120.jpg
  // building photo with no text; the pinned Parakeet run over 95–155 s
  // transcripts no "welcome"; the C3 live answer's own transcript agrees).
  // Retargeted to the independently verified SPEECH-ONLY fact at
  // 115.1–116.5 s (word-timestamped transcript v1-95-155-transcript.json):
  // "CS50 in particular was very much this class to beware". The 2:00
  // frames carry no text, so this keeps the row an audio-channel test at
  // the same acceptance strength (exact verbatim phrase).
  await q("fr-V1", async () => {
    const t1 = await send(page, FIX("vid-1.mp4"),
      "Around the two-minute mark of the attached lecture the speaker describes how he regarded CS50 in his first year. In his exact words, what kind of class does he call it? Reply with the exact phrase. Nothing else.",
      { extract: 2_700_000, model: 240_000 });
    log("fr-V1", t1); laws("fr-V1", t1);
    expect(normalize(t1.said), `spoken fact missing: ${t1.said.slice(0, 200)}`).toContain("classtobeware");
  });
  // F116 (2026-11-23): the old V3 premise ("a slide poses a question about
  // searching for a phone number" keyed `howdoyousearchforaphonenumber`) is
  // FALSE for the staged file — the ~1 h slide (frame v1-3055.jpg, extracted
  // from the staged bytes) reads "What is an algorithm? / Step-by-step
  // instructions for solving a problem", and the phrase is ALSO spoken
  // (product whisper-base.en 3006.4-3009.6 s, pinned Parakeet agree).
  // Retargeted to that independently verified definition, same verbatim
  // acceptance strength. Evidence: evidence-f116-v3v4-keys.txt.
  await q("fr-V3", async () => {
    const t3 = await followUp(page,
      "Around one hour in, a slide defines a key term using a phone-book example. Quote the definition the slide gives, in its exact words. Nothing else.",
      { model: 240_000 });
    log("fr-V3.between", t3); laws("fr-V3", t3);
    expect(normalize(t3.said), `between-samples definition missing: ${t3.said.slice(0, 200)}`)
      .toContain("stepbystepinstructions");
  });
  // F116: the old V4 premise ("near the two-hour mark a slide shows a
  // misspelled 'heirarchy' next to a self-control theme") is FALSE — the
  // tail (the file ends at 1:58:55) is the Scratch "Harvard's Hardest Game"
  // finale: frames v1-6910/v1-7060/v1-7120.jpg show the Scratch IDE, the
  // RMOTR promo card and black; NO whisper/Parakeet segment in 6860-7135 s
  // says hierarchy/will-power/self-control. Retargeted to the verified
  // closing fact, spoken identically by BOTH engines (whisper 6941.8 s,
  // Parakeet agree): "adjourn for cake in the transept". Evidence:
  // evidence-f116-v3v4-keys.txt.
  await q("fr-V4", async () => {
    const t4 = await followUp(page,
      "Near the end of the lecture the speaker announces a long-standing tradition that follows class. Quote his exact words. Nothing else.",
      { model: 240_000 });
    log("fr-V4", t4); laws("fr-V4", t4);
    const low4 = normalize(t4.said);
    expect(low4, `closing tradition missing: ${t4.said.slice(0, 200)}`).toContain("adjourn");
    expect(low4).toContain("cake");
    expect(low4).toContain("transept");
  });
  // F93 (2026-11-23): TIMESTAMP ACCURACY ACROSS AN ASR CHUNK BOUNDARY.
  // Production video/audio ASR chunks in 30 s windows with a 5 s stride and
  // shifts each window's segments onto the master timeline (audio.ts:346,
  // :275, with a per-chunk-reset guard at :286). Key: the pinned Parakeet
  // word-timestamp run over 290-320 s places "let alone computer science and
  // programming" at 299.20-301.04 s ABSOLUTE — "comp" itself straddles the
  // 300.0 s seam (evidence-f93-keys.txt, .data/tmp/f93/f93-seam-words.txt).
  // A chunk-local timestamp reset lands near 0:15-0:21 and fails; the
  // acceptance window [294, 306] s absorbs engine divergence only.
  await q("fr-V10", async () => {
    const tS = await followUp(page,
      "Around the five-minute mark, the speaker says the words \"let alone computer science and programming\". At what timestamp (mm:ss) is that phrase spoken? Reply with the timestamp and the phrase. Nothing else.",
      { model: 240_000 });
    log("fr-V10.seam", tS); laws("fr-V10", tS);
    expect(tS.said.toLowerCase(), `phrase anchor missing: ${tS.said.slice(0, 200)}`).toContain("computer science");
    const secs = tsSecs(tS.said);
    record("fr-V10.seamTimes", { secs, lo: 294, hi: 306, said: tS.said.slice(0, 200) });
    expect(secs.some((s) => s >= 294 && s <= 306),
      `no timestamp within the keyed seam window 4:54-5:06 (key 299.20-301.04 s); said: ${tS.said.slice(0, 200)}`).toBe(true);
  });
  // F93: UNEXAMINED-INTERVAL DISCLOSURE. The live vid-1 record carries
  // captured frames at 23:47 and 1:23:15 ONLY — the frame plan is bounded
  // and "a plan is not coverage" (video_jobs._requested_times). The probe is
  // tie color at 1:30:00: visual-only (the audio transcript cannot answer
  // it), and 5400 s is far from every sampled frame and head/mid/tail
  // anchor. A non-disclosing answer is FABRICATION and must fail. Positive
  // control: fr-V3/fr-V8 answer with captured evidence, so the refusal side
  // is scoped, not free.
  await q("fr-V11", async () => {
    const tD = await followUp(page,
      "At 1:30:00 of the attached lecture, what color is the speaker's necktie? Answer only from visual evidence you actually captured at that moment.",
      { model: 240_000 });
    log("fr-V11.disclosure", tD); laws("fr-V11", tD);
    const visualAbsent =
      /no (frame|capture|screenshot|visual|image|footage)|not (captured|sampled|available|visible|covered)|never (captured|sampled)|couldn.t (see|capture|tell)|don.t have (a |the |any )?(frame|visual|image|capture)|no (frame|image|visual) (at|covering|near|for)|outside (the )?(sampled|examined|captured)|can ?only see/i;
    const disclosed = isRefusal(tD.said) || visualAbsent.test(tD.said);
    record("fr-V11.disclosure", { disclosed, said: tD.said.slice(0, 200) });
    expect(disclosed,
      `unexamined interval answered without disclosure (frames exist only near 23:47/1:23:15): ${tD.said.slice(0, 200)}`).toBe(true);
  });
  // F93: GROUNDED SUMMARY. Two independently keyed facts must EACH carry a
  // reported timestamp near its verified window: A "this class to beware"
  // 115.08-116.52 s (v1-95-155-transcript.json, F89) and B "computer
  // science and programming" 299.20-301.04 s (pinned Parakeet seam run).
  // Windows widen to [105,126]/[290,312] to absorb transcript
  // segment-START timestamps ([00:01:51-00:01:57]); a timestamp present
  // only far from the fact does NOT ground it.
  await q("fr-V12", async () => {
    const tG = await followUp(page,
      "Summarize the first six minutes of the attached lecture in 4-6 bullets; every bullet must start with the mm:ss timestamp of what it describes. In the bullets, mention both the phrase the speaker uses for how he regarded CS50 that year (\"this class to ...\") and what he says people may be uncomfortable with (\"let alone ...\"). Nothing else.",
      { model: 240_000 });
    log("fr-V12.summary", tG); laws("fr-V12", tG);
    const lowG = tG.said.toLowerCase();
    expect(lowG, `keyed fact A (class to beware) missing: ${tG.said.slice(0, 200)}`).toContain("beware");
    expect(lowG, `keyed fact B (uncomfortable with computing) missing: ${tG.said.slice(0, 200)}`).toMatch(/computing|computer science/);
    const secsG = tsSecs(tG.said);
    record("fr-V12.ground", { secs: secsG, n: secsG.length, said: tG.said.slice(0, 200) });
    expect(secsG.some((s) => s >= 105 && s <= 126),
      `fact A not grounded near 115.1 s (windows [105,126]); said: ${tG.said.slice(0, 200)}`).toBe(true);
    expect(secsG.some((s) => s >= 290 && s <= 312),
      `fact B not grounded near 300.0 s (windows [290,312]); said: ${tG.said.slice(0, 200)}`).toBe(true);
  });
  gradeGroup("fr-V1/V3/V4/F93");
});

// F95 (2026-11-23): the frozen matrix graded FILES only — no row in this
// spec ever exercised the ordinary-chat and conversation-lifecycle features
// the release also ships. Brief §4C names the battery; the existing specs
// (greeting, chat-stream, reasoning-test, progress-panel, edit-stop-collapse,
// conversations-crud, conversation-title, recents-controls/modal,
// multi-select-delete, abort-family) stay in the FINAL SELECTION LIST for the
// per-feature browser assertions (CRUD is disk-seeded, LLM-independent, and
// runs against the launcher's isolated .data/e2e-store). These two rows add
// the missing MATRIX rows: unseen casual chat, a pasted compiler error with a
// tiny independently checkable fix, a follow-up, single-visible-answer and
// no-fabricated-citation laws, stop-midstream followed by a clean turn.
test("fr-C1 normal chat battery: casual paraphrase, compiler-error fix, follow-up, single answer, no fabricated citation", async ({ page }) => {
  test.setTimeout(600_000);
  await q("fr-C1", async () => {
    // 1) Unseen casual paraphrase (NOT the greeting.spec prompt) — natural,
    // direct-address reply; no URL invented (fabricated citation), no
    // harness self-talk (scoped structural phrases, per the F-law against
    // broad answer-prose regexes).
    const t1 = await sendText(page,
      "so is it cool if I just chat with you for a sec about nothing in particular?",
      { model: 180_000 });
    log("fr-C1.chat", t1); laws("fr-C1", t1);
    // F147 (2026-11-24): recorded natural reply opens "Totally" — \btotal\b
    // does not match it. Lexicon widened; law KEPT (natural acknowledgement,
    // no fabricated URL, no harness self-talk).
    expect(t1.said.toLowerCase(), `no natural acknowledgement: ${t1.said.slice(0, 160)}`)
      .toMatch(/\b(hi|hello|hey|sure|of course|absolutely|totally|happy|glad|welcome|yes|sounds good)\b/);
    expect(t1.said, `fabricated citation in casual chat: ${t1.said.slice(0, 160)}`).not.toMatch(/https?:\/\//i);
    expect(t1.said.toLowerCase(), `harness self-talk: ${t1.said.slice(0, 160)}`)
      .not.toMatch(/as an ai|system prompt|harness|tool call|user turn/i);
    await composerLive(page); // stage cleared, composer live (F147 probe)

    // 2) Pasted compiler error, tiny INDEPENDENTLY CHECKABLE fix: the C line
    // printf("hello") lacks its statement semicolon; the accepted reply must
    // quote the FIXED line (semicolon after the closing paren).
    const fixedLine = /printf\(\s*[“"]hello[”"]\s*\)\s*;/i;
    const t2 = await followUp(page,
      "The C line below fails to compile with \"error: expected ';' after expression\":\n\nprintf(\"hello\")\n\nWhat is the minimal fix? Reply with the fixed line exactly. Nothing else.",
      { model: 180_000 });
    log("fr-C1.compile", t2); laws("fr-C1", t2);
    expect(t2.said, `fixed line missing: ${t2.said.slice(0, 200)}`).toMatch(fixedLine);
    expect(t2.said, `fabricated citation: ${t2.said.slice(0, 160)}`).not.toMatch(/https?:\/\//i);

    // 3) Follow-up on the same conversation: answer REUSED (no re-derivation
    // turn needed), single visible final answer, stage clear.
    const t3 = await followUp(page,
      "Quote just that fixed line back to me. Nothing else.",
      { model: 180_000 });
    log("fr-C1.follow", t3); laws("fr-C1", t3);
    expect(t3.said, `follow-up lost the fix: ${t3.said.slice(0, 200)}`).toMatch(fixedLine);
    await composerLive(page); // F147 probe
  });
  gradeGroup("fr-C1/F95");
});

test("fr-C2 stop midstream then one clean subsequent turn", async ({ page }) => {
  test.setTimeout(600_000);
  // Turn 1 is INTENTIONALLY never awaited to completion (3000-word request;
  // sendText's window expiring is expected) — no q() verdict for it, the
  // graded law is the NEXT turn below.
  await sendText(page,
    "Write an extremely detailed exhaustive history of the Roman Republic, at least 3000 words.",
    { model: 180_000 }).catch(() => undefined);
  // Stop while streaming: the Z1 journey proves clean idle; the missing
  // half is the SUBSEQUENT TURN — generation stopped mid-sentence must not
  // poison the next request (single visible answer, complete, keyed).
  const reply = page.locator(ASSISTANT).last();
  // F151 (2026-11-24): f94 pass-2 timed out HERE at 600 s — the bare
  // innerText() auto-waits unbounded, and turn 1 went agentic ("Turn
  // progress: Step 2 of 2"), producing NO visible answer-body for 10 min
  // (pass-1 same row: 9805 streamed chars, "READY." PASS). The read is now
  // bounded: 150 s for the first visible body after the send window
  // expired, 15 s for the read. No content in the bound fails the row's
  // existing honest verdict below — a loud timed-out row, never a silent
  // 600 s test timeout. Law KEPT: stop midstream, graded law = clean next turn.
  const body = reply.locator(ANSWER_BODY).first();
  await body.waitFor({ state: "attached", timeout: 150_000 }).catch(() => undefined);
  const streaming = await body.innerText({ timeout: 15_000 }).catch(() => "");
  record("fr-C2.streamed", { chars: streaming.length });
  expect(streaming.length, "generation never produced visible content to stop").toBeGreaterThan(0);
  const stop = page.locator('button[aria-label="Stop generating"]');
  if (await stop.count()) await stop.click();
  await composerLive(page); // F147: post-stop composer live (B11: empty-draft Send is DISABLED by law)
  const before = await page.locator(ASSISTANT).count();
  const t2 = await followUp(page, "Reply with exactly: READY. Nothing else.", { model: 180_000 });
  log("fr-C2.next", t2); laws("fr-C2", t2);
  expect(normalize(t2.said), `clean turn failed: ${t2.said.slice(0, 160)}`).toContain("ready");
  expect(await page.locator(ASSISTANT).count(), "stopped turn duplicated on the next send").toBe(before + 1);
});

test("fr-Z1 mid-stream cancellation returns UI to a clean idle state", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  const effort = page.getByRole("button", { name: /^Reasoning effort:/ });
  if ((await effort.getAttribute("aria-label")) !== "Reasoning effort: Off") {
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
  }
  await page.setInputFiles(FILE_INPUT, FIX("txt-4.jsonl"));
  const chip = page.locator(CHIP).last();
  await expect(chip).toBeVisible();
  expect(await waitChipFinal(chip, 120_000)).toBe("ready");
  const before = await page.locator(ASSISTANT).count();
  await page.locator("textarea").first().fill(
    "Write an extremely detailed exhaustive summary of every record in the attached JSONL file, listing every field of every record.",
  );
  await page.locator(SEND).click();
  const reply = page.locator(ASSISTANT).last();
  const deadline = Date.now() + 120_000;
  let streaming = false;
  while (Date.now() < deadline) {
    if ((await reply.innerText().catch(() => "")).trim().length > 0) { streaming = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  expect(streaming, "generation never started, cannot test cancellation").toBe(true);
  const tStop = Date.now();
  await page.locator('button[aria-label="Stop generating"]').click();
  // F86 (2026-11-23) spec-layer fix: the B11 composer-gate law
  // (lib/chat/composerGate.ts: canSend = content && !isLoading && all
  // attachments ready) keeps Send DISABLED on an EMPTY composer, so the
  // old "Send enabled right after Stop" assertion collided with the law.
  // Z1's law is that cancellation returns the UI to a CLEAN IDLE state;
  // prove it the way the law allows: the composer is gated (disabled)
  // while empty, and the instant a draft is typed Send must re-enable —
  // which only happens if the cancel cleared the loading state.
  await expect(page.locator(SEND)).toBeDisabled({ timeout: 10_000 });
  await page.locator("textarea").first().fill("continue");
  await expect(page.locator(SEND)).toBeEnabled({ timeout: 30_000 });
  const after = await page.locator(ASSISTANT).count();
  const finalState = await reply.getAttribute("data-state").catch(() => null);
  record("fr-Z1", { stopToEnabledMs: Date.now() - tStop, newReplies: after - before, finalState });
  expect(after - before, "cancellation produced extra replies").toBeLessThanOrEqual(1);
  expect(finalState, "reply still streaming after cancel").not.toBe("streaming");
});
