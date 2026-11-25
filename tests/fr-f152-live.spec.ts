/**
 * fr-F152 — pixel-only label + threshold-crossing crop, LIVE journey
 * (exclusive Playwright; run ONLY via scripts/run-browser-e2e-exclusive.ps1
 * under the f152-live-1 kit).
 *
 * One upload of f152-survey.pdf, one question, independently-recorded proofs
 * (F85 per-question verdicts; a shared failure never blends them; P4 carries
 * a gating verdict AND a recorded recovery fact, repair 4):
 *
 *  P0 app identity PRE-run (F152 Part 1): the launcher wrote
 *     .data/e2e-store/launcher-identity.json — the app is launcher-OWNED
 *     (never a reused foreign app), the store is the isolated e2e-store, and
 *     the LLM env points at THIS kit's capture proxy. The f152-live-1 setup
 *     failure (foreign app, real store, :8080 direct) can never pass silently.
 *  P1 label fact in the user-visible answer: the FULL printed label
 *     "KAPPA 9" — digit included, graded from key.label_text (exists ONLY as
 *     pixels inside the embedded chart raster — the native text layer provably
 *     carries no label, the staging script asserted that model-free);
 *  P2 colour fact: the COLOUR FIELD of the pinned two-line answer,
 *     canonicalised through the synonym families MEASURED on the fixture
 *     (tests/lib/f152-colour-grader; 2026-11-24 audit replaced the whole-
 *     response family regex — "pink" for a violet fixture stays a FAIL);
 *  P3 zero web dispatch on a file-only turn (fr-P1 wire law, not a UI label);
 *  P4 durable OCR evidence, split into TWO verdicts (2026-11-24 audit,
 *     repair 4 — "'OCR ran' can pass as 'OCR recovered the label'"):
 *     P4a OCR EXECUTION: the durable record selected by STRUCTURED
 *     source.sha256 equality (never a serialized-JSON substring match) names
 *     the adapter (pipeline.engines_used / unit engine — primary_engine is a
 *     selection, not a run), the region unit's state and the invocation
 *     counts, correlated by job_id/written_at; with no durable record (units
 *     persist ONLY for recognised regions — current-code contract) the
 *     channel is the F152 region report on the persisted attachment spine
 *     ("probe passes N, engine calls M; states {...}") with probe >= 1 and
 *     engine calls >= 1 — inspected AND engine-evidenced, never a silent skip;
 *     P4b OCR RECOVERY: the exact region unit's TEXT FIELD (metadata
 *     mentions never count) carries the FULL printed label (digit included)
 *     from a PRODUCING engine. A recovery FAIL is a RECORDED FACT (the
 *     three-fact row: "vision label PASS; OCR execution PASS; OCR recovery
 *     FAIL.") — it never fails the visual journey, which stands on P4a +
 *     P5-P7; negative controls: __tests__/f152-ocr-grader.test.ts;
 *  P5 the correct crop in the ANSWERING request's CURRENT-USER content
 *     (2026-11-24 audit, repair 5 — the old grade pooled EVERY captured
 *     request, so a crop from history or a sibling request passed): the LAST
 *     captured request (F121 verbatim-final-request law; __reset scopes the
 *     capture to this turn) is correlated to this turn by carrying this
 *     turn's prompt text, and the region frame's exact png (key.crop_sha256
 *     = sha of the production crop: page render at PROBE_DPI 150 cropped by
 *     the placement rect, byte-exact replay verified) must ride the last
 *     user message's image parts — a crop ONLY in history or ONLY in a
 *     different request FAILS; a correct answer alone is NOT proof;
 *  P6 the persisted attachment frame: region "pdf:1:page:1/image:0" (the
 *     product region-id contract kind:unit:part), state engine-evidenced
 *     ("recognised" or "empty" — the engine RAN), pixels byte-identical to
 *     the production region render;
 *  P7 the pixel CHAIN, end to end: chart raster (key.measured_rgb_chart) ->
 *     page render -> production crop (key.crop_sha256 + key.cross_sample_rgb,
 *     staged model-free) -> the exact bytes in the captured final request
 *     (proxy) -> the graded answer (P2). A colour disagreement fails at the
 *     delivery leg, where the 2026-11-24 channel swap lived (violet arrived
 *     as pink rgb(219,61,150)), never at the answer.
 *
 * Row fr-F152b runs the UNSEEN chart (f152-survey2.pdf, "SIGMA 4", amber
 * crossing): the same field law, crop chain and pixel proof on a fixture
 * whose facts are in no prompt, filename, key carried from an earlier run,
 * or earlier results line — generality of the grader, not a memorised violet.
 *
 * Grading key: $F152_KEY_DIR/f152-survey.key.json (the launching kit's own
 * attempt dir; default .data/tmp/file-regression/f152-live-1). The label and
 * colour words exist in NO metadata, alt text, filename, native text,
 * prompt, or web source — the pixels are the only channel, so a text leak
 * cannot fake a pass and the visual path must really deliver.
 *
 * Results ride a DEDICATED jsonl (results-live-f152.jsonl) — separate from
 * the frozen 105/119 matrix, per the F152 brief.
 */
import { test, expect, Locator, Page, Response } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gradeAnswer, verifyCropPixels, type F152Key } from "./lib/f152-colour-grader";
import {
  selectRecordsForSource, parseRegionReport, gradeOcrExecution, gradeOcrRecovery,
  combineFacts, gradeCropDelivery, type OcrRecordEntry,
} from "./lib/f152-ocr-grader";

const LIVE = path.join(
  process.cwd(), ".data", "tmp", "file-regression", "fr-20261122a", "dl", "live",
);
// The kit that launches this row owns its own attempt directory (key +
// f152-running freshness marker live THERE, next to the submit kit); the
// env pin is absolute. Default keeps the original f152-live-1 layout.
const KEY_DIR = process.env.F152_KEY_DIR
  ? path.resolve(process.env.F152_KEY_DIR)
  : path.join(process.cwd(), ".data", "tmp", "file-regression", "f152-live-1");
const KEY_JSON = path.join(KEY_DIR, "f152-survey.key.json");
const RESULTS = path.join(
  process.cwd(), "docs", "overnight", "file-regression-fr-20261122a", "results-live-f152.jsonl",
);
const OCR_RESULTS = path.join(process.cwd(), ".data", "e2e-store", "python", "ocr-results");

const FILE_INPUT = '[data-testid="file-input"]';
const CHIP = '[data-testid="attachment-chip"]';
const SEND = '[data-testid="send-button"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const PROGRESS = '[data-testid="progress-chip"]';
const SCROLL = '[data-testid="messages-scroll"]';
const ANSWER_BODY = '[data-testid="answer-body"]';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function record(row: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), row, ...obj }) + "\n");
}

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
}

/** Fresh page, reasoning off, upload -> ready -> prompt -> completed reply
 *  (the fr-live-regression harness, copied verbatim in shape). */
async function send(
  page: Page, file: string, prompt: string, t: { extract: number; model: number },
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
    throw new Error(`extraction not ready (status: ${status}, title: ${await chip.getAttribute("title")})`);
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
  while (Date.now() < deadline) {
    const state = await reply.getAttribute("data-state").catch(() => null);
    if (state === "error") throw new Error(`chat failed: ${await reply.innerText()}`);
    if (ttftMs < 0 && (await reply.locator(ANSWER_BODY).first().innerText().catch(() => "")).trim().length > 0) {
      ttftMs = Date.now() - tAsk;
      record(`${currentRow}.milestone`, { phase: "first-token", ttftMs });
    }
    if (state === "complete") {
      const chipLabel = (await page.locator(PROGRESS).first().innerText().catch(() => "")).trim();
      const driving = await page.getByText("RUKE is driving").count();
      const bottomGap = await page.locator(SCROLL).evaluate((el: Element) => {
        const e = el as HTMLElement;
        return e.scrollHeight - e.scrollTop - e.clientHeight;
      });
      const body = reply.locator(ANSWER_BODY);
      const said = (await (await body.count()
        ? body.first().innerText()
        : reply.innerText()).catch(() => "")).trim();
      const newReplies = (await page.locator(ASSISTANT).count()) - before;
      return { said, readyMs, ttftMs, totalMs: Date.now() - tAsk, newReplies, driving, bottomGap, chipLabel };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("the assistant never finished answering");
}

function laws(row: string, t: Turn): void {
  expect(t.newReplies, `${row}: more than one assistant reply for one send`).toBe(1);
  expect(t.said.toLowerCase(), `${row}: reply carries retry text`).not.toMatch(/retry|try again/);
}

function log(row: string, t: Turn): void {
  console.log(`[${row}] ready=${t.readyMs}ms ttft=${t.ttftMs}ms total=${t.totalMs}ms :: ${t.said.replace(/\s+/g, " ").slice(0, 160)}`);
  record(row, { ...t, said: t.said.slice(0, 1200) });
}

/* Dispatch capture on the /api/chat wire (fr-live-regression, F147 wire law). */
interface Dispatch { started: number; requested: number; retrieved: number; rejected: string[] }
interface StageFrame { stage?: string; activityStatus?: string; researchLedger?: { actions?: { tool: string; ok: boolean; requested: number; retrieved: number; error?: string }[] } }
function countDispatch(frames: StageFrame[]): Dispatch {
  const d = { started: 0, requested: 0, retrieved: 0, rejected: [] as string[] };
  for (const f of frames) {
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
          try { const j = JSON.parse(m[1]); frames.push((j.ruke_stage ?? j) as StageFrame); } catch { /* keepalive */ }
        }
      }
      return countDispatch(frames);
    },
  };
}

/* Per-question verdicts (F85): each proof records its own PASS/FAIL row and
   gradeGroup() fails the test at the END with the full table. */
const groupVerdicts: Map<string, { row: string; ok: boolean; reason: string; fact?: boolean }> = new Map();
let currentRow = "";
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
async function qFact(
  row: string, run: () => Promise<{ ok: boolean; reason: string }>,
): Promise<{ ok: boolean; reason: string }> {
  // A RECORDED FACT: it appears in the verdict table with its honest
  // PASS/FAIL (F85 law), and it NEVER fails the group — the repair-4
  // recovery verdict is a preserved fact about OCR, not a gate on the
  // visual journey the user can still use (brief: "Do not make OCR success
  // a prerequisite for displaying a usable visual").
  let v = { ok: false, reason: "fact grader reported nothing" };
  try {
    v = await run();
  } catch (e) {
    v = { ok: false, reason: (e as Error).message.split("\n")[0].slice(0, 300) };
  }
  groupVerdicts.set(row, { row, ok: v.ok, reason: v.reason, fact: true });
  record(`${row}.verdict`, { pass: v.ok, fact: true, reason: v.reason });
  return v;
}

function gradeGroup(group: string): void {
  const rows = [...groupVerdicts.values()];
  groupVerdicts.clear();
  record(`${group}.grade`, { rows });
  const bad = rows.filter((r) => !r.ok && !r.fact);
  expect(bad, `per-proof verdicts [${group}]: ${rows.map((r) => `${r.row}=${r.ok ? "PASS" : `FAIL(${r.reason})`}`).join(" ")}`).toEqual([]);
}

const FIX = (name: string): string => {
  const p = path.join(LIVE, name);
  if (!fs.existsSync(p)) throw new Error(`fr live fixture missing: ${p}`);
  return p;
};

const STORE = path.join(process.cwd(), ".data", "e2e-store");

/** Newest chat records' attachment for the fixture (name substring match).
 *  `file` is the persisted conversation record's name — the conversation id
 *  the crop-delivery proof correlates against (repair 5). */
function storeAttachment(fixtureName: string): { file: string; text: string; frames: { dataUrl?: string; label?: string; region?: string; region_state?: string }[] } {
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
        if (String(a.name ?? "").includes(fixtureName) && (typeof a.text === "string" || Array.isArray(a.frames)))
          return { file: f, text: typeof a.text === "string" ? a.text : "", frames: Array.isArray(a.frames) ? a.frames : [] };
  }
  return { file: "", text: "", frames: [] };
}

/** All durable cascade results (bounded poll: the record write is async
 *  w.r.t. the chat answer). Selection is STRUCTURED — records whose
 *  source.sha256 EQUALS the fixture sha (repair 4); the old
 *  JSON.stringify(body).includes(sha) matched any record merely MENTIONING
 *  the sha. The full list returns so the graders can also grade the
 *  record-absent (report) channel. */
async function ocrRecordsFor(sha: string): Promise<OcrRecordEntry[]> {
  const readAll = (): OcrRecordEntry[] => {
    if (!fs.existsSync(OCR_RESULTS)) return [];
    const out: OcrRecordEntry[] = [];
    for (const f of fs.readdirSync(OCR_RESULTS).filter((x) => x.endsWith(".json"))) {
      try { out.push({ name: f, body: JSON.parse(fs.readFileSync(path.join(OCR_RESULTS, f), "utf8")) }); } catch { /* partial write: skip */ }
    }
    return out;
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const all = readAll();
    if (selectRecordsForSource(all, sha).length > 0) return all;
    if (Date.now() >= deadline) return all;
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Proxy channel: the verbatim final-Qwen requests (F121 evidence law). */
async function proxyFetch(api: string): Promise<any> {
  const portFile = process.env.E2E_LLM_PROXY_PORT_FILE;
  if (!portFile || !fs.existsSync(portFile)) throw new Error("E2E_LLM_PROXY_PORT_FILE missing — proxy channel unavailable, crop proof impossible");
  const { port } = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const res = await fetch(`http://127.0.0.1:${port}/${api}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`proxy /${api} -> HTTP ${res.status}`);
  const text = await res.text(); // /__reset answers 204 with an empty body
  return text ? JSON.parse(text) : null;
}

/** sha256 of every image payload in the captured chat-completion requests.
 *  The proxy captures each request body VERBATIM (scripts/e2e-llm-proxy.mjs
 *  pushes body.toString("utf8")), so __captured is an array of JSON STRINGS:
 *  one parse of the array is not enough — each entry must be parsed itself
 *  before its messages can be scanned. */
async function capturedImages(): Promise<{ shas: string[]; buffers: Map<string, Buffer>; requests: number }> {
  const captured = await proxyFetch("__captured");
  const shas: string[] = [];
  const buffers = new Map<string, Buffer>();
  for (const entry of captured) {
    let body: any = entry;
    if (typeof entry === "string") {
      try { body = JSON.parse(entry); } catch { continue; }
    }
    for (const msg of body?.messages ?? []) {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const p of parts) {
        const url = p?.type === "image_url" ? String(p.image_url?.url ?? "") : "";
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
        if (m) {
          const buf = Buffer.from(m[1], "base64");
          const sha = sha256(buf);
          shas.push(sha);
          buffers.set(sha, buf); // the exact bytes the model request carried
        }
      }
    }
  }
  return { shas, buffers, requests: captured.length };
}

/** The captured request bodies, PARSED, in capture order (the answering
 *  request is the last one — F121 law). Repair 5's delivery grading needs
 *  per-request structure: pooling all image parts across requests is exactly
 *  what made history/sibling-request crops pass. */
async function capturedBodies(): Promise<any[]> {
  const captured = await proxyFetch("__captured");
  const bodies: any[] = [];
  for (const entry of captured) {
    if (typeof entry === "string") {
      try { bodies.push(JSON.parse(entry)); } catch { /* non-JSON body: not a chat request */ }
    } else bodies.push(entry);
  }
  return bodies;
}

/** The pinned prompt, shared by the send and the delivery correlation: the
 *  answering request is tied to THIS turn by carrying this exact text in its
 *  last user message. */
const CROP_PROMPT =
  "Page 1 of the attached PDF embeds a chart image. The image carries a short label printed ONLY inside the picture, and several coloured lines are drawn against a dashed reference line. What is the label printed in the image, and which coloured line crosses above the dashed reference line? Reply in exactly two lines and nothing else: first line \"LABEL: <the label>\", second line \"COLOUR: <one colour word>\".";

/** Product region-id contract (region_ocr.region_id): "{kind}:{unit}:{part}"
 *  — the part for a PDF figure is "page:1/image:0" (the figure, not the
 *  page); the unit id (1) is what the durable cascade record keys its unit by. */
const REGION = "pdf:1:page:1/image:0";
const REGION_UNIT = Number(REGION.split(":")[1]);

test("fr-F152 pixel-only label + threshold-crossing crop", async ({ page }) => {
  test.setTimeout(900_000);
  currentRow = "fr-F152";
  record("fr-F152", { phase: "start" });

  const key = JSON.parse(fs.readFileSync(KEY_JSON, "utf8"));
  expect(fs.existsSync(FIX("f152-survey.pdf")), "staged fixture missing").toBe(true);
  expect(fs.readFileSync(FIX("f152-survey.pdf")).length, "fixture size drift vs key").toBe(key.pdf_bytes);
  expect(sha256(fs.readFileSync(FIX("f152-survey.pdf"))), "fixture sha drift vs key").toBe(key.pdf_sha256);

  // P0 (F152 Part 1): prove the app under test BEFORE the journey runs.
  await q("P0 app identity (launcher-owned, isolated store, proxy LLM)", async () => {
    const identity = path.join(STORE, "launcher-identity.json");
    expect(fs.existsSync(identity), `launcher identity missing: ${identity}`).toBe(true);
    const id = JSON.parse(fs.readFileSync(identity, "utf8"));
    expect(id.schema, "identity schema").toBe("ruke.e2e-launcher-identity.v1");
    expect(id.reusedForeign, "app was a REUSED foreign instance — its environment, not this tree, owns the evidence").toBe(false);
    expect(String(id.storePath).replace(/\\/g, "/"), "isolated store").toContain("/.data/e2e-store");
    const portFile = process.env.E2E_LLM_PROXY_PORT_FILE;
    expect(portFile, "E2E_LLM_PROXY_PORT_FILE missing — cannot prove the capture proxy IS the app's LLM").toBeTruthy();
    const { port } = JSON.parse(fs.readFileSync(portFile!, "utf8"));
    expect(String(id.llmEnvSet), "app LLM env does not point at this kit's capture proxy").toContain(`127.0.0.1:${port}`);
    expect(id.owner3101?.Pid, "no Rust :3101 owner recorded — production path unproven").toBeTruthy();
    const running = path.join(KEY_DIR, "f152-running");
    if (fs.existsSync(running)) {
      expect(fs.statSync(identity).mtimeMs, "identity is STALE (older than this attempt's start)").toBeGreaterThanOrEqual(fs.statSync(running).mtimeMs);
    }
    record("fr-F152.identity", { runId: id.runId, appStartedUtc: id.appStartedUtc, llmResolved: id.llmResolved, owner3101: id.owner3101 });
  });

  const P1_ROW = "P1 FULL label fact incl. digit (pixels-only, answer)";
  const EXEC_ROW = "P4a OCR execution (structured sha selection; adapter + region state + invocations)";
  const RECOV_ROW = "P4b OCR recovery (region unit TEXT has full label + producing engine) [fact]";

  await proxyFetch("__reset"); // the crop proof grades THIS turn's requests
  const cap = chatCapture(page);
  cap.begin();
  // The pinned two-line format (audit law): the grader scores the COLOUR
  // FIELD, not a whole-response word scan — prose mentions, listings and
  // negations cannot pass, and label/colour facts stay separable.
  const t = await send(page, FIX("f152-survey.pdf"), CROP_PROMPT, { extract: 420_000, model: 300_000 });
  const d = await cap.collect();
  record("fr-F152.dispatch", { ...d });
  log("fr-F152", t);
  laws("fr-F152", t);

  const att = storeAttachment("f152-survey.pdf");
  record("fr-F152.att", { textLen: att.text.length, frames: att.frames.length });

  await q(P1_ROW, async () => {
    // Amended brief: grade the FULL printed label, digit included — a partial
    // "kappa" answer is NOT a pass (the live run recovered "KAPPA" while the
    // unit's label grade demanded the complete label).
    const full = normalize(String(key.label_text)); // "KAPPA 9" -> "kappa9"
    expect(normalize(t.said), `full label "${key.label_text}" missing from answer: ${t.said.slice(0, 300)}`).toContain(full);
  });
  await q("P2 crossing colour (COLOUR field, canonicalised; 'pink' stays a FAIL)", async () => {
    // 2026-11-24 audit: the old grade scanned the WHOLE answer for any word in
    // a perceptual family map, so "pink" passed violet and prose mentions
    // passed. The grader scores the pinned COLOUR field only, through the
    // synonym families measured on the fixture's own pixels (key.
    // colour_synonyms[key.color_word]) — pink/magenta is NOT a violet answer
    // (delivered hues 274° vs 326°) — and rejects negation, listings and
    // colour words outside the field. Negative controls:
    // __tests__/f152-colour-grader.test.ts.
    const v = gradeAnswer(t.said, key as F152Key);
    record("fr-F152.p2fields", {
      labelOk: v.labelOk, colourOk: v.colourOk, canonical: v.colourCanonical,
      tokens: v.colourTokens, reasons: v.reasons, measured: key.cross_sample_rgb,
    });
    expect(v.colourOk,
      `COLOUR field fails (measured crossing colour "${key.color_word}" rgb ${JSON.stringify(key.cross_sample_rgb)}): ${v.reasons.join("; ")} :: answer ${t.said.slice(0, 300)}`)
      .toBe(true);
  });
  await q("P3 zero web dispatch (file-only wire law)", async () => {
    expect(d.started, `file-only turn dispatched ${d.started} web actions: ${JSON.stringify(d)}`).toBe(0);
    expect(d.requested, `file-only turn requested ${d.requested} web lookups: ${JSON.stringify(d)}`).toBe(0);
  });
  // Repair 4: OCR EXECUTION and OCR RECOVERY are SEPARATE verdicts. The live
  // run to beat recorded 0/1 recognised with 2 engine calls (the engine RAN,
  // returned nothing) and the old single P4 PASSED "OCR recovered the label"
  // by searching serialized JSON for the sha and serialized units for the
  // label. Execution gates; recovery is a recorded fact; the visual journey
  // stands on execution + pixels, never on OCR success.
  const records = await ocrRecordsFor(String(key.pdf_sha256));
  const report = parseRegionReport(att.text);
  await q(EXEC_ROW, async () => {
    const v = gradeOcrExecution({ records, report, sourceSha: String(key.pdf_sha256), regionUnit: REGION_UNIT });
    record("fr-F152.engine", {
      channel: v.channel, adapter: v.adapter, invocations: v.invocations,
      regionState: v.regionState, correlation: v.correlation, reasons: v.reasons,
      selected: selectRecordsForSource(records, String(key.pdf_sha256)).map((r) => r.name),
      report: report ?? att.text.slice(0, 300),
    });
    expect(v.ok, v.reasons.join("; ")).toBe(true);
  });
  const recovery = await qFact(RECOV_ROW, async () => {
    const r = gradeOcrRecovery({ records, sourceSha: String(key.pdf_sha256), regionUnit: REGION_UNIT, labelText: String(key.label_text) });
    record("fr-F152.recovery", { verdict: r.verdict, engine: r.engine, recoveredText: r.recoveredText.slice(0, 200), reasons: r.reasons });
    return { ok: r.ok, reason: r.reasons.join("; ") };
  });
  // The three facts, preserved together (brief's exact reporting):
  record("fr-F152.threefacts", {
    sentence: combineFacts(
      groupVerdicts.get(P1_ROW)?.ok ?? false,
      groupVerdicts.get(EXEC_ROW)?.ok ?? false,
      recovery.ok,
    ),
  });
  await q("P5 crop in the ANSWERING request's current-user content (turn-correlated)", async () => {
    const bodies = await capturedBodies();
    const v = gradeCropDelivery({ bodies, cropSha: String(key.crop_sha256), promptText: CROP_PROMPT });
    record("fr-F152.requestImages", {
      requests: v.requests, answeringIndex: v.answeringIndex, imageParts: v.cropShasSeen.length,
      cropSha: key.crop_sha256, cropInCurrentUser: v.cropInCurrentUser,
      historyOnly: v.historyOnly, otherRequestOnly: v.otherRequestOnly,
      conversation: att.file, reasons: v.reasons,
    });
    expect(v.ok, v.reasons.join("; ")).toBe(true);
  });
  await q("P7 delivered crop pixels ARE the measured crossing colour (chain law)", async () => {
    // Original chart raster (key.measured_rgb_chart) -> page render ->
    // production crop (key.crop_sha256 + key.cross_sample_rgb, staged
    // model-free) -> THE REQUEST BYTES (proxy capture) -> the answer (P2).
    // This is where the 2026-11-24 channel swap showed up: the crop delivered
    // rgb(219,61,150) = hue 326° pink while the source was violet 274°, and
    // the model answered honestly about the pixels it received. A colour
    // disagreement is attributed HERE, at the delivery, never to the answer.
    const { buffers } = await capturedImages();
    const crop = buffers.get(String(key.crop_sha256));
    expect(crop, `crop ${String(key.crop_sha256).slice(0, 12)} absent from the captured requests: pixel chain unmeasurable`).toBeTruthy();
    const px = verifyCropPixels(new Uint8Array(crop!), key as F152Key);
    record("fr-F152.pixels", { sample: key.crop_sample_point, ...px });
    expect(px.ok,
      `the crop the model received carries rgb ${JSON.stringify(px.measured)} (hue ${px.hueMeasured.toFixed(0)}°) at the crossing sample, not the measured rgb ${JSON.stringify(px.expected)} (hue ${px.hueExpected.toFixed(0)}°) — the ANSWER is not the place to blame (channel-order law)`)
      .toBe(true);
  });
  await q("P6 persisted frame: region, state, exact pixels", async () => {
    expect(att.frames.length, "attachment frames not persisted to the chat record").toBeGreaterThan(0);
    const f = att.frames.find((x) => x.region === REGION);
    expect(f, `no frame for region ${REGION}: ${JSON.stringify(att.frames.map((x) => ({ region: x.region, state: x.region_state, label: x.label })))}`).toBeTruthy();
    // Engine-evidenced states only. "recognised": the engine read text; "empty":
    // the engine RAN and found no text (region_ocr's own state law) — the
    // visual path then answers from the frame's pixels, which P1 proves.
    // "skipped"/"unreadable" mean the engine never ran on this glyph-bearing
    // region and fail the row honestly.
    expect(["recognised", "empty"], `region state ${f!.region_state} is not engine-evidenced`).toContain(f!.region_state);
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(f!.dataUrl ?? ""));
    expect(m, "frame dataUrl is not a base64 PNG").toBeTruthy();
    expect(sha256(Buffer.from(m![1], "base64")), "persisted frame pixels are not the production region render")
      .toBe(key.crop_sha256);
  });
  gradeGroup("fr-F152");
});

/**
 * fr-F152b — the UNSEEN chart (added by the 2026-11-24 audit): a second
 * fixture (f152-survey2.pdf, "SIGMA 4", amber crossing line, different
 * geometry, axis word "LIMIT", new prose) whose facts appear in no filename,
 * prompt wording, key carried from an earlier run, or earlier results line.
 * It grades the grader's generality: the SAME field law, synonym map, crop
 * chain and delivery proof must carry a colour the violet fixture never
 * tested. A pass here cannot be a memorised "violet".
 */
test("fr-F152b unseen chart: label + crossing colour, field-graded, pixels proven", async ({ page }) => {
  test.setTimeout(900_000);
  currentRow = "fr-F152b";
  record("fr-F152b", { phase: "start" });

  const key = JSON.parse(fs.readFileSync(path.join(KEY_DIR, "f152-survey2.key.json"), "utf8"));
  expect(fs.existsSync(FIX("f152-survey2.pdf")), "staged unseen fixture missing").toBe(true);
  expect(sha256(fs.readFileSync(FIX("f152-survey2.pdf"))), "unseen fixture sha drift vs key").toBe(key.pdf_sha256);

  await proxyFetch("__reset"); // this row's crop/pixel proofs read only THIS turn
  const t = await send(page, FIX("f152-survey2.pdf"), CROP_PROMPT, { extract: 420_000, model: 300_000 });
  log("fr-F152b", t);
  laws("fr-F152b", t);

  await q("U1 FULL label fact (unseen label, pixels-only)", async () => {
    expect(normalize(t.said), `unseen label "${key.label_text}" missing: ${t.said.slice(0, 300)}`)
      .toContain(normalize(String(key.label_text)));
  });
  await q("U2 COLOUR field graded through the key synonyms (unseen colour)", async () => {
    const v = gradeAnswer(t.said, key as F152Key);
    record("fr-F152b.p2fields", {
      labelOk: v.labelOk, colourOk: v.colourOk, canonical: v.colourCanonical,
      tokens: v.colourTokens, reasons: v.reasons, measured: key.cross_sample_rgb,
    });
    expect(v.colourOk,
      `COLOUR field fails (measured crossing colour "${key.color_word}" rgb ${JSON.stringify(key.cross_sample_rgb)}): ${v.reasons.join("; ")} :: answer ${t.said.slice(0, 300)}`)
      .toBe(true);
    // The violet fixture's word must NOT be what this row grades: generality.
    expect(v.colourCanonical, "the unseen chart must test a colour beyond the violet family")
      .not.toBe("violet");
  });
  await q("U3 crop in the ANSWERING request's current-user content (repair-5 law, unseen fixture)", async () => {
    const bodies = await capturedBodies();
    const v = gradeCropDelivery({ bodies, cropSha: String(key.crop_sha256), promptText: CROP_PROMPT });
    record("fr-F152b.requestImages", {
      requests: v.requests, answeringIndex: v.answeringIndex, imageParts: v.cropShasSeen.length,
      cropSha: key.crop_sha256, cropInCurrentUser: v.cropInCurrentUser,
      historyOnly: v.historyOnly, otherRequestOnly: v.otherRequestOnly,
      conversation: storeAttachment("f152-survey2.pdf").file, reasons: v.reasons,
    });
    expect(v.ok, v.reasons.join("; ")).toBe(true);
  });
  await q("U4 delivered crop pixels ARE the measured crossing colour", async () => {
    const { buffers } = await capturedImages();
    const crop = buffers.get(String(key.crop_sha256));
    expect(crop, `crop ${String(key.crop_sha256).slice(0, 12)} absent from the captured requests`).toBeTruthy();
    const px = verifyCropPixels(new Uint8Array(crop!), key as F152Key);
    record("fr-F152b.pixels", { sample: key.crop_sample_point, ...px });
    expect(px.ok,
      `delivered crop rgb ${JSON.stringify(px.measured)} (hue ${px.hueMeasured.toFixed(0)}°) != measured ${JSON.stringify(px.expected)} (hue ${px.hueExpected.toFixed(0)}°)`)
      .toBe(true);
  });
  gradeGroup("fr-F152b");
});
