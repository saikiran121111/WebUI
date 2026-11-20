"""Held-out fixtures scored against a frozen answer key, at reader level.

The answer key (`docs/overnight/fixtures/f09/answer-key.json`) was authored from the
fixture SOURCE before any reader was scored against it, so a reader that disagrees is a
defect, not a test that needs updating. Unknown keys in the key fail the run: a silently
ignored expectation is how a check stops existing.

What this file proves is the reader's own fidelity: which units produced content, which
unit a fact came from, merged-range geometry, formula/cached-value separation, declared
empty vs explicit 0, corruption reporting, note provenance, and the derived rendering
that the delivery layer actually ships. HTTP-level scoring is a separate probe
(`docs/overnight/probes/f09_heldout_http_probe.mjs`); coverage notes are produced by the
delivery layer, so they are not asserted against the reader body here.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

from ruke_ml.documents import ocr as ocr_mod
from ruke_ml.documents import parser, render
from ruke_ml.documents.structures import Document

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXDIR = os.path.join(REPO, "docs", "overnight", "fixtures", "f09")
KEY_PATH = os.path.join(FIXDIR, "answer-key.json")

sys.path.insert(0, FIXDIR)
import ho_docs  # noqa: E402

ALLOWED_TOP = {"version", "authored", "authored_from", "matching_rule", "unit_numbering",
               "status_meaning", "files"}
ALLOWED_FILE = {
    "reader_kind", "coverage", "ocr", "meta_checks", "unit_attribution",
    "blocks_none_for_unit", "block_field_checks", "cell_value_absent",
    "meta_empty_cell_checks", "block_count", "block_count_for_unit",
    "kind_absent_for_fact", "must_not_facts", "reader_notes", "http",
}
ALLOWED_COVERAGE = {"units_total", "units_succeeded", "units_empty", "units_needing_ocr",
                    "units_failed", "complete"}
ALLOWED_META_CHECK = {"path", "equals", "contains_all", "contains_all_joined", "min_items",
                      "has_entry"}
ALLOWED_HTTP = {"must", "must_not", "must_not_note", "coverage_must_any", "accept_any_of"}


def flat(value: str) -> str:
    """Collapse whitespace runs only; token order and exact tokens stay required."""
    return " ".join(str(value).split())


def in_text(hay: str, needle: str) -> bool:
    return flat(needle) in flat(hay)


def dig(value: object, path: str) -> object:
    """Dotted lookup, list indices allowed. Missing -> KeyError, never a silent None."""
    current = value
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                raise KeyError(path)
            current = current[part]
        elif isinstance(current, list):
            current = current[int(part)]
        else:
            raise KeyError(path)
    return current


class HeldOutReaders(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        with open(KEY_PATH, encoding="utf-8") as fh:
            cls.key = json.load(fh)
        unknown = set(cls.key) - ALLOWED_TOP
        assert not unknown, f"answer key has unrecognised top-level keys: {sorted(unknown)}"
        missing = set(cls.key["files"]) - set(ho_docs.BUILDERS)
        assert not missing, f"answer key names fixtures the generator cannot build: {sorted(missing)}"

    def _load(self, name: str) -> Document:
        build = ho_docs.BUILDERS[name]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, name)
            with open(path, "wb") as fh:
                fh.write(build())
            return parser.load_document(path)

    def test_answer_key_covers_every_fixture(self):
        self.assertEqual(sorted(self.key["files"]), sorted(ho_docs.BUILDERS))

    def test_held_out_readers(self):
        for name, spec in self.key["files"].items():
            with self.subTest(fixture=name):
                self._score(name, spec)

    # ---- scoring -------------------------------------------------------------

    def _score(self, name: str, spec: dict) -> None:
        unknown = set(spec) - ALLOWED_FILE
        self.assertFalse(unknown, f"{name}: answer-key keys nobody scores: {sorted(unknown)}")

        doc = self._load(name)
        self.assertEqual(doc.kind, spec["reader_kind"],
                         f"{name}: reader kind must be {spec['reader_kind']}")

        blocks = doc.blocks
        self._coverage(name, doc, spec["coverage"])

        if doc.coverage.units_failed:
            # Honest failure needs a REASON beside the failed id, not just a count.
            reasons = [(str(f.get("sheet_index")), str(f.get("why", "")))
                       for f in doc.meta.get("sheet_failures", [])] if doc.kind == "xlsx" else []
            if doc.kind == "xlsx":
                for unit in doc.coverage.units_failed:
                    self.assertTrue(
                        any(str(unit) == unit_id and detail for unit_id, detail in reasons),
                        f"{name}: failed unit {unit} carries no reason; recorded={reasons}")

        if "ocr" in spec:
            a = ocr_mod.assess(doc)
            self.assertEqual(a.route, spec["ocr"]["route"],
                             f"{name}: OCR route {a.route!r} != key "
                             f"{spec['ocr']['route']!r}; reasons={a.reasons}")
            self.assertEqual(sorted(a.units), sorted(spec["ocr"]["units"]),
                             f"{name}: OCR units {a.units} != key {spec['ocr']['units']}")

        for check in spec.get("meta_checks", []):
            self._meta_check(name, doc, check)

        for a in spec.get("unit_attribution", []):
            units = {render.unit_of(b) for b in blocks if in_text(b.text, a["fact"])}
            self.assertTrue(units, f"{name}: fact never extracted: {a['fact']!r}")
            self.assertEqual(units, {a["unit"]},
                             f"{name}: {a['fact']!r} attributed to units {sorted(units)}, "
                             f"key says unit {a['unit']}")

        for unit in spec.get("blocks_none_for_unit", []):
            self.assertFalse([b for b in blocks if render.unit_of(b) == unit],
                             f"{name}: unit {unit} must produce no content, but blocks exist")

        for check in spec.get("block_field_checks", []):
            self._block_fields(name, blocks, check)

        for check in spec.get("cell_value_absent", []):
            cell = check["cell"]
            self.assertFalse([b for b in blocks if str(b.loc.get("cell", "")) == cell],
                             f"{name}: {cell} has no value, so no block may carry it")

        for check in spec.get("meta_empty_cell_checks", []):
            sheet = check["sheet"]
            entry = doc.meta.get("empty_cells", {}).get(sheet)
            self.assertIsNotNone(entry, f"{name}: meta.empty_cells has no entry for {sheet!r}")
            refs = [str(r) for r in entry.get("refs", [])]
            for want in check["contains_all"]:
                self.assertIn(want, refs,
                              f"{name}: {sheet}!{want} is a declared-empty cell and must be "
                              f"recorded as missing; recorded refs={refs}")

        if "block_count" in spec:
            self.assertEqual(len(blocks), spec["block_count"]["equals"],
                             f"{name}: {len(blocks)} blocks, key says "
                             f"{spec['block_count']['equals']}: {[b.text[:40] for b in blocks]}")

        for check in spec.get("block_count_for_unit", []):
            got = len([b for b in blocks if render.unit_of(b) == check["unit"]])
            self.assertEqual(got, check["equals"],
                             f"{name}: unit {check['unit']} has {got} blocks, key says "
                             f"{check['equals']}")

        for check in spec.get("kind_absent_for_fact", []):
            hits = [b for b in blocks if b.kind == check["kind"] and in_text(b.text, check["fact"])]
            self.assertFalse(hits, f"{name}: {check['fact']!r} must not be classified "
                                   f"{check['kind']!r}: {[b.loc for b in hits]}")

        for fact in spec.get("must_not_facts", []):
            hits = [b.text[:60] for b in blocks if in_text(b.text, fact)]
            self.assertFalse(hits, f"{name}: must-not fact present: {fact!r} in {hits}")

        self._body(name, doc, spec["http"])

    def _coverage(self, name: str, doc: Document, want: dict) -> None:
        unknown = set(want) - ALLOWED_COVERAGE
        self.assertFalse(unknown, f"{name}: unscored coverage keys {sorted(unknown)}")
        cov = doc.coverage
        self.assertEqual(cov.units_total, want["units_total"], f"{name}: units_total")
        for field_name in ("units_succeeded", "units_empty", "units_needing_ocr",
                           "units_failed"):
            # An omitted id list in the key means "this list must be EMPTY", not "check skipped":
            # a structured OOXML unit must never show up as OCR-pending.
            want_ids = want.get(field_name, [])
            self.assertEqual(sorted(getattr(cov, field_name)), sorted(want_ids),
                             f"{name}: {field_name} is {getattr(cov, field_name)}, key says "
                             f"{want_ids} (note={cov.note!r})")
        self.assertEqual(cov.complete, want["complete"],
                         f"{name}: coverage.complete is {cov.complete}, key says "
                         f"{want['complete']}; extracted={cov.units_extracted} of "
                         f"{cov.units_total}")

    def _meta_check(self, name: str, doc: Document, check: dict) -> None:
        unknown = set(check) - ALLOWED_META_CHECK
        self.assertFalse(unknown, f"{name}: unscored meta_check keys {sorted(unknown)}")
        path = check["path"]
        try:
            got = dig(doc.meta, path)
        except (KeyError, IndexError, ValueError, TypeError) as exc:
            self.fail(f"{name}: meta path {path!r} is absent ({exc}); meta keys="
                      f"{sorted(doc.meta)}")
        if "equals" in check:
            self.assertEqual(got, check["equals"], f"{name}: meta.{path} != {check['equals']!r}")
        if "min_items" in check:
            self.assertGreaterEqual(len(got), check["min_items"],
                                    f"{name}: meta.{path} has {len(got)} items, key needs "
                                    f"{check['min_items']}: {got}")
        if "contains_all" in check:
            items = [str(x) for x in got] if isinstance(got, (list, tuple, set)) else []
            for want in check["contains_all"]:
                self.assertIn(str(want), items, f"{name}: meta.{path} lacks {want!r}; has {items}")
        if "contains_all_joined" in check:
            joined = " ".join(str(x) for x in got) if isinstance(got, (list, tuple)) else str(got)
            for want in check["contains_all_joined"]:
                self.assertIn(want, joined,
                              f"{name}: meta.{path} entries must mention {want!r}; got {joined}")
        if "has_entry" in check:
            self.assertIsInstance(got, dict, f"{name}: meta.{path} must be a mapping")
            for want_key, want_value in check["has_entry"].items():
                hit = any(str(key) == str(want_key) and value == want_value
                          for key, value in got.items())
                self.assertTrue(hit, f"{name}: meta.{path} needs entry {want_key!r}="
                                     f"{want_value!r}; has {got}")

    def _block_fields(self, name: str, blocks: list, check: dict) -> None:
        """Locate blocks by the identity fields the key names, then check the text."""
        loc_want = check.get("loc", {})
        kind = check.get("kind")

        def loc_ok(block) -> bool:
            for key, value in loc_want.items():
                if key.startswith("!"):
                    if key[1:] in block.loc:
                        return False
                    continue
                got = block.loc.get(key)
                if isinstance(value, list):
                    if [str(x) for x in (got if isinstance(got, list) else [])] != [
                            str(x) for x in value]:
                        return False
                elif str(got) != str(value):
                    return False
            return True

        with_loc = [b for b in blocks if loc_ok(b)]
        self.assertTrue(with_loc,
                        f"{name}: no block carries loc {loc_want} for fact "
                        f"{check['fact']!r}; observed locs={[b.loc for b in blocks][:12]}")
        typed = [b for b in with_loc if kind is None or b.kind == kind]
        self.assertTrue(typed, f"{name}: fact {check['fact']!r}: blocks with loc {loc_want} "
                               f"have kinds {[b.kind for b in with_loc]}, key says {kind!r}")
        matched = [b for b in typed if in_text(b.text, check["fact"])]
        self.assertTrue(matched, f"{name}: {check['fact']!r} not found on a block with loc "
                                 f"{loc_want} kind {kind!r}; those blocks carry "
                                 f"{[b.text[:60] for b in typed][:6]}")

    def _body(self, name: str, doc: Document, http: dict) -> None:
        """The derived body is what the delivery layer compares and ships."""
        unknown = set(http) - ALLOWED_HTTP
        self.assertFalse(unknown, f"{name}: unscored http keys {sorted(unknown)}")
        if doc.kind in render.RENDERED_KINDS:
            body = "\n".join(u["text"] for u in render.render_units(doc))
        else:
            body = doc.as_text()
        for want in http.get("must", []):
            self.assertTrue(in_text(body, want),
                            f"{name}: delivered body loses {want!r}: {body[:400]!r}")
        for bad in http.get("must_not", []):
            self.assertNotIn(flat(bad), flat(body),
                             f"{name}: delivered body states {bad!r}, which the key forbids")


class HeldOutKeyIsIndependent(unittest.TestCase):
    """The key must predate the scoring and must not be a copy of reader output."""

    def test_key_declares_its_own_provenance(self):
        with open(KEY_PATH, encoding="utf-8") as fh:
            key = json.load(fh)
        self.assertTrue(key.get("authored"), "answer key needs an authored date")
        self.assertIn("ho_docs.py", key.get("authored_from", ""),
                      "answer key must say where its expectations came from")

    def test_every_fixture_name_is_hermetic(self):
        for name, build in ho_docs.BUILDERS.items():
            self.assertTrue(name.startswith("ho-"), f"{name} is not namespaced as held-out")
            self.assertIsInstance(build(), bytes)


if __name__ == "__main__":
    unittest.main()
