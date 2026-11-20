"""Read the F06 fixtures with the Python reader and print what it actually claims.

Run from python-backend with the pinned venv:
  .\.venv\Scripts\python.exe ..\docs\overnight\probes\f06_parse_probe.py
"""
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "python-backend"))

from ruke_ml.documents.parser import load_document  # noqa: E402

BASE = os.path.join(REPO, ".data", "tmp", "f06")
for name in ("f06-review.pdf", "f06-sheet.xlsx", "f06-notes.docx"):
    path = os.path.join(BASE, name)
    doc = load_document(path)
    cov = doc.coverage
    print("=" * 70)
    print(name, "kind=", doc.kind, "blocks=", len(doc.blocks))
    print("coverage:", json.dumps(cov.to_dict(), default=str)[:600])
    print("complete:", cov.complete, "succeeded_spans:", cov.succeeded_spans(),
          "uncovered:", cov.uncovered_spans())
    if doc.meta:
        print("meta:", json.dumps({k: v for k, v in doc.meta.items() if k != "text"}, default=str)[:520])
    for b in doc.blocks[:6]:
        print("  block:", b.kind, "| loc=", json.dumps(b.loc, default=str)[:160], "|", b.text[:80].replace("\n", " "))
    tail = doc.blocks[-2:]
    for b in tail:
        print("  TAIL:", b.kind, "| loc=", json.dumps(b.loc, default=str)[:160], "|", b.text[:90].replace("\n", " "))
    full = " ".join(b.text for b in doc.blocks)
    for probe, label in (("Ridgeway corridor was suspended", "late evidence on the last page"),
                         ("20", "spreadsheet cached formula total"),
                         ("merged", "merged-range marker"),
                         ("table", "table row grouping")):
        print(f"  probe {label!r}: {probe in full}")
