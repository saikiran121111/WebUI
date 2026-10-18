"""Decision Engine schemas — the exact DecisionEnvelope contract shared with lib/decision/types.ts."""
from typing import Literal, Optional
from pydantic import BaseModel, Field

MODES = [
    "excel", "docs", "pdf", "ppt", "3d_asset",
    "cad_blueprint", "chart", "html_render", "standard_chat",
]
Mode = Literal["excel", "docs", "pdf", "ppt", "3d_asset",
               "cad_blueprint", "chart", "html_render", "standard_chat"]

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
    """LFM2.5-1.2B deep-decision JSON. This schema is passed to llama-server as
    response_format json_object+schema, so generation is grammar-constrained to
    exactly these fields: one of the 9 Mode literals, a bounded confidence and a
    NON-EMPTY model-generated stripped_prompt (no rule-based stripping exists)."""
    active_mode: Mode
    confidence: float = Field(ge=0.0, le=1.0)
    stripped_prompt: str = Field(min_length=1)
    task_constraints: list[str] = Field(default_factory=list)


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
    needle_latency_ms: float = 0.0
    lfm_latency_ms: float = 0.0
