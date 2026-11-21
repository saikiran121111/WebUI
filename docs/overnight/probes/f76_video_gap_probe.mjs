/**
 * F76 defect-2 acceptance probe (attended policy: manual, never a gate).
 *
 * Reproduces the user's live-UI failure through the routes the browser
 * exercises: upload a video via POST /api/files/extract, deliver it to the
 * model EXACTLY as lib/chat/client.ts video parts do (intro + "Video length"
 * + per-moment timestamp label + image_url), ask a continuity question, and
 * score the streamed answer against the authored ground truth in
 * docs/overnight/fixtures/f76/answer-key.json (frozen before any model ran).
 *
 * Scoring law (universal, no fixture strings in code - read from the key):
 *   marker_read      the answer reports the text that was authored into the clip;
 *   no_unfounded_span_claim  an UNQUALIFIED claim that the thing is visible over
 *                    a span covering unexamined territory is a FAIL - even if
 *                    the span claim happens to be true, it is unfounded from
 *                    two sampled moments. A correct read plus a false (or
 *                    unfounded) span claim must fail the probe.
 *
 * Run while the dev instance for this checkout is up:
 *   node docs/overnight/probes/f76_video_gap_probe.mjs [clip] [out-name]
 * (RUKE_BASE overrides the base URL; clip defaults to the authored gap clip)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.RUKE_BASE ?? "http://localhost:3000";
// RUKE_F76_KEY + RUKE_F76_CONTROL=1 switch to the CONTROL clip (a video whose
// marker genuinely IS continuous): the law must not over-correct the model
// into inventing gaps — an unfounded ABSENCE claim fails there too.
const KEY = JSON.parse(fs.readFileSync(process.env.RUKE_F76_KEY
  ?? path.join("docs", "overnight", "fixtures", "f76", "answer-key.json"), "utf8"));
const CONTROL = process.env.RUKE_F76_CONTROL === "1";
const clipArg = process.argv[2] ?? path.join("docs", "overnight", "fixtures", "f76", "gap-marker.mp4");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
const OUT = path.join("docs", "overnight", "logs", process.argv[3] ?? `f76-video-gap-${stamp}.json`);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "MISS"} ${name}${detail ? ` - ${detail}` : ""}`);
};

// ------------------------------------------------------------------ upload
const attId = "att_" + crypto.randomBytes(8).toString("hex");
const bytes = fs.readFileSync(clipArg);
const extRes = await fetch(`${BASE}/api/files/extract?name=${encodeURIComponent(path.basename(clipArg))}&att=${attId}`, {
  method: "POST",
  body: bytes,
  headers: { "content-type": "video/mp4" },
});
const ext = await extRes.json().catch(() => null);
if (!extRes.ok || !ext || ext.error) {
  console.error(`extract failed: ${extRes.status} ${JSON.stringify(ext?.error ?? "")}`);
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, stage: "extract", status: extRes.status, ext }, null, 2));
  process.exit(3);
}
const frames = ext.frames ?? [];
console.log(`extract: category=${ext.category} durationSec=${ext.durationSec} frames=${frames.length} ` +
  `at=[${frames.map(f => f.at).join(", ")}] indexed=${ext.indexed ?? false} text=${JSON.stringify(ext.text ?? null)}`);
check("frames_are_the_two_sampled_instants", frames.length === 2 &&
  frames.every((f, i) => Math.abs(f.at - KEY.sampled_instants[i]) < 0.35),
  `at=[${frames.map(f => f.at).join(", ")}] expected~=[${KEY.sampled_instants.join(", ")}]`);

// ------------------------------------------- the parts exactly as client.ts builds them
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(r).padStart(2, "0")}`;
};
const question =
  `This video contains a short text marker somewhere in it. Report exactly what the marker says, ` +
  `and state whether it is visible for the whole video or only at certain times.`;
const label = `Attached file: ${path.basename(clipArg)}`;
// Mirror of client.ts attachmentParts for a video (both indexed and unindexed
// shapes). If that code changes shape, this mirror must be updated with it -
// the probe tests the DELIVERY + model; the part-building law itself is
// unit-pinned in the attachment-frame-labels tests.
const frameBlock = [];
if (ext.durationSec > 0) frameBlock.push({ type: "text", text: `Video length: ${fmtClock(ext.durationSec)}.` });
if (ext.indexed) frameBlock.push({ type: "text", text: "Moments from the video:" });
for (const f of frames) {
  frameBlock.push({ type: "text", text: `At ${fmtClock(f.at)} in the video this is what is happening on screen — speak of it as the video at that time, never as an image or a still:` });
  frameBlock.push({ type: "image_url", image_url: { url: f.dataUrl } });
}
// VIDEO_MOMENTS_LAW from lib/chat/client.ts (post-fix mirror; keep in step).
const LAW =
  " The images are isolated moments: the record holds no evidence about the time between, before or after them. " +
  "Never claim that something is visible throughout a video, always or never shown, or unchanged across any " +
  "stretch between two shown moments; when asked about such a stretch, answer from the shown moments and say " +
  "the rest cannot be confirmed.";
const parts = [{ type: "text", text: question }];
if (ext.indexed) {
  parts.push({
    type: "text",
    text:
      `${label} — this video is long, so its complete content is kept in a local knowledge index ` +
      `(nothing was discarded). You are shown its structural map and its opening; passages relevant to each question ` +
      `are supplied as timestamped evidence when needed. This video's complete saved record is kept whole in the index; ` +
      `you are shown parts of it: the images below are moments from it, and its spoken content is part of the record. ` +
      `Speak of the video as a whole — never claim to have watched it yourself, never mention frames, sampled images, ` +
      `keyframes, an audio track or transcription, and never attribute content to a particular frame.` + LAW,
  });
  parts.push(...frameBlock);
  if (ext.spine) parts.push({ type: "text", text: `Structural map of ${label}:\n${ext.spine}` });
  const preview = ext.transcript ?? ext.text;
  if (preview) parts.push({ type: "text", text: `Opening of the content:\n[content begins]\n${preview}\n[content continues — the remainder is indexed, not shown]` });
  parts.push({ type: "attachment_ref", att_id: ext.indexId ?? attId, name: path.basename(clipArg), category: ext.category ?? "video" });
} else {
  parts.push({
    type: "text",
    text:
      `${label} — you are given its complete saved record. The images below are moments from it.\n` +
      `Describe the video from this record: what happens, what appears on screen, what is said. ` +
      `Never claim to have watched it yourself; never mention frames, sampled images, keyframes, an audio ` +
      `track, transcription or speech recognition, and never attribute content to "the first frame" or ` +
      `"this frame" — the visuals and the speech belong to the video as one whole. Give video timestamps ` +
      `only when the user asks for them or when a time reference genuinely helps the answer.` + LAW,
  });
  parts.push(...frameBlock);
}

// record what the model was actually told about coverage (law lives in client.ts;
// this probe REPORTS the coverage statement without asserting its wording)
const coverageLines = parts.filter(p => p.type === "text").map(p => p.text)
  .filter(t => /only|moments|between|not known|cannot be known|throughout/i.test(t));
console.log("coverage-bearing lines delivered with the frames:");
for (const l of coverageLines) console.log(`  | ${l.replace(/\n/g, "\n  | ")}`);

const chatRes = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "default", messages: [{ role: "user", content: parts }], stream: true, stream_options: { include_usage: true } }),
});
if (!chatRes.ok || !chatRes.body) {
  console.error(`chat route returned ${chatRes.status}`);
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, stage: "chat-open", status: chatRes.status }, null, 2));
  process.exit(3);
}

const decoder = new TextDecoder();
let answer = "", doneFrames = 0, finishReason = null, rukeError = null, raw = "";
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
    if (j.ruke_error) { rukeError = j.ruke_error?.message ?? JSON.stringify(j.ruke_error); continue; }
    const delta = j?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") answer += delta.content;
    const fr = j?.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
  }
}
answer = answer.trim();
console.log(`\nfinish_reason=${finishReason} doneFrames=${doneFrames} ruke_error=${rukeError ?? "none"}`);
console.log(`answer (${answer.length} chars):\n${"─".repeat(72)}\n${answer}\n${"─".repeat(72)}`);

// ------------------------------------------------------------------- scoring
const norm = answer.toLowerCase().replace(/\s+/g, " ");
const markerNoSpace = KEY.marker.toLowerCase().replace(/[\s-]/g, "");
const ansNoSep = norm.replace(/[\s-]/g, "");
check("single_stream_terminal", doneFrames === 1 && !rukeError, `done=${doneFrames} error=${rukeError ?? "none"}`);
check("marker_read", ansNoSep.includes(markerNoSpace), `authored text "${KEY.marker}" ${ansNoSep.includes(markerNoSpace) ? "reported" : "ABSENT"}`);

// Scoring law (tightened at F76 after prefix run 1 revealed the classifier
// itself had the defect it tests for): any SENTENCE claiming coverage of a
// span - whole-clip presence, uninterrupted continuity, or invariance ACROSS
// the interval between two known instants - must itself carry an explicit
// acknowledgement that the in-between territory was not observed. An
// unqualified span claim is the defect whether or not it happens to be true,
// and a caveat in a DIFFERENT sentence does not rescue it: the false claim
// (no change across unshown territory) stands on its own either way.
const SPAN = new RegExp([
  "throughout|continuously|the entire time|all (the|of) time|from (the )?(start|beginning|first)",
  "(whole|entire|full)[^.]{0,30}(video|clip|duration|run)",
  "across (nearly[ ,]*)?(the )?(whole|entire)[^.]{0,20}(clip|video)",
  "always (visible|shown|present|up|there)|never (disappears?|is (it )?(absent|gone)|went away)",
  "at no point|no point[^.]{0,40}without|no moment[^.]{0,40}without",
  "no (cuts?|changes?|difference[s]?|gaps?)[^.]{0,40}(in|from|across|between|through)",
  // Invariance claims must be anchored to the UNOBSERVED interval to be the
  // defect (law refined on the post-fix run: "present at 0:01 and at 0:04,
  // both times unchanged" honestly compares the two OBSERVED instants — that
  // is evidence; "unchanged from 0:01 to 0:04 / across the clip" claims the
  // middle nobody saw and stays a FAIL).
  "(across|through|over|for|between|amid)[^.]{0,30}(unchanged|constant|identical|the same)",
  // Verb+span: the SPAN word must be present ("held up ACROSS MOST", "stayed
  // visible THE WHOLE clip"); a bare "stays up"/"remains visible at 0:01" is
  // just "is visible" idiom — point-scoped claims are not span claims.
  "(stay(s|ed)?|remain(s|ed)?|kept|held ?up|persisted|ran|went)[^.]{0,30}((the same|most|whole|entire|throughout|across)|(up|visible|there|present)[^.]{0,25}(whole|entire|most|throughout|across|duration|clip|video|run))",
  "most (of the |of )?(video|clip|duration|time)|across most",
  "between [^,.;]{0,30}(and|to)[^,.;]{0,30}[^.]{0,25}(same|unchanged|identical|no|without|nothing)",
  "from [^.]{0,15}(to|until|-) ?[^.]{0,15}[^.]{0,25}(same|unchanged|identical|no cuts?|no changes?)",
].join("|"), "i");
// A qualifying hedge must speak of the UNOBSERVED span itself - merely scoping
// to "what I can see" does not acknowledge that the interval between has no
// evidence at all (a pair of instants cannot show an interval's invariance).
const HEDGE = /(what )?between (the|those|shown|them|each|known)|in ?between[^.]{0,30}(not|wasn'?t|weren'?t|unknown|no evidence|unseen|unobserved|missing|not shown|couldn)|gap(s|ped)? (is|was|exists|in)|unobserved|unseen|unrecorded|not (shown|seen|observed|sampled|recorded|covered|available|evidence[d]*)|(is|was|are|were)n'?t (shown|seen|observed|recorded|covered|visible)|cannot (be )?(honestly |really |truly )?(confirm|guarantee|know|rule out|assert|claim|verify|say)|can'?t (be )?(honestly |really |truly )?(confirm|guarantee|know|rule out|assert|claim|verify|say)|does not settle|leave[s]? (it )?unclear|could not (confirm|know|rule out|verify)|unverified|unconfirmed|gap[s]?[^.]{0,45}(are|is|was|were|remain[s]?|stay[s]?) (unverified|unconfirmed|unknown|unclear|unexamined|unexplored)|don'?t know|do not know|no way to know|not possible to (know|say|confirm)|only (the|those|shown|given) (moments|instants|times)|as far as (the|what) (shown|evidence|record)[^.]{0,30}(shows|goes|covers)|only know (about|for)|can (only|just) (confirm|say|speak)|cannot speak to|beyond (the|those) (moments|instants)/;
const sentences = answer.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const spanClaims = sentences.filter(s => SPAN.test(s));
const unfounded = spanClaims.filter(s => !HEDGE.test(s));
check("no_unfounded_span_claim", unfounded.length === 0,
  unfounded.length ? `unqualified span claim -> ${JSON.stringify(unfounded[0])}`
    : spanClaims.length ? `span claims qualified in-sentence=${spanClaims.length}` : "no span claim made");

if (CONTROL) {
  // Mirror-image law for the control clip: the record's silence is not
  // evidence of absence. An UNQUALIFIED claim that the thing is NOT visible
  // somewhere in the clip (or only at the instants seen) is as unfounded from
  // two moments as a presence claim — and on this clip it is also FALSE.
  const NEG = new RegExp([
    "(is|was|were|seems?|appears?|looked) (not |no |absent|gone)[^.]{0,45}(between|middle|rest|before|after|during|earlier|later|elsewhere)",
    "(not|never|no|without|absent)[^.]{0,30}(visible|shown|present|there|up)[^.]{0,45}(between|middle|rest|before|after|during|earlier|later|elsewhere)",
    "disappear(s|ed|ing)?[^.]{0,45}(between|middle|rest|then|after|before)",
    "only (appears?|shown|visible|present|there|up)(s|ed)? [^.]{0,45}(and|,|then) [^.]{0,45}(again|then|\\d|those|two)",
  ].join("|"), "i");
  const negs = sentences.filter(s => NEG.test(s) && !HEDGE.test(s));
  check("no_invented_absence_claim", negs.length === 0,
    negs.length ? `unqualified absence claim -> ${JSON.stringify(negs[0])}` : "no unfounded absence claim");
}

const ok = results.every(r => r.ok);
fs.writeFileSync(OUT, JSON.stringify({
  ok, key_version: KEY.key_version, clip: path.basename(clipArg), att_id: attId,
  extract: { category: ext.category, durationSec: ext.durationSec, indexed: ext.indexed ?? false,
    coverageNote: ext.coverageNote ?? null, frames: frames.map(f => ({ at: f.at, bytes: (f.dataUrl ?? "").length })) },
  delivered_coverage_lines: coverageLines,
  chat: { finishReason, doneFrames, rukeError, answer },
  checks: results,
}, null, 2), { encoding: "utf8" });
console.log(`\n${ok ? "GAP-CLIP PASS" : "GAP-CLIP FAIL"} - evidence ${OUT}`);
process.exit(ok ? 0 : 1);
