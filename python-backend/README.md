# ruke-ml - Ruke capability backend

Layout, contracts and lifecycle rules are defined by docs/overnight/SPEC.md sections 6-9.

## What runs today (verified)
- A **stdlib-only supervisor** (ruke_ml/supervisor.py) on a loopback port with a per-run secret.
  It answers /health and /capabilities **without importing any ML framework** and without
  downloading a model. Tests assert that (no torch/paddle/transformers in sys.modules).
- **Versioned contracts** (ruke_ml/contracts.py, SCHEMA_VERSION 1) shared in shape with the
  TS/Rust sides: job/run/request ids, capability, progress state, typed retryable errors,
  cancellation, model identity, actual coverage, artifact provenance, embedding
  dimension/normalization.
- **Lazy worker processes**: exit of the worker is the memory-reclamation mechanism. One heavy
  worker at a time, TTL idle unload, bounded terminate escalation, typed crash, restart allowed.
- **Lexical retrieval baseline** reporting its real quality mode ("lexical"), never claiming
  model-quality parity.

## What is intentionally not installed yet
Heavy families (embeddings, documents/OCR, ASR, diarization) are declared as extras in
pyproject.toml and deliberately **unpinned**: this host has no proven CUDA path (the repo's
onnxruntime reports only dml/webgpu/cpu), and the quality gate in the brief requires measured
Telugu/Hindi/Indic evidence before a model is selected. Running the gate is an evaluation step,
not an import.

## Commands
    uv sync --project python-backend          # stdlib-only env (no heavy deps)
    uv run --project python-backend python -m unittest discover -s tests -v
    uv run --project python-backend python -m ruke_ml.supervisor --port 0   # prints its port + secret file
Run without uv (same interpreter, no deps needed):
    python -m unittest discover -s tests      # from python-backend/
