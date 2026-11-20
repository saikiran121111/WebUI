#!/usr/bin/env python3
"""D1 ENGINE-LEVEL scorer — scores persisted engine output against the frozen key d1-ocr-1.

This is NOT the attended delivery-level pass (`d1_ocr_acceptance_probe.py`). That probe
scores what the browser's extract call delivered; THIS probe scores what the OCR engines
actually produced, read from a persisted `ruke.ocr-result.v1` record (written durably by
`ocr_cascade._write_result`) or from a transcript map. A pass here is evidence about the
engines and their bookkeeping on a real run; it says nothing about what the delivery
merged, and a `--self-check` pass says only that the SCORER works — never anything about
OCR quality. Primary OCR acceptance still requires output from a real engine run.

Three states per fixture, deliberately kept distinct:
    pass          every scored check held
    fail          at least one scored check broke
    not_evaluable no engine output was supplied for this fixture, the persisted record is
                  ABSENT / UNREADABLE / MALFORMED / schema-mismatched / STALE (mirroring
                  `_read_result`'s four answers), or the run requested a strict subset of
                  the pages the key needs (a bounded measurement run is honestly partial)

Usage (repo root):
    python-backend\\.venv\\Scripts\\python.exe docs\\overnight\\probes\\d1_engine_scoring_probe.py --self-check
    python-backend\\.venv\\Scripts\\python.exe docs\\overnight\\probes\\d1_engine_scoring_probe.py \
        --result d1_scanned.pdf=<path-to-ruke.ocr-result.v1.json> [--transcript <map.json>]

`--transcript PATH` takes a JSON map (fixture name -> entry, optionally wrapped in
{"fixtures": {...}}); an entry may carry:
    "units":  [{"page":1,"state":"recognised","text":"...","engine":"paddleocr-vl-1.6",
                "raster":{"rotation":90}}, ...]          # engine-attributed form, or
    "delivered": "[page 1 | read by: ...]\n..."          # delivery-shaped text, converted
                                                         # through page_blocks/page_readers
    "request": {"units":[1,2], "rotations":[[1,90]]},    # omitted = derived from units
    "engines_used": [...], "coverage": {"requested":..,"read":..,"unresolved":[..]},
    "fallback": {"ran":false,"reason":"","fidelity_note":""},
    "needs_language": {"stated":true,"reason":"..."}     # the ONLY way to score
                                                         # d1_scan_nolang.pdf at engine
                                                         # level: run_ocr_stage refuses
                                                         # BEFORE the cascade, so no
                                                         # ocr-result record exists — the
                                                         # typed refusal lives in the job
                                                         # report (workers/document_jobs.py
                                                         # :161-166), never a silent English
                                                         # default

The thresholds come from docs/overnight/fixtures/d1/answer-key.json (key_version
"d1-ocr-1", authored_before_engine_run true) and are never loosened here: WER 0.1 for a
unit the primary engine read, 0.15 for a unit Tesseract recovered, coverage fraction 1.0.
A different key version is a config error (exit 2), never a silent re-calibration.

Engine-attribution mapping at engine level, stated so nothing is silently reinterpreted:
    * "heading not duplicated" (delivery property) maps to "the OCR engine must NOT
      re-recognise the native heading" — if the engine re-emits it, the merge duplicates
      it; a count of exactly zero across engine units is what this scorer checks.
    * "page 3 native only" maps to "no unit for page 3 exists in the engine record" —
      the assessment is what keeps native pages out of the OCR request.
    * native text-layer facts (d1_native.pdf content, d1_mixed late evidence) are
      delivery-layer claims; this scorer checks only that no OCR engine ran on a
      native-routed document, unless a transcript supplies the text-layer units.

`--self-check` builds a positive control FROM the answer key per fixture (must score 0
fails and state pass) and runs named sabotages per fixture (each must score >= 1 fail):
drop a page, drop the numeric fact, fabricate "Chapter" on page 1, claim an unresolved
unit as read, swap the engine attribution, re-recognise the native heading, OCR a
native-only page, drop the rotation evidence, strip the language env name. No engine
runs in self-check and its output is never OCR evidence.

Writes docs/overnight/logs/d1-engine-<utc>.json (d1-engine-selfcheck-<utc>.json for
--self-check). Exit 0 when every supplied fixture passes; 1 on any fail or any
not_evaluable (neither is acceptance); 2 on a config error (bad CLI, unknown fixture,
duplicate source, unparsable transcript, key version mismatch).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]                      # docs/overnight/probes/<this file> -> repo root
sys.path.insert(0, str(HERE))

from d1_ocr_acceptance_probe import (  # noqa: E402  (same arithmetic authority, no duplication)
    KEY, PDFS, KEY_VERSION, PASS_FIXTURES, collapse, page_blocks, page_readers,
    paddle_engine, wer,
)

OUT_DIR = REPO / "docs" / "overnight" / "logs"
ENGINE_PADDLE = paddle_engine()            # the id the ADAPTER reports, not a label here
ENGINE_TESS = "tesseract"
NATIVE_ENGINE = "pdf-text-layer"           # text-layer units are not OCR evidence
ENV_NAME = "RUKE_DOCUMENT_OCR_LANGUAGE"
READ_STATES = ("recognised", "empty", "native_text")

try:
    from ruke_ml.documents.ocr_cascade import RESULT_SCHEMA
except Exception:  # noqa: BLE001 - the constant is stable; importing the cascade must never break the scorer
    RESULT_SCHEMA = "ruke.ocr-result.v1"


def is_ocr_engine(engine: object) -> bool:
    e = str(engine or "")
    return bool(e) and e != "none" and e != NATIVE_ENGINE


def _unit(page: int, text: str, engine: str, state: str = "recognised",
          raster: dict | None = None, conf: float | None = 0.95) -> dict:
    return {"page": int(page), "state": state, "text": text, "engine": engine,
            "raster": raster or {}, "confidence": conf}


def _empty_art(note: str, kind: str) -> dict:
    return {"request_units": None, "rotations": set(), "units": [], "engines_used": None,
            "fallback": {"ran": False, "reason": "", "fidelity_note": ""}, "coverage": None,
            "needs_language": None, "note": note, "source_kind": kind}


# ---------------------------------------------------------------- record + transcript intake
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def normalize_record(path: Path, fixture: str) -> tuple[dict | None, str, str]:
    """Read one persisted record. ABSENT / UNREADABLE / MALFORMED / schema / STALE are answers."""
    if not path.is_file():
        return None, "absent", f"no file at {path}"
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, "unreadable", f"{type(exc).__name__}: {exc}"
    try:
        data = json.loads(raw)
    except ValueError as exc:
        return None, "malformed", f"the persisted record is not valid JSON: {exc}"
    if not isinstance(data, dict):
        return None, "malformed", f"the record is a {type(data).__name__}, not an object"
    if data.get("schema") != RESULT_SCHEMA:
        return None, "schema_mismatch", (f"the record declares schema {data.get('schema')!r}, "
                                         f"not {RESULT_SCHEMA!r}")
    pdf = PDFS / fixture
    if pdf.is_file():
        stored = str(((data.get("source") or {}).get("sha256")) or "")
        actual = sha256_file(pdf)
        if stored and stored != actual:
            return None, "stale", (f"the record's source sha256 {stored[:16]}... does not match "
                                   f"the current {fixture} sha256 {actual[:16]}...")
    req = data.get("request") if isinstance(data.get("request"), dict) else {}
    pipeline = data.get("pipeline") if isinstance(data.get("pipeline"), dict) else {}
    limitations = data.get("limitations") if isinstance(data.get("limitations"), dict) else {}
    units = []
    for u in (data.get("units") or []):
        if isinstance(u, dict):
            units.append(_unit(int(u.get("page") or 0), str(u.get("text") or ""),
                               str(u.get("engine") or ""), str(u.get("state") or ""),
                               u.get("raster") if isinstance(u.get("raster"), dict) else {},
                               u.get("confidence") if isinstance(u.get("confidence"),
                                                                 (int, float)) else None))
    rotations = set()
    for pair in (req.get("rotations") or []):
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            try:
                rotations.add((int(pair[0]), int(pair[1])))
            except (TypeError, ValueError):
                pass
    art = _empty_art("persisted engine output", RESULT_SCHEMA)
    try:
        art["request_units"] = sorted({int(u) for u in (req.get("units") or [])}) or None
    except (TypeError, ValueError):
        art["request_units"] = None
    art["rotations"] = rotations
    art["units"] = units
    art["engines_used"] = ([str(e) for e in (pipeline.get("engines_used") or [])]
                           if "engines_used" in pipeline else None)
    art["fallback"] = {"ran": bool(pipeline.get("fallback_ran")),
                       "reason": str(pipeline.get("fallback_reason") or ""),
                       "fidelity_note": str(limitations.get("fallback_fidelity") or "")}
    art["coverage"] = data.get("coverage") if isinstance(data.get("coverage"), dict) else None
    return art, "ok", ""


def units_from_delivered(text: str) -> list[dict]:
    """Convert a delivery-shaped body into engine-attributed units (no arithmetic invented)."""
    blocks, labels, units = page_blocks(text), page_readers(text), []
    for page in sorted(blocks):
        chunk, lab = blocks[page], "; ".join(labels.get(page, []))
        if not chunk:
            units.append(_unit(page, "", "", state="not_read", conf=None))
            continue
        if ENGINE_PADDLE in lab or "paddleocr" in lab.lower():
            eng = ENGINE_PADDLE
        elif "tesseract" in lab.lower():
            eng = ENGINE_TESS
        elif "text layer" in lab.lower():
            eng = NATIVE_ENGINE
        else:
            eng = ""  # an unlabelled reader is scored as unattributed, never guessed
        state = "native_text" if eng == NATIVE_ENGINE else ("recognised" if eng else "recognised")
        units.append(_unit(page, chunk, eng, state=state, conf=None))
    return units


def normalize_transcript(path: Path) -> dict[str, dict]:
    """Parse a transcript map. Structural errors raise ValueError (config errors, exit 2)."""
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if isinstance(data, dict) and isinstance(data.get("fixtures"), dict):
        data = data["fixtures"]
    if not isinstance(data, dict):
        raise ValueError("the transcript must be an object of fixture name -> entry")
    out: dict[str, dict] = {}
    for name, entry in data.items():
        if not isinstance(entry, dict):
            raise ValueError(f"{name}: the entry is a {type(entry).__name__}, not an object")
        art = _empty_art("transcript map entry", "transcript")
        if "units" in entry:
            if not isinstance(entry["units"], list):
                raise ValueError(f"{name}: units must be a list")
            for u in entry["units"]:
                if not isinstance(u, dict):
                    raise ValueError(f"{name}: every unit must be an object")
                art["units"].append(_unit(int(u.get("page") or 0), str(u.get("text") or ""),
                                          str(u.get("engine") or ""), str(u.get("state") or ""),
                                          u.get("raster") if isinstance(u.get("raster"), dict)
                                          else {}, u.get("confidence")
                                          if isinstance(u.get("confidence"), (int, float))
                                          else None))
        elif isinstance(entry.get("delivered"), str):
            art["units"] = units_from_delivered(entry["delivered"])
        req = entry.get("request") if isinstance(entry.get("request"), dict) else {}
        if "units" in req:
            art["request_units"] = sorted({int(u) for u in req["units"]})
        elif art["units"]:
            art["request_units"] = sorted({u["page"] for u in art["units"]})
        for pair in (req.get("rotations") or []):
            if isinstance(pair, (list, tuple)) and len(pair) == 2:
                art["rotations"].add((int(pair[0]), int(pair[1])))
        if "engines_used" in entry:
            art["engines_used"] = [str(e) for e in (entry["engines_used"] or [])]
        if isinstance(entry.get("fallback"), dict):
            fb = entry["fallback"]
            art["fallback"] = {"ran": bool(fb.get("ran")), "reason": str(fb.get("reason") or ""),
                               "fidelity_note": str(fb.get("fidelity_note") or "")}
        if isinstance(entry.get("coverage"), dict):
            art["coverage"] = entry["coverage"]
        if "needs_language" in entry:
            nl = entry["needs_language"]
            art["needs_language"] = ({"stated": bool(nl), "reason": str(entry.get("reason") or "")}
                                     if isinstance(nl, bool) else
                                     ({"stated": bool(nl.get("stated")),
                                      "reason": str(nl.get("reason") or "")}
                                     if isinstance(nl, dict) else None))
            if art["needs_language"] is None:
                raise ValueError(f"{name}: needs_language must be true/false or an object")
        if "note" in entry:
            art["note"] = str(entry["note"])
        out[name] = art
    return out


# ---------------------------------------------------------------- scoring
def required_ocr_pages(spec: dict) -> set[int]:
    """Which pages MUST an OCR engine have read for this fixture to be a complete attempt."""
    if spec.get("typed_error") or spec.get("ocr_must_not_run"):
        return set()
    if "must_recognise_despite_rotation" in spec:
        return {1}
    if "page_1_must_contain_recognised" in spec:
        return {1}
    if spec.get("ocr_must_run"):
        return set(range(1, int(spec.get("pages") or 0) + 1))
    return set()


def score_engine_artifact(name: str, spec: dict, art: dict, th: dict) -> tuple[list, str, bool]:
    """Score one engine artifact. Returns (checks, state, partial). Nothing here relaxes the key."""
    checks: list[dict] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        checks.append({"check": label, "ok": bool(ok), "detail": str(detail)[:900]})

    units = art["units"]
    req = art.get("request_units")
    rots = art.get("rotations") or set()
    fb = art.get("fallback") or {}
    declared = art.get("engines_used")

    read_pages = {u["page"] for u in units if str(u.get("state")) in READ_STATES}
    ocr_units = [u for u in units if str(u.get("state")) in READ_STATES
                 and is_ocr_engine(u.get("engine"))]
    ocr_read = {u["page"] for u in ocr_units}
    page_texts: dict[int, str] = {}
    for u in units:
        if u["page"] >= 1 and str(u.get("text") or ""):
            page_texts[u["page"]] = collapse(page_texts.get(u["page"], "") + " " + str(u["text"]))

    def page_engine(page: int) -> str:
        cand = [u for u in ocr_units if u["page"] == page] or [u for u in units if u["page"] == page]
        return str((cand[0] if cand else {}).get("engine") or "")

    def page_wer_limit(page: int) -> tuple[float, str]:
        eng = page_engine(page)
        if eng == ENGINE_PADDLE:
            return float(th["word_error_rate_primary"]), f"reader {ENGINE_PADDLE} (primary limit)"
        if eng == ENGINE_TESS:
            return float(th["word_error_rate_fallback"]), f"reader {ENGINE_TESS} (fallback limit)"
        return float(th["word_error_rate_fallback"]), (f"reader {eng or 'UNATTRIBUTED'!r}; the "
                                                       "attribution check scores that separately")

    partial = False

    # --- typed refusal: an undeclared language is a refusal, never a silent English default ---
    if spec.get("typed_error") == "needs_language":
        nl = art.get("needs_language") or {}
        blob = collapse(f"{nl.get('reason') or ''} {art.get('note') or ''}")
        check("needs_language_typed", bool(nl.get("stated")),
              f"artifact needs_language: {json.dumps(nl)[:300]}")
        check("needs_language_names_env", ENV_NAME in blob, blob[:400])
        check("no_ocr_ran_without_language", not ocr_units
              and not [e for e in (declared or []) if is_ocr_engine(e)],
              f"units: {len(ocr_units)}; engines_used: {declared}")
        fails = [c for c in checks if not c["ok"]]
        return checks, ("fail" if fails else "pass"), False

    # --- routing honesty: a native-routed document must not have been OCR-read ---
    if spec.get("ocr_must_not_run"):
        check("ocr_did_not_run", not ocr_units
              and not [e for e in (declared if declared is not None else []) if is_ocr_engine(e)],
              f"OCR units: {[(u['page'], u['engine']) for u in ocr_units]}; "
              f"engines_used: {declared}")

    # --- per-page containment + WER, the WER limit set by that unit's OWN reader ---
    per_page = {int(k): collapse(v) for k, v in (spec.get("expected_per_page") or {}).items()}
    wer_key = {int(k): v for k, v in (spec.get("word_error_rate_key") or {}).items()}
    for page in sorted(per_page):
        if page not in read_pages:
            if req is not None and page in set(req):
                check(f"page{page}_unit_read", False,
                      f"page {page} was requested but no readable unit exists in the record")
            else:
                partial = True  # this page was never part of THIS attempt
            continue
        got = page_texts.get(page, "")
        check(f"page{page}_phrase_in_units", per_page[page] in got, f"got: {got[:300]}")
        wl = wer_key.get(page)
        if wl:
            limit, why = page_wer_limit(page)
            value = wer([str(w) for w in wl], got.split())
            check(f"page{page}_wer<=limit", value <= limit,
                  f"wer={value:.3f} limit={limit} ({why})")

    # --- coverage of the key's listed pages, and honesty of the record's own coverage claim ---
    if per_page:
        full = (req is not None and set(per_page) <= set(req)) or (read_pages >= set(per_page))
        if full:
            n_read = len(read_pages & set(per_page))
            check("coverage_units_read",
                  n_read / len(per_page) >= float(th["coverage_units_read_fraction"]),
                  f"{n_read} of {len(per_page)} listed page(s) carry a readable unit")
        else:
            partial = True
    if spec.get("ocr_must_run"):
        check("ocr_ran", bool(ocr_units), f"read units: {sorted(read_pages)}")
        if ocr_units and not fb.get("ran"):
            wrong = sorted({str(u.get("engine")) for u in ocr_units
                            if str(u.get("engine")) != ENGINE_PADDLE})
            check("primary_engine_attributed", not wrong,
                  f"units read but attributed to {wrong}; the primary is {ENGINE_PADDLE} and no "
                  f"fallback ran (fallback.ran={fb.get('ran')})")

    cov = art.get("coverage")
    if cov is not None:
        declared_read = int(cov.get("read") or 0)
        computed_read = len(read_pages)
        check("coverage_read_honest", declared_read == computed_read,
              f"declared read {declared_read}; the real states support {computed_read} read "
              f"page(s) {sorted(read_pages)}; anything else would count an unresolved unit as read")
        unresolved_computed = sorted(
            {u["page"] for u in units if str(u.get("state")) not in READ_STATES}
            | ((set(req) - read_pages) if req else set()))
        unresolved_declared = sorted(int(u) for u in (cov.get("unresolved") or []))
        check("coverage_unresolved_honest", unresolved_declared == unresolved_computed,
              f"declared unresolved {unresolved_declared} vs computed {unresolved_computed}")
        if req and cov.get("requested") is not None:
            check("coverage_requested_honest", int(cov.get("requested") or 0) == len(set(req)),
                  f"declared requested {cov.get('requested')} vs request.units {sorted(req)}")

    # --- no fabrication, late evidence ---
    required = required_ocr_pages(spec)
    fab = spec.get("must_not_fabricate")
    if fab:
        page = int(fab["page"])
        check("no_fabricated_content", str(fab["absent_word"]) not in page_texts.get(page, ""),
              f"page {page}: {page_texts.get(page, '')[:300]}")
    late = spec.get("late_evidence")
    if isinstance(late, dict):
        page, want = int(late["page"]), collapse(late["contains"])
        if page in read_pages or (req is not None and page in set(req)):
            check(f"late_evidence_page{page}", want in page_texts.get(page, ""),
                  f"delivered on page {page}: {page_texts.get(page, '')[:300]}")
        elif page in required:
            partial = True  # a page THIS engine attempt had to read is missing it
        else:
            # the key's late evidence sits on a page this engine was never asked to read
            # (d1_mixed page 3 is native-routed by the assessment); scoring that fact at
            # engine level would invent an OCR unit for a native page — it is scored by
            # the delivery-level probe instead, and the skip is recorded, not silent
            checks.append({"check": f"late_evidence_page{page}", "ok": True, "skipped": True,
                           "detail": f"page {page} is outside this engine attempt "
                                     "(native-routed or not in the OCR request); this fact "
                                     "belongs to the delivery-level probe"})

    # --- mixed: recognised fact present, native heading NOT re-recognised, native-only pages absent ---
    if "page_1_must_contain_recognised" in spec:
        recog = collapse(spec["page_1_must_contain_recognised"])
        joined = collapse(" ".join(str(u.get("text") or "") for u in ocr_units if u["page"] == 1))
        check("mixed_page1_recognised", recog in joined, joined[:300])
        heading = collapse(spec["no_duplicate_heading_once"])
        occurrences = sum(collapse(str(u.get("text") or "")).count(heading) for u in ocr_units)
        check("mixed_heading_not_recognised", occurrences == 0,
              f"the native heading was re-recognised {occurrences} time(s) by the OCR engine; "
              "a merge of this record would duplicate it")
        p3 = [(u["page"], u["engine"]) for u in ocr_units if u["page"] == 3]
        check("mixed_page3_native_only", not p3,
              f"an OCR engine read page 3 (native-only page): {p3}")

    # --- rotation: the fact survives the correction AND the record says which correction ran ---
    if "must_recognise_despite_rotation" in spec:
        want = collapse(spec["must_recognise_despite_rotation"])
        p1 = [u for u in ocr_units if u["page"] == 1]
        joined = collapse(" ".join(str(u.get("text") or "") for u in p1))
        check("rotated_recognised", want in joined, joined[:300])
        check("rotated_page_reference", 1 in read_pages, f"pages read: {sorted(read_pages)}")
        deg = int(spec.get("rotate_declared") or 0)
        rot_req = (1, deg) in rots
        raster_rot = any(int((u.get("raster") or {}).get("rotation") or 0) == deg for u in p1)
        check("rotation_evidence_recorded", rot_req or raster_rot,
              f"request.rotations: {sorted(rots)}; page-1 raster rotations: "
              f"{[int((u.get('raster') or {}).get('rotation') or 0) for u in p1]}")

    # --- required OCR coverage for page-thin fixtures (scanned is handled by the per-page loop) ---
    if required and not spec.get("ocr_must_run"):
        missing = required - ocr_read
        if missing:
            if req is not None and required <= set(req):
                check("required_ocr_pages_read", False,
                      f"the request covered {sorted(required)} but {sorted(missing)} carry no "
                      "readable OCR-engine unit")
            else:
                partial = True

    # --- one authority for what read each page: declared engines vs the units' own readers ---
    if declared is not None:
        computed_engines = sorted({str(u.get("engine")) for u in units
                                   if str(u.get("state")) in READ_STATES
                                   and str(u.get("engine") or "") and str(u.get("engine")) != "none"})
        check("engines_used_agree_units", sorted(str(e) for e in declared) == computed_engines,
              f"declared engines_used {sorted(str(e) for e in declared)} vs per-unit readers "
              f"{computed_engines}")
    unattributed = [u["page"] for u in ocr_units if not str(u.get("engine") or "")
                    or str(u.get("engine")) == "none"]
    check("every_ocr_unit_names_its_engine", not unattributed,
          f"read units without a real engine name: {unattributed}")

    # --- recovery may not claim equivalent fidelity ---
    if fb.get("ran"):
        note = str(fb.get("fidelity_note") or "")
        check("fallback_fidelity_note_reduced",
              "fidelity" in note.lower() and ("not" in note.lower() or "reduced" in note.lower()),
              f"fallback ran; fidelity note: {note[:300] or '(absent)'}")

    fails = [c for c in checks if not c["ok"]]
    state = "fail" if fails else ("not_evaluable" if partial else "pass")
    return checks, state, partial


# ---------------------------------------------------------------- self-check controls
def positive_artifact(name: str, spec: dict) -> dict:
    """An engine-shaped artifact built FROM the answer key. No engine runs; it must score 0 fails."""
    art = _empty_art("synthetic positive control built from the answer key; NO engine ran",
                     "self_check")
    per_page = {int(k): str(v) for k, v in (spec.get("expected_per_page") or {}).items()}
    pages = int(spec.get("pages") or 0)

    if spec.get("typed_error") == "needs_language":
        art["needs_language"] = {
            "stated": True,
            "reason": ("no document language was given or declared; the engine's language data "
                       "is chosen explicitly and is never defaulted to English; OCR needs an "
                       "explicit language (set RUKE_DOCUMENT_OCR_LANGUAGE)")}
        art["engines_used"] = []
        return art
    if spec.get("ocr_must_not_run"):
        art["units"] = [_unit(p, per_page[p], NATIVE_ENGINE, state="native_text", conf=None)
                        for p in sorted(per_page)]
        art["engines_used"] = [NATIVE_ENGINE]
        return art
    if spec.get("ocr_must_run"):
        req = sorted(per_page) or list(range(1, pages + 1))
        art["request_units"] = req
        art["units"] = [_unit(p, per_page[p], ENGINE_PADDLE) for p in req]
        art["engines_used"] = [ENGINE_PADDLE]
        art["coverage"] = {"requested": len(req), "read": len(req), "unresolved": []}
        return art
    if "page_1_must_contain_recognised" in spec:
        art["request_units"] = [1, 2]
        art["units"] = [
            _unit(1, collapse(spec["page_1_must_contain_recognised"])
                  + " plus the scanned figure body on that page", ENGINE_PADDLE),
            _unit(2, "continuation of the scanned figure body read by recognition", ENGINE_PADDLE)]
        art["engines_used"] = [ENGINE_PADDLE]
        art["coverage"] = {"requested": 2, "read": 2, "unresolved": []}
        return art
    if "must_recognise_despite_rotation" in spec:
        art["request_units"] = [1]
        art["rotations"] = {(1, int(spec.get("rotate_declared") or 0))}
        art["units"] = [_unit(1, collapse(spec["must_recognise_despite_rotation"]), ENGINE_PADDLE)]
        art["engines_used"] = [ENGINE_PADDLE]
        art["coverage"] = {"requested": 1, "read": 1, "unresolved": []}
        return art
    return art


def sabotages(name: str, spec: dict) -> list[tuple[str, dict]]:
    """Named, fixture-specific corruptions. Each MUST score at least one fail, or the scorer is blind."""
    base = positive_artifact(name, spec)
    out: list[tuple[str, dict]] = []

    def variant(label: str):
        art = copy.deepcopy(base)
        out.append((label, art))
        return art

    if spec.get("ocr_must_run"):
        a = variant("drop_last_page")
        del a["units"][-1]          # coverage declared read stays 6 -> honesty + coverage fire
        a = variant("drop_numeric_fact")
        for u in a["units"]:
            if u["page"] == int(spec["late_evidence"]["page"]):
                u["text"] = u["text"].replace(str(spec["late_evidence"]["contains"]), "")
        a = variant("fabricate_chapter_page1")
        for u in a["units"]:
            if u["page"] == int(spec["must_not_fabricate"]["page"]):
                u["text"] = "Chapter invented by nothing " + u["text"]
        a = variant("claim_unresolved_unit_read")
        for u in a["units"]:
            if u["page"] == 2:
                u["state"], u["text"] = "ocr_failed", ""   # coverage still declares 6 read
        a = variant("swap_engine_attribution")
        for u in a["units"]:
            u["engine"] = ENGINE_TESS                      # declared engines_used stays paddle
        a = variant("swap_engine_attribution_no_fidelity_note")
        for u in a["units"]:
            u["engine"] = ENGINE_TESS
        a["engines_used"] = [ENGINE_TESS]
        a["fallback"] = {"ran": True, "reason": "simulated primary failure", "fidelity_note": ""}
    if "page_1_must_contain_recognised" in spec:
        a = variant("native_heading_re_recognised")
        for u in a["units"]:
            if u["page"] == 1:
                u["text"] = collapse(spec["no_duplicate_heading_once"]) + " " + u["text"]
        a = variant("ocr_read_a_native_only_page")
        a["units"].append(_unit(3, "invented recognition of a native-only page", ENGINE_PADDLE))
        a["request_units"] = [1, 2, 3]
        a["coverage"] = {"requested": 3, "read": 3, "unresolved": []}
    if spec.get("ocr_must_not_run"):
        a = variant("ocr_ran_on_a_native_document")
        a["units"].append(_unit(1, "Section 4.2 Ground Water re-read by an OCR engine",
                                ENGINE_PADDLE))
    if "must_recognise_despite_rotation" in spec:
        a = variant("drop_rotation_evidence")
        a["rotations"] = set()                             # no request rotation, no raster echo
    if spec.get("typed_error") == "needs_language":
        a = variant("language_refusal_without_env_name")
        a["needs_language"] = {"stated": True,
                               "reason": "no document language was given or declared"}
    return out


def self_check(key: dict, th: dict) -> tuple[list, int]:
    records, broken = [], 0
    for name in sorted(key["fixtures"]):
        spec = key["fixtures"][name]
        checks, state, _ = score_engine_artifact(name, spec, positive_artifact(name, spec), th)
        fails = [c["check"] for c in checks if not c["ok"]]
        ok = state == "pass" and not fails
        records.append({"fixture": name, "control": "positive",
                        "expect": "state pass with zero fails", "state": state,
                        "fails": fails, "checks_total": len(checks), "ok": ok})
        if not ok:
            broken += 1
            print(f"SELF-CHECK BROKEN {name}: the scorer cannot satisfy its own key-shaped "
                  f"positive control: {fails} (state {state})")
        for label, art in sabotages(name, spec):
            schecks, sstate, _ = score_engine_artifact(name, spec, art, th)
            sfails = [c["check"] for c in schecks if not c["ok"]]
            ok = len(sfails) >= 1
            records.append({"fixture": name, "control": f"sabotage:{label}",
                            "expect": "at least one fail", "state": sstate,
                            "fails": sfails, "checks_total": len(schecks), "ok": ok})
            if not ok:
                broken += 1
                print(f"SELF-CHECK BROKEN {name}/{label}: a sabotaged artifact scored clean — "
                      "the corresponding live check can never fire")
    return records, broken


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", action="append", default=[], metavar="FIXTURE=PATH",
                    help="score a persisted ruke.ocr-result.v1 record for FIXTURE")
    ap.add_argument("--transcript", action="append", default=[], metavar="PATH",
                    help="score a transcript map (fixture -> engine-attributed units or "
                         "delivered text)")
    ap.add_argument("--fixture", action="append", default=[], metavar="NAME",
                    help="restrict scoring to these fixtures (default: every fixture the "
                         "supplied evidence covers plus every key fixture, scored not_evaluable)")
    ap.add_argument("--self-check", action="store_true",
                    help="scorer mechanics only: a key-shaped positive control must pass and "
                         "each named sabotage must fail. NO engine runs; never OCR evidence.")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    # a live run may carry no evidence at all (--fixture only): every scored fixture is then
    # not_evaluable, which is the honest "no engine output exists yet" record, exit 1 — never
    # counted as acceptance, and never folded into a config error
    live_requested = bool(args.result or args.transcript or args.fixture)
    if bool(args.self_check) == live_requested:
        print("give exactly one of --self-check or (--result/--transcript/--fixture ...)")
        return 2

    key = json.loads(KEY.read_text(encoding="utf-8"))
    if key.get("key_version") != KEY_VERSION:
        print(f"refusing: answer key version {key.get('key_version')!r} != {KEY_VERSION!r}; "
              "a frozen key is replaced by a NEW version, recorded separately")
        return 2
    th = dict(key["thresholds_fixed_before_results"])
    fixtures = key["fixtures"] or {}

    if args.self_check:
        records, broken = self_check(key, th)
        out = {"level": "ENGINE-LEVEL SELF-CHECK (scorer mechanics; NO engine ran; "
                        "NOT the attended delivery-level pass)",
               "key_version": KEY_VERSION, "mode": "self_check",
               "run_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "thresholds": th,
               "controls": records, "broken": broken,
               "note": ("a positive control built FROM the answer key must score zero misses "
                        "and every named sabotage must score at least one; that is what makes a "
                        "live engine-level pass meaningful. This file is not OCR evidence and "
                        "primary OCR acceptance requires output from a real engine run.")}
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out_path = Path(args.out) if args.out else (
            OUT_DIR / f"d1-engine-selfcheck-{time.strftime('%Y%m%d-%H%M%S')}.json")
        out_path.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        print(json.dumps({"mode": "self_check", "broken": broken,
                          "controls": len(records), "out": str(out_path)}, indent=2))
        return 0 if broken == 0 else 1

    wanted = set(args.fixture) or set(fixtures)
    if not wanted <= set(fixtures):
        print(f"unknown fixture(s): {sorted(wanted - set(fixtures))}; the key lists "
              f"{sorted(fixtures)}")
        return 2
    seen: dict[str, str] = {}
    arts: dict[str, dict] = {}
    problems: dict[str, tuple[str, str]] = {}

    def claim(name: str, source: str) -> bool:
        if name in seen:
            print(f"config error: {name} supplied twice ({seen[name]} and {source})")
            return False
        seen[name] = source
        return True

    for spec_s in args.result:
        if "=" not in spec_s:
            print(f"--result wants FIXTURE=PATH, got {spec_s!r}")
            return 2
        name, raw_path = spec_s.split("=", 1)
        if name not in fixtures:
            print(f"config error: unknown fixture {name!r}; the key lists {sorted(fixtures)}")
            return 2
        if not claim(name, f"--result {name}"):
            return 2
        art, kind, detail = normalize_record(Path(raw_path), name)
        if kind == "ok" and art is not None:
            arts[name] = art
        else:
            problems[name] = (kind, detail)

    for tp in args.transcript:
        try:
            entries = normalize_transcript(Path(tp))
        except (OSError, ValueError) as exc:
            print(f"config error: transcript {tp}: {type(exc).__name__}: {exc}")
            return 2
        for name, art in entries.items():
            if name not in fixtures:
                print(f"config error: transcript {tp} names unknown fixture {name!r}")
                return 2
            if not claim(name, f"--transcript {tp}"):
                return 2
            arts[name] = art

    scored = sorted(wanted)
    results, any_fail, any_ne = [], False, False
    passes_for = {name: [p for p in sorted(PASS_FIXTURES) if name in PASS_FIXTURES[p]]
                  for name in fixtures}
    for name in scored:
        if name in arts:
            checks, state, partial = score_engine_artifact(name, fixtures[name], arts[name], th)
            note = arts[name]["note"]
        elif name in problems:
            kind, detail = problems[name]
            checks, state, partial = [], "not_evaluable", True
            note = f"persisted record {kind}: {detail}"
        else:
            checks, state, partial = [], "not_evaluable", True
            note = ("no engine output supplied for this fixture (an attended delivery pass "
                    "is different evidence; a bounded partial run is scored not_evaluable)")
        fails = [c["check"] for c in checks if not c["ok"]]
        any_fail = any_fail or bool(fails)
        any_ne = any_ne or state == "not_evaluable"
        results.append({"fixture": name, "state": state, "partial": partial,
                        "attended_passes_that_visit_it": passes_for[name],
                        "note": note, "checks": checks, "misses": fails})
        print(f"{name}: {state} ({sum(1 for c in checks if c['ok'])}/{len(checks)} checks ok)"
              + (f" misses={fails}" if fails else ""))

    out = {"level": "ENGINE-LEVEL (scores persisted engine output or a transcript; NOT the "
                    "attended delivery-level pass d1_ocr_acceptance_probe.py)",
           "key_version": KEY_VERSION, "mode": "engine_scoring",
           "run_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "thresholds": th,
           "fixtures_supplied": sorted(seen), "fixtures": results,
           "states": {"pass": sum(1 for r in results if r["state"] == "pass"),
                      "fail": sum(1 for r in results if r["state"] == "fail"),
                      "not_evaluable": sum(1 for r in results if r["state"] == "not_evaluable")},
           "note": ("a pass here scores what the engines ACTUALLY produced and claimed; a "
                    "not_evaluable fixture means the scorer never saw a complete real engine "
                    "run for it, and is never counted as acceptance. Primary OCR acceptance "
                    "additionally requires output from a real PaddleOCR run.")}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (
        OUT_DIR / f"d1-engine-{time.strftime('%Y%m%d-%H%M%S')}.json")
    out_path.write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"states": out["states"], "out": str(out_path)}, indent=2))
    return 1 if (any_fail or any_ne) else 0


if __name__ == "__main__":
    raise SystemExit(main())
