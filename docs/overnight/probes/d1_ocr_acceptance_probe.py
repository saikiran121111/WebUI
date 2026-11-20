#!/usr/bin/env python3
"""D1 OCR acceptance probe. ATTENDED ONLY — it is deliberately not part of any automated gate.

What it scores is the PRODUCTION upload path, not a helper:

    POST {base}/api/files/extract?name=...&att=...
      -> app/api/files/extract -> lib/server/extract (TS text layer)
      -> documents.parse capability job (Rust ml_job) -> Python supervisor
      -> ocr_cascade (PaddleOCR-VL-1.6 primary, Tesseract recovery)
      -> the merged body + coverageNote the browser would actually receive.

The expectations come from docs/overnight/fixtures/d1/answer-key.json, whose thresholds were
frozen BEFORE any engine ran (`authored_before_engine_run: true`, key_version "d1-ocr-1").
The probe re-reads that file rather than embedding expectations, so a threshold cannot be
loosened without editing the key, which is itself a recorded decision.

Why there are passes instead of one run:
    the document language (RUKE_DOCUMENT_OCR_LANGUAGE) and the engine fault switches
    (RUKE_OCR_PRIMARY, RUKE_OCR_FAULT) are read by the SERVER process (Next -> Rust -> the
    Python supervisor), never by this probe. Each pass therefore states which server
    configuration it assumes, and the probe VERIFIES that assumption from the delivered
    evidence. A contradiction is `config_mismatch` (exit 2), never a silent pass.

    --pass content           server: RUKE_DOCUMENT_OCR_LANGUAGE=eng, no fault env
    --pass fallback_primary  server: ... =eng AND RUKE_OCR_PRIMARY=not-registered
    --pass fallback_crash    server: ... =eng AND RUKE_OCR_FAULT=crash
    --pass no_language       server: RUKE_DOCUMENT_OCR_LANGUAGE unset

Optional `--worker-evidence <json>` additionally scores the worker-level cascade report that
`python -m ruke_ml.handoff --pdf ... --out ...` writes. Per-unit engine attribution, the
recovery fidelity note and the cold-load/processing peaks live THERE (the HTTP body carries
provenance labels, not RSS), so the crash-fault fidelity claim is scored at that level.

Usage (from the repo root, while `npm run dev` is up in the assumed configuration):
    python-backend\\.venv\\Scripts\\python.exe docs\\overnight\\probes\\d1_ocr_acceptance_probe.py --pass content

Writes docs/overnight/logs/d1-<pass>-<utc>.json and exits non-zero on any miss.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]  # docs/overnight/probes/<this file> -> repo root
sys.path.insert(0, str(REPO / "python-backend"))

from ruke_ml.models import resources  # noqa: E402

KEY = REPO / "docs" / "overnight" / "fixtures" / "d1" / "answer-key.json"
PDFS = REPO / "docs" / "overnight" / "fixtures" / "d1" / "pdfs"
OUT_DIR = REPO / "docs" / "overnight" / "logs"
KEY_VERSION = "d1-ocr-1"


def paddle_engine() -> str:
    """The engine id the ADAPTER reports, read lazily so this probe never imports Paddle.

    The id has to come from the adapter, not from a label written into the probe: if the two
    drift apart, an attribution check would pass while naming an engine that never ran.
    """
    try:
        from ruke_ml.documents import ocr_paddle
        return str(ocr_paddle.ENGINE)
    except Exception:  # noqa: BLE001 — the main venv has no Paddle installed; that is expected
        return "paddleocr-vl-1.6"

# One attachment id per (pass, fixture) so a re-run cannot silently reuse another
# pass's on-disk index: cache invalidation is part of what this run proves.
att_seen: set[str] = set()

PASS_FIXTURES = {
    "content": ["d1_native.pdf", "d1_scanned.pdf", "d1_mixed.pdf", "d1_rotated_scan.pdf"],
    "fallback_primary": ["d1_scanned.pdf"],
    "fallback_crash": ["d1_scanned.pdf"],
    "no_language": ["d1_scan_nolang.pdf"],
}


def collapse(text: object) -> str:
    return re.sub(r"\s+", " ", str("" if text is None else text)).strip()


def page_readers(body: str) -> dict[int, list[str]]:
    """The provenance labels the delivery itself printed on each page marker.

    `[page 3 | read by: pdf.js text layer]` / `[page 1 | read by: tesseract OCR (eng, ...)]`.
    Which READER produced a page is a scored claim, not a vibe: a page the key says is
    native-only must not have been invented by an OCR engine, and a rotated page must say
    what orientation was corrected.
    """
    out: dict[int, list[str]] = {}
    for m in re.finditer(r"\[page (\d+) \| ([^\]\n]*)\]", body):
        out.setdefault(int(m.group(1)), []).append(collapse(m.group(2)))
    return out


def page_blocks(body: str) -> dict[int, str]:
    """Split the delivered body into per-page blocks using the delivery's own page markers.

    The merge emits one marker per reader, so a page can legitimately have two blocks (the
    text layer plus a labelled second-reader variant). They are joined, because the key asks
    whether the DELIVERED content for that page contains the fact, not which block did it.
    """
    out: dict[int, str] = {}
    matches = list(re.finditer(r"\[page (\d+) \|", body))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        chunk = body[m.end():end]
        # Drop the rest of the marker line itself: it is delivery chrome, never document text.
        chunk = chunk.split("\n", 1)[1] if "\n" in chunk else ""
        page = int(m.group(1))
        out[page] = collapse((out.get(page, "") + " " + chunk))
    return out


def wer(expected: list[str], got_words: list[str]) -> float:
    """Word error rate with the usual Levenshtein alignment (sub+ins+del)/|expected|."""
    n, m = len(expected), len(got_words)
    if n == 0:
        return 0.0 if m == 0 else 1.0
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cost = 0 if expected[i - 1] == got_words[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[m] / float(n)


class Sampler(threading.Thread):
    """System RAM/commit plus VRAM while the job runs. Peak, not a single lucky sample."""

    def __init__(self, interval_s: float = 2.0) -> None:
        super().__init__(daemon=True)
        self.interval_s = interval_s
        self.stop = threading.Event()
        self.samples: list[dict[str, object]] = []

    def snapshot(self) -> dict[str, object]:
        mem = resources.system_memory()
        gpu = resources.vram()
        return {"at": round(time.time(), 2),
                "avail_physical_mib": mem.available_mib, "total_physical_mib": mem.total_mib,
                "commit_avail_mib": mem.commit_avail_mib,
                "vram_used_mib": sum(int(g.get("used_mib") or 0) for g in gpu),
                "vram_total_mib": sum(int(g.get("total_mib") or 0) for g in gpu)}

    def run(self) -> None:
        while not self.stop.is_set():
            self.samples.append(self.snapshot())
            self.stop.wait(self.interval_s)

    def summary(self) -> dict[str, object]:
        if not self.samples:
            return {"samples": 0}
        least_free = min(int(s["avail_physical_mib"]) for s in self.samples)  # type: ignore[arg-type]
        most_commit = max(int(s["commit_avail_mib"]) for s in self.samples)  # type: ignore[arg-type]
        peak_vram = max(int(s["vram_used_mib"]) for s in self.samples)  # type: ignore[arg-type]
        total = int(self.samples[0]["total_physical_mib"])  # type: ignore[arg-type]
        return {"samples": len(self.samples),
                "min_available_physical_mib": least_free,
                "peak_physical_used_mib": total - least_free,
                "peak_vram_used_mib": peak_vram,
                "max_commit_available_mib": most_commit,
                "samples_head_tail": [self.samples[0], self.samples[-1]]}


def post_upload(base: str, name: str, att: str, data: bytes, timeout_s: float) -> tuple[int, dict[str, object], str]:
    url = f"{base}/api/files/extract?name={urllib.parse.quote(name)}&att={att}"
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"content-type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as res:
            raw = res.read().decode("utf-8", "replace")
            return res.status, json.loads(raw or "{}"), raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw or "{}"), raw
        except json.JSONDecodeError:
            return exc.code, {}, raw


def score_fixture(name: str, spec: dict[str, object], payload: dict[str, object], raw: str,
                  pass_name: str, thresholds: dict[str, float]) -> list[dict[str, object]]:
    """Return one record per check. A miss is a miss; nothing here relaxes the key."""
    checks: list[dict[str, object]] = []
    body = collapse(payload.get("text") or payload.get("error") or "")
    note = collapse(payload.get("coverageNote") or "")
    both = f"{note} {body}"
    # NOT collapsed first: the page markers are line-delimited, and collapsing the body would
    # erase the very boundary the per-page checks and the page citations depend on.
    raw_body = str(payload.get("text") or "")
    blocks = page_blocks(raw_body)
    labels = page_readers(raw_body)

    def check(label: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": label, "ok": bool(ok), "detail": detail[:900]})

    # --- route / OCR-run honesty, stated in the delivery, not inferred from a status string ---
    if spec.get("ocr_must_not_run"):
        ran = "recognised by OCR" in note or " capability-ocr" in body \
            or f"{paddle_engine()} OCR" in body
        check("ocr_did_not_run", not ran, f"note: {note[:400]}")
    if spec.get("ocr_must_run"):
        check("ocr_ran", "recognised by OCR" in note or " OCR (" in body, f"note: {note[:400]}")
    if pass_name.startswith("fallback"):
        check("primary_engine_not_claimed", f"{paddle_engine()}=" not in note
              and f"{paddle_engine()} OCR" not in body, f"note: {note[:400]}")

    # --- per-page content, scored against the key's listed phrases and word lists ---
    per_page = spec.get("expected_per_page") or {}
    wer_key = spec.get("word_error_rate_key") or {}
    limit = thresholds["word_error_rate_fallback"] if pass_name.startswith("fallback") \
        else thresholds["word_error_rate_primary"]
    for page_s, phrase in sorted(per_page.items(), key=lambda kv: int(kv[0])):
        page = int(page_s)
        got = blocks.get(page, "")
        check(f"page{page}_phrase_in_body", collapse(phrase) in got, f"delivered: {got[:300]}")
        words = wer_key.get(page_s)
        if words:
            value = wer([str(w) for w in words], re.findall(r"\S+", got))
            check(f"page{page}_wer<=limit", value <= limit,
                  f"wer={value:.3f} limit={limit}")

    if spec.get("late_evidence"):
        le = spec["late_evidence"]
        page = int(le["page"]) if isinstance(le, dict) else 1
        want = collapse(le["contains"]) if isinstance(le, dict) else ""
        check(f"late_evidence_page{page}", want in blocks.get(page, ""), f"delivered: {blocks.get(page, '')[:300]}")
    if isinstance(spec.get("late_evidence"), list):  # d1_mixed uses [page, contains]
        page, want = int(spec["late_evidence"][0]), collapse(spec["late_evidence"][1])
        check(f"late_evidence_page{page}", want in blocks.get(page, ""),
              f"delivered: {blocks.get(page, '')[:300]}")

    fab = spec.get("must_not_fabricate")
    if fab:
        got = blocks.get(int(fab["page"]), "")
        check("no_fabricated_content", fab["absent_word"] not in got, f"page{fab['page']}: {got[:300]}")

    # --- mixed document: native AND recognised evidence on one page, heading exactly once ---
    if "page_1_must_contain_native" in spec:
        p1 = blocks.get(1, "")
        check("mixed_page1_native", collapse(spec["page_1_must_contain_native"]) in p1, p1[:300])
        check("mixed_page1_recognised", collapse(spec["page_1_must_contain_recognised"]) in p1, p1[:300])
        once = collapse(body).count(collapse(spec["no_duplicate_heading_once"]))
        check("mixed_heading_not_duplicated", once == 1, f"heading occurrences: {once}")
    if spec.get("page_3_native_only"):
        # The key asks that a page with a good text layer stay native: OCR on it would be a
        # second opinion, not a replacement, and a page read ONLY by recognition here would
        # mean native extraction was skipped.
        page = 3
        seen = labels.get(page, [])
        got = blocks.get(page, "")
        check("page3_has_delivered_content", bool(got), f"delivered: {got[:200]}")
        check("page3_not_read_by_ocr", all("OCR" not in s for s in seen),
              f"page 3 markers: {seen}")
        check("page3_read_by_a_native_reader",
              any(("text layer" in s) or ("second reader" in s) for s in seen),
              f"page 3 markers: {seen}")

    # --- rotation: the page reference stays page 1 while the content is recovered ---
    if "must_recognise_despite_rotation" in spec:
        got = blocks.get(1, "")
        check("rotated_recognised", collapse(spec["must_recognise_despite_rotation"]) in got, got[:300])
        check("rotated_page_reference", 1 in blocks, f"pages seen: {sorted(blocks)}")
        if spec.get("rotate_declared"):
            # A rotated sheet is only honestly "page 1" if the delivery says which orientation
            # it corrected. Silence here is how a rotated scan becomes a silent wrong answer.
            declared = f"rotation applied: page 1 {int(spec['rotate_declared'])}"
            check("rotation_declared_in_delivery",
                  declared in note or declared in body or "rotation applied: page 1" in both,
                  f"note: {note[:300]}")
            check("rotated_marker_says_ocr_reader",
                  any("OCR" in s for s in labels.get(1, [])), f"page 1 markers: {labels.get(1, [])}")

    # --- undeclared language: a typed refusal, never a silent English default ---
    if spec.get("typed_error") == "needs_language":
        check("needs_language_stated", "needs an explicit language" in both
              or "needs_language" in both, both[:400])
        check("needs_language_names_env", "RUKE_DOCUMENT_OCR_LANGUAGE" in both, both[:400])
        check("ocr_not_run_without_language", "recognised by OCR" not in note, note[:400])

    # --- coverage: every listed unit is either read or explicitly reported unresolved ---
    units_total = int(spec.get("pages") or 0)
    if units_total and not spec.get("ocr_must_not_run") and "typed_error" not in spec:
        # A page whose marker says "not read", or whose delivered content is empty, is NOT a
        # read unit. Counting marker lines would turn a refusal into fake coverage.
        read = sum(1 for page, text in blocks.items()
                   if text and not any(s.startswith("not read") for s in labels.get(page, [])))
        frac = read / units_total
        check("coverage_units_read", frac >= thresholds["coverage_units_read_fraction"],
              f"{read} of {units_total} page(s) carry delivered content in the body "
              f"(markers seen: {sorted(blocks)})")
    return checks


def positive_control(name: str, spec: dict[str, object], pass_name: str) -> dict[str, object]:
    """Build a delivery-shaped payload from the ANSWER KEY, for probe mechanics only.

    This is the probe testing ITSELF: the content comes from the key, so scoring it must give
    zero misses. It proves the marker parsing, the WER arithmetic and every assertion in
    score_fixture can actually be satisfied, and it catches a probe bug (a regex that never
    matches, a label string that drifted) before a multi-hour attended OCR run does. NO ENGINE
    RUNS HERE and it is never counted as OCR evidence.
    """
    engine = "tesseract" if pass_name.startswith("fallback") else paddle_engine()
    per_page = {int(k): collapse(v) for k, v in (spec.get("expected_per_page") or {}).items()}
    bodies: list[str] = []
    parts = [f"document capability documents.parse (pypdf-selfcheck)"]
    if spec.get("typed_error") == "needs_language":
        parts.append("OCR needs an explicit language (set RUKE_DOCUMENT_OCR_LANGUAGE); "
                     "no document language was given or declared")
        return {"text": "[" + "; ".join(parts) + "]",
                "coverageNote": "[" + "; ".join(parts) + "]",
                "error": ("this document has no readable text layer - OCR needs an explicit "
                          "language (set RUKE_DOCUMENT_OCR_LANGUAGE)")}
    if spec.get("ocr_must_run"):
        npages = int(spec.get("pages") or len(per_page))
        parts.append(f"{npages} page(s) recognised by OCR (eng): {npages}/{npages} page(s) recognised")
        parts.append(f"engines consulted: {engine}; recognised by {engine}: {npages}")
        for page, text in sorted(per_page.items()):
            bodies.append(f"[page {page} | read by: {engine} OCR (eng, confidence 0.95)]\n{text}")
    elif "page_1_must_contain_native" in spec:
        parts.append("text layer: 3 of 3 page(s) via pdf.js")
        parts.append("2 page(s) recognised by OCR (eng): 2/2 page(s) recognised")
        native = collapse(spec["page_1_must_contain_native"])
        recognised = collapse(spec["page_1_must_contain_recognised"])
        bodies.append(f"[page 1 | read by: pdf.js text layer]\n{native}")
        bodies.append(f"[page 1 | second reader {engine} OCR (eng): 26 non-whitespace characters "
                      "vs the pdf.js text layer's 74; kept as a variant, the text layer above was "
                      f"NOT replaced]\n{recognised}")
        bodies.append("[page 2 | read by: pdf.js text layer]\n"
                      "Section 4.2 Ground Water native layer on the mixed page")
        late = spec.get("late_evidence") or {}
        bodies.append(f"[page 3 | read by: pdf.js text layer]\nAppendix note {collapse(late.get('contains') if isinstance(late, dict) else '')} ends the document")
    elif "must_recognise_despite_rotation" in spec:
        sentence = collapse(spec["must_recognise_despite_rotation"])
        parts.append(f"1 page(s) recognised by OCR (eng): 1/1 page(s) recognised")
        parts.append(f"raster rotation applied: page 1 {int(spec.get('rotate_declared') or 0)}°")
        bodies.append(f"[page 1 | read by: {engine} OCR (eng, confidence 0.9)]\n{sentence}")
    else:  # native text layer, no OCR
        parts.append("OCR did not run: the assessment routed this document to the native text layer")
        for page, text in sorted(per_page.items()):
            bodies.append(f"[page {page} | read by: pdf.js text layer]\n{text}")
    note = "[" + "; ".join(parts) + "]"
    return {"text": "\n".join([note, ""] + bodies), "coverageNote": note}


def negative_control(name: str, spec: dict[str, object], pass_name: str,
                     payload: dict[str, object]) -> dict[str, object]:
    """Sabotage a known-good delivery: the probe MUST report misses.

    Without this half, a check that can never fire (bad regex, wrong label, off-by-one page)
    looks identical to a check that passed.
    """
    text = str(payload.get("text") or "")
    pages = sorted({int(m.group(1)) for m in re.finditer(r"\[page (\d+) \|", text)})
    if not pages:
        return payload
    first, last = pages[0], pages[-1]
    # 1. delete the LAST page's block entirely (late-evidence / coverage must fail)
    text = re.sub(rf"\[page {last} \|[^\n]*\]\n[^\[]*", "", text)
    # 2. fabricate a fact on the FIRST page (must_not_fabricate / heading-once must fail)
    text = re.sub(rf"(\[page {first} \|[^\n]*\]\n)", r"\g<1>Chapter invented by nothing ", text, count=1)
    return {"text": text, "coverageNote": str(payload.get("coverageNote") or "")}


def self_check(key: dict[str, object], th: dict[str, float]) -> tuple[list[dict[str, object]], int]:
    """Run both controls over every (pass, fixture) the attended runner will visit."""
    records: list[dict[str, object]] = []
    broken = 0
    for pass_name in sorted(PASS_FIXTURES):
        for name in PASS_FIXTURES[pass_name]:
            spec = (key["fixtures"] or {}).get(name) or {}
            good = positive_control(name, spec, pass_name)
            checks = score_fixture(name, spec, good, str(good.get("error") or ""), pass_name, th)
            failed = [c for c in checks if not c["ok"]]
            ok_positive = not failed
            records.append({
                "pass": pass_name, "fixture": name, "control": "positive",
                "expect": "zero misses", "misses": [c["check"] for c in failed],
                "checks_total": len(checks), "ok": ok_positive,
                "sample": {k: collapse(v) if isinstance(v, str) else v
                           for k, v in list(positive_control(name, spec, pass_name).items())[:1]},
            })
            if not ok_positive:
                broken += 1
                print(f"SELF-CHECK BROKEN {pass_name}/{name}: probe checks that a key-shaped "
                      f"delivery cannot satisfy: {[c['check'] for c in failed]}")
            bad = negative_control(name, spec, pass_name, good)
            if "[page " not in str(good.get("text") or ""):
                # A typed refusal carries no page blocks, so a page-level canary cannot apply
                # to it. Saying "not applicable" is honest; calling it a pass would not be.
                records.append({"pass": pass_name, "fixture": name, "control": "negative",
                                "expect": "not applicable (refusal payload has no page blocks)",
                                "misses": [], "checks_total": 0, "ok": True,
                                "note": "the positive control for this fixture is the check"})
                continue
            nchecks = score_fixture(name, spec, bad, "", pass_name, th)
            nmisses = [c["check"] for c in nchecks if not c["ok"]]
            expected_miss = bool(nmisses)
            records.append({"pass": pass_name, "fixture": name, "control": "negative",
                            "expect": "at least one miss", "misses": nmisses,
                            "checks_total": len(nchecks), "ok": expected_miss})
            if not expected_miss:
                broken += 1
                print(f"SELF-CHECK BROKEN {pass_name}/{name}: a sabotaged delivery scored clean")
    return records, broken


def score_worker_evidence(path: Path, thresholds: dict[str, float]) -> list[dict[str, object]]:
    """Score the handoff runner's JSON: per-unit engine attribution, fidelity, peaks."""
    checks: list[dict[str, object]] = []
    data = json.loads(path.read_text(encoding="utf-8"))
    casc = ((data.get("work_detail") or {}).get("cascade")) or {}

    def check(label: str, ok: bool, detail: str = "") -> None:
        checks.append({"source": "worker_evidence", "check": label, "ok": bool(ok),
                       "detail": detail[:900]})

    pages = (data.get("work_detail") or {}).get("pages") or []
    engines = {str(p.get("engine") or "") for p in pages if p.get("state") == "recognised"}
    unresolved = [p.get("page") for p in pages if p.get("state") not in ("recognised", "empty")]
    check("per_unit_engine_attribution", bool(engines) and "" not in engines,
          f"recognised by: {sorted(engines)}")
    check("primary_not_claimed_when_forced_off", paddle_engine() not in engines,
          f"engines that actually recognised units: {sorted(engines)}")
    check("unresolved_units_stay_reported", casc.get("units_unresolved", []) == unresolved,
          f"cascade says {casc.get('units_unresolved')}, pages say {unresolved}")
    fb = casc.get("fallback") or {}
    check("recovery_fidelity_note_present", "fidelity" in str(fb.get("fidelity_note", "")).lower(),
          str(fb.get("fidelity_note", ""))[:300])
    run = (casc.get("primary") or {}).get("run") or {}
    peak = int(run.get("peak_working_set_mib") or 0)
    commit = int(run.get("peak_commit_mib") or 0)
    hard_max_mib = int(thresholds["hard_max_mib"])
    check("worker_peak_within_hard_max", commit <= hard_max_mib,
          f"worker peak commit {commit} MiB (working set {peak} MiB), hard max {hard_max_mib} MiB")
    check("worker_peak_recorded", peak > 0, f"peak_working_set_mib={peak}")
    check("device_echo_recorded", bool(((data.get("work") or {}).get("device_echo"))
                                       or run.get("device_echo")),
          json.dumps(run.get("device_echo", {}))[:300])
    check("handoff_phases_present", bool(data.get("phases")),
          ",".join(str(p.get("phase")) for p in (data.get("phases") or [])))
    return checks


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--pass", dest="pass_name", choices=sorted(PASS_FIXTURES),
                    help="attended pass to score against the live delivery")
    ap.add_argument("--self-check", action="store_true",
                    help="probe mechanics only: score a key-shaped synthetic delivery and a "
                         "sabotaged one. NO engine runs, NO upload happens, and its result is "
                         "never OCR evidence.")
    ap.add_argument("--timeout-s", type=float, default=1800.0,
                    help="per-upload budget; a cold PaddleOCR-VL load is minutes, and a "
                         "timeout here is recorded as a failure, never skipped")
    ap.add_argument("--worker-evidence", default="",
                    help="JSON written by `python -m ruke_ml.handoff --out ...`")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    if bool(args.pass_name) == bool(args.self_check):
        print("give exactly one of --pass <name> or --self-check")
        return 2

    key = json.loads(KEY.read_text(encoding="utf-8"))
    if key.get("key_version") != KEY_VERSION:
        print(f"refusing: answer key version {key.get('key_version')!r} != {KEY_VERSION!r}; "
              f"a frozen key is replaced by a NEW version, recorded separately")
        return 2
    th = dict(key["thresholds_fixed_before_results"])
    mem = key.get("memory") or {}
    th["hard_max_mib"] = int(mem.get("hard_max_bytes", 5_000_000_000) // (1 << 20))
    th.setdefault("coverage_units_read_fraction", 1.0)

    if args.self_check:
        records, broken = self_check(key, th)
        out = {"key_version": KEY_VERSION, "mode": "self_check",
               "label": "MECHANICS ONLY (synthetic, no engine ran, no upload happened)",
               "run_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "thresholds": th,
               "controls": records, "broken": broken,
               "note": "a positive control built FROM the answer key must score zero misses and a "
                       "sabotaged delivery must score at least one; that is what makes the attended "
                       "run's passes meaningful. This file is not OCR evidence."}
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out_path = Path(args.out) if args.out else (
            OUT_DIR / f"d1-selfcheck-{time.strftime('%Y%m%d-%H%M%S')}.json")
        out_path.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        print(json.dumps({"mode": "self_check", "broken": broken,
                          "controls": len(records), "out": str(out_path)}, indent=2))
        return 0 if broken == 0 else 1

    records: list[dict[str, object]] = []
    misses = 0
    sampler = Sampler()
    baseline = sampler.snapshot()
    sampler.start()

    for name in PASS_FIXTURES[args.pass_name]:
        spec = key["fixtures"][name]
        pdf = PDFS / name
        if not pdf.is_file():
            records.append({"fixture": name, "checks": [
                {"check": "fixture_present", "ok": False,
                 "detail": f"missing {pdf}; regenerate with python-backend venv: "
                           f"docs/overnight/fixtures/d1/ocr_docs.py"}]})
            misses += 1
            continue
        att = f"att_d1{args.pass_name.replace('_', '')}{len(att_seen) + 1:02d}"
        att_seen.add(att)
        t0 = time.time()
        status, payload, raw = post_upload(args.base, name, att, pdf.read_bytes(), args.timeout_s)
        checks = score_fixture(name, spec, payload, raw, args.pass_name, th)
        elapsed = round(time.time() - t0, 2)
        records.append({"fixture": name, "http_status": status, "seconds": elapsed,
                        "pages": payload.get("pages"), "indexed": payload.get("indexed"),
                        "coverageNote": collapse(payload.get("coverageNote") or "")[:900],
                        "checks": checks})
        for c in checks:
            if not c["ok"]:
                misses += 1
                print(f"MISS {name} {c['check']}: {c['detail'][:200]}")
        print(f"{name}: http {status} in {elapsed}s, "
              f"{sum(1 for c in checks if c['ok'])}/{len(checks)} checks ok")

    sampler.stop.wait(1)
    if args.worker_evidence:
        for c in score_worker_evidence(Path(args.worker_evidence), th):
            records.append({"fixture": "<worker-evidence>", "checks": [c]})
            if not c["ok"]:
                misses += 1
                print(f"MISS worker {c['check']}: {c['detail'][:200]}")

    out = {"key_version": KEY_VERSION, "pass": args.pass_name, "base": args.base,
           "run_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "thresholds": th,
           "memory": {"baseline": baseline, "during_run": sampler.summary(),
                      "after_run": sampler.snapshot(),
                      "definitions": "avail_physical_mib = GlobalMemoryStatusEx ullAvailPhys; "
                                     "commit_avail_mib = ullAvailPageFile; vram via nvidia-smi; "
                                     "worker peaks come from --worker-evidence",
                      "target_bytes": mem.get("target_bytes"), "hard_max_bytes": mem.get("hard_max_bytes")},
           "note": "passing this run establishes routing, page attribution, fallback selection, "
                   "coverage honesty and the listed facts on clean synthetic renders. It does NOT "
                   "establish general OCR quality, and a Tesseract pass is NOT primary-engine acceptance.",
           "fixtures": records, "misses": misses}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (
        OUT_DIR / f"d1-{args.pass_name}-{time.strftime('%Y%m%d-%H%M%S')}.json")
    out_path.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"pass": args.pass_name, "misses": misses, "out": str(out_path)}, indent=2))
    return 0 if misses == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
