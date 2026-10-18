"""
Prompt stripping is MODEL-MADE: LFM2.5-1.2B generates the stripped_prompt
under schema constraint (see decision_server.lfm_decide). All former
regex/rule-based filler-stripping was removed 2026-10-18 — zero rule-based
text stripping runs anywhere in the pipeline.

What remains here is ONLY whitespace normalization, used on the fallback path
when LFM2.5 failed and the RAW prompt is forwarded (never a rewritten task).
"""


def strip_prompt(text: str) -> tuple[str, list[str]]:
    """Whitespace-normalize the raw text; no word is removed. Constraints are
    model-extracted (Stage2Out.task_constraints), never regex-mined."""
    return " ".join(text.split()), []
