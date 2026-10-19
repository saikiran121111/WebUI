"""
Hybrid Decision Engine worker (100% project-local).

Stage 1 — Needle 3 (resident, grammar-constrained tool call): fast mode prior
with a calibrated confidence head. Stage 2 — LFM2.5-1.2B-Instruct via the
contained llama-server subprocess: ALWAYS runs on every non-empty
request, receives the raw prompt + Needle's prior, makes the final mode
decision and generates the stripped_prompt (schema-constrained JSON).
There is NO rule-based text stripping and NO silent drop to standard_chat:
if LFM fails after one self-correction retry, the envelope falls back to
Needle 3's top prior mode with the raw prompt.

Deterministic safety layers on top of the models (2026-10-19 execution-bridge
patch):
  * Target-Deliverable Routing Rule in both system prompts (script-phrasing
    traps like "execute a Python/openpyxl script to build an xlsx" route to
    the artifact's mode, never standard_chat).
  * _strip_execution_meta(): post-filter that deletes hostile meta-clauses
    ("if execution or file creation is unavailable, state the limitation
    immediately") from stripped_prompt for every non-standard_chat mode.
  * Multi-turn mode policy: refinement keeps the previous turn's mode, a
    pivot to a new deliverable switches it, a pure conceptual question drops
    to standard_chat (prior mode recovered from the session cache or the
    previous assistant turn's fence language).
  * _preserve_hard_tokens(): append-only lossless hard-token guard.
  * threading.Lock around Needle + llama-server calls (concurrent /decision
    requests must never corrupt the shared slot or 500 on KV overflow).
  * PID lockfiles so hot reloads reuse :8790/:8791 and never spawn duplicates.
  * Parent-PID watchdog: when spawned by the WebUI (DECISION_ENGINE_PARENT_PID)
    the worker kills its llama-server child and exits once the dev server dies,
    so stopping `npm run dev` never leaves python/llama-server holding RAM.
  * CREATE_NO_WINDOW on every subprocess launch: a detached worker popping a
    console window for llama-server/tasklist/powershell is a user-facing bug.
  * Head+tail truncation of >3000-char prompts so llama-server -c 2048 never
    overflows on 8,000-char inputs.

Every weight, binary, cache and venv lives inside ./.decision-engine/.
Start:  .decision-engine/.venv/Scripts/python.exe .decision-engine/worker/decision_server.py
Serves: http://127.0.0.1:8790  POST /decision {message, conversationHistory?}
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from collections import OrderedDict
from pathlib import Path

DE = Path(__file__).resolve().parents[1]

# ---- Containment: force every Needle/HF path inside ./.decision-engine/ ----
os.environ.setdefault("NEEDLE3_LIB_PATH", str(DE / ".cache" / "needle-engine" / "libneedle.dll"))
os.environ.setdefault("NEEDLE_WHISTLE_WEIGHTS", str(DE / "models" / "whistle" / "whistle.cact"))
os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("DO_NOT_TRACK", "1")
os.environ.setdefault("HF_HOME", str(DE / ".cache" / "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TMPDIR", str(DE / ".cache" / "tmp"))

import needle  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schemas import (  # noqa: E402
    MODES, MODE_MAP, DecisionEnvelope, DecisionRequest, Stage2Out,
)
from stripper import strip_prompt  # noqa: E402

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

# ---- Stage 1: Needle 3 ----------------------------------------------------
CLASSIFY_SYSTEM = (
    "Route the request's PRIMARY deliverable by calling exactly one route_* tool.\n"
    "Route by the DELIVERABLE the user wants, never by the tools/languages they "
    "mention: 'execute a Python/openpyxl script to build an xlsx' is still excel.\n"
    "standard_chat only when nothing new is produced: reading/parsing an existing "
    "file, or a conceptual question.\n"
    "excel: spreadsheet/workbook/rows/formulas/SUMIFS/tracker/budget/ledger/KPI over tabular data.\n"
    "docs: document/report/letter/handover/essay. pdf: printable invoice/receipt/export.\n"
    "ppt: slide deck/presentation. 3d_asset: 3D model/logo/mesh/animated object.\n"
    "cad_blueprint: floor plan/building layout/wall dimensions/plumbing/BIM.\n"
    "chart: plot data (bar/line/pie). html_render: web page/component/UI.\n"
    "standard_chat: question/explanation/debugging, nothing to render."
)


# Needle 3 is a multi-tool router: one crisp tool per RendererMode. The tool
# Needle picks IS the prior; the route_* name maps back to the mode by prefix.
# Each tool carries a required `task` parameter (the one-line deliverable) so
# the grammar forces an explicit slot fill, and its docstring lists distinct
# trigger keywords — overlapping vocabulary made Needle collapse modes before.
def route_excel(task: str) -> None:
    """Pick when a NEW spreadsheet, workbook, xlsx, tracker or ledger over rows of data is to be built: formulas, SUMIFS, budget, KPI dashboard, 500-row table, an invoice sheet. A finance question (NPV/IRR math) or reading an existing CSV is standard_chat, not excel."""
def route_docs(task: str) -> None:
    """Pick when the deliverable is a written document, docx, report, letter, offer letter, handover, essay, memo or sign-off doc. A git commit message or text answer is standard_chat, not docs."""
def route_pdf(task: str) -> None:
    """Pick when the deliverable is a printable or exportable file: pdf, printable invoice, receipt, print-ready document. A sheet with totals is excel; an offer letter is docs; a drawing with scale/hatch is cad_blueprint."""
def route_ppt(task: str) -> None:
    """Pick only when the user explicitly asks for slides, a slide deck, a presentation, powerpoint or pptx."""
def route_3d_asset(task: str) -> None:
    """Pick when the deliverable is a 3D model, logo, mesh, animated or spinning object, 3D scene, Blender or Three.js asset."""
def route_cad_blueprint(task: str) -> None:
    """Pick when the deliverable is an architectural floor plan, building layout, wall dimensions, elevation, scale (1:100), hatch, column grid, plumbing, BIM, dxf or CAD blueprint — even if it will later be 3D-printed."""
def route_chart(task: str) -> None:
    """Pick when the deliverable is a plot of data: bar chart, line chart, pie chart, graph, histogram or scatter plot."""
def route_html_render(task: str) -> None:
    """Pick only when the user asks to BUILD a web page, webpage, landing page, html page, component, widget or UI."""
def route_standard_chat(task: str) -> None:
    """Pick when the turn is a question, explanation, debugging help, comparison, advice/tips or parsing an existing file, with nothing new to render — even when it mentions spreadsheets, charts, slides, invoices, CSS or scripts."""

ROUTE_TOOLS = [route_excel, route_docs, route_pdf, route_ppt, route_3d_asset,
               route_cad_blueprint, route_chart, route_html_render, route_standard_chat]
TOOL_TO_MODE = {fn.__name__: fn.__name__[len("route_"):] for fn in ROUTE_TOOLS}


# ---- Stage 2: LFM2.5-1.2B via llama-server --------------------------------
LFM_SYSTEM = (
    "You are the Decision Engine of a local AI WebUI. Decide the single renderer mode for the user's request, then strip the prompt.\n"
    "Modes: excel (spreadsheet/workbook/rows/formulas/SUMIFS/tracker/budget/KPI dashboard), "
    "docs (written document/report/letter/handover/sign-off), "
    "pdf (printable invoice/receipt or an export-for-print document — an invoice is pdf, never docs), "
    "ppt (slide deck/presentation/pitch deck/slides), "
    "3d_asset (3D model/logo/mesh/spinning or animated object/3D scene), "
    "cad_blueprint (architectural floor plan/building layout/wall dimensions/plumbing/BIM), "
    "chart (plot data: bar/line/pie/scatter), html_render (web page/component/UI/landing page/dark mode), "
    "standard_chat (question/explanation/advice, nothing to render).\n"
    "Rules: financial/tabular words (rows, SUMIFS, tracker, budget, KPI) mean excel even if other words appear. "
    "A tracker/ledger/log over rows of data is a SPREADSHEET (excel), never a 'document' (docs); "
    "docs is for prose (reports, letters, essays). "
    "A request to plot/graph/visualize data is chart, even if other words hint at slides or reports. "
    "ppt requires the user to explicitly ask for slides, a deck or a presentation; a lone chart request is never ppt. "
    "A question asking why/how/explain/debug is standard_chat even when it mentions React, UI or code — there is no artifact to build. "
    "Mentioning a framework or technology does NOT mean html_render; html_render requires the user asks you to BUILD a page or component. "
    "If the user asks to CREATE/GENERATE a new downloadable file or artifact (.xlsx/.docx/.pdf/.pptx/3D model/floor plan/chart/web page), it is that file's mode even when phrased as 'write and execute a Python/openpyxl/python-docx/reportlab/python-pptx/Blender script'; but why/how/explain questions and reading existing files stay standard_chat. A request to BUILD/create a spreadsheet, workbook or budget sheet is excel even if the same sentence also asks to explain something in a notes column.\n"
    "MULTI-TURN: if this turn refines a previous artifact (short instruction, pronouns, make/change/add/recolor verbs), keep the previous mode; if the user pivots to a new deliverable, switch; a pure question about it is standard_chat.\n"
    "EXECUTION-META REMOVAL: delete clauses about how to produce the file ('create and execute a Python script using openpyxl to', 'execute the code rather than merely describing it', 'if execution is unavailable state the limitation', 'reopen it to validate') and rewrite the lead-in to 'Generate downloadable <artifact>...', keeping every filename, sheet name, row count, column, formula, chart and color VERBATIM.\n"
    "Stripping is LOSSLESS NOISE REMOVAL, never summarization: keep the full task sentence with its main verb and "
    "deliverable noun, and keep 100% of numbers, prices, hex colors, column names, formulas, dimensions and "
    "technical specs VERBATIM. ONLY remove conversational fluff (e.g. 'hey can you please') and conflicting "
    "secondary renderer triggers. Build stripped_prompt only from the user's own words, e.g. "
    "\"<user request with only conflicting mode triggers removed>\"; never answer with a fragment. "
    "task_constraints: ONLY the hard specs you had to drop from stripped_prompt — usually []; max 5 items, <=6 words each. "
    "Example: 'Plot a bar chart comparing <a metric>' -> chart. "
    "Example: 'Explain why <a coding behavior> happens' -> standard_chat. "
    "Example: 'Make a <N>-slide deck about <a topic>' -> ppt, not pdf. "
    "Example: 'Create a spinning <an animated 3D object>' -> 3d_asset, not pdf. "
    "CONTRASTS (artifact vocabulary alone never sets an artifact mode): "
    "the math behind NPV/IRR -> standard_chat, not excel; "
    "anatomy of a TCP packet header -> standard_chat, not docs; "
    "microservices vs monolith, compare -> standard_chat, not excel; "
    "write a git commit message -> standard_chat, not docs; "
    "speaking tips for a slide review -> standard_chat, not ppt; "
    "how Chart.js picks tick intervals -> standard_chat, not chart; "
    "Excel workbook vs PDF report, which is better -> standard_chat, not pdf; "
    "Blender script generating a low-poly crate -> 3d_asset; "
    "CAD floor plan to be 3D-printed later -> cad_blueprint, not 3d_asset; "
    "invoice sheet whose totals show $4,890.75 -> excel, not pdf; "
    "build an Excel budget sheet that explains a topic in a notes column -> excel, not docs; "
    "salary figure in the offer letter -> docs, not pdf; "
    "elevation at 1:100 scale with #FF0000 hatch -> cad_blueprint, not pdf; "
    "18.5m x 12.25m retail unit plan with column grid -> cad_blueprint, not pdf; "
    "after a deck turn, 'just plot the Q4 numbers as a bar chart' -> chart. "
    "A PRIOR section at the end of the user message is a GUESS from a WEAKER classifier — it is "
    "wrong more often than right and the correct mode is usually NOT among its candidates. Decide "
    "ONLY from the user's request: if the candidates contradict the request, ignore them completely. "
    "NEVER copy the prior's mode, and NEVER copy its reliability label as your confidence — report your own. "
    'Reply with ONLY one JSON object: {"active_mode":"<one mode>","confidence":<0..1>,'
    '"stripped_prompt":"<user request with only noise removed>","task_constraints":["<dropped specs only, usually none>"]}'
)


# ---- Deterministic hard-token preservation guard --------------------------
# Appends (never removes) any numeric/currency/hex/quoted/capitalized-identifier
# token from the RAW user message that LFM2.5 dropped from stripped_prompt, so
# detail preservation is 100% lossless regardless of model behavior.
_RX_CURRENCY = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?")
_RX_HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
_RX_NUM = re.compile(r"(?<![\w$#.,])\d[\d,]*(?:\.\d+)?")
_RX_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9]{1,}\b")
_RX_QUOTED = re.compile("[\"'“]([^\"'”\n]{2,40})[\"'”]")
_RX_CAPIDENT = re.compile(r"\b[A-Z][a-z]{2,}\b")


def _hard_tokens(text: str) -> list[str]:
    toks: list[str] = []
    toks += _RX_CURRENCY.findall(text)
    toks += _RX_HEX.findall(text)
    toks += _RX_QUOTED.findall(text)
    toks += _RX_ACRONYM.findall(text)
    for m in _RX_CAPIDENT.finditer(text):
        prev = text[:m.start()].rstrip()
        if not prev or prev[-1] in ".!?\n":
            continue  # sentence-initial capitalization is not an identifier
        # After ":" or ";" the next capitalized word IS an identifier — it is a
        # list item ("sheets: Dashboard, Transactions..."), not a sentence start.
        toks.append(m.group(0))
    toks += _RX_NUM.findall(text)
    return list(dict.fromkeys(t.strip() for t in toks if t.strip()))


def _preserve_hard_tokens(raw: str, stripped: str, coverage: str = "",
                          extra: list[str] | None = None) -> str:
    # task_constraints are forwarded to the main LLM by route.ts, so a token
    # already covered there does not need re-appending to stripped_prompt.
    # `extra` carries the active mode's artifact nouns found in the raw
    # message ("crate asset" -> "asset") — the deliverable noun itself must
    # survive the strip even when it is a plain lowercase word.
    seen = (stripped + " " + coverage).lower()
    toks = list(dict.fromkeys(_hard_tokens(raw) + [t.strip() for t in (extra or []) if t.strip()]))
    missing = [t for t in toks if t.lower() not in seen]
    if not missing:
        return stripped
    return f"{stripped}  Required Specs: [{', '.join(missing[:24])}]"


# ---- Execution-meta post-filter (deterministic, non-standard_chat modes) ---
# The refusal trap: prompts that demand "execute the code" + "state the
# limitation immediately" prime the main LLM to refuse. LFM2.5 removes most of
# it, but a 1.2B model is not reliable enough to be the ONLY defense — this
# regex layer guarantees the meta-clauses never reach the main LLM. Sentence-
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


def _strip_execution_meta(message: str, mode: str, stripped: str) -> str:
    """Delete execution meta-clauses from `stripped`; rewrite the lead-in to a
    'Generate downloadable <artifact>' verb. standard_chat is untouched."""
    if mode == "standard_chat":
        return stripped
    t = stripped
    leadin = _EXEC_LEADIN_RX.match(t)
    if leadin:
        t = t[leadin.end():].lstrip(" ,:;.-\n")
    for rx in _EXEC_META_SENT_RXS:
        t = rx.sub("", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\s+([.,;:])", r"\1", t).strip()
    if not t:
        return stripped  # safety: never blank out the task
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


# ---- Deterministic post-decision routing guards ----------------------------
# The 1.2B Stage-2 model keeps failing homonym traps even with contrast
# few-shots (greedy decoding is lexical, not semantic). These guards follow
# the MESSAGE's own artifact evidence, never the model's guess. Silent: they
# change active_mode only — decided_by stays "needle3+lfm2.5" (audit trail
# via the printed log line).
_RX_SHEET_EVIDENCE = re.compile(r"\b(sheet|workbook|spreadsheet|columns|rows|totals)\b", re.I)


def _routing_guards(message: str, active_mode: str, prior_mode: str | None) -> str | None:
    """Returns the mode the message's own evidence demands, or None to trust
    Stage 2. Order: question gate -> chat gate -> evidence switch -> sheet-
    beats-invoice homonym."""
    # (1) A pure question with no deliverable verb is conversation, whatever
    # artifact nouns it happens to mention ("how does Chart.js work?").
    if _Q_START_RX.match(message) and not _DELIVER_VERB_RX.search(message):
        return "standard_chat"
    # (2) Nothing artifact-shaped in the turn at all (debug help, comparisons,
    # parsing an uploaded file) -> chat. A refinement of a previous artifact
    # (prior_mode) legitimately carries no artifact noun.
    if active_mode != "standard_chat" and not prior_mode and not _artifact_modes(message):
        return "standard_chat"
    # (3) Evidence switch: the chosen mode's artifact noun never appears in the
    # message but other modes' do — follow the message, earliest match wins
    # ("build that as a 500-row Excel time series with charts" -> excel).
    if active_mode != "standard_chat" and not _MODE_ARTIFACT_RX[active_mode].search(message):
        hits = [(m.start(), mode) for mode, rx in _MODE_ARTIFACT_RX.items()
                if mode != active_mode and (m := rx.search(message))]
        if hits:
            return min(hits)[1]
    # (4) "invoice sheet whose totals show $X" is a spreadsheet, not a
    # printable invoice: tabular evidence outranks the pdf homonym.
    if active_mode == "pdf" and _RX_SHEET_EVIDENCE.search(message):
        return "excel"
    return None


_llm_proc: subprocess.Popen | None = None
_NEEDLE_LOCK = threading.Lock()   # cactus-needle runtime is not reentrant-safe
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


def _write_pid(path: Path) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(os.getpid()))
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
        _write_pid(pidfile)
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
            return  # parent unopenable — stay alive (safe default for manual spawns)
    while True:
        if os.name == "nt":
            if _kernel32.WaitForSingleObject(handle, 0) == _WAIT_OBJECT_0:
                break
        else:
            try:
                os.kill(_PARENT_PID, 0)
            except OSError:
                break
        time.sleep(2)
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
        "messages": msgs, "max_tokens": 180, "temperature": 0.0,
        "top_k": 1, "top_p": 1.0, "seed": 42,
        # Token-constrained: only JSON matching the exact 9 Mode literals with a
        # non-empty stripped_prompt is decodable (llama.cpp json-schema grammar).
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
    """Recover a decision from a max_tokens-truncated JSON object. The schema
    grammar emits active_mode/confidence first, so a cut-off object still
    carries the routing decision — only the tail (stripped_prompt end,
    constraints) is lost, and the deterministic strip + hard-token guard
    rebuild those from the raw message anyway."""
    try:
        mode = re.search(r'"active_mode"\s*:\s*"([a-z_]+)"', raw)
        if not mode or mode.group(1) not in MODES:
            return None
        conf = re.search(r'"confidence"\s*:\s*([0-9.]+)', raw)
        sp = re.search(r'"stripped_prompt"\s*:\s*"((?:[^"\\]|\\.)*)', raw)
        stripped = ""
        if sp:
            try:
                stripped = json.loads('"' + sp.group(1) + '"')
            except Exception:
                stripped = sp.group(1)
        if not stripped.strip():
            return None
        return Stage2Out(active_mode=mode.group(1),
                         confidence=float(conf.group(1)) if conf else 0.5,
                         stripped_prompt=stripped, task_constraints=[])
    except Exception:
        return None


def lfm_decide(message: str, history: list[dict],
               prior_modes: list[str], needle_conf: float) -> Stage2Out:
    """Stage 2: raw prompt + Needle prior -> final decision + model-made strip.
    One self-correction retry on invalid output; raises after the 2nd failure."""
    msgs = [{"role": "system", "content": LFM_SYSTEM}]
    for h in history[-4:]:
        role = h.get("role")
        content = (h.get("content") or "")[:300]
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    # The prior travels as a qualitative hint only: pasting Needle's raw
    # confidence number made LFM copy it verbatim into its own confidence.
    reliability = "high" if needle_conf >= 0.85 else "LOW (usually wrong)"
    msgs.append({
        "role": "user",
        "content": (f"{message}\n\n---\nPRIOR (weaker-classifier hint only — often WRONG; "
                    f"do NOT copy its mode, do NOT let it change your own confidence): "
                    f"candidates={json.dumps(prior_modes) if prior_modes else '[] (no signal)'}, "
                    f"reliability={reliability}"),
    })
    for attempt in (0, 1):
        raw = _lfm_call(msgs)
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


app = FastAPI(title="WebUI Decision Engine")
_agent: needle.Needle | None = None

# Head+tail truncation: an 8,000-char prompt must never overflow the 2048-
# token llama-server slot (system ~780 incl. CONTRASTS + history ~450 +
# message ~650 + 180 output < 2048). The head carries the task framing, the
# tail the closing constraints, so both survive; middle boilerplate is cut.
MAX_LFM_CHARS = 2_600
_HEAD_CHARS = 1_900
_TAIL_CHARS = 700


def _truncate_for_engine(message: str) -> str:
    if len(message) <= MAX_LFM_CHARS:
        return message
    return (message[:_HEAD_CHARS] + "\n […middle truncated…] \n" + message[-_TAIL_CHARS:])


@app.on_event("startup")
def warm() -> None:
    global _agent
    t0 = time.perf_counter()
    _agent = needle.Needle(
        tools=ROUTE_TOOLS,
        weights=str(DE / "models" / "needle3" / "needle3.cact"),
        system=CLASSIFY_SYSTEM,
        stateless=True,
    )
    ensure_llama_server()
    print(f"[decision-engine] warm: needle3 in {round((time.perf_counter()-t0)*1000)}ms, "
          f"lfm2.5 on :{LFM_PORT}, needle on :{DECISION_PORT}", flush=True)


@app.on_event("shutdown")
def _cool() -> None:
    # Graceful uvicorn stop (e.g. Ctrl+C on a manual terminal launch): never
    # leave our llama-server child behind.
    _shutdown_llama()


@app.get("/health")
def health():
    return {"ok": _agent is not None and _health(LFM_PORT), "lfm": _health(LFM_PORT)}


@app.post("/decision")
def decision(req: DecisionRequest) -> DecisionEnvelope:
    if _agent is None:
        raise HTTPException(503, "engine warming")
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "empty message")
    message = _truncate_for_engine(message)

    # ---- Stage 1: Needle 3 fast prior ----
    t0 = time.perf_counter()
    with _NEEDLE_LOCK:
        r = _agent.complete(message)
    needle_ms = round((time.perf_counter() - t0) * 1000, 1)
    calls = (r.get("function_calls") or []) + (r.get("suppressed_calls") or [])
    prior_modes = list(dict.fromkeys(
        TOOL_TO_MODE[c["name"]] for c in calls if (c.get("name") or "") in TOOL_TO_MODE))
    needle_conf = float(r.get("confidence") or 0.0)

    # ---- Stage 2: LFM2.5 ALWAYS decides + strips (no confidence skip) ----
    ensure_llama_server()
    t1 = time.perf_counter()
    try:
        s2 = lfm_decide(message, req.conversationHistory, prior_modes, needle_conf)
        lfm_ms = round((time.perf_counter() - t1) * 1000, 1)
        active_mode, conf, decided_by = s2.active_mode, s2.confidence, "needle3+lfm2.5"
        constraints = s2.task_constraints
        noun_rx = _MODE_ARTIFACT_RX.get(active_mode)
        artifact_nouns = [m.group(0) for m in noun_rx.finditer(message)] if noun_rx else []
        stripped = _preserve_hard_tokens(
            message,
            _strip_execution_meta(message, active_mode, s2.stripped_prompt.strip() or message),
            "; ".join(constraints), extra=artifact_nouns)
    except Exception as err:
        # NEVER silently drop to standard_chat when Needle has a valid prior:
        # fall back to Needle 3's top predicted mode with the RAW prompt.
        lfm_ms = round((time.perf_counter() - t1) * 1000, 1)
        if prior_modes:
            active_mode, conf, decided_by = prior_modes[0], needle_conf, "needle3 (lfm-fail)"
        else:
            active_mode, conf, decided_by = "standard_chat", 0.0, "fallback (no prior)"
        stripped, constraints = strip_prompt(message)
        stripped = _strip_execution_meta(message, active_mode, stripped)
        print(f"[decision] LFM2.5 failed after retry: {err}", flush=True)

    # ---- Deterministic routing guards (message evidence outranks Stage 2) ----
    prior_turn_mode = _prior_mode_from_history(req.conversationHistory)
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

    # ---- Trivial-chat passthrough (deterministic) ----
    # The 1.2B stripper hallucinates artifact boilerplate for greetings and
    # one-liners ("Hi" -> "Generate downloadable <artifact>..."), and that
    # hallucinated rewrite reaches the main LLM in place of the user's words,
    # sending it into an endless generation loop (observed: 600KB of reasoning
    # for "Hi", stream never closes). A one-liner has no conversational noise
    # to strip anyway, so forward it verbatim with no constraints.
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
        needle_latency_ms=needle_ms,
        lfm_latency_ms=lfm_ms,
    )
    print(f"[decision] mode={active_mode} conf={env.confidence} by={decided_by} "
          f"needle={needle_ms}ms lfm={lfm_ms}ms prior={prior_modes}@{needle_conf:.2f}", flush=True)
    return env


if __name__ == "__main__":
    _guard_single_instance()
    if _PARENT_PID > 0:
        threading.Thread(target=_parent_watchdog, daemon=True).start()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=DECISION_PORT, log_level="warning")
