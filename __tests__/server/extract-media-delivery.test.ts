/**
 * F78 Family G media-delivery regression (2026-11-22), retargeted for F123
 * (2026-11-23) when the TypeScript whisper substitution was removed.
 *
 * What stays REAL here (the F78 law stands where it needs no speech engine):
 *   (1) short transcripts keep every segment TIME in [HH:MM:SS - HH:MM:SS]
 *       form — both the pure formatter and the delivered transcript;
 *   (3) an exact-time question over a frames-only video index serves the
 *       nearest saved moments with the distance named;
 *   (4) the video path keeps its eagerly extracted keyframes: on a frames-only
 *       index they ride in the published index (with their files), on the
 *       small-transcript path a time-spread ships inline before the scratch
 *       dir is released.
 *
 * What moved (F123): the speech engine is now the pinned Python Parakeet job
 * alone. Real-inference CONTENT rows (the Monday / 47 kg / Toronto facts on
 * sound.wav, and stereo overlap.wav per-channel attribution — that channel
 * split was part of the removed TypeScript pipeline) run in the exclusive
 * LIVE acceptance batch against the real backend, never as vitest inferences.
 * What vitest CAN prove deterministically is the ROUTER law: every blocked
 * speech state (no endpoint / admission refused / structural / cancelled)
 * surfaces as an actionable typed outcome naming the SAME pinned engine, and
 * NO whisper module remains reachable anywhere in the extract tree.
 *
 * Pins (set before any production import): RUKE_LLM_AUTOMATIC_HANDOFF=0
 * RUKE_OCR_ALLOW_UNLOAD=0 — a test process never hands off to, probes,
 * unloads or restarts the shared :8080 model. RUKE_SPEECH_CAPABILITY=off —
 * the Python endpoint is not part of unit scope, and the operator switch is
 * a pinned law (it gates BEFORE any job is sent, seam included — pinned in
 * extract-speech-capability.test.ts), so the seam rows below CLEAR the switch
 * per test instead: an injected runJob REPLACES the transport, so those rows
 * have no endpoint in scope either (fully hermetic). Paths without an
 * injected seam take the honest "no backend" admission state. The
 * live-provider guard (vitest setupFiles) fails the run if anything tries to
 * reach :8080.
 */
import { test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

process.env.RUKE_LLM_AUTOMATIC_HANDOFF = "0";
process.env.RUKE_OCR_ALLOW_UNLOAD = "0";
process.env.RUKE_SPEECH_CAPABILITY = "off"; // no Python endpoint in unit scope

const FIX = path.join(process.cwd(), "docs/overnight/fixtures/f78/review-complex-1121");
const ATT = {
  vid: "att_f78gvid",
  av: "att_f78gav",
  asr: "att_f78gasr",
} as const;

let extractFileFromPath: typeof import("@/lib/server/extract").extractFileFromPath;
let store: typeof import("@/lib/server/attachindex/store");
let buildAttachmentTurn: typeof import("@/lib/server/attachindex/turn").buildAttachmentTurn;
let timedTranscriptText: typeof import("@/lib/server/extract").timedTranscriptText;

beforeAll(async () => {
  ({ extractFileFromPath } = await import("@/lib/server/extract"));
  store = await import("@/lib/server/attachindex/store");
  ({ buildAttachmentTurn } = await import("@/lib/server/attachindex/turn"));
  ({ timedTranscriptText } = await import("@/lib/server/extract"));
  for (const att of Object.values(ATT)) store.removeIndex(att);
});

afterAll(() => {
  for (const att of Object.values(ATT)) {
    try {
      store.removeIndex(att);
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** First timestamped line whose text contains `fact`, as [startSec, line]. */
function timedLine(transcript: string, fact: string): [number, string] | null {
  for (const line of transcript.split("\n")) {
    if (!line.includes(fact)) continue;
    const m = /^\[(?:channel \d+)?\s*(?:\[)?(\d\d):(\d\d):(\d\d)/.exec(line.trim());
    if (!m) continue;
    return [Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), line];
  }
  return null;
}

function systemText(messages: any[]): string {
  return messages
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : String(m.content?.[0]?.text ?? "")))
    .join("\n\n");
}

/** A wire envelope in exactly the shape ml-job.ts normalizes. */
function envelope(state: string, extra: Record<string, unknown> = {}): any {
  return {
    state,
    capability: "speech.asr",
    job_id: "job-f123",
    run_id: "run-f123",
    request_id: "req-f123",
    deadline_s: 240,
    source: "test-seam",
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * The formatter law (F78 defect 1) — engine-independent.
 * ------------------------------------------------------------------ */

test("timedTranscriptText puts every segment in [HH:MM:SS - HH:MM:SS] form", () => {
  const out = timedTranscriptText([
    { text: "  The harbor opens on Monday. ", start: 3, end: 6 },
    { text: "no end segment", start: 61 },
    { text: "   ", start: 10, end: 12 },
  ] as any[]);
  expect(out).toBe("[00:00:03 - 00:00:06] The harbor opens on Monday.\n[00:01:01 - 00:01:01] no end segment");
});

/* ------------------------------------------------------------------ *
 * F123 router law: the pinned speech job is the SOLE engine, and every
 * blocked state is actionable with the SAME engine promised — proven
 * through the real production router with the job seam injected.
 * ------------------------------------------------------------------ */

test("F123: no whisper module remains anywhere in the extract tree", () => {
  const extractDir = path.join(process.cwd(), "lib/server/extract");
  expect(fs.existsSync(path.join(extractDir, "audio.ts"))).toBe(false);
  for (const f of ["index.ts", "speech-capability.ts", "ffmpeg.ts"]) {
    const src = fs.readFileSync(path.join(extractDir, f), "utf8");
    expect(src, `${f} imports the deleted audio module`).not.toMatch(/from ["']\.\/audio["']/);
    expect(src, `${f} pulls the whisper ONNX runtime`).not.toMatch(/@huggingface\/transformers/);
    expect(src, `${f} references the whisper checkpoint env`).not.toMatch(/WHISPER_MODEL/);
  }
  // The positive law is stated where the routing happens.
  const idx = fs.readFileSync(path.join(extractDir, "index.ts"), "utf8");
  expect(idx).toContain("Parakeet");
});

test("F123: audio with no reachable pinned backend throws an actionable retryable state", async () => {
  // RUKE_SPEECH_CAPABILITY is off, so the router takes the honest "none"
  // path: it must NAME the pinned engine and the retry, never substitute.
  await expect(
    extractFileFromPath("sound.wav", path.join(FIX, "sound.wav"), ATT.asr),
  ).rejects.toThrow(/Parakeet[\s\S]*retryable admission state/);
});

test("F123: an admission refusal surfaces the worker's own reason and human step", async () => {
  delete process.env.RUKE_SPEECH_CAPABILITY; // the seam REPLACES the transport: no endpoint in scope
  const runJob = async () =>
    envelope("unavailable", {
      error: {
        reason: "asset_missing",
        message: "the pinned snapshot of nvidia/parakeet-tdt-0.6b-v3 is not prepared locally",
        retryable: true,
        capability: "speech.asr",
        human_step: "the first upload prepares it automatically (progress is shown in the composer)",
      },
    });
  await expect(
    extractFileFromPath("sound.wav", path.join(FIX, "sound.wav"), ATT.asr, undefined, undefined, { runJob } as any),
  ).rejects.toThrow(/snapshot of nvidia\/parakeet[\s\S]*composer[\s\S]*retryable admission state/);
});

test("F123: a structural refusal is final for the file and promises no re-run", async () => {
  delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: no endpoint in scope
  const runJob = async () =>
    envelope("unavailable", {
      error: {
        reason: "corrupt_input",
        message: "ffprobe found no decodable audio stream in this container",
        retryable: false,
        capability: "speech.asr",
        human_step: "",
      },
    });
  const err = await extractFileFromPath("broken.wav", path.join(FIX, "sound.wav"), ATT.asr, undefined, undefined, { runJob } as any)
    .then(() => null, (e: unknown) => e as Error);
  expect(err).not.toBeNull();
  expect(err!.message).toContain("ffprobe found no decodable audio stream");
  // A structural verdict is a fact about THIS file: the router must not
  // promise a same-engine retry for something no engine can change.
  expect(err!.message).not.toMatch(/retryable admission state/);
});

test("F123: caller cancellation propagates as cancellation, not as a media defect", async () => {
  delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: no endpoint in scope
  const runJob = async () => envelope("cancelled");
  await expect(
    extractFileFromPath("sound.wav", path.join(FIX, "sound.wav"), ATT.asr, undefined, undefined, { runJob } as any),
  ).rejects.toThrow(/aborted/);
});

test("F123: a ready run delivers timed segments with the pinned engine's provenance", async () => {
  delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: no endpoint in scope
  const runJob = async () =>
    envelope("ready", {
      result: {
        state: "transcribed",
        text: "the cargo weighs 47 kg",
        segments: [{ text: "the cargo weighs 47 kg", start: 60.4, end: 64.2 }],
        segment_count: 1,
        language: "en",
        language_source: "explicit",
        model: "nvidia/parakeet-tdt-0.6b-v3",
        device: "cuda",
        compute_type: "auto",
        duration: 66,
        complete: true,
        asr_ran: true,
        note: "",
        examined: [[0, 66]],
        coverage: { skipped: [] },
        audio_level: {},
        probe: {},
        routing: {},
        vad_filter: false,
        vad_state: "unsupported_by_backend",
        superseded_fragments: 0,
        superseded: [],
      },
    });
  const r = await extractFileFromPath("sound.wav", path.join(FIX, "sound.wav"), ATT.asr, undefined, undefined, { runJob } as any);
  const t = String((r as any).transcript ?? "");
  // F78 defect (1) law, now on the Python job's segments: times ride the
  // inline transcript, and the run's REPORTED provenance (model + device)
  // rides the note — never a label the caller invented.
  const kg = timedLine(t, "47 kg");
  expect(kg, `no timed line for 47 kg in: ${t}`).not.toBeNull();
  expect(kg![0]).toBe(60);
  expect(t).toContain('nvidia/parakeet-tdt-0.6b-v3');
  expect(t).toContain("cuda");
});

/* ------------------------------------------------------------------ *
 * Real ffmpeg rows (no speech engine needed).
 * ------------------------------------------------------------------ */

test(
  "exact-time questions over a frames-only video index serve the nearest saved moments",
  async () => {
    process.env.RUKE_SPEECH_CAPABILITY = "off"; // restored after the seam rows: no endpoint in scope
    const r = await extractFileFromPath("three-hours.mp4", path.join(FIX, "three-hours.mp4"), ATT.vid);
    expect(r.indexed).toBe(true);
    // F123: the video's speech row is the pinned job; with the endpoint out of
    // unit scope the frames survive and the coverage note SAYS the spoken
    // content is blocked and retryable — the frames are never silently sold
    // as full evidence.
    const note = String((r as any).coverageNote ?? (r as any).text ?? "");
    expect(note).toContain("pinned speech backend is not available");
    expect(note).toContain("visual content WAS read");
    const idx = store.readIndex(ATT.vid);
    const ats = (idx?.meta.frames ?? []).map(f => f.at).sort((a, b) => a - b);
    expect(ats.length).toBeGreaterThanOrEqual(60);
    expect(ats).toContain(5460); // the 01:31:00 frame is indexed

    const ask = async (q: string, conv: string) => {
      const messages: any[] = [
        {
          role: "user",
          content: [
            { type: "text", text: q },
            { type: "attachment_ref", att_id: ATT.vid, name: "three-hours.mp4", category: "video" },
          ],
        },
      ];
      const blocks = await buildAttachmentTurn(messages, 0, q, undefined, "default", conv);
      // The evidence is injected as a system block BEFORE the user turn, so
      // the user message is no longer necessarily at index 0.
      const user = messages.find(m => m.role === "user");
      return {
        blocks,
        images: ((user?.content ?? []) as any[]).filter((p: any) => p.type === "image_url").length,
        text: systemText(messages),
      };
    };

    // Defect (3): baseline delivered injectedBlocks=0 imageParts=0.
    const one = await ask("What is on screen at 01:31:00?", "conv-f78g-exact");
    expect(one.blocks).toBeGreaterThanOrEqual(1);
    expect(one.images).toBeGreaterThanOrEqual(1);
    expect(one.text).toContain("Asked time 01:31:00");
    expect(one.text).toContain("cannot be confirmed"); // unconfirmable-between law
    expect(one.text).toContain("[coverage:");
    expect(one.text).toContain("[ranking:");

    // The asked instant has no saved moment (PAUSE 793 at 6381-6383 s): the
    // nearest saved moment (6420 s = 01:47:00) is served WITH its distance
    // named — never presented as the asked second itself.
    const near = await ask("What is on screen at 01:46:21?", "conv-f78g-pause");
    expect(near.blocks).toBeGreaterThanOrEqual(1);
    expect(near.text).toContain("Asked time 01:46:21");
    expect(near.text).toContain("01:47:00");

    // Comparative cues: both asked times get their own attribution line.
    const two = await ask("Compare what is on screen at 01:31:00 and at 00:00:45.", "conv-f78g-pair");
    expect(two.blocks).toBeGreaterThanOrEqual(1);
    expect(two.text).toContain("Asked time 01:31:00");
    expect(two.text).toContain("Asked time 00:00:45");
    expect(two.images).toBeGreaterThanOrEqual(2);
  },
  600_000,
);

test(
  "F123: a blocked video transcription keeps its keyframes and states the blocker (61 s alignment control)",
  async () => {
    // F78 defect (4) law, F123 speech law: with the pinned backend out of
    // unit scope the video keeps its saved keyframes in the published index,
    // and the coverage note reports the speech blocker — never a silent pass.
    process.env.RUKE_SPEECH_CAPABILITY = "off"; // restored after the seam rows: no endpoint in scope
    const r = await extractFileFromPath("mixed-av.mp4", path.join(FIX, "mixed-av.mp4"), ATT.av);
    expect(r.indexed).toBe(true);
    const note = String((r as any).coverageNote ?? (r as any).text ?? "");
    expect(note).toContain("its spoken content could not be read");
    expect(note).toContain("visual content WAS read");
    expect(note).toContain("Questions about what is SPOKEN cannot.");
    // The returned record carries the sampled 20%/70% previews, spread.
    const ats = ((r as any).frames ?? []).map((f: any) => f.at).sort((a: number, b: number) => a - b);
    expect(ats.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(14);
    expect(ats).toContain(25);
    expect(ats).toContain(87.5);
    // F78 defect (4) law on the BLOCKED path: the eagerly extracted keyframes
    // (incl. the 61 s alignment control) are KEPT — they ride in the frames-only
    // index — and the scratch dir is cleaned up. The original 3+-inline-frames
    // shape belongs to the READY path (working speech engine) and is proven in
    // the exclusive live acceptance batch, not laundered here.
    const idx = store.readIndex(ATT.av);
    const saved = (idx?.meta.frames ?? []).map(f => f.at).sort((a, b) => a - b);
    // This 125 s fixture has ONE scene change (~61 s): the keyframe pass finds
    // exactly that moment, and the blocked path must KEEP it in the index
    // (the original ≥3 inline shape = these 2 previews + this 1 keyframe).
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved).toContain(60); // the alignment control: the moment showing the 61 s COBALT VALVE screen survives the blocked speech run
    // The blocked path KEEPS the keyframes as durable index evidence: the frames
    // dir is the index's frame home, so it must survive (deleting it would
    // destroy the published evidence the exact-time rows cite — the three-hours
    // row above serves its images from exactly there). The "scratch dir cleaned
    // up" law belongs to the paths that DROP the frames (frames-inline, :922).
    expect(fs.existsSync(store.framesDir(ATT.av))).toBe(true);
    const firstFrame = (idx?.meta.frames ?? [])[0];
    expect(firstFrame, "the index must reference its frame files").toBeTruthy();
    expect(
      fs.existsSync(path.join(store.framesDir(ATT.av), path.basename(firstFrame.file))),
    ).toBe(true);
  },
  600_000,
);
