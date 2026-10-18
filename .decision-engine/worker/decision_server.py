"""
Hybrid Decision Engine worker (100% project-local).

Stage 1 — Needle 3 (resident, grammar-constrained tool call): fast mode prior
with a calibrated confidence head. Stage 2 — LFM2.5-1.2B-Instruct via the
contained llama.cpp llama-server subprocess: ALWAYS runs on every non-empty
request, receives the raw prompt + Needle's prior, makes the final mode
decision and generates the stripped_prompt (schema-constrained JSON).
There is NO rule-based text stripping and NO silent drop to standard_chat:
if LFM fails after one self-correction retry, the envelope falls back to
Needle 3's top prior mode with the raw prompt.

Every weight, binary, cache and venv lives inside ./.decision-engine/.
Start:  .decision-engine/.venv/Scripts/python.exe .decision-engine/worker/decision_server.py
Serves: http://127.0.0.1:8790  POST /decision {message, conversationHistory?}
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
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

# ---- Stage 1: Needle 3 ----------------------------------------------------
CLASSIFY_SYSTEM = (
    "Route the request's PRIMARY deliverable by calling exactly one route_* tool.\n"
    "excel: spreadsheet/workbook/rows/formulas/SUMIFS/tracker/budget/ledger/KPI over tabular data.\n"
    "docs: document/report/letter/handover/essay. pdf: printable invoice/receipt/export.\n"
    "ppt: slide deck/presentation. 3d_asset: 3D model/logo/mesh/animated object.\n"
    "cad_blueprint: floor plan/building layout/wall dimensions/plumbing/BIM.\n"
    "chart: plot data (bar/line/pie). html_render: web page/component/UI.\n"
    "standard_chat: question/explanation/debugging, nothing to render."
)


# Needle 3 is a multi-tool router: one crisp tool per RendererMode. The tool
# Needle picks IS the prior; the route_* name maps back to the mode by prefix.
def route_excel() -> None:
    """Pick when the deliverable is a spreadsheet, workbook, tracker or ledger over rows of data (formulas, SUMIFS, budget, KPI)."""
def route_docs() -> None:
    """Pick when the deliverable is a written document: report, letter, handover, essay or sign-off doc."""
def route_pdf() -> None:
    """Pick when the deliverable is a printable or exportable document: invoice, receipt, print-ready file."""
def route_ppt() -> None:
    """Pick only when the user explicitly asks for slides, a deck or a presentation."""
def route_3d_asset() -> None:
    """Pick when the deliverable is a 3D model, logo, mesh, animated object or scene."""
def route_cad_blueprint() -> None:
    """Pick when the deliverable is an architectural floor plan, building layout, wall dimensions, plumbing or BIM."""
def route_chart() -> None:
    """Pick when the deliverable is a plot of data: bar, line, pie or scatter chart."""
def route_html_render() -> None:
    """Pick only when the user asks to BUILD a web page, component, landing page or UI."""
def route_standard_chat() -> None:
    """Pick when the turn is a question, explanation, debugging help or advice with nothing to render."""

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
    "Mentioning a framework or technology does NOT mean html_render; html_render requires the user asks you to BUILD a page or component.\n"
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
    "A PRIOR section at the end of the user message is a hint from a WEAKER classifier — "
    "it is wrong more often than right. Decide ONLY from the user's request; NEVER copy the "
    "prior's mode, and NEVER copy its reliability label as your confidence — report your own. "
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
        if not prev or prev[-1] in ".!?:;\n":
            continue  # sentence-initial capitalization is not an identifier
        toks.append(m.group(0))
    toks += _RX_NUM.findall(text)
    return list(dict.fromkeys(t.strip() for t in toks if t.strip()))


def _preserve_hard_tokens(raw: str, stripped: str) -> str:
    missing = [t for t in _hard_tokens(raw) if t.lower() not in stripped.lower()]
    if not missing:
        return stripped
    return f"{stripped}  Required Specs: [{', '.join(missing[:24])}]"

_llm_proc: subprocess.Popen | None = None


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


def _thread_count() -> int:
    """Physical core count (llama.cpp wants physical, not logical, threads)."""
    env = os.environ.get("LFM_THREADS")
    if env:
        return max(1, int(env))
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).NumberOfCores"],
            capture_output=True, text=True, timeout=10).stdout
        cores = int(out.strip())
        if cores >= 1:
            return cores
    except Exception:
        pass
    return max(1, min(6, os.cpu_count() or 4))


def ensure_llama_server() -> None:
    """Start the contained llama-server subprocess unless one is already warm.
    The bundled binary is CPU-only (`--list-devices` reports none), so -ngl 0
    stands; context is trimmed 4096->1024 (decision prompt + 4 truncated
    history turns ~= 500 tokens) with small batches + no warmup to cut RSS."""
    global _llm_proc
    if _health(LFM_PORT):
        return
    _llm_proc = subprocess.Popen(
        [str(_llama_binary()), "-m", str(_gguf_path()),
         "--host", "127.0.0.1", "--port", str(LFM_PORT),
         "-c", "1024", "-ngl", "0", "-t", str(_thread_count()),
         "--batch-size", "512", "--ubatch-size", "512", "--no-warmup", "--no-webui"],
        cwd=str(DE / ".cache" / "tmp"),  # never run from inside the extracted bin dir
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(120):
        if _health(LFM_PORT):
            return
        time.sleep(1)
    raise RuntimeError("llama-server failed to become healthy within 120s")


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
    with urllib.request.urlopen(req, timeout=90) as r:
        j = json.loads(r.read())
    return j["choices"][0]["message"]["content"]


def lfm_decide(message: str, history: list[dict],
               prior_modes: list[str], needle_conf: float) -> Stage2Out:
    """Stage 2: raw prompt + Needle prior -> final decision + model-made strip.
    One self-correction retry on invalid output; raises after the 2nd failure."""
    msgs = [{"role": "system", "content": LFM_SYSTEM}]
    for h in history[-4:]:
        role = h.get("role")
        content = (h.get("content") or "")[:400]
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
                raise
            msgs = msgs + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": f"Invalid output ({err}). "
                 "Reply with ONLY one valid JSON object matching the schema."},
            ]
    raise RuntimeError("unreachable")


app = FastAPI(title="WebUI Decision Engine")
_agent: needle.Needle | None = None


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

    # ---- Stage 1: Needle 3 fast prior ----
    t0 = time.perf_counter()
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
        stripped = _preserve_hard_tokens(message, s2.stripped_prompt.strip() or message)
        constraints = s2.task_constraints
    except Exception as err:
        # NEVER silently drop to standard_chat when Needle has a valid prior:
        # fall back to Needle 3's top predicted mode with the RAW prompt.
        lfm_ms = round((time.perf_counter() - t1) * 1000, 1)
        if prior_modes:
            active_mode, conf, decided_by = prior_modes[0], needle_conf, "needle3 (lfm-fail)"
        else:
            active_mode, conf, decided_by = "standard_chat", 0.0, "fallback (no prior)"
        stripped, constraints = strip_prompt(message)
        print(f"[decision] LFM2.5 failed after retry: {err}", flush=True)

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
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=DECISION_PORT, log_level="warning")
