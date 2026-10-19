"""Decision Engine schemas — the exact DecisionEnvelope contract shared with lib/decision/types.ts."""
from typing import Literal, Optional
from pydantic import BaseModel, Field

# standard_chat FIRST: it is the default container — the grammar's literal
# ordering nudges the 1.2B model toward the safe default on ambiguous turns.
MODES = [
    "standard_chat", "excel", "docs", "pdf", "ppt", "3d_asset",
    "cad_blueprint", "chart", "html_render",
]
Mode = Literal["standard_chat", "excel", "docs", "pdf", "ppt", "3d_asset",
               "cad_blueprint", "chart", "html_render"]

# mode -> (core skill in ./.cskills/ or None, allowed code fence or None)
MODE_MAP: dict[str, tuple[Optional[str], Optional[str]]] = {
    "excel":         ("xlsx", "xlsx"),
    "docs":          ("docx", "docx"),
    "pdf":           ("pdf", "html"),
    "ppt":           ("pptx", "pptx"),
    "3d_asset":      ("threejs-skills", "scene3d"),
    "cad_blueprint": ("archify", "cad"),
    "chart":         (None, "chart"),
    "html_render":   ("html-viewer", "html"),
    "standard_chat": (None, None),
}


class DecisionRequest(BaseModel):
    message: str
    conversationHistory: list[dict[str, str]] = Field(default_factory=list)


class Stage2Out(BaseModel):
    """LFM2.5-1.2B container classification — ONE field only. Passed to
    llama-server as response_format json_object+schema, so generation is
    grammar-constrained to {"active_mode": <one of 9 literals>}: ~5 decoded
    tokens instead of ~80. The 1.2B model can no longer echo the system
    prompt, rewrite the user's words or hallucinate constraints — prompt
    cleaning is deterministic Python in decision_server.py, not model output."""
    active_mode: Mode


class DecisionEnvelope(BaseModel):
    active_mode: Mode
    confidence: float
    decided_by: str
    stripped_prompt: str
    skill_to_load: Optional[str]
    allowed_code_fence: Optional[str]
    disable_validators: list[str]
    enable_validator: Mode
    task_constraints: list[str] = Field(default_factory=list)
    extracted_entities: list[str] = Field(default_factory=list)
    lfm_latency_ms: float = 0.0
    # Diagnostics for the WebUI dev-terminal decision table
    # (lib/server/decision-log.ts). Never used for routing.
    lfm_input: Optional[str] = None       # last user message actually sent to LFM2.5
    lfm_raw: Optional[str] = None         # raw grammar-constrained JSON from LFM2.5
