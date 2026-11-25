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
 * F152 (2026-11-24) adds the channel-independence rows at the end: an
 * audio-only video must be ANSWERED from its transcript although the frame
 * decoder threw, and a measured-silent video must KEEP its keyframes —
 * each channel is recoverable on its own, through the real router.
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
import { spawnSync } from "node:child_process";

process.env.RUKE_LLM_AUTOMATIC_HANDOFF = "0";
process.env.RUKE_OCR_ALLOW_UNLOAD = "0";
process.env.RUKE_SPEECH_CAPABILITY = "off"; // no Python endpoint in unit scope

const FIX = path.join(process.cwd(), "docs/overnight/fixtures/f78/review-complex-1121");
const ATT = {
  vid: "att_f78gvid",
  av: "att_f78gav",
  asr: "att_f78gasr",
  aud: "att_f152aud", // F152: audio-only video — speech must survive frame failure
  sil: "att_f152sil", // F152: measured-silent video — frames must survive silence
  cap: "att_f153cap", // F153: 20,001-segment tail law — durable + final-request reachability
  capx: "att_f153capx", // F153: overflow reporting law
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

/**
 * F153: the INDEXED-passage timestamp law (retrieve.ts): a timed chunk is
 * emitted as a `[HH:MM:SS - HH:MM:SS]` header line, then the chunk's text.
 * Find the fact, walk back to the nearest header, and return the cited
 * range in seconds - the range the per-turn rules tell the model to cite.
 */
function timedRange(transcript: string, fact: string): [number, number] | null {
  const lines = transcript.split("\n");
  const idx = lines.findIndex((l) => l.includes(fact));
  if (idx < 0) return null;
  for (let j = idx; j >= 0; j--) {
    const m = /^\[(\d\d):(\d\d):(\d\d) - (\d\d):(\d\d):(\d\d)\]/.exec(lines[j].trim());
    if (!m) continue;
    const from = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const to = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    return [from, to];
  }
  return null;
}

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

/* ------------------------------------------------------------------ *
 * F152 channel-independence law: the video's visual channel and its
 * speech channel are INDEPENDENTLY recoverable evidence. The decoder
 * throws when it obtains no frames; that failure used to take the whole
 * upload down BEFORE ASR ever ran, so valid speech died with the frames
 * it never needed. And a measured-silent track must never take the
 * frames down. Proven through the real production router with the real
 * bundled ffmpeg; the speech verdict rides the job seam.
 * ------------------------------------------------------------------ */

test(
  "F152: valid speech SURVIVES failed frame extraction — an audio-only video is answered from its transcript",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: the injected runJob replaces the transport
    const { ffmpegPath } = await import("@/lib/server/extract/ffmpeg");
    const ffmpeg = await ffmpegPath();
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".data", "tmp", "f152av_"));
    const src = path.join(dir, "audio-only.mp4");
    try {
      // A REAL mp4 container (ftyp) carrying ONLY an audio stream — the
      // honest shape of a recording whose visuals cannot be decoded. The
      // category stays "video" (the .mp4 name decides), so the frame pass
      // runs and the decoder throws on zero frames.
      const mk = spawnSync(ffmpeg, ["-y", "-i", path.join(FIX, "sound.wav"), "-vn", "-c:a", "aac", src], {
        encoding: "buffer",
      });
      expect(mk.status, `ffmpeg could not mux the audio-only fixture: ${mk.stderr}`).toBe(0);
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
      const r = await extractFileFromPath("audio-only.mp4", src, ATT.aud, undefined, undefined, { runJob } as any);
      // THE law: the upload did not go down with the frames. The spoken fact
      // arrives timed, with the pinned engine's reported provenance.
      const t = String((r as any).transcript ?? "");
      const kg = timedLine(t, "47 kg");
      expect(kg, `no timed line for 47 kg in: ${t}`).not.toBeNull();
      expect(kg![0]).toBe(60);
      expect(t).toContain("nvidia/parakeet-tdt-0.6b-v3");
      // No frames were decoded — and the outcome SAYS which channel failed.
      expect((r as any).frames).toEqual([]);
      const note = String((r as any).coverageNote ?? "");
      expect(note).toContain("visual content could not be decoded");
      expect(note).toContain("the spoken content WAS read");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  600_000,
);

test(
  "F152: a measured-silent video keeps its keyframes — silence is a result, not a failure",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: the injected runJob replaces the transport
    const runJob = async () =>
      envelope("ready", {
        result: {
          state: "silence",
          text: "",
          segments: [],
          segment_count: 0,
          asr_ran: false,
          language: "",
          language_source: "",
          duration: 125,
          complete: true,
          note: "",
          examined: [[0, 125]],
          coverage: { skipped: [] },
          audio_level: { max_volume_db: -90.0, mean_volume_db: -91.2 },
          probe: {},
          routing: {},
          vad_filter: false,
          vad_state: "unsupported_by_backend",
          superseded_fragments: 0,
          superseded: [],
        },
      });
    const r = await extractFileFromPath("mixed-av.mp4", path.join(FIX, "mixed-av.mp4"), ATT.sil, undefined, undefined, {
      runJob,
    } as any);
    expect(r.indexed).toBe(true);
    const note = String((r as any).coverageNote ?? (r as any).text ?? "");
    // The silence is a MEASUREMENT with its level, never an inference, and
    // never a defect that takes the visuals down.
    expect(note).toContain("measured at -90.0 dBFS");
    expect(note).toContain("a measured verdict, not an inference");
    expect(note).toContain("Its visual content WAS read");
    expect(note).toContain("Questions about what is SPOKEN cannot.");
    expect((r as any).transcript).toBeUndefined();
    // The 61 s alignment-control keyframe survives the silent-audio run: the
    // visual channel stands on its own.
    const idx = store.readIndex(ATT.sil);
    const saved = (idx?.meta.frames ?? []).map(f => f.at).sort((a, b) => a - b);
    expect(saved).toContain(60);
    expect(fs.existsSync(store.framesDir(ATT.sil))).toBe(true);
  },
  600_000,
);

/* ------------------------------------------------------------------ *
 * F153 item 2 (2026-11-24): the 20,001-segment recording must stay
 * fully reachable through the PRODUCTION delivery path. Repro: the
 * adapter's slice(0, MAX_SEGMENTS) + index.ts's
 * `timedTranscriptText(asr.segments) || asr.text` precedence dropped the
 * final segment from the delivered transcript, the durable index, and the
 * final request — while the run reported complete=true, droppedSegments=0.
 * Law proven here through extractFileFromPath + buildAttachmentTurn (the
 * exact answering request): the LAST fact rides with its timestamp, and a
 * real cap drop is stated, with the full timed transcript preserved in the
 * durable index (bounded chunks are the store's existing pagination).
 * ------------------------------------------------------------------ */
function f153Payload(n: number) {
  const segments = Array.from({ length: n }, (_, i) => ({
    start: i * 0.15,
    end: i * 0.15 + 0.14,
    text: `filler reading number ${i}`,
  }));
  if (n > 20_100) segments[20_100] = { start: 3015.0, end: 3015.14, text: "middle marker five five alpha" };
  segments[n - 1] = {
    start: 3599.4,
    end: 3600.25,
    text: "the final ledger entry is sealed on March third",
  };
  return {
    state: "transcribed",
    text: "filler opening ... the final ledger entry is sealed on March third",
    segments,
    segment_count: n,
    language: "en",
    language_source: "explicit",
    model: "nvidia/parakeet-tdt-0.6b-v3",
    device: "cuda",
    compute_type: "auto",
    duration: 3600,
    complete: true,
    asr_ran: true,
    note: "",
    examined: [[0, 3600]],
    coverage: { skipped: [] },
    audio_level: {},
    probe: {},
    routing: {},
    vad_filter: false,
    vad_state: "unsupported_by_backend",
    superseded_fragments: 0,
    superseded: [],
  };
}

const askIndex = async (att: string, q: string, conv: string) => {
  const messages: any[] = [
    {
      role: "user",
      content: [
        { type: "text", text: q },
        { type: "attachment_ref", att_id: att, name: "sound.wav", category: "audio" },
      ],
    },
  ];
  await buildAttachmentTurn(messages, 0, q, undefined, "default", conv);
  return systemText(messages);
};

test(
  "F153: 20,001 segments — the FINAL fact is durably indexed and reaches the exact answering request with its timestamp",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY; // seam row: the injected runJob replaces the transport
    const runJob = async () => envelope("ready", { result: f153Payload(20_001) });
    const r = await extractFileFromPath(
      "sound.wav",
      path.join(FIX, "sound.wav"),
      ATT.cap,
      undefined,
      undefined,
      { runJob } as any,
    );
    expect((r as any).indexed).toBe(true); // > TEXT_CHAR_LIMIT: the durable path is the law
    const t = await askIndex(ATT.cap, "What was the final ledger entry?", "conv-f153cap");
    // The retrieved passage must carry the fact INSIDE a cited time range that
    // covers the segment's own timestamp — the indexed form of the timed law.
    const range = timedRange(t, "final ledger entry");
    expect(range, "the final fact never reached the answering request").not.toBeNull();
    expect(
      range![0] <= 3599.4 && 3599.4 <= range![1],
      `the cited range [${range![0]} - ${range![1]}]s must cover the final segment at 3599.4s`,
    ).toBe(true);
  },
  300_000,
);

test(
  "F153: 20,500 segments — the cap drop is STATED, and the skipped middle + tail remain in the durable index",
  async () => {
    delete process.env.RUKE_SPEECH_CAPABILITY;
    const runJob = async () => envelope("ready", { result: f153Payload(20_500) });
    const r = await extractFileFromPath(
      "sound.wav",
      path.join(FIX, "sound.wav"),
      ATT.capx,
      undefined,
      undefined,
      { runJob } as any,
    );
    expect((r as any).indexed).toBe(true);
    // The statement rides the delivered record (preview header): a reader sees
    // what was skipped, with the count, at the upload moment.
    const preview = String((r as any).transcript ?? "");
    expect(preview, "the delivery must STATE the cap drop, not hide it").toContain("[transcript cap:");
    expect(preview).toContain("300");
    // The facts themselves ride the durable index and reach the answering request.
    // The skipped middle must be RETRIEVABLE (the cap note promises the time
    // range is readable): a natural follow-up pulls it with a cited range.
    const t = await askIndex(ATT.capx, "What was middle marker five five alpha?", "conv-f153capx");
    expect(t, "the skipped middle must be retrievable from the durable index").toContain(
      "middle marker five five alpha",
    );
    const mid = timedRange(t, "middle marker five five alpha");
    expect(mid, "the middle fact must carry a cited time range").not.toBeNull();
    expect(mid![0] <= 3015 && 3015 <= mid![1], `cited range [${mid![0]} - ${mid![1]}]s must cover 3015s`).toBe(true);
    // The tail fact, asked as its own follow-up, rides its own cited range.
    // This is the SECOND follow-up in the conversation: the first turn's shown
    // ledger had served the tail chunk as filler noise, and the ledger demoted
    // the exact lexical match away — the follow-up asking the tail's own words
    // could not reach it. The ledger now rotates filler only: chunks carrying
    // the current query's words (BM25 hits) are protected from demotion.
    const t2 = await askIndex(ATT.capx, "What was the final ledger entry?", "conv-f153capx");
    const tail = timedRange(t2, "final ledger entry");
    expect(tail, "the final fact never reached the answering request").not.toBeNull();
    expect(tail![0] <= 3599.4 && 3599.4 <= tail![1], `cited range [${tail![0]} - ${tail![1]}]s must cover 3599.4s`).toBe(true);
  },
  300_000,
);
