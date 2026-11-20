"""E03 - the pinned ASR adapter driven end to end through the REAL worker pipe.

This is real engine execution, not a mock: it spawns the same owned worker the
supervisor spawns (config.child_env + WorkerPool pump + the handshake protocol),
loads the snapshot the registry pins, and transcribes media whose ground truth was
AUTHORED BEFORE the run (Windows SAPI en-US voice; the sentences are written into
this file first). Nothing here infers the expected text from the engine's own output.

Corpus (regenerate with docs/overnight/probes/e03_make_media.ps1):
  speech.wav  one sentence, en-US TTS
  final.wav   a second sentence, placed at the END of long.wav
  long.wav    speech.wav + 10 s digital silence + final.wav
  silence.wav digital silence            -> must read as SILENCE
  tone.wav    440 Hz tone, audible       -> must NOT read as silence
  noaudio.mp4 video-only container       -> must read as NO TRACK
  av.mp4      video + audio in one container

Every case asserts a DISTINCT state, so the probe fails loudly if one content fact
collapses into another. It also measures the worker peak working set and checks that
no new GPU compute process appeared (the CPU-only processing policy).
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python-backend"))

from ruke_ml.contracts import JobRequest
from ruke_ml.models.lifecycle import WorkerPool

MEDIA = ROOT / ".data" / "tmp" / "e03"
LOGDIR = ROOT / "docs" / "overnight" / "logs"

# Ground truth, authored BEFORE transcription. The TTS voice renders exactly this.
SENTENCE_A = ("the kestrel depot inventory lists eleven crates of copper cable "
              "worth two thousand four hundred euros")
SENTENCE_B = ("ambrose finch parked a maroon bicycle behind the lighthouse "
              "at quarter past nine")

WORD_ERROR_LIMIT = 0.35     # frozen before the run: en-US TTS through whisper-base/int8


class ProcessMemory(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


def sample(pids):
    """(rss_mib, peak_rss_mib, commit_mib) over the pids this run owns AND their children.

    Measured defect (F18): this probe used to read only the pid the pool recorded, and
    that pid is the venv redirector - the interpreter that loads faster-whisper is its
    child. A run that had loaded a 145 MB model therefore reported a 5.2 MiB peak. The
    probe now uses the product's own tree accounting, so the number it prints is the
    number the supervisor itself would report.
    """
    from ruke_ml.models import resources
    total = [0.0, 0.0, 0.0]
    if os.name != "nt":
        return total
    seen: list[int] = []
    for pid in pids:
        for entry in resources.process_tree_memory(pid).get("processes", []):
            if not entry.get("available") or entry["pid"] in seen:
                continue
            seen.append(entry["pid"])
            total[0] += entry["working_set_mib"]
            total[1] += entry["peak_working_set_mib"]
            total[2] += entry.get("commit_mib", 0)
    return [round(x, 1) for x in total]


def tree_pids(pids):
    from ruke_ml.models import resources
    out: list[int] = []
    for pid in pids:
        for p in resources.tree_pids(pid):
            if p not in out:
                out.append(p)
    return out


class PeakWatcher(threading.Thread):
    """Poll the owned children; a worker's model-load peak is inside the job window."""

    def __init__(self, pool):
        super().__init__(daemon=True)
        self.pool = pool
        self.stop = threading.Event()
        self.peak = [0.0, 0.0, 0.0]
        self.samples = 0
        self.peak_pids = []

    def run(self):
        while not self.stop.is_set():
            pids = self.pool.owned_pids()
            if pids:
                got = sample(pids)
                self.samples += 1
                for i in range(3):
                    if got[i] > self.peak[i]:
                        self.peak[i] = got[i]
                        self.peak_pids = list(pids)
            self.stop.wait(0.25)


def gpu_compute_apps():
    """The host's GPU compute processes, if nvidia-smi can say. None means unknown."""
    try:
        done = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader"],
            capture_output=True, timeout=20,
            creationflags=0x08000000 if os.name == "nt" else 0)
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


# --- scoring normalisation (answer-key mechanics, NOT a threshold change) -----------
# The authored truth spells numbers as words because that is what the clip says; whisper
# writes digits ("11", "2,400"). A raw word diff would score a correct transcription as
# three errors, so numerals are canonicalised on BOTH sides before diffing. This does not
# loosen WORD_ERROR_LIMIT and does not accept a wrong number: "2,400" and "two thousand
# four hundred" both reduce to 2400, while "2,500" would not match anything.
NUM_UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
             "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
             "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
             "eighteen": 18, "nineteen": 19}
NUM_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
            "eighty": 80, "ninety": 90}
NUM_SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000, "billion": 1000000000}
NUM_WORDS = set(NUM_UNITS) | set(NUM_TENS) | set(NUM_SCALES)


def normalise(text):
    low = (text or "").lower().replace("-", " ")
    # Thousands separators inside a number ("2,400") must not split it into two tokens.
    low = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", low)
    return re.sub(r"[^a-z0-9 ]+", " ", low)


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


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def wer(hypothesis, truth):
    h, t = words(hypothesis), words(truth)
    if not t:
        return (0.0 if not h else 1.0), len(t), edit_distance(h, t)
    return edit_distance(h, t) / len(t), len(t), edit_distance(h, t)


def selftest_number_scoring():
    """The normaliser is itself checked, so a passing WER cannot come from the scorer."""
    assert words("two thousand four hundred") == words("2,400") == ["2400"]
    assert words("eleven crates") == words("11 crates") == ["11", "crates"]
    assert words("one hundred thousand") == words("100,000") == ["100000"]
    assert words("two thousand five hundred") != words("2,400"), "a wrong number must not match"
    assert words("quarter past nine") == words("quarter past 9")

def media_payload(name, extra=None):
    from ruke_ml.models import binaries
    payload = {"path": str(MEDIA / name), "root": str(MEDIA)}
    for prog in ("ffmpeg", "ffprobe"):
        path = binaries.path_for(prog)
        if path:
            payload[prog] = str(path)
    if extra:
        payload.update(extra)
    return payload


def run_job(pool, capability, name, job_id, extra=None, deadline_s=900.0):
    req = JobRequest(request_id="e03-" + job_id, run_id="e03-run", job_id=job_id,
                     capability=capability, payload=media_payload(name, extra),
                     deadline_s=deadline_s)
    started = time.time()
    res = pool.run(req, deadline_s=deadline_s)
    return res, round(time.time() - started, 2)


def summarise(res):
    return {"state": res.state,
            "reason": getattr(res.error, "reason", "") if res.error else "",
            "detail": (getattr(res.error, "message", "") if res.error else "")[:400],
            "payload_state": (res.payload or {}).get("state", ""),
            "asr_ran": (res.payload or {}).get("asr_ran", True),
            "device": (res.payload or {}).get("device", ""),
            "compute_type": (res.payload or {}).get("compute_type", ""),
            "model": (res.payload or {}).get("model", ""),
            "revision": (res.model.revision if res.model else ""),
            "language": (res.payload or {}).get("language", ""),
            "language_source": (res.payload or {}).get("language_source", ""),
            "segment_count": (res.payload or {}).get("segment_count", 0),
            "text": (res.payload or {}).get("text", ""),
            "segments": (res.payload or {}).get("segments", [])[:40],
            # Evidence only, no assertion: what the speech gate did, and which readings
            # the bounded windows superseded because they were cut at a window edge. A
            # transcript that silently deleted a duplicate would be indistinguishable from
            # one that lost real evidence, so the run has to say.
            "vad_filter": (res.payload or {}).get("vad_filter", False),
            "vad_state": (res.payload or {}).get("vad_state", ""),
            "superseded_fragments": (res.payload or {}).get("superseded_fragments", 0),
            "superseded": (res.payload or {}).get("superseded", [])[:8],
            "audio_level": (res.payload or {}).get("audio_level", {}),
            "coverage": res.coverage.to_dict() if res.coverage else None}


def spans_examined(cov):
    if not cov:
        return 0.0
    return sum(b - a for a, b in cov.examined)


def uncovered_gap(cov, duration):
    """Largest second of the source this run never decoded."""
    if not cov or duration <= 0:
        return duration
    cursor, worst = 0.0, 0.0
    for a, b in sorted((max(0.0, a), min(duration, b)) for a, b in cov.examined if b > a):
        worst = max(worst, a - cursor)
        cursor = max(cursor, b)
    return max(worst, duration - cursor)


def check(fails, name, condition, evidence):
    if not condition:
        fails.append(f"{name}: {evidence}")
    return bool(condition)

def main():
    from ruke_ml.models import binaries
    from ruke_ml.models.registry import catalog
    from ruke_ml.speech import asr as speech_asr

    LOGDIR.mkdir(parents=True, exist_ok=True)
    needed = ("speech.wav", "long.wav", "silence.wav", "tone.wav", "noaudio.mp4", "av.mp4")
    missing = [n for n in needed if not (MEDIA / n).exists()]
    if missing:
        print("media corpus missing: " + ", ".join(missing))
        print("run docs/overnight/probes/e03_make_media.ps1 first")
        return 2

    fails, cases = [], {}
    selftest_number_scoring()
    gpu_before = gpu_compute_apps()
    pool = WorkerPool()
    watcher = PeakWatcher(pool)
    watcher.start()
    pinned = catalog().get("Systran/faster-whisper-base", "speech.asr")

    def record(tag, res, seconds):
        cases[tag] = {"seconds": seconds, **summarise(res)}

    try:
        # ---- C1 explicit language, short track, whole-file decode
        res, secs = run_job(pool, "speech.asr", "speech.wav", "e03-c1",
                            {"language": "en", "word_timestamps": True})
        record("c1_explicit_en", res, secs)
        p = res.payload or {}
        check(fails, "C1 job state", res.state == "ready", f"state={res.state} detail={cases['c1_explicit_en']['detail']}")
        check(fails, "C1 transcribed", p.get("state") == "transcribed", f"payload.state={p.get('state')}")
        check(fails, "C1 CPU device policy", p.get("device") == "cpu" and p.get("compute_type") == "int8",
              f"device={p.get('device')} compute={p.get('compute_type')}")
        check(fails, "C1 pinned model + revision",
              p.get("model") == pinned.id and res.model and res.model.revision == pinned.revision,
              f"model={p.get('model')} revision={cases['c1_explicit_en']['revision']} expected={pinned.revision}")
        err, n, dist = wer(p.get("text", ""), SENTENCE_A)
        cases["c1_explicit_en"]["word_error"] = round(err, 4)
        cases["c1_explicit_en"]["truth_words"] = n
        cases["c1_explicit_en"]["edits"] = dist
        check(fails, "C1 content accuracy", err <= WORD_ERROR_LIMIT,
              f"WER={err:.3f} over {n} truth words (limit {WORD_ERROR_LIMIT})")
        cov = res.coverage
        dur = float((cov.total_source if cov else 0.0) or 0.0)
        check(fails, "C1 coverage complete", bool(cov and cov.complete and uncovered_gap(cov, dur) < 0.5),
              f"coverage={cases['c1_explicit_en']['coverage']}")
        check(fails, "C1 language is explicit, not guessed",
              p.get("language_source") == "explicit" and p.get("language") == "en",
              f"language={p.get('language')} source={p.get('language_source')}")
        c1_segments = list(p.get("segments") or [])

        # ---- C2 long source, bounded windows, distinctive evidence near the END
        res, secs = run_job(pool, "speech.asr", "long.wav", "e03-c2",
                            {"window_s": 12.0})
        record("c2_windowed_tail", res, secs)
        p = res.payload or {}
        check(fails, "C2 job state", res.state == "ready", f"state={res.state} detail={cases['c2_windowed_tail']['detail']}")
        cov = res.coverage
        dur = float((cov.total_source if cov else 0.0) or 0.0)
        segs = list(p.get("segments") or [])
        check(fails, "C2 more than one decoded window",
              bool(cov and len(cov.examined) >= 2), f"examined={cases['c2_windowed_tail']['coverage']}")
        check(fails, "C2 whole source decoded", bool(cov and uncovered_gap(cov, dur) < 1.0),
              f"largest undecoded gap={uncovered_gap(cov, dur):.2f}s of {dur:.2f}s")
        tail = [s for s in segs if float(s.get("start", 0)) >= 0.55 * dur]
        check(fails, "C2 tail evidence exists", len(tail) > 0,
              f"duration={dur:.2f} segments={[(s.get('start'), s.get('end')) for s in segs]}")
        tail_err, tail_n, _ = wer(" ".join(str(s.get("text", "")) for s in tail), SENTENCE_B)
        cases["c2_windowed_tail"]["tail_word_error"] = round(tail_err, 4)
        cases["c2_windowed_tail"]["tail_truth_words"] = tail_n
        check(fails, "C2 tail content accuracy", tail_err <= WORD_ERROR_LIMIT,
              f"tail WER={tail_err:.3f} over {tail_n} words")
        beyond = [s for s in segs if float(s.get("start", 0)) > 12.0]
        check(fails, "C2 chunk offsets are SOURCE time, not window-relative",
              len(beyond) > 0 and all(float(s.get("end", 0)) <= dur + 1.0 for s in segs),
              f"segments={[(s.get('start'), s.get('end')) for s in segs]} duration={dur:.2f}")
        lvl = p.get("audio_level") or {}
        check(fails, "C2 loudness measured audible", lvl.get("state") == "audible" and lvl.get("measured"),
              f"audio_level={lvl}")
        check(fails, "C2 the silent middle is measured, not invented",
              any((b - a) >= 8.0 for a, b in [tuple(x) for x in (lvl.get("silence_intervals") or [])]),
              f"silence_intervals={lvl.get('silence_intervals')}")

        # ---- C3 digital silence: measured, and NO model inference
        res, secs = run_job(pool, "speech.asr", "silence.wav", "e03-c3")
        record("c3_digital_silence", res, secs)
        p = res.payload or {}
        check(fails, "C3 reported as a result, not a failure", res.state == "ready",
              f"state={res.state} detail={cases['c3_digital_silence']['detail']}")
        check(fails, "C3 distinct silence state", p.get("state") == "silence", f"payload.state={p.get('state')}")
        check(fails, "C3 no ASR ran on a silent track", p.get("asr_ran") is False and not p.get("segments"),
              f"asr_ran={p.get('asr_ran')} segments={p.get('segment_count')} text={p.get('text')!r}")
        check(fails, "C3 silence was MEASURED", (p.get("audio_level") or {}).get("state") == "silence"
              and (p.get("audio_level") or {}).get("measured"), f"audio_level={p.get('audio_level')}")

        # ---- C4 audible non-speech tone: must not be classified as silence
        res, secs = run_job(pool, "speech.asr", "tone.wav", "e03-c4")
        record("c4_audible_tone", res, secs)
        p = res.payload or {}
        lvl = p.get("audio_level") or {}
        check(fails, "C4 a tone is audible, never silence",
              lvl.get("state") == "audible" and p.get("state") != "silence",
              f"audio_level={lvl} payload.state={p.get('state')}")
        emitted = (p.get("text") or "").strip()
        cases["c4_audible_tone"]["non_speech_emitted_text"] = emitted
        cases["c4_audible_tone"]["music_vs_speech_classified"] = False
        check(fails, "C4 the model actually ran on audible audio", p.get("asr_ran", True) is True,
              f"asr_ran={p.get('asr_ran')}")
        if emitted:
            print("NOTE: the ASR emitted text for a non-speech tone (measured limitation, "
                  "no content-type classifier runs here): " + emitted[:120])
        # ---- C5 video-only container: no track is not silence, and not "nothing to say"
        res, secs = run_job(pool, "speech.asr", "noaudio.mp4", "e03-c5")
        record("c5_no_audio_track", res, secs)
        check(fails, "C5 typed refusal", res.state == "failed"
              and cases["c5_no_audio_track"]["reason"] == "unsupported_input",
              f"state={res.state} reason={cases['c5_no_audio_track']['reason']}")
        detail = cases["c5_no_audio_track"]["detail"].lower()
        check(fails, "C5 names the missing track", "audio track" in detail or "no audio" in detail,
              f"detail={detail[:200]}")
        check(fails, "C5 never calls a missing track silence", "silence" not in detail,
              f"detail={detail[:200]}")

        # ---- C6 a language no published table covers is refused, not force-transcribed
        route = speech_asr.language_route("zz")
        cases["c6_language_route"] = {"decision": route.get("decision"), "note": route.get("note"),
                                      "language": route.get("language")}
        check(fails, "C6 unknown language is refused by the router",
              route.get("decision") == "unsupported", f"route={cases['c6_language_route']}")
        res, secs = run_job(pool, "speech.asr", "speech.wav", "e03-c6", {"language": "zz"})
        record("c6_unsupported_language_job", res, secs)
        check(fails, "C6 the job refuses too",
              res.state == "failed" and cases["c6_unsupported_language_job"]["reason"] == "unsupported_input",
              f"state={res.state} reason={cases['c6_unsupported_language_job']['reason']}")

        # ---- C7 a published-but-unavailable model is never swapped silently
        res, secs = run_job(pool, "speech.asr", "speech.wav", "e03-c7",
                            {"language": "en", "model": "Xenova/whisper-base.en"})
        record("c7_unavailable_model", res, secs)
        check(fails, "C7 model_unavailable, not a silent substitution",
              res.state == "failed" and cases["c7_unavailable_model"]["reason"] == "model_unavailable",
              f"state={res.state} reason={cases['c7_unavailable_model']['reason']} detail={cases['c7_unavailable_model']['detail']}")

        # ---- C8 corrupt media is corrupt, not empty
        (MEDIA / "corrupt.mp4").write_bytes(b"this is not a media container " * 40)
        res, secs = run_job(pool, "speech.asr", "corrupt.mp4", "e03-c8")
        record("c8_corrupt_input", res, secs)
        check(fails, "C8 typed corrupt-input failure",
              res.state == "failed" and cases["c8_corrupt_input"]["reason"] == "corrupt_input",
              f"state={res.state} reason={cases['c8_corrupt_input']['reason']}")

        # ---- C9 an MP4-family container that DOES carry audio still transcribes
        res, secs = run_job(pool, "speech.asr", "av.mp4", "e03-c9")
        record("c9_container_with_audio", res, secs)
        p = res.payload or {}
        err9, n9, _ = wer(p.get("text", ""), SENTENCE_A)
        cases["c9_container_with_audio"]["word_error"] = round(err9, 4)
        check(fails, "C9 audio inside a video container is found and transcribed",
              res.state == "ready" and err9 <= WORD_ERROR_LIMIT,
              f"state={res.state} WER={err9:.3f} detail={cases['c9_container_with_audio']['detail']}")

        # ---- C10 alignment: word timing only from the provider, verified on receipt
        res, secs = run_job(pool, "speech.align", "speech.wav", "e03-c10",
                            {"language": "en", "segments": c1_segments})
        record("c10_align_word_timing", res, secs)
        ap = res.payload or {}
        check(fails, "C10 alignment runs on the registered aligner",
              res.state == "ready" and ap.get("aligner") == pinned.id,
              f"state={res.state} aligner={res.payload.get('aligner')} detail={cases['c10_align_word_timing']['detail']}")
        counts = dict(ap.get("verdict_counts") or {})
        cases["c10_align_word_timing"]["verdict_counts"] = counts
        # Harness defect found in F18, NOT a product defect: this check asked for a
        # "provider" verdict, a token the product never emits. The real vocabulary from
        # alignment.accept_word_timestamps is provider_supplied | partially_valid |
        # provider_output_invalid | segment_span_only | invalid_segment_span, and it is
        # asserted by python-backend/tests/test_speech.py. The criterion is unchanged
        # (word timing must be provider-proven or honestly reported as span-only) and is
        # now STRICTER: a provider verdict that failed validation counts as a failure.
        proven = sum(counts.get(k, 0) for k in ("provider_supplied", "partially_valid"))
        honest_absent = counts.get("segment_span_only", 0)
        broken = sum(counts.get(k, 0) for k in ("provider_output_invalid", "invalid_segment_span"))
        check(fails, "C10 word timing is either proven or honestly absent",
              (proven > 0 or honest_absent > 0) and broken == 0,
              f"verdict_counts={counts}")
        check(fails, "C10 the ASR's own word spans survived",
              bool(c1_segments) and bool(c1_segments[0].get("words")),
              f"first_segment={c1_segments[:1]}")
        res, secs = run_job(pool, "speech.align", "speech.wav", "e03-c11",
                            {"language": "qq", "segments": c1_segments})
        record("c11_align_unknown_language", res, secs)
        check(fails, "C11 a language the aligner cannot handle is refused",
              res.state == "failed" and cases["c11_align_unknown_language"]["reason"] == "unsupported_input",
              f"state={res.state} reason={cases['c11_align_unknown_language']['reason']}")

        # ---- C12 diarization stays honestly gated (never faked as completed)
        res, secs = run_job(pool, "speech.diarize", "speech.wav", "e03-c12")
        record("c12_diarize_gated", res, secs)
        check(fails, "C12 diarization reports the real blocker",
              res.state == "failed" and cases["c12_diarize_gated"]["reason"] == "license_acceptance_required",
              f"state={res.state} reason={cases['c12_diarize_gated']['reason']} detail={cases['c12_diarize_gated']['detail']}")
    finally:
        watcher.stop.set()
        time.sleep(0.4)
        watcher.join(timeout=2.0)
        resident = sample(pool.owned_pids())
        pool.stop_all()
        time.sleep(1.0)

    gpu_after = gpu_compute_apps()
    owned = set(pool.owned_pids())
    gpu_violation = None
    if gpu_before is not None and gpu_after is not None:
        new_apps = [a for a in gpu_after if a["pid"] not in {b["pid"] for b in gpu_before}]
        stolen = [a for a in new_apps if a["pid"] in owned]
        if stolen:
            gpu_violation = stolen

    result = {
        "probe": "e03_speech_roundtrip",
        "started_utc": START,
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "model": {"id": pinned.id, "revision": pinned.revision, "package": pinned.package,
                  "adapter": pinned.adapter, "asset_present": bool(pinned.asset)},
        "media_dir": str(MEDIA),
        "thresholds": {"word_error_limit": WORD_ERROR_LIMIT},
        "cases": cases,
        "memory_mib": {
            "worker_peak_working_set": watcher.peak[1],
            "worker_peak_commit": watcher.peak[2],
            "resident_working_set_after_jobs": resident[0],
            "samples": watcher.samples,
            "peak_pids": watcher.peak_pids,
            "simultaneous_peak_working_set": watcher.peak[0],
            "tree_pids_at_job_end": tree_pids(pool.owned_pids()),
            "definition": ("K32GetProcessMemoryInfo over each owned worker AND its process "
                           "children (the venv python.exe we spawn is a redirector; the "
                           "interpreter holding the model weights is its child). "
                           "simultaneous_peak_working_set = the largest summed live working "
                           "set seen in one sample; worker_peak_working_set = the sum of the "
                           "per-process peak counters, an upper bound. working set = resident "
                           "RAM, commit = pagefile charge."),
        },
        "gpu": {"before": gpu_before, "after": gpu_after,
                "owned_worker_gpu_allocations": gpu_violation or [],
                "policy": "cpu/int8; this host's GPU belongs to the main LLM"},
        "failures": fails,
        "ok": not fails and gpu_violation is None,
    }
    stamp = START.replace(":", "").replace("-", "").replace(".", "")[:20]
    out = LOGDIR / f"e03-speech-{stamp}.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result["ok"], "failures": fails,
                      "word_errors": {k: v.get("word_error") for k, v in cases.items() if "word_error" in v},
                      "peak_working_set_mib": watcher.peak[1],
                      "gpu_violations": gpu_violation,
                      "evidence": str(out)}, indent=2))
    return 0 if result["ok"] else 1


START = datetime.now(timezone.utc).isoformat()

if __name__ == "__main__":
    raise SystemExit(main())
