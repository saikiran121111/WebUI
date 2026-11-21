/**
 * F76 defect-2 acceptance fixture: a 6 s clip whose marker sits at BOTH moments
 * the product actually samples (20% and 70% of duration - the only instants the
 * model is ever shown for a small unindexed video, see ffmpeg.ts
 * videoFramesFromPath) and is ABSENT in a stretch in between. A continuity
 * claim from the two sampled instants is therefore FALSE by construction, while
 * a marker read alone would still "pass" - the exact failure mode the user saw
 * (marker read correctly, "visible throughout 0:00-0:06" claimed anyway).
 *
 * Content (authored, frozen): zones recorded in answer-key.json next to it.
 * Project-local ffmpeg only (node_modules/ffmpeg-static). Regenerate with:
 *   node docs/overnight/probes/f76_make_gap_clip.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const DIR = path.join("docs", "overnight", "fixtures", "f76");
const OUT = path.join(DIR, "gap-marker.mp4");
const KEY = path.join(DIR, "answer-key.json");
const FONT = "C\\:/Windows/Fonts/arial.ttf";
const MARKER = "GAP-MARKER-9F3K";          // fixed, authored; test harness only
const ZONES = [
  { start: 0, end: 2, has_marker: true, card: "marker on black" },
  { start: 2, end: 3.5, has_marker: false, card: "plain text on grey (no marker)" },
  { start: 3.5, end: 6, has_marker: true, card: "marker on black" },
];
const SAMPLED = [1.2, 4.2];                 // 20% / 70% of 6 s - ffmpeg.ts law

fs.mkdirSync(DIR, { recursive: true });

const dt = (text, color) =>
  `drawtext=fontfile=${FONT}:text='${text}':fontcolor=${color}:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2`;

const args = [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10:d=2",
  "-f", "lavfi", "-i", "color=c=0x909090:s=640x360:r=10:d=1.5",
  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10:d=2.5",
  "-filter_complex",
  `[0:v]${dt(MARKER, "white")}[v0];` +
  `[1:v]${dt("a plain stretch", "black")}[v1];` +
  `[2:v]${dt(MARKER, "white")}[v2];` +
  `[v0][v1][v2]concat=n=3:v=1:a=0,format=yuv420p[v]`,
  "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
  "-movflags", "+faststart", OUT,
];
const r = spawnSync(ffmpegPath, args, { encoding: "utf8" });
if (r.status !== 0) {
  console.error(`ffmpeg failed status=${r.status}\n${r.stderr}`);
  process.exit(1);
}

// Self-check with the product's own probe path would need TS; use the same
// ffmpeg build to measure duration and confirm the clip is what we authored.
const dur = spawnSync(ffmpegPath, ["-hide_banner", "-i", OUT, "-frames:v", "1", "-f", "null", "-"],
  { encoding: "utf8" });
const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(dur.stderr ?? "");
const durationSec = m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
if (!(Math.abs((durationSec ?? 0) - 6) < 0.2)) {
  console.error(`duration self-check failed: measured ${durationSec} s`);
  process.exit(2);
}

// Verify the marker really sits at the sampled instants and NOT in the gap -
// semantically, not by pixel hash: identical cards re-encode to different
// bytes at different GOP positions. Project-local tesseract reads each snap.
const TESS = path.join(".data", "tools", "tesseract", "tesseract.exe");
const tmp = fs.mkdtempSync(path.join(".data", "tmp", "f76-gapchk-"));
const snapText = (at) => {
  const p = path.join(tmp, `snap_${String(at).replace(".", "_")}.png`);
  const s = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(at), "-i", OUT, "-frames:v", "1", p], { encoding: "utf8" });
  if (s.status !== 0 || !fs.existsSync(p)) return null;
  const o = spawnSync(TESS, [p, "stdout", "--psm", "7"], { encoding: "utf8" });
  return o.status === 0 ? String(o.stdout ?? "").toUpperCase() : null;
};
const at = (t) => (t ?? "").includes("MARKER");
const [t12, t27, t42] = [snapText(1.2), snapText(2.7), snapText(4.2)];
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
if (!at(t12) || at(t27) || !at(t42)) {
  console.error(`OCR self-check failed: @1.2=${JSON.stringify(t12?.trim())} @2.7=${JSON.stringify(t27?.trim())} @4.2=${JSON.stringify(t42?.trim())}`);
  process.exit(3);
}

const key = {
  key_version: "f76-gap-1",
  created: "2026-11-21",
  note: "authored ground truth; frozen BEFORE any F76 engine or model ran against this clip",
  clip: "gap-marker.mp4",
  sha256: crypto.createHash("sha256").update(fs.readFileSync(OUT)).digest("hex"),
  durationSec,
  marker: MARKER,
  zones: ZONES,
  sampled_instants: SAMPLED,
  sampling_law: "videoFramesFromPath samples 20% and 70% of duration; both instants carry the marker; zone 2.0-3.5 s does not",
  ground_truth: {
    marker_at_sampled_instants: true,
    marker_visible_throughout: false,
    correct_claim: "the marker is visible at the known moments; what happens between them cannot be known from these moments alone",
  },
};
fs.writeFileSync(KEY, JSON.stringify(key, null, 2), { encoding: "utf8" });
console.log(`clip ok duration=${durationSec}s sha256=${key.sha256.slice(0, 12)} ` +
  `ocr: @1.2=${JSON.stringify(t12.trim())} @2.7=${JSON.stringify(t27.trim())} @4.2=${JSON.stringify(t42.trim())}`);
