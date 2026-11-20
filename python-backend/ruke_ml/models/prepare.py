"""Explicit asset preparation: `--pipeline <display-id>` or `--model <repo-id>`.

Ordinary startup never downloads a model. This command is the deliberate, opt-in step
that puts a pinned asset on disk so a capability can become executable. It prints what
it did and exits non-zero on failure, so a setup script cannot "succeed" silently.

`--pipeline` exists because a pipeline adapter needs MORE than one weight repository, and
because its display id is not its Hugging Face repo id. `--pipeline PaddleOCR-VL-1.6`
prepares the recognition model AND the layout model at the revisions the registry pins,
then verifies the required files of each. Asking the operator to pass two repo ids by hand
is how a "prepared" pipeline ends up missing half of itself.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

from .assets import prepare, prepare_local
from .registry import NOT_MIGRATED, AssetRef, catalog


def _allow_patterns_for(ref: AssetRef) -> list[str]:
    """The files a project-local checkout actually needs, not the whole repository.

    A pinned ONNX checkpoint is weights plus tokenizer; its PyTorch originals and its
    quantised variants are another engine's business. Downloading everything turns asset
    preparation into a multi-GB exercise nobody asked for.
    """
    names = [name for name, _minimum in ref.required_files]
    extras = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
              "config.json", "vocab.txt"]
    out: list[str] = []
    for pattern in names + extras:
        if pattern not in out:
            out.append(pattern)
    return out


def _revision_for(spec_revision: str, ref_revision: str) -> str:
    """The revision to fetch for one asset reference.

    An asset's own pinned revision wins; otherwise the row's revision; a row that pins
    nothing deliberately prepares whatever the repo resolves to (and says so).
    """
    if ref_revision:
        return ref_revision
    if spec_revision not in ("", NOT_MIGRATED, "builtin", "builtin-v1"):
        return "" if spec_revision == "unpinned" else spec_revision
    return ""


def _refs_for(spec) -> list[AssetRef]:
    if spec.asset:
        primary = AssetRef(spec.asset, "", spec.required_files)
        return [primary] + list(spec.extra_assets)
    return list(spec.extra_assets)


def _prepare_row(spec, *, override_revision: str, force: bool,
                 local: bool = False) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for ref in _refs_for(spec):
        revision = override_revision or _revision_for(spec.revision, ref.revision)
        manifest: dict[str, object] = {}
        if local:
            # A digest-pinned adapter (embeddings, cross-encoder rerank) reads a plain
            # project-local checkout, so preparation must write THAT layout and record the
            # origin on disk, or the digest pin has no provenance behind it.
            state, manifest = prepare_local(ref.repo_id, revision=revision,
                                            allow_patterns=_allow_patterns_for(ref),
                                            required=ref.required_files, force_download=force)
        else:
            state = prepare(ref.repo_id, revision=revision, force_download=force,
                            required=ref.required_files)
        row: dict[str, object] = {
            "model_id": state.model_id, "ok": state.present, "detail": state.detail,
            "path": state.path, "revision": revision or "unpinned",
            "required_files": len(ref.required_files),
            "capability": spec.capability, "pipeline": spec.id,
            "layout": "project-local checkout" if local else "hub snapshot"}
        if manifest:
            files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
            weights = files.get("onnx/model.onnx")
            row["manifest_ok"] = manifest.get("ok")
            row["files"] = sorted(files.keys())
            row["weights_sha256"] = (weights or {}).get("sha256", "") if isinstance(weights, dict) else ""
            row["problems"] = manifest.get("problems") or []
        out.append(row)
    return out


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Prepare pinned model assets explicitly.")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--model", help="repo id, e.g. Systran/faster-whisper-base")
    group.add_argument("--pipeline", help="registered pipeline/display id, e.g. PaddleOCR-VL-1.6; "
                                          "prepares every asset that adapter loads")
    ap.add_argument("--revision", default="",
                    help="revision to fetch; defaults to the revision this build pins, so a "
                         "setup script cannot silently prepare a different snapshot than "
                         "the one readiness will accept")
    ap.add_argument("--force", action="store_true", help="re-download even if cached")
    ap.add_argument("--local", action="store_true",
                    help="write a pinned project-local checkout under the project model dir "
                         "instead of a hub snapshot, and record asset-manifest.json with the "
                         "commit and the sha256 of every file; required for the digest-pinned "
                         "ONNX embedding/rerank adapters")
    args = ap.parse_args(argv)

    cat = catalog()
    if args.model:
        spec = cat.get(args.model)
        if spec is None:
            print(json.dumps({"model_id": args.model, "ok": False,
                              "detail": "model id is not in the registry; a registry row must name "
                                        "the adapter that will actually use it"}, indent=2))
            return 2
        rows = [spec]
    else:
        rows = cat.pipeline_rows(args.pipeline)
        if not rows:
            print(json.dumps({"pipeline": args.pipeline, "ok": False,
                              "detail": "no registered pipeline row names that id; known pipelines: "
                                        + ", ".join(cat.pipeline_names()),
                              "assets": []}, indent=2))
            return 2

    results: list[dict[str, object]] = []
    for spec in rows:
        results += _prepare_row(spec, override_revision=args.revision, force=args.force,
                                local=args.local)
    ok = bool(results) and all(bool(r["ok"]) for r in results)
    print(json.dumps({"ok": ok, "assets": results,
                      "prepared_for": (args.pipeline or args.model),
                      "layout": "project-local checkout" if args.local else "hub snapshot",
                      "pipelines": sorted({str(r["pipeline"]) for r in results})},
                     indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
