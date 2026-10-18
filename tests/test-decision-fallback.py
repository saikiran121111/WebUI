"""
Decision Engine failure-path probe (run with the contained venv python):

    .decision-engine/.venv/Scripts/python.exe -I tests/test-decision-fallback.py

Forces LFM2.5 to emit INVALID output twice (malformed JSON from the model,
not a transport error) and asserts the envelope falls back to Needle 3's top
prior mode with the RAW prompt — NEVER a silent drop to standard_chat when
Needle has a valid prior. Also proves the one-time self-correction retry
actually fires (2 model attempts: original + correction round).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".decision-engine" / "worker"))

import decision_server as ds  # noqa: E402
from schemas import DecisionRequest  # noqa: E402

PROMPT = "Build a 500-row financial transaction tracker with SUMIFS budget alerts and dashboard KPIs"

attempts = []


def boom(*_a, **_k):
    # The model answered — but with garbage that fails Stage2Out validation,
    # which is exactly what the self-correction retry is for.
    attempts.append(1)
    return "I am not valid JSON"


def main() -> int:
    ds._agent = ds.needle.Needle(
        tools=ds.ROUTE_TOOLS,
        weights=str(ds.DE / "models" / "needle3" / "needle3.cact"),
        system=ds.CLASSIFY_SYSTEM,
        stateless=True,
    )
    ds.ensure_llama_server = lambda: None  # skip the live server; _lfm_call is stubbed
    ds._lfm_call = boom

    env = ds.decision(DecisionRequest(message=PROMPT))

    problems = []
    if len(attempts) != 2:
        problems.append(f"retry attempts={len(attempts)} (want 2: original + 1 self-correction)")
    if not env.decided_by.startswith("needle3 (lfm-fail)"):
        problems.append(f"decided_by={env.decided_by}")
    if env.active_mode == "standard_chat":
        problems.append("SILENT DROP to standard_chat — forbidden with a valid Needle prior")
    if env.stripped_prompt != " ".join(PROMPT.split()):
        problems.append("stripped_prompt was rewritten on the fallback path (must be RAW prompt)")
    if env.enable_validator != env.active_mode:
        problems.append(f"enable_validator={env.enable_validator}")

    print(f"[fallback-probe] attempts={len(attempts)} decided_by={env.decided_by} "
          f"mode={env.active_mode} conf={env.confidence} raw_prompt_kept={env.stripped_prompt == ' '.join(PROMPT.split())}")
    if problems:
        print("FAIL:", "; ".join(problems))
        return 1
    print("PASS: LFM failure -> Needle prior mode + raw prompt, zero standard_chat drop, retry fired once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
