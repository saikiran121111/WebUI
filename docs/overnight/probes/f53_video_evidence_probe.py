"""F53 - frame OCR and ASR executed for real through the production video job path.

Nothing here is a mock: the probe spawns the same owned worker the supervisor spawns
(``models.lifecycle.WorkerPool`` plus the stdin/stdout handshake), using the project-local
ffmpeg/ffprobe and the project-local Tesseract that ``models.binaries`` resolves. The primary
PaddleOCR-VL engine is deliberately NOT loaded here, because loading it requires the attended
main-LLM handoff; this probe therefore proves frame decode, engine attribution and coverage
honesty, not Paddle quality.

GROUND TRUTH IS AUTHORED IN THIS FILE, BEFORE ANY ENGINE RUNS. The fixture is synthetic video
with burned-in text cards, so the expected strings are known by construction and are never
inferred from OCR output.

Fixture (40 s, 1280x720, 10 fps, one mono audio track):
    0-10 s  card A  burned-in text     sampled at  4.0 s
   10-20 s  card B  burned-in text     sampled at 14.0 s
   20-30 s  card C  burned-in text     sampled at 27.0 s
   30-40 s  card D  NO text at all     sampled at 35.0 s  -> must read glyph-free
   audio: silence until 33.8 s, then the authored e03 tail sentence -> late evidence
   plus a 61.0 s request past the end of the container   -> must read out_of_range

The content facts must stay distinct: recognised != glyph-free != out of range != unavailable.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python-backend"))

from ruke_ml.contracts import JobRequest
from ruke_ml.models.lifecycle import WorkerPool

WORK = ROOT / ".data" / "tmp" / "f53_video"
E03 = ROOT / ".data" / "tmp" / "e03"
LOGDIR = ROOT / "docs" / "overnight" / "logs"
FIXTURE = WORK / "cards_av.mp4"

# ------------------------------------------------------------------ authored ground truth
CARD_A = ["HARBOUR LEDGER  entry 7", "the amber kettle weighed 9 kg"]
CARD_B = ["MID-ROLL CARD B  14 s", "quarterly throughput rose 3.5 percent"]
CARD_C = ["CLOSING CARD C  27 s", "the lighthouse closed in 1913"]

# Per sampled instant: the tokens that MUST appear if that frame was actually read.
EXPECTED = {
    4.0: ["harbour", "ledger", "kettle", "9"],
    14.0: ["throughput", "3.5", "percent"],
    27.0: ["lighthouse", "1913"],
}
# The authored e03 tail sentence (the same text the e03 corpus renders with Windows SAPI).
SENTENCE_B = ("ambrose finch parked a maroon bicycle behind the lighthouse "
              "at quarter past nine")
TAIL_START_S = 33.0          # the audio track is silent until 33.8 s
CARD_TIMES = [4.0, 14.0, 27.0, 35.0, 61.0]
DURATION_S = 40.0
WORD_ERROR_LIMIT = 0.35      # frozen before the run, same as the e03 corpus
PEAK_WS_LIMIT_MIB = 4768.0   # 5,000,000,000 B hard budget for the Ruke tree


def normalise(text):
    low = (text or "").lower().replace("-", " ")
    low = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", low)
    return re.sub(r"[^a-z0-9 ]+", " ", low)


NUM_UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
             "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
NUM_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
            "eighty": 80, "ninety": 90}
NUM_SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000}
NUM_WORDS = set(NUM_UNITS) | set(NUM_TENS) | set(NUM_SCALES)


def _parse_spoken_number(run):
    total = current = 0
    for word in run:
        if word in NUM_UNITS:
            current += NUM_UNITS[word]
        elif word in NUM_TENS:
            current += NUM_TENS[word]
        elif word == "hundred":
            current = (current or 1) * 100
        else:
            total += (current or 1) * NUM_SCALES[word]
            current = 0
    return total + current


def words(text):
    raw = [w for w in normalise(text).split() if w]
    out, run = [], []
    for tok in raw + [""]:
        if tok in NUM_WORDS:
            run.append(tok)
            continue
        if run:
            out.append(str(_parse_spoken_number(run)))
            run = []
        if tok:
            out.append(tok)
    return out


def wer(hypothesis, truth):
    h, t = words(hypothesis), words(truth)
    if not t:
        return (0.0 if not h else 1.0), len(t)
    prev = list(range(len(t) + 1))
    for i, ca in enumerate(h, start=1):
        cur = [i]
        for j, cb in enumerate(t, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] / len(t), len(t)


# ---------------------------------------------------------------------- fixture builder
def build_fixture(ffmpeg: str) -> tuple[bool, str]:
    """Burn the authored cards into a real mp4. Synthetic, so truth is known a priori."""
    WORK.mkdir(parents=True, exist_ok=True)
    font = "C\\:/Windows/Fonts/arialbd.ttf"

    def card(lines):
        parts = []
        for i, line in enumerate(lines):
            # The two authored lines sit 120 px apart. The first cut of this fixture put
            # them 20 px apart, which stacked the glyph boxes on top of each other: the OCR
            # then honestly returned garbage from a garbage picture. Harness defect, fixed
            # here; the engine's output was correct for the image it was given.
            y = "h/2-90" if i == 0 else "h/2+30"
            parts.append("drawtext=fontfile=" + font + ":text='" + line + "'"
                         ":fontcolor=0x101010:fontsize=40:x=(w-text_w)/2:y=" + y)
        return ",".join(parts)

    # Measured harness defect (run 3, logs/f53-video-probe-3.log): on an 800x450 canvas a
    # fontsize-40 line wider than the frame gets CLIPPED at both edges by drawtext, so
    # "quarterly throughput rose 3.5 percent" was authored as "arterly throughput rose 3.5
    # percer" in the actual pixels and Tesseract honestly read "larterly throughput rose
    # 3.5 percer" (logs/f53_frame14.png, inspected directly). The engine was right about a
    # broken picture. A 1280x720 canvas fits every authored line; the expected strings and
    # thresholds below are UNCHANGED - only the picture the truth is about got fixed.
    card_input = "color=c=0xF7F7F7:s=1280x720:r=10:d=10"
    graph = ("[0:v]" + card(CARD_A) + "[v0];"
             "[1:v]" + card(CARD_B) + "[v1];"
             "[2:v]" + card(CARD_C) + "[v2];"
             "[3:v]null[v3];"
             "[v0][v1][v2][v3]concat=n=4:v=1:a=0[vout];"
             "[5:a]adelay=33800:all=1[apad];"
             "[4:a][apad]amix=inputs=2:duration=longest:normalize=0,"
             "atrim=0:40,asetpts=PTS-STARTPTS[aout]")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", card_input,
           "-f", "lavfi", "-i", card_input,
           "-f", "lavfi", "-i", card_input,
           "-f", "lavfi", "-i", card_input,
           "-f", "lavfi", "-t", "40", "-i", "anullsrc=r=22050:cl=mono",
           "-i", str(E03 / "final.wav"),
           "-filter_complex", graph,
           "-map", "[vout]", "-map", "[aout]",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10",
           "-c:a", "aac", "-ar", "22050", "-shortest", str(FIXTURE)]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=900,
                              creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, type(exc).__name__ + ": " + str(exc)
    if done.returncode != 0:
        return False, (done.stderr or b"").decode("utf-8", "replace")[-900:]
    return (FIXTURE.exists() and FIXTURE.stat().st_size > 10_000), "built"


# ----------------------------------------------------------------------- measurement
class PeakWatcher(threading.Thread):
    """Poll the pids this run owns AND their children; the peak is inside the job window."""

    def __init__(self, pool):
        super().__init__(daemon=True)
        self.pool, self.stop = pool, threading.Event()
        self.peak = [0.0, 0.0, 0.0]
        self.samples = 0

    def run(self):
        from ruke_ml.models import resources
        while not self.stop.is_set():
            pids = self.pool.owned_pids()
            if pids:
                rss = peak = commit = 0.0
                seen = []
                for pid in pids:
                    for entry in resources.process_tree_memory(pid).get("processes", []):
                        if not entry.get("available") or entry["pid"] in seen:
                            continue
                        seen.append(entry["pid"])
                        rss += entry["working_set_mib"]
                        peak += entry["peak_working_set_mib"]
                        commit += entry.get("commit_mib", 0)
                self.samples += 1
                for i, got in enumerate((rss, peak, commit)):
                    if got > self.peak[i]:
                        self.peak[i] = round(got, 1)
            self.stop.wait(0.25)


def gpu_compute_apps():
    """The host's GPU compute processes, if nvidia-smi can say. None means unknown."""
    try:
        done = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory",
                               "--format=csv,noheader"], capture_output=True, timeout=20,
                              creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    out = []
    for line in (done.stdout or b"").decode("utf-8", "replace").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[0].isdigit():
            out.append({"pid": int(parts[0]), "used_memory": parts[1]})
    return out


def check(fails, name, condition, evidence):
    if not condition:
        fails.append(name + ": " + str(evidence))
    return bool(condition)


def main() -> int:
    from ruke_ml.models import binaries

    LOGDIR.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    ffmpeg, ffprobe = binaries.path_for("ffmpeg"), binaries.path_for("ffprobe")
    if not ffmpeg or not ffprobe:
        print("ffmpeg/ffprobe unresolved by models.binaries - nothing to run")
        return 2
    if not (E03 / "final.wav").exists():
        print("e03 audio tail missing; run docs/overnight/probes/e03_make_media.ps1 first")
        return 2

    built, note = build_fixture(ffmpeg)
    size = FIXTURE.stat().st_size if FIXTURE.exists() else 0
    print("fixture " + FIXTURE.name + ": " + note + " size=" + str(size))
    if not built:
        print("fixture build FAILED - refusing to report any video result")
        return 2

    fails, cases = [], {}
    gpu_before = gpu_compute_apps()
    pool = WorkerPool()
    watcher = PeakWatcher(pool)
    watcher.start()

    def payload(extra=None):
        p = {"path": str(FIXTURE), "root": str(WORK), "ffmpeg": str(ffmpeg),
             "ffprobe": str(ffprobe)}
        if extra:
            p.update(extra)
        return p

    try:
        # ---- V1 frame OCR through the production job: explicit instants, explicit language
        req = JobRequest(request_id="f53-v1", run_id="f53-run", job_id="f53-v1",
                         capability="video.frame_ocr",
                         payload=payload({"times": CARD_TIMES, "language": "eng"}),
                         deadline_s=900.0)
        started = time.time()
        res = pool.run(req, deadline_s=900.0)
        secs = round(time.time() - started, 2)
        p = res.payload or {}
        frames = {float(f["time_s"]): f for f in (p.get("frames") or [])}
        cases["v1_frame_ocr"] = {
            "seconds": secs, "state": res.state,
            "reason": getattr(res.error, "reason", "") if res.error else "",
            "detail": (getattr(res.error, "message", "") if res.error else "")[:300],
            "stage_counts": p.get("stage_counts"), "ocr": p.get("ocr"),
            "language": p.get("language"), "probe": p.get("probe"),
            "sampling_note": p.get("sampling_note"), "note": p.get("note"),
            "coverage": res.coverage.to_dict() if res.coverage else None,
            "frames": {str(k): {"state": v.get("state"), "engine": v.get("engine"),
                                "language_code": v.get("language_code"),
                                "confidence": v.get("confidence"),
                                "text": (v.get("text") or "")[:400]}
                       for k, v in frames.items()},
        }
        check(fails, "V1 job state", res.state == "ready",
              "state=" + str(res.state) + " reason=" + str(cases["v1_frame_ocr"]["reason"])
              + " detail=" + str(cases["v1_frame_ocr"]["detail"]))
        for t, tokens in EXPECTED.items():
            frame = frames.get(t) or {}
            text = normalise(frame.get("text", ""))
            # Second measured harness defect (run 3): normalise() maps punctuation to
            # spaces, so the authored token "3.5" was compared UNNORMALISED against text
            # that can only ever contain "3 5" - an expected miss no engine could pass.
            # Normalise the expected token the same way the observed text was normalised.
            # Strictness is unchanged: the token must still be present.
            missing = [w for w in tokens
                       if normalise(w).strip()
                       and normalise(w).strip() not in text.split()
                       and normalise(w).strip() not in text]
            check(fails, "V1 authored text found at " + str(t) + "s",
                  frame.get("state") == "recognised" and not missing,
                  "state=" + str(frame.get("state")) + " missing=" + str(missing)
                  + " text=" + repr(text[:200]))
        blank = frames.get(35.0) or {}
        check(fails, "V1 a frame with no glyphs stays distinct from a failure",
              blank.get("state") == "empty",
              "state=" + str(blank.get("state")) + " text=" + repr((blank.get("text") or "")[:120]))
        past = frames.get(61.0) or {}
        check(fails, "V1 an instant past the end is out_of_range",
              past.get("state") == "out_of_range",
              "state=" + str(past.get("state")) + " detail=" + str(past.get("detail", "")))
        sc = p.get("stage_counts") or {}
        check(fails, "V1 planned/decoded/recognised/glyph-free stay separate counts",
              sc.get("planned") == len(CARD_TIMES) and sc.get("recognised") == 3
              and sc.get("glyph_free") == 1, "stage_counts=" + str(sc))
        check(fails, "V1 every read frame names the engine that read it",
            all((frames.get(t) or {}).get("engine") for t in EXPECTED),
              "engines=" + str([frames.get(t, {}).get("engine") for t in EXPECTED]))
        check(fails, "V1 the language read is the language requested, no silent default",
              p.get("language") == "eng"
              and all((frames.get(t) or {}).get("language_code") == "eng" for t in EXPECTED),
              "language=" + str(p.get("language")) + " codes="
              + str([frames.get(t, {}).get("language_code") for t in EXPECTED]))
        cov = res.coverage
        check(fails, "V1 coverage says SAMPLED INSTANTS, never complete",
              bool(cov and not cov.complete and cov.units == "instants"
                   and len(cov.examined) == 4),
              "coverage=" + str(cases["v1_frame_ocr"]["coverage"]))
        check(fails, "V1 the container's audio track is reported, not assumed absent",
              str((p.get("probe") or {}).get("audio_state", "")) not in ("", "none", "absent"),
              "probe=" + str(p.get("probe")))
        check(fails, "V1 the sampling basis is stated in the result",
              "plan" in (p.get("sampling_note") or "").lower()
              or "explicit" in (p.get("sampling_note") or "").lower(),
              "sampling_note=" + str(p.get("sampling_note")))

        # ---- V2 structural routing: an audio-only file must not get a frame-OCR "finding"
        req = JobRequest(request_id="f53-v2", run_id="f53-run", job_id="f53-v2",
                         capability="video.frame_ocr",
                         payload={"path": str(E03 / "speech.wav"), "root": str(E03),
                                  "ffmpeg": str(ffmpeg), "ffprobe": str(ffprobe),
                                  "times": [1.0], "language": "eng"},
                         deadline_s=120.0)
        res2 = pool.run(req, deadline_s=120.0)
        cases["v2_audio_only_refusal"] = {
            "state": res2.state,
            "reason": getattr(res2.error, "reason", "") if res2.error else "",
            "detail": (getattr(res2.error, "message", "") if res2.error else "")[:300]}
        check(fails, "V2 an audio-only container gets a typed refusal, not an empty success",
              res2.state == "failed"
              and cases["v2_audio_only_refusal"]["reason"] == "unsupported_input",
              "state=" + str(res2.state) + " reason=" + str(cases["v2_audio_only_refusal"]["reason"]))

        # ---- V3 the SAME container's audio, transcribed for real, with tail timestamps
        req = JobRequest(request_id="f53-v3", run_id="f53-run", job_id="f53-v3",
                         capability="speech.asr",
                         payload=payload({"language": "en", "word_timestamps": True}),
                         deadline_s=1800.0)
        started = time.time()
        res3 = pool.run(req, deadline_s=1800.0)
        secs = round(time.time() - started, 2)
        p3 = res3.payload or {}
        segs = list(p3.get("segments") or [])
        cases["v3_asr_tail"] = {
            "seconds": secs, "state": res3.state, "payload_state": p3.get("state"),
            "model": p3.get("model"), "device": p3.get("device"),
            "compute_type": p3.get("compute_type"), "language": p3.get("language"),
            "language_source": p3.get("language_source"),
            "audio_level": p3.get("audio_level"), "text": (p3.get("text") or "")[:600],
            "segment_count": len(segs),
            "segment_windows": [[round(float(s.get("start", 0)), 2),
                                 round(float(s.get("end", 0)), 2)] for s in segs[:12]],
            "coverage": res3.coverage.to_dict() if res3.coverage else None,
            "reason": getattr(res3.error, "reason", "") if res3.error else "",
            "detail": (getattr(res3.error, "message", "") if res3.error else "")[:300],
            "ceiling": (p3.get("resource_ceiling") or p3.get("job_limits") or {}),
        }
        check(fails, "V3 ASR ran on the video container's audio track",
              res3.state == "ready" and p3.get("state") == "transcribed",
              "state=" + str(res3.state) + " payload.state=" + str(p3.get("state"))
              + " reason=" + str(cases["v3_asr_tail"]["reason"]))
        check(fails, "V3 CPU device policy on the pinned ASR model",
              p3.get("device") == "cpu" and p3.get("compute_type") == "int8",
              "device=" + str(p3.get("device")) + " compute=" + str(p3.get("compute_type"))
              + " model=" + str(p3.get("model")))
        err, ntruth = wer(p3.get("text", ""), SENTENCE_B)
        cases["v3_asr_tail"]["word_error"] = round(err, 4)
        cases["v3_asr_tail"]["truth_words"] = ntruth
        check(fails, "V3 tail content accuracy against authored truth",
              err <= WORD_ERROR_LIMIT,
              "WER=" + format(err, ".3f") + " over " + str(ntruth) + " truth words "
              "(limit " + str(WORD_ERROR_LIMIT) + ") text=" + repr((p3.get("text") or "")[:200]))
        check(fails, "V3 the tail sits near the END of the source, source-relative",
              bool(segs) and all(float(s.get("start", -1)) >= TAIL_START_S for s in segs)
              and max(float(s.get("end", 0)) for s in segs) <= DURATION_S + 1.0,
              "segment_windows=" + str(cases["v3_asr_tail"]["segment_windows"]))
        check(fails, "V3 the silent head is not reported as speech",
              sum(1 for s in segs if float(s.get("end", 0)) < TAIL_START_S) == 0,
              "segments before " + str(TAIL_START_S) + "s: "
              + str(cases["v3_asr_tail"]["segment_windows"]))

        # ---- V4 a language the frame engine cannot do must never produce a fake reading
        req = JobRequest(request_id="f53-v4", run_id="f53-run", job_id="f53-v4",
                         capability="video.frame_ocr",
                         payload=payload({"times": [4.0], "language": "zxx-nope"}),
                         deadline_s=120.0)
        res4 = pool.run(req, deadline_s=120.0)
        bad = [f for f in ((res4.payload or {}).get("frames") or [])
               if f.get("state") not in ("ocr_failed", "engine_unavailable", "not_run",
                                         "out_of_range")]
        cases["v4_unsupported_language"] = {
            "state": res4.state,
            "reason": getattr(res4.error, "reason", "") if res4.error else "",
            "detail": (getattr(res4.error, "message", "") if res4.error else "")[:300],
            "frame_states": [f.get("state") for f in ((res4.payload or {}).get("frames") or [])],
        }
        check(fails, "V4 an unavailable frame language never fakes a reading",
              res4.state != "ready" or not bad,
              "state=" + str(res4.state) + " frames="
              + str(cases["v4_unsupported_language"]["frame_states"]))
    finally:
        watcher.stop.set()
        time.sleep(0.4)
        watcher.join(timeout=2.0)
        pool.stop_all()
        time.sleep(1.0)

    gpu_after = gpu_compute_apps()
    new_gpu = []
    if gpu_before is not None and gpu_after is not None:
        before = {a["pid"] for a in gpu_before}
        new_gpu = [a for a in gpu_after if a["pid"] not in before]
    cases["resources"] = {
        "owned_child_peak_working_set_mib": watcher.peak[1] if watcher.samples else None,
        "owned_child_peak_commit_mib": watcher.peak[2] if watcher.samples else None,
        "samples": watcher.samples,
        "gpu_compute_apps_before": gpu_before, "gpu_compute_apps_after": gpu_after,
        "new_gpu_compute_apps": new_gpu,
        "peak_ws_limit_mib": PEAK_WS_LIMIT_MIB,
    }
    check(fails, "R1 peak memory measured, never defaulted to zero",
          watcher.samples > 0 and (watcher.peak[1] or 0) > 0,
          "samples=" + str(watcher.samples) + " peak=" + str(watcher.peak))
    check(fails, "R2 the Ruke tree stays inside the 5,000,000,000 B hard budget",
          (watcher.peak[1] or 0) <= PEAK_WS_LIMIT_MIB, "peak_ws_mib=" + str(watcher.peak[1]))
    check(fails, "R3 no new GPU compute process appeared during processing",
          not new_gpu, "new_gpu=" + str(new_gpu))

    out = LOGDIR / "f53-video-evidence.json"
    out.write_text(json.dumps(cases, indent=2, ensure_ascii=False), encoding="utf-8")
    print("evidence written: " + str(out))
    if fails:
        print("FAILURES:")
        for f in fails:
            print("  - " + f)
        return 1
    print("F53 VIDEO EVIDENCE: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
