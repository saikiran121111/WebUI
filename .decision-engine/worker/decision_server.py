"""
Decision Engine worker (100% project-local) — SINGLE-MODEL LFM2.5-1.2B router.

LFM2.5-1.2B via the contained llama-server subprocess is the SOLE decision
model: it ALWAYS runs on every non-empty request, receives ONLY the raw user
message (plus an optional one-line "[Previous turn artifact mode: X]" prefix
for multi-turn) and classifies the requested OUTPUT CONTAINER into one mode.
The grammar-constrained reply is a single field, {"active_mode": ...} — ~5
decoded tokens, sub-second CPU latency, and the 1.2B model can no longer echo
the system prompt, rewrite the user's words or hallucinate constraints.
Prompt cleaning is deterministic Python (_clean_artifact_prompt), never
model-generated: the user's words, numbers, formulas, sheet names and colors
reach the main LLM verbatim, with only hostile sandbox-refusal clauses
removed. If LFM fails validation on BOTH attempts (original + 1
self-correction retry), the envelope falls back to the deterministic
container-evidence resolver (_fallback_mode_from_evidence) with the raw
prompt untouched — never a silent drop to standard_chat when the message
names an explicit studio container.

Needle 3 (cactus-needle) was FULLY REMOVED on 2026-10-19: it cost ~185 MB of
resident _worker.py --child processes and 150–900 ms of CPU latency per turn
while producing low-confidence priors (@0.01–0.04). LFM2.5-1.2B decides
directly.

Deterministic safety layers on top of the model (2026-10-19 single-field
container-classifier patch):
  * Target-Deliverable Routing Rule in the system prompt (script-phrasing
    traps like "execute a Python/openpyxl script to build an xlsx" route to
    the artifact's mode, never standard_chat).
  * _clean_artifact_prompt(): deterministic cleaner that deletes hostile
    meta-clauses ("if execution or file creation is unavailable, state the
    limitation immediately", "execute the code rather than merely describing
    it", "do not repeat your planning") and rewrites the "create and execute
    a Python/openpyxl script to" lead-in to a plain "Generate" verb for
    every non-standard_chat mode — everything else survives verbatim.
  * Strict container-evidence gate (_STRICT_CONTAINER_RX + hard coding
    override): generic words ("python", "code", "calculator", "math",
    "table", "formula") are NOT studio evidence — a plain coding request
    with zero explicit studio container nouns is always standard_chat.
  * Explicit artifact promotion (_RX_EXPLICIT_ARTIFACT, routing guard 5):
    when Stage 2 defaults to standard_chat but the message names a studio
    container in deliverable position ("generate a downloadable Excel
    file", "10-slide deck", "3D logo"), the deterministic layer promotes
    it back — the 1.2B DEFAULT-chat paragraph regresses on explicit asks,
    while high-precision patterns keep homonym chat mentions demoted.
  * Multi-turn mode policy: refinement keeps the previous turn's mode, a
    pivot to a new deliverable switches it, a pure conceptual question drops
    to standard_chat (prior mode recovered from the session cache or the
    previous assistant turn's fence language).
  * threading.Lock around llama-server calls (concurrent /decision requests
    must never corrupt the shared slot or 500 on KV overflow).
  * PID lockfiles so hot reloads reuse :8790/:8791 and never spawn duplicates.
  * Parent-PID watchdog: when spawned by the WebUI (DECISION_ENGINE_PARENT_PID)
    the worker kills its llama-server child and exits once the dev server dies,
    so stopping `npm run dev` never leaves python/llama-server holding RAM.
    An unopenable parent handle means the parent already died (spawn->watchdog
    race) — we shut down then too instead of lingering forever.
  * Startup reclaim: any llama-server already listening on LFM_PORT when we
    boot (orphaned by a worker that died uncleanly, so its watchdog never ran)
    is killed before we spawn OUR OWN child — the only llama the watchdog can
    guarantee to kill. Without this, an orphan gets adopted via the /health
    early-return, _llm_proc stays None, and it outlives every future worker.
  * CREATE_NO_WINDOW on every subprocess launch: a detached worker popping a
    console window for llama-server/tasklist/powershell is a user-facing bug.
  * Head+tail truncation of >3000-char prompts so llama-server -c 2048 never
    overflows on 8,000-char inputs.

Every weight, binary, cache and venv lives inside ./.decision-engine/.
Start:  .decision-engine/.venv/Scripts/python.exe .decision-engine/worker/decision_server.py
Serves: http://127.0.0.1:8790  POST /decision {message, conversationHistory?}
"""
import atexit
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path

DE = Path(__file__).resolve().parents[1]

# ---- Containment: force every HF/temp path inside ./.decision-engine/ ------
os.environ.setdefault("DO_NOT_TRACK", "1")
os.environ.setdefault("HF_HOME", str(DE / ".cache" / "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TMPDIR", str(DE / ".cache" / "tmp"))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schemas import (  # noqa: E402
    MODES, MODE_MAP, DecisionEnvelope, DecisionRequest, Stage2Out,
)

DECISION_PORT = int(os.environ.get("DECISION_PORT", "8790"))
LFM_PORT = int(os.environ.get("LFM_PORT", "8791"))

# ---- Lifecycle: parent watchdog + hidden subprocess windows -----------------
# lib/decision/client.ts spawns us detached with DECISION_ENGINE_PARENT_PID =
# the Next dev server's PID. When that process dies (Ctrl+C, terminal closed,
# crash) the watchdog kills our llama-server child and exits, so stopping
# `npm run dev` never leaves python/llama-server orphaned in the background.
# Manual launches (no env var) stay independent. On Windows the watchdog holds
# a SYNCHRONIZE handle to the parent: it signals when the ORIGINAL process
# exits, immune to PID reuse. CREATE_NO_WINDOW stops Windows from allocating
# a visible console for each console-subsystem child (llama-server, tasklist,
# powershell) when we ourselves run without a console.
_PARENT_PID = int(os.environ.get("DECISION_ENGINE_PARENT_PID", "0") or "0")
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    _kernel32 = ctypes.windll.kernel32
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.WaitForSingleObject.restype = wintypes.DWORD
    _kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _WAIT_OBJECT_0 = 0x00000000
    _SYNCHRONIZE = 0x00100000

# ---- Decision model: LFM2.5-1.2B via llama-server --------------------------
# Single-field CONTAINER classifier (2026-10-19): the 1.2B model only answers
# {"active_mode": ...}. standard_chat is the explicit default; studio
# containers require an explicit request. The model never strips or rewrites
# the prompt — _clean_artifact_prompt does that deterministically in Python.
LFM_SYSTEM = """Classify the user message into ONE `active_mode` based strictly on the OUTPUT CONTAINER requested.

DEFAULT ("standard_chat"):
Use "standard_chat" for ALL greetings, chat, Q&A, math, explanations, and ALL programming/coding requests (writing code, scripts, calculators, algorithms, Round Robin, functions, classes, SQL, React/HTML/CSS code snippets, debugging) in ANY language (Python, JS, TS, C++, Java, Rust, etc.) unless the user explicitly asks to generate one of the 8 studio containers below.

STUDIO CONTAINERS (pick ONLY when explicitly requested):
- "excel": Excel workbook, .xlsx file, spreadsheet, or sheet with Excel formulas (SUMIFS, VLOOKUP, INDEX/MATCH).
- "docs": Word document, .docx file, formal report/handover doc, or resume/CV.
- "pdf": Printable .pdf file or PDF invoice/receipt.
- "ppt": PowerPoint presentation, .pptx file, slide deck, or pitch deck.
- "3d_asset": 3D model, Three.js / WebGL 3D scene, or spinning 3D mesh/logo.
- "cad_blueprint": Architectural floor plan, 2D CAD drawing, building layout, or isometric anatomy cutaway.
- "chart": Standalone bar/line/pie/scatter chart or PowerBI dashboard.
- "html_render": Live interactive HTML webpage preview, landing page UI, or web widget preview.

MULTI-TURN:
If `[Previous turn artifact mode: X]` is present and the user is asking to edit/tweak that same artifact (e.g. "make it red", "spin faster", "add a column"), keep mode `X`. If the user asks a new question, asks for code, or switches deliverables, classify the new request independently.

Reply with JSON only: {"active_mode": "<mode>"}"""


# ---- Deterministic prompt cleaner (non-standard_chat modes) ----------------
# The refusal trap: prompts that demand "execute the code" + "state the
# limitation immediately" prime the main LLM to refuse. This regex layer is
# now the ONLY cleaner (the 1.2B classifier no longer strips text), so it
# guarantees the meta-clauses never reach the main LLM while every other
# word survives. Sentence-
# level deletion only: every artifact token (filename, sheet, row count,
# formula, color) survives because the patterns anchor on execution verbs.
_EXEC_LEADIN_RX = re.compile(
    r"^\s*(?:please\s+)?(?:create|write|generate|build)\s+and\s+(?:then\s+)?execute\s+"
    r"(?:a|an|the)?\s*(?:short\s+|full\s+|complete\s+)?(?:[\w+.-]+\s+)*?"
    r"(?:python|openpyxl|pandas|docx|python-docx|pptx|python-pptx|reportlab|blender|script|code|program|module)?"
    r"[\w+.,' -]{0,60}?(?:script|code|program|module)?\s*(?:using\s+[\w+.,' -]{0,60}?)?\s*(?:in order\s+)?to\b",
    re.I,
)
_EXEC_META_SENT_RXS = [
    re.compile(r"\bexecute\s+the\s+code\b[^.!?\n]*", re.I),
    re.compile(r"\b(?:run|executing|execute)\s+(?:the\s+|your\s+|all\s+)?(?:generated\s+)?(?:code|script)\b[^.!?\n]*", re.I),
    re.compile(r"\b(?:rather\s+than|instead\s+of)\s+merely\s+[^.!?\n]*", re.I),
    re.compile(r"\bif\s+(?:execution|file\s+creation|creating|you\s+cannot|such\s+a\s+capability|that\s+is\s+not\s+possible)[^.!?\n]*", re.I),
    re.compile(r"\bstate\s+the\s+limitation[^.!?\n]*", re.I),
    re.compile(r"\bdo\s+not\s+repeat\s+your\s+planning[^.!?\n]*", re.I),
    re.compile(r"\breopen\s+it\s+to\s+validat[^.!?\n]*", re.I),
    re.compile(r"\b(?:create|write|generate|build)\s+and\s+(?:then\s+)?execute\s+a\s+[^.!?\n]{0,80}?\b(?:script|code|program)\b[^.!?\n]{0,60}?\bto\b", re.I),
    re.compile(r"\busing\s+(?:openpyxl|python-docx|python-pptx|reportlab|the\s+blender\s+api|pyautogui)\b", re.I),
    re.compile(r"\b(?:by|via)\s+(?:writing|using|executing)\s+a\s+(?:python|scripting)\s+(?:script|code)\b", re.I),
]
_MODE_LABEL = {
    "excel": "Excel (.xlsx) workbook", "docs": "Word (.docx) document", "pdf": "print-ready PDF",
    "ppt": "PowerPoint (.pptx) deck", "3d_asset": "3D asset", "cad_blueprint": "CAD blueprint",
    "chart": "chart", "html_render": "HTML page",
}


def _clean_artifact_prompt(message: str, mode: str = "") -> str:
    """Deterministic, LOSSLESS prompt cleaner for artifact modes (the 1.2B
    model no longer strips anything): keeps 100% of the user's specs,
    numbers, formulas, sheet names and colors verbatim and ONLY removes
    hostile sandbox-refusal / execution-meta clauses — the "create and
    execute a Python script using openpyxl to generate" lead-in becomes a
    plain "Generate", and refusal traps ("if execution or file creation is
    unavailable, state the limitation immediately", "execute the code rather
    than merely describing or printing it", "do not repeat your planning")
    are deleted. standard_chat never reaches this: its prompt is forwarded
    100% untouched."""
    t = " ".join(message.split())
    leadin = _EXEC_LEADIN_RX.match(t)
    if leadin:
        t = t[leadin.end():].lstrip(" ,:;.-\n")
    for rx in _EXEC_META_SENT_RXS:
        t = rx.sub("", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\s+([.,;:])", r"\1", t).strip()
    if not t:
        return " ".join(message.split())  # safety: never blank out the task
    if leadin:
        m = re.match(r"([a-z])", t)
        if m:
            t = t[0].upper() + t[1:]
        elif not re.match(r"(?i)^(generate|create|build|make|produce|write|plot|design)\b", t):
            t = f"Generate downloadable {_MODE_LABEL.get(mode, 'artifact')}: {t}"
    return t


# ---- Multi-turn mode policy (deterministic refinement / pivot / question) --
_REFINE_START_RX = re.compile(
    r"^(?:please\s+|now\s+|also\s+|ok(?:ay)?[,!]?\s+)?(make|change|add|remove|delete|move|resize|recolor|"
    r"recolour|adjust|update|tweak|swap|turn|set|use|color|colour|paint|keep|rotate|spin|speed|slow|brighten|"
    r"darken|increase|decrease|fix|extend|rename|reorder|highlight|same|but|and|give)\b", re.I)
_PRONOUN_RX = re.compile(r"\b(it|this|that|these|those|them|there|again|same)\b", re.I)
_Q_START_RX = re.compile(
    r"^(?:why|what|how|when|where|which|who|explain|describe|can\s+you\s+explain|could\s+you\s+explain|tell\s+me|"
    r"difference\s+between|is\s+it|should\s+i|do\s+i)\b", re.I)
_DELIVER_VERB_RX = re.compile(
    r"\b(create|build|make|generate|write|design|produce|export|draft|plot|draw|prepare|render|emit|"
    r"give\s+me|add\s+a|turn\s+(?:it|this|that|those|these)\s+into)\b", re.I)
_MODE_ARTIFACT_RX = {
    "excel": re.compile(r"\b(excel|spreadsheet|workbook|xlsx|worksheet|tracker|ledger|budget\s+sheet|pivot\s+table)\b", re.I),
    "docs": re.compile(r"\b(document|docx|report|letter|essay|handover|memo|write-?up)\b", re.I),
    "pdf": re.compile(r"\b(pdf|invoice|receipt|print-?ready)\b", re.I),
    "ppt": re.compile(r"\b(slides?|deck|presentation|powerpoint|pptx)\b", re.I),
    "3d_asset": re.compile(r"\b(3d|model|mesh|logo|scene|blender|three\.?js|asset|spinning|emissive\w*)\b", re.I),
    "cad_blueprint": re.compile(r"\b(floor\s*plan|blueprint|cad|layout|plumbing|bim|dxf|elevation|hatch|column\s*grid|site\s*plan|unit\s*plan)\b|\d+(?:\.\d+)?\s*m\s*[x×]\s*\d+", re.I),
    "chart": re.compile(r"\b(chart|plot|graph|histogram|scatter)\b", re.I),
    "html_render": re.compile(r"\b(web\s*page|webpage|landing\s+page|page|component|widget|html|ui)\b", re.I),
}
_FENCE_TO_MODE = {}
for _m, (_sk, _f) in MODE_MAP.items():
    if _f and _f != "html":  # html fence is ambiguous (pdf vs html_render) — skip
        _FENCE_TO_MODE.setdefault(_f, _m)

_norm = lambda s: re.sub(r"\s+", " ", s or "").strip().lower()

# Bounded session cache: message -> decided mode. Lets a follow-up turn know
# the previous turn's mode even when the assistant fence is ambiguous.
_recent_modes: "OrderedDict[str, str]" = OrderedDict()
_CACHE_LOCK = threading.Lock()


def _remember(message: str, mode: str) -> None:
    key = _norm(message)
    if not key:
        return
    with _CACHE_LOCK:
        _recent_modes[key] = mode
        _recent_modes.move_to_end(key)
        while len(_recent_modes) > 256:
            _recent_modes.popitem(last=False)


def _prior_mode_from_history(history: list[dict]) -> str | None:
    """Mode of the previous deliverable turn: session cache first (exact),
    then the last assistant turn's fence language (works even when turn 1 was
    decided by another process)."""
    for h in reversed(history):
        if h.get("role") == "user":
            with _CACHE_LOCK:
                mode = _recent_modes.get(_norm(h.get("content") or ""))
            if mode:
                return mode
            # Cache miss (turn 1 was decided by another process / after a
            # worker restart): fall through to the assistant fence scan.
            break
    for h in reversed(history):
        if h.get("role") == "assistant":
            for m in re.finditer(r"```(\w+)", h.get("content") or ""):
                mode = _FENCE_TO_MODE.get(m.group(1).lower())
                if mode:
                    return mode
            break
    return None


def _artifact_modes(text: str) -> set[str]:
    return {m for m, rx in _MODE_ARTIFACT_RX.items() if rx.search(text)}


def _multi_turn_rule(message: str, prior_mode: str | None) -> str | None:
    """Deterministic override: returns the mode the multi-turn policy demands,
    or None to trust Stage 2. Order: question -> artifact pivot -> refinement."""
    if not prior_mode:
        return None
    if _Q_START_RX.match(message) and not _DELIVER_VERB_RX.search(message):
        return "standard_chat"
    if _artifact_modes(message) - {prior_mode}:
        return None  # pivot to a new deliverable: Stage 2 decides
    if len(message) <= 200 and (_REFINE_START_RX.match(message) or _PRONOUN_RX.search(message)):
        return prior_mode
    return None


# ---- Strict container-evidence gate (2026-10-19 single-field classifier) ---
# Generic words ("python", "code", "calculator", "math", "table", "formula")
# are NOT studio evidence — only explicit studio-container nouns count. The
# LOOSE _MODE_ARTIFACT_RX map stays for multi-turn refinement detection (a
# follow-up like "spin faster" legitimately carries no container noun) and
# for the chat gate; the strict map below drives the evidence switch and the
# hard coding override.
_STRICT_CONTAINER_RX = {
    "excel": re.compile(r"\b(excel|xlsx|spreadsheet|worksheet|workbook|openpyxl|sumifs|vlookup|xlookup|index/match|pivot\s+table)\b", re.I),
    "docs": re.compile(r"\b(docx|word\s+document|word\s+file|handover\s+document|formal\s+report|sign-?off\s+table|resume|cv|curriculum\s+vitae|project\s+report|offer\s+letter|letter)\b", re.I),
    "pdf": re.compile(r"\b(pdf|printable\s+invoice|printable\s+receipt|invoice\s+receipt|reportlab)\b", re.I),
    "ppt": re.compile(r"-slide|\b(pptx?|powerpoint|slide\s+deck|pitch\s+deck|slides|presentation)\b", re.I),
    "3d_asset": re.compile(r"\b(3d|three\.?js|scene3d|r3f|webgl|glb|gltf|spinning|energy\s+core|mesh|extrude|lathe|blender)\b", re.I),
    "cad_blueprint": re.compile(r"\b(cad|floor\s*plans?|floorplan|blueprint|2-?story|residential\s+plan|plumbing\s+layout|structural\s+wall|isometric\s+cutaway|anatomy|dxf|elevation)\b|\d+(?:\.\d+)?\s*m\s*[x×]\s*\d+", re.I),
    "chart": re.compile(r"\b(charts?|bar\s+chart|line\s+chart|pie\s+chart|donut\s+chart|scatter\s+plot|histogram|plot\s+a|powerbi|pbip)\b", re.I),
    "html_render": re.compile(r"\b(pricing\s+page|landing\s+page|dark\s+mode\s+toggle|html\s+component|ui\s+component|interactive\s+html|web\s+widget|webpage\s+preview)\b", re.I),
}
_RX_CODE_CUE = re.compile(r"\b(code|program|programme|script|function|class|algorithm|snippet|hook)\b", re.I)
_RX_CODE_VERB = re.compile(r"\b(write|create|give|build|make|generate|implement|provide|develop)\b", re.I)
_RX_LANG_CUE = re.compile(
    r"\b(python|javascript|typescript|java|kotlin|swift|c\+\+|c#|rust|golang|\bgo\b|sql|react|vue|angular|"
    r"node\.?js|round\s+robin|binary\s+search|dijkstra|useeffect|scientific\s+calculator|linked\s+list|"
    r"recursion|regex|bash|powershell|matlab|perl|ruby|php|scala|elixir|haskell|assembly)\b", re.I)


def _hard_coding_override(message: str) -> bool:
    """True when the turn is a plain coding request with ZERO explicit studio
    container nouns: it must be standard_chat regardless of what Stage 2 said
    ("write python code for a scientific calculator" must never reach excel)."""
    if any(rx.search(message) for rx in _STRICT_CONTAINER_RX.values()):
        return False
    return bool(_RX_CODE_CUE.search(message) and _RX_CODE_VERB.search(message)
                and _RX_LANG_CUE.search(message))


def _fallback_mode_from_evidence(message: str) -> str:
    """lfm-fail-guard resolver: when LFM2.5 fails validation on BOTH attempts,
    follow the message's OWN explicit container evidence instead of guessing —
    the earliest STRICT container-noun hit wins ("Build a 500-row transaction
    tracker with SUMIFS ..." names SUMIFS, so it resolves to excel and never
    silently drops to standard_chat). standard_chat is returned ONLY when no
    studio container noun appears anywhere in the message."""
    hits = [(m.start(), mode) for mode, rx in _STRICT_CONTAINER_RX.items()
            if (m := rx.search(message))]
    return min(hits)[1] if hits else "standard_chat"


# ---- Explicit artifact-request promotion (2026-10-19) ----------------------
# The single-field classifier's DEFAULT-standard_chat paragraph makes the 1.2B
# model regress on explicit deliverable asks ("generate a downloadable Excel
# file ..." -> standard_chat). The deterministic layer follows the MESSAGE's
# own explicit-deliverable evidence, never the model's guess. These patterns
# are deliberately HIGH PRECISION (a container noun in deliverable position:
# "downloadable Excel file", "10-slide deck", "3D logo", ".xlsx"): a bare
# homonym mention ("openpyxl internals", "3D rotation math", "slide-based
# review", "Chart.js") must never match, or chat turns get promoted into
# studio modes.
_RX_EXPLICIT_ARTIFACT = {
    "excel": re.compile(
        r"downloadable[^.!?\n]{0,30}?\b(excel|xlsx|spreadsheet|workbook)\b"
        r"|\b(excel|xlsx|spreadsheet|workbook)\b[^.!?\n]{0,15}\b(file|named|titled|sheet|sheets|rows|series)\b"
        r"|\b[\w-]*\.xlsx\b|\bxlsx\b|\bworkbook\b|\bspreadsheet\b"
        r"|invoice\s+sheet|\bsheet\s+totals\b"
        r"|\bsumifs\b|\bvlookup\b|\bxlookup\b|\btransaction\s+tracker\b", re.I),
    "docs": re.compile(
        r"downloadable[^.!?\n]{0,30}?\b(docx|word\s+document|report|document|letter|handover)\b"
        r"|\bdocx\b|\bhandover\s+document\b|\bformal\s+report\b|\bproject\s+report\b"
        r"|\bword\s+document\b|\boffer\s+letter\b|\bcv\b|\bresume\b|\bcurriculum\s+vitae\b", re.I),
    "pdf": re.compile(
        r"downloadable[^.!?\n]{0,30}?\bpdf\b|\bprintable\s+(pdf|invoice|receipt)\b"
        r"|\b[\w-]*\.pdf\b|\bpdf\b|\breportlab\b", re.I),
    "ppt": re.compile(
        r"\b\d+[- ]slides?\b|\bpptx?\b|\bslide\s+deck\b|\bpitch\s+deck\b|\bpowerpoint\b"
        r"|\bslides\b|\bpresentation\b", re.I),
    "3d_asset": re.compile(
        r"\bspinning\b|\benergy\s+core\b|\bblender\b|\bthree\.?js\b|\bscene3d\b|\bglb\b|\bgltf\b"
        r"|\b3d\b[^.!?\n]{0,15}\b(model|logo|asset|scene|print|printing|render)\b"
        r"|downloadable[^.!?\n]{0,30}?\b(3d|model|asset)\b", re.I),
    "cad_blueprint": re.compile(
        r"\bcad\b|\bfloor\s*plans?\b|\bfloorplan\b|\bblueprint\b|\bdxf\b|\belevation\b"
        r"|\b2-?story\b|\bresidential\s+plan\b|\bplumbing\s+layout\b|\bstructural\s+wall\b"
        r"|\bisometric\s+cutaway\b|\d+(?:\.\d+)?\s*m\s*[x×]\s*\d+", re.I),
    "chart": re.compile(
        r"\b(bar|line|pie|donut|scatter|stacked|area|waterfall|revenue|small)\s+(chart|graph)s?\b"
        r"|\bhistogram\b|\bscatter\s+plot\b|\bplot\b[^.!?\n]{0,20}\bchart\b", re.I),
    "html_render": re.compile(
        r"\bpricing\s+page\b|\blanding\s+page\b|\bdark\s+mode\s+toggle\b|\binteractive\s+html\b"
        r"|\bhtml\s+component\b|\bui\s+component\b|\bweb\s+widget\b|\bwebpage\s+preview\b", re.I),
}


# ---- Deterministic post-decision routing guards ----------------------------
# The 1.2B router keeps failing homonym traps (greedy decoding is lexical,
# not semantic). These guards follow the MESSAGE's own artifact evidence,
# never the model's guess. Silent: they change active_mode only —
# decided_by stays "lfm2.5" (audit trail via the printed log line).
_RX_SHEET_EVIDENCE = re.compile(r"\b(sheet|workbook|spreadsheet|columns|rows|totals)\b", re.I)


def _routing_guards(message: str, active_mode: str, prior_mode: str | None) -> str | None:
    """Returns the mode the message's own evidence demands, or None to trust
    Stage 2. Order: question gate -> chat gate -> evidence switch -> sheet-
    beats-invoice homonym -> explicit artifact promotion (chat -> studio)."""
    # (1) A pure question with no deliverable verb is conversation, whatever
    # artifact nouns it happens to mention ("how does Chart.js work?").
    if _Q_START_RX.match(message) and not _DELIVER_VERB_RX.search(message):
        return "standard_chat"
    # (2) Nothing artifact-shaped in the turn at all (debug help, comparisons,
    # parsing an uploaded file) -> chat. A refinement of a previous artifact
    # (prior_mode) legitimately carries no artifact noun.
    if active_mode != "standard_chat" and not prior_mode and not _artifact_modes(message):
        return "standard_chat"
    # (3) Evidence switch: the chosen mode's STRICT container noun never
    # appears in the message but other modes' do — follow the message,
    # earliest match wins ("python code for a calculator" carries no studio
    # noun at all, so a wrong excel guess finds no hits and the coding
    # override above already forced standard_chat).
    if active_mode != "standard_chat" and not _STRICT_CONTAINER_RX[active_mode].search(message):
        hits = [(m.start(), mode) for mode, rx in _STRICT_CONTAINER_RX.items()
                if mode != active_mode and (m := rx.search(message))]
        if hits:
            return min(hits)[1]
    # (4) "invoice sheet whose totals show $X" is a spreadsheet, not a
    # printable invoice: tabular evidence outranks the pdf homonym.
    if active_mode == "pdf" and _RX_SHEET_EVIDENCE.search(message):
        return "excel"
    # (5) Promotion: the router defaulted to standard_chat but the message
    # explicitly requests a studio deliverable in deliverable position
    # ("generate a downloadable Excel file ...", "10-slide deck"). The
    # single-field classifier's DEFAULT-chat paragraph regresses on these;
    # the explicit-artifact patterns are high-precision so homonym chat
    # mentions never promote. Earliest explicit hit wins.
    if active_mode == "standard_chat":
        hits = [(m.start(), mode) for mode, rx in _RX_EXPLICIT_ARTIFACT.items()
                if (m := rx.search(message))]
        if hits:
            return min(hits)[1]
    return None


_llm_proc: subprocess.Popen | None = None
_LFM_LOCK = threading.Lock()      # llama-server :8791 runs one slot at -c 2048


def _llama_binary() -> Path:
    exe = "llama-server.exe" if os.name == "nt" else "llama-server"
    p = DE / "bin" / exe
    if not p.exists():
        raise RuntimeError(f"llama-server missing at {p} — run setup-engine first")
    return p


def _gguf_path() -> Path:
    matches = sorted((DE / "models" / "lfm2.5").glob("*Q4_K_M.gguf"))
    if not matches:
        raise RuntimeError("LFM2.5 Q4_K_M GGUF missing — run setup-engine first")
    return matches[0]


def _health(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                                 capture_output=True, text=True, timeout=5,
                                 creationflags=_NO_WINDOW).stdout
            return str(pid) in out
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _read_pid(path: Path) -> int:
    try:
        return int(path.read_text().strip())
    except Exception:
        return -1


def _write_pid(path: Path, pid: int | None = None) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(pid if pid is not None else os.getpid()))
    except Exception:
        pass


def _guard_single_instance() -> None:
    """PID lockfile: if another live worker already answers on :8790, exit 0 —
    Next dev hot-reloads must never stack duplicate workers."""
    pidfile = DE / ".cache" / "decision_server.pid"
    other = _read_pid(pidfile)
    if other not in (-1, os.getpid()) and _pid_alive(other) and _health(DECISION_PORT):
        print(f"[decision-engine] another worker (pid {other}) owns :{DECISION_PORT} — exiting", flush=True)
        sys.exit(0)
    _write_pid(pidfile)


def _kill_port_holder(port: int) -> None:
    """Force-kill every process LISTENING on 127.0.0.1:port. Used ONLY to
    reclaim our own contained engine port (LFM_PORT) from an orphaned
    llama-server — never for foreign backends like Strata on :8080."""
    if os.name != "nt":
        return
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                             text=True, timeout=10, creationflags=_NO_WINDOW).stdout
        pids = set()
        for line in out.splitlines():
            parts = line.split()
            # TCP  127.0.0.1:8791  0.0.0.0:0  LISTENING  <pid>
            if (len(parts) >= 5 and parts[0].upper() == "TCP"
                    and parts[1].endswith(f":{port}") and parts[3].upper() == "LISTENING"):
                pids.add(int(parts[4]))
        for pid in pids:
            if pid != os.getpid():
                subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                               capture_output=True, timeout=10, creationflags=_NO_WINDOW)
    except Exception:
        pass


def _reclaim_orphan_llama() -> None:
    """Run right after _guard_single_instance(): we are the only live worker,
    so any llama-server already answering on LFM_PORT is NOT ours — an orphan
    from a worker that died uncleanly (watchdog never ran) or a stale manual
    launch. ensure_llama_server() would ADOPT it via the /health early-return,
    leaving _llm_proc None so _shutdown_llama() is a no-op forever: the orphan
    would outlive every future worker and every watchdog. Kill it; the llama we
    spawn next is OUR child and therefore always killable by our watchdog."""
    if not _health(LFM_PORT):
        return
    _kill_port_holder(LFM_PORT)
    for _ in range(10):  # port must actually free before we bind it again
        if not _health(LFM_PORT):
            break
        time.sleep(0.5)
    pidfile = DE / ".cache" / "llama_server.pid"
    try:
        if pidfile.exists():
            pidfile.unlink()
    except Exception:
        pass
    print(f"[decision-engine] reclaimed orphaned llama-server on :{LFM_PORT}", flush=True)


def _thread_count() -> int:
    """Physical core count (llama.cpp wants physical, not logical, threads)."""
    env = os.environ.get("LFM_THREADS")
    if env:
        return max(1, int(env))
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).NumberOfCores"],
            capture_output=True, text=True, timeout=10,
            creationflags=_NO_WINDOW).stdout
        cores = int(out.strip())
        if cores >= 1:
            return cores
    except Exception:
        pass
    return max(1, min(6, os.cpu_count() or 4))


def ensure_llama_server() -> None:
    """Start the contained llama-server subprocess unless one is already warm.
    The bundled binary is CPU-only (`--list-devices` reports none), so -ngl 0
    stands; context is 2048 (decision prompt + truncated history + a 3,000-char
    head/tail-truncated message ~= 1,900 tokens) with small batches + no warmup
    to cut RSS. PID lockfile: if another process is mid-spawn we WAIT on
    health instead of racing it onto :8791."""
    global _llm_proc
    if _health(LFM_PORT):
        return
    with _LFM_LOCK:
        if _health(LFM_PORT):
            return
        pidfile = DE / ".cache" / "llama_server.pid"
        other = _read_pid(pidfile)
        if other not in (-1, os.getpid()) and _pid_alive(other):
            for _ in range(120):  # someone else is starting it — reuse, never duplicate
                if _health(LFM_PORT):
                    return
                time.sleep(1)
            raise RuntimeError("llama-server (foreign pid) failed to become healthy within 120s")
        _llm_proc = subprocess.Popen(
            [str(_llama_binary()), "-m", str(_gguf_path()),
             "--host", "127.0.0.1", "--port", str(LFM_PORT),
             "-c", "2048", "-ngl", "0", "-t", str(_thread_count()),
             "--batch-size", "512", "--ubatch-size", "512", "--no-warmup", "--no-webui"],
            cwd=str(DE / ".cache" / "tmp"),  # never run from inside the extracted bin dir
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,  # no console window popped for llama-server
        )
        _write_pid(pidfile, _llm_proc.pid)  # the LLAMA pid, not ours — ownership must be truthful
        for _ in range(120):
            if _health(LFM_PORT):
                return
            time.sleep(1)
        raise RuntimeError("llama-server failed to become healthy within 120s")


def _shutdown_llama() -> None:
    """Terminate the llama-server child WE spawned (never a reused foreign one)."""
    proc = _llm_proc
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def _parent_watchdog() -> None:
    """Exit once the spawning WebUI dev-server PID dies (see _PARENT_PID).
    This is the ONLY teardown path for a detached spawn: closing the terminal
    or crashing the dev server sends no signal to us, so polling the parent is
    what keeps `npm run dev` stopped == engine stopped. os._exit is fine here:
    uvicorn is single-threaded on the main thread and no request state needs
    flushing; llama-server is terminated first so nothing outlives us."""
    handle = None
    if os.name == "nt":
        handle = _kernel32.OpenProcess(_SYNCHRONIZE, False, _PARENT_PID)
        if not handle:
            # We were spawned BY that PID (manual spawns have _PARENT_PID 0 and
            # never reach this thread), so an unopenable handle means the
            # parent already exited before the watchdog started (spawn->watchdog
            # race). Lingering "just in case" is exactly the orphan bug users
            # hit: dev server stopped but python stays up. Shut down instead.
            print(f"[decision-engine] parent pid {_PARENT_PID} already gone — shutting down", flush=True)
            _shutdown_llama()
            os._exit(0)
    while True:
        if os.name == "nt":
            # Blocking wait with 1s tick: fires within ~1s of the parent dying.
            if _kernel32.WaitForSingleObject(handle, 1000) == _WAIT_OBJECT_0:
                break
        else:
            try:
                os.kill(_PARENT_PID, 0)
            except OSError:
                break
            time.sleep(1)
    print(f"[decision-engine] parent pid {_PARENT_PID} exited — shutting down", flush=True)
    _shutdown_llama()
    try:
        pidfile = DE / ".cache" / "decision_server.pid"
        if _read_pid(pidfile) == os.getpid():
            pidfile.unlink()
    except Exception:
        pass
    os._exit(0)


def _lfm_call(msgs: list[dict]) -> str:
    """One llama-server completion, grammar-constrained to the Stage2Out schema."""
    body = json.dumps({
        # Fully deterministic: identical prompts must yield identical mode +
        # confidence across runs (0.92-vs-0.23 drift seen before this fix).
        "messages": msgs, "max_tokens": 24, "temperature": 0.0,
        "top_k": 1, "top_p": 1.0, "seed": 42,
        # Grammar-constrained to the single-field Stage2Out schema: only
        # {"active_mode": "<one of 9 literals>"} is decodable — ~5 tokens,
        # sub-second CPU decode, no room to echo or rewrite anything.
        "response_format": {"type": "json_object", "schema": Stage2Out.model_json_schema()},
    }).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{LFM_PORT}/v1/chat/completions",
        data=body, headers={"Content-Type": "application/json"})
    with _LFM_LOCK:
        with urllib.request.urlopen(req, timeout=90) as r:
            j = json.loads(r.read())
    return j["choices"][0]["message"]["content"]


def _salvage_stage2(raw: str) -> Stage2Out | None:
    """Recover the mode from a truncated/garbled single-field reply: the
    grammar emits {"active_mode": "<mode>"} first, so even a cut-off object
    still carries the routing decision."""
    try:
        m = re.search(r'"active_mode"\s*:\s*"([a-z_]+)"', raw)
        if m and m.group(1) in MODES:
            return Stage2Out(active_mode=m.group(1))
        return None
    except Exception:
        return None


def lfm_decide(message: str, history: list[dict], prev_mode: str | None,
               trace: dict | None = None) -> Stage2Out:
    """The raw user message reaches LFM2.5 UNTOUCHED. The only addition is an
    optional one-line "[Previous turn artifact mode: X]" prefix when the
    previous assistant turn produced an artifact, so the MULTI-TURN rule in
    LFM_SYSTEM can keep the mode on refinement turns. One self-correction
    retry on invalid output; raises after the 2nd failure — the caller then
    runs the deterministic _fallback_mode_from_evidence guard."""
    msgs = [{"role": "system", "content": LFM_SYSTEM}]
    for h in history[-4:]:
        role = h.get("role")
        content = (h.get("content") or "")[:300]
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    prefix = f"[Previous turn artifact mode: {prev_mode}]\n" if prev_mode else ""
    msgs.append({"role": "user", "content": prefix + message})
    # Diagnostics for the WebUI decision table: the exact input the gate saw
    # and the raw grammar JSON it produced (kept even when parsing failed —
    # that is precisely when it is most useful).
    if trace is not None:
        trace["input"] = msgs[-1]["content"]
    for attempt in (0, 1):
        raw = _lfm_call(msgs)
        if trace is not None:
            trace["raw"] = raw
        try:
            return Stage2Out(**json.loads(raw))
        except Exception as err:
            if attempt == 1:
                salvaged = _salvage_stage2(raw)
                if salvaged is not None:
                    print(f"[decision] salvaged truncated Stage-2 JSON -> {salvaged.active_mode}", flush=True)
                    return salvaged
                raise
            msgs = msgs + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": f"Invalid output ({err}). "
                 "Reply with ONLY one valid JSON object matching the schema."},
            ]
    raise RuntimeError("unreachable")


# Head+tail truncation: an 8,000-char prompt must never overflow the 2048-
# token llama-server slot (system ~450 + history ~450 + message ~1,100 +
# 24 output < 2048). The head carries the task framing, the tail the closing
# constraints, so both survive; middle boilerplate is cut.
MAX_LFM_CHARS = 2_600
_HEAD_CHARS = 1_900
_TAIL_CHARS = 700


def _truncate_for_engine(message: str) -> str:
    if len(message) <= MAX_LFM_CHARS:
        return message
    return (message[:_HEAD_CHARS] + "\n […middle truncated…] \n" + message[-_TAIL_CHARS:])


def warm() -> None:
    ensure_llama_server()
    print(f"[decision-engine] warm: lfm2.5 on :{LFM_PORT}, worker on :{DECISION_PORT}", flush=True)


def _cool() -> None:
    # Graceful uvicorn stop (e.g. Ctrl+C on a manual terminal launch): never
    # leave our llama-server child behind.
    _shutdown_llama()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """FastAPI lifespan context manager — replaces the deprecated
    @app.on_event("startup")/("shutdown") hooks so `npm run dev` boots and
    stops with zero DeprecationWarning."""
    warm()
    try:
        yield
    finally:
        _cool()


app = FastAPI(title="WebUI Decision Engine", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": _health(LFM_PORT), "lfm": _health(LFM_PORT)}


@app.post("/decision")
def decision(req: DecisionRequest) -> DecisionEnvelope:
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "empty message")
    message = _truncate_for_engine(message)

    # ---- LFM2.5-1.2B classifies the output container (single field) ----
    # The prompt is cleaned deterministically, NEVER by the model:
    # standard_chat forwards the user's message 100% untouched; artifact
    # modes run it through _clean_artifact_prompt (refusal traps only).
    prior_turn_mode = _prior_mode_from_history(req.conversationHistory)
    ensure_llama_server()
    t1 = time.perf_counter()
    lfm_trace: dict = {}
    try:
        s2 = lfm_decide(message, req.conversationHistory, prior_turn_mode, lfm_trace)
        lfm_ms = round((time.perf_counter() - t1) * 1000, 1)
        active_mode, conf, decided_by = s2.active_mode, 0.95, "lfm2.5"
        stripped = (" ".join(message.split()) if active_mode == "standard_chat"
                    else _clean_artifact_prompt(message, active_mode))
    except Exception as err:
        # 2-strike LFM failure (original + 1 self-correction retry both
        # invalid): NEVER silently drop to standard_chat — resolve the mode
        # from the message's own container evidence and keep the RAW prompt.
        lfm_ms = round((time.perf_counter() - t1) * 1000, 1)
        active_mode = _fallback_mode_from_evidence(message)
        conf = 0.0 if active_mode == "standard_chat" else 0.5
        decided_by = "lfm-fail-guard"
        stripped = (" ".join(message.split()) if active_mode == "standard_chat"
                    else _clean_artifact_prompt(message, active_mode))
        print(f"[decision] LFM2.5 failed after retry: {err} — evidence guard -> {active_mode}", flush=True)
    # The classifier no longer emits constraints — the deterministic cleaner
    # is lossless, so the main LLM always receives the user's full spec set.
    constraints: list[str] = []
    cleaned_for = active_mode  # mode `stripped` was computed under

    # ---- Hard coding override: plain code request, zero container nouns ----
    if active_mode != "standard_chat" and _hard_coding_override(message):
        print(f"[decision] coding override: {active_mode} -> standard_chat "
              f"(no studio container noun in message)", flush=True)
        active_mode = "standard_chat"

    # ---- Deterministic routing guards (message evidence outranks Stage 2) ----
    guard_mode = _routing_guards(message, active_mode, prior_turn_mode)
    if guard_mode and guard_mode != active_mode:
        print(f"[decision] routing guard: {active_mode} -> {guard_mode} "
              f"(message-evidence override, by={decided_by})", flush=True)
        active_mode = guard_mode

    # ---- Multi-turn policy: refinement keeps, pivot switches, question drops ----
    rule_mode = _multi_turn_rule(message, prior_turn_mode)
    if rule_mode and rule_mode != active_mode:
        print(f"[decision] multi-turn override: {active_mode} -> {rule_mode} "
              f"(prior turn mode={prior_turn_mode})", flush=True)
        active_mode, decided_by = rule_mode, decided_by + "+multi-turn"

    # A guard/override that flipped the mode also flips the cleaning policy:
    # chat forwards verbatim, studio modes get the refusal-trap cleaner.
    if active_mode != cleaned_for:
        stripped = (" ".join(message.split()) if active_mode == "standard_chat"
                    else _clean_artifact_prompt(message, active_mode))

    # ---- Trivial-chat passthrough (deterministic) ----
    # Guarantees greetings/one-liners reach the main LLM verbatim even on the
    # lfm-fail fallback path (the old 1.2B stripper hallucinated "Generate
    # downloadable <artifact>..." boilerplate for "Hi", sending the main LLM
    # into an endless generation loop — 600KB of reasoning, stream never
    # closed). A one-liner has nothing to clean anyway.
    if active_mode == "standard_chat" and len(message) < 120:
        stripped, constraints = message, []

    _remember(message, active_mode)

    skill, fence = MODE_MAP[active_mode]
    env = DecisionEnvelope(
        active_mode=active_mode,
        confidence=round(conf, 3),
        decided_by=decided_by,
        stripped_prompt=stripped,
        skill_to_load=skill,
        allowed_code_fence=fence,
        disable_validators=[m for m in MODES if m != active_mode],
        enable_validator=active_mode,
        task_constraints=constraints,
        lfm_latency_ms=lfm_ms,
        lfm_input=lfm_trace.get("input"),
        lfm_raw=lfm_trace.get("raw"),
    )
    # The per-turn [decision] summary line is replaced by the WebUI's pino
    # decision table (lib/server/decision-log.ts): mode, conf, latency and
    # the raw LFM JSON in one readable block. The exception
    # prints above (routing guard, multi-turn override, salvage, LFM failure)
    # stay — they are the signal, not the routine noise.
    return env


if __name__ == "__main__":
    _guard_single_instance()
    _reclaim_orphan_llama()  # any live :8791 llama now is OURS to spawn and kill
    atexit.register(_shutdown_llama)  # covers manual Ctrl+C / clean uvicorn exits
    if _PARENT_PID > 0:
        threading.Thread(target=_parent_watchdog, daemon=True).start()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=DECISION_PORT, log_level="warning")
