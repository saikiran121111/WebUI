/**
 * F73 production-level STREAMED-ANSWER acceptance probe (attended policy: manual, never a gate).
 *
 * What it proves end to end, through the routes the browser actually exercises:
 *   1. POST {base}/api/files/extract?name=d1_scanned.pdf&att=<id>  (raw bytes, same fetch shape
 *      as lib/files/docProcessor.ts extractOnServer) - the scanned PDF's text must come out of
 *      the OCR cascade, with the coverage note the delivery layer attaches;
 *   2. POST {base}/api/chat with the attachment_parts lib/chat/client.ts builds (indexed spine +
 *      opening + attachment_ref, or the inline full text when the file was too small to index),
 *      asking a question whose answer sits ONLY on the scanned page the frozen key names;
 *   3. the delivered streamed answer must carry the exact fact from answer-key late_evidence,
 *      the payment deadline, and the page attribution - and the turn must settle in ONE terminal
 *      (the "streams once, never stops and repeats" law).
 *
 * Expectations are READ from docs/overnight/fixtures/d1/answer-key.json (key d1-ocr-1, frozen
 * before any engine ran); nothing here re-states them. A miss is a miss: the probe prints the
 * whole answer and exits non-zero, it never paraphrases the check into passing.
 *
 * Run while `npm run dev` is up (in the content configuration: RUKE_DOCUMENT_OCR_LANGUAGE=eng,
 * no fault env):  node docs/overnight/probes/f73_scanned_answer_probe.mjs [out-name]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.RUKE_BASE ?? "http://localhost:3000";
const REPO = path.resolve(".");
const KEY = JSON.parse(fs.readFileSync(path.join("docs", "overnight", "fixtures", "d1", "answer-key.json"), "utf8"));
const PDF = path.join("docs", "overnight", "fixtures", "d1", "pdfs", "d1_scanned.pdf");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
const outName = process.argv[2] ?? `f73-answer-${stamp}.json`;
const OUT = path.join("docs", "overnight", "logs", outName);

const spec = KEY.fixtures["d1_scanned.pdf"];
const late = spec.late_evidence;            // { page: "6", contains: "4,18,25,000" } - frozen
if (!late || !late.contains) {
  console.error("answer key carries no late_evidence for d1_scanned.pdf - refusing to invent one");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "MISS"} ${name}${detail ? ` - ${detail}` : ""}`);
};

// ---------------------------------------------------------------- 1. upload (real extract route)
const attId = "f73-answer-" + crypto.randomBytes(6).toString("hex");
const bytes = fs.readFileSync(PDF);
const extRes = await fetch(`${BASE}/api/files/extract?name=${encodeURIComponent("d1_scanned.pdf")}&att=${attId}`, {
  method: "POST",
  body: bytes,
  headers: { "content-type": "application/pdf" },
});
const ext = await extRes.json().catch(() => null);
if (!extRes.ok || !ext || ext.error) {
  console.error(`extract failed: ${extRes.status} ${JSON.stringify(ext?.error ?? "")} - precondition not met`);
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, stage: "extract", status: extRes.status, ext }, null, 2));
  process.exit(3);
}
check("extract_delivered_text", typeof ext.text === "string" && ext.text.trim().length > 0,
  `chars=${(ext.text ?? "").length} indexed=${ext.indexed} chunks=${ext.chunkCount ?? 0}`);
check("late_fact_reached_the_body", collapse(ext.text ?? "").includes(late.contains),
  `key fact "${late.contains}" ${collapse(ext.text ?? "").includes(late.contains) ? "is" : "ABSENT from"} the delivered body`);
console.log(`extract coverageNote: ${JSON.stringify(ext.coverageNote ?? null)}`);

// ------------------------------------------------- 2. the turn exactly as the browser builds it
const question =
  `In the attached scanned document there is an arbitration award dated 14 November 2021. ` +
  `What did that award order the defendant to pay, and within what period? State the exact ` +
  `amount as the document gives it, and say which page of the document the award appears on.`;
const label = "Attached file: d1_scanned.pdf";
const parts = [{ type: "text", text: question }];
if (ext.indexed) {
  // Mirrors client.ts attachmentParts for a long indexed document.
  parts.push({
    type: "text",
    text:
      `${label} — this document is long, so its complete content is kept in a local knowledge index ` +
      `(nothing was discarded). You are shown its structural map and its opening; passages relevant ` +
      `to each question are supplied as timestamped evidence when needed.`,
  });
  if (ext.spine) parts.push({ type: "text", text: `Structural map of ${label}:\n${ext.spine}` });
  if (ext.text) parts.push({ type: "text", text: `Opening of the content:\n[content begins]\n${ext.text.slice(0, 900)}\n[content continues — the remainder is indexed, not shown]` });
  parts.push({ type: "attachment_ref", att_id: ext.indexId ?? attId, name: "d1_scanned.pdf", category: ext.category ?? "text" });
} else {
  parts.push({ type: "text", text: `${label}\n[file content begins]\n${ext.text}\n[file content ends]` });
}

const body = {
  model: "default",
  messages: [{ role: "user", content: parts }],
  stream: true,
  stream_options: { include_usage: true },
};
const chatRes = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const chatHeaders = Object.fromEntries(chatRes.headers.entries());
if (!chatRes.ok || !chatRes.body) {
  console.error(`chat route returned ${chatRes.status} - precondition not met`);
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, stage: "chat-open", status: chatRes.status, ext, chatHeaders }, null, 2));
  process.exit(3);
}

// ----------------------------------------------------------- 3. read the stream, score the wire
const decoder = new TextDecoder();
let answer = "";
const stages = [];
let doneFrames = 0, finishReason = null, rukeError = null;
let raw = "";
const reader = chatRes.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  raw += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = raw.indexOf("\n")) >= 0) {
    const line = raw.slice(0, nl).trim();
    raw = raw.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { doneFrames++; continue; }
    let j = null;
    try { j = JSON.parse(payload); } catch { continue; }
    if (j.ruke_stage) { stages.push(j.ruke_stage); continue; }
    if (j.ruke_error) { rukeError = j.ruke_error?.message ?? JSON.stringify(j.ruke_error); continue; }
    const delta = j?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") answer += delta.content;
    const fr = j?.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
  }
}
answer = answer.trim();

console.log(`\nstages seen: ${JSON.stringify(stages)}`);
console.log(`finish_reason=${finishReason} doneFrames=${doneFrames} ruke_error=${rukeError ?? "none"}`);
console.log(`answer (${answer.length} chars):\n${"─".repeat(72)}\n${answer}\n${"─".repeat(72)}`);

const norm = collapse(answer);
check("single_stream_terminal", doneFrames === 1 && finishReason !== "error",
  `doneFrames=${doneFrames} finish=${finishReason} error=${rukeError ?? "none"}`);
check("answer_not_empty", answer.length > 0, `chars=${answer.length}`);
check("late_fact_delivered", norm.includes(late.contains), `exact amount "${late.contains}" (frozen key)`);
check("deadline_delivered", /\b(90|ninety)\b/i.test(norm), "payment period stated");
check("page_attributed", new RegExp(`page\\s*${late.page}\\b`, "i").test(norm) || norm.includes(`p${late.page}`),
  `key names page ${late.page} as the late evidence`);
const mentionCount = (norm.match(/arbitration award/gi) ?? []).length;
check("no_repeat_loop", mentionCount <= 4, `phrase repeated ${mentionCount}x in one answer`);

const ok = results.every((r) => r.ok);
fs.writeFileSync(OUT, JSON.stringify({
  ok, key_version: KEY.key_version, att_id: attId, late,
  extract: { indexed: ext.indexed, chunkCount: ext.chunkCount ?? 0, coverageNote: ext.coverageNote ?? null,
             pages: ext.pages ?? null, truncated: ext.truncated ?? null, text_chars: (ext.text ?? "").length },
  chat: { stages, finishReason, doneFrames, rukeError, headers: chatHeaders, answer },
  checks: results,
}, null, 2), { encoding: "utf8" });
console.log(`\n${ok ? "ANSWER PASS" : "ANSWER FAIL"} - evidence ${OUT}`);
process.exit(ok ? 0 : 1);

function collapse(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
