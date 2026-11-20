"""Frame OCR: the stage that actually READS the visible text in decoded video frames.

Why this module exists: the video pipeline could plan frames (video.scenes), record
observations (video.observations) and derive hints from them, but nothing in the whole
pipeline ever turned a pixel into text. A "visual" observation with no reader behind it is
a bookkeeping entry, so media with on-screen text (slides, captions burned into the picture,
signage, terminal output) was unreachable no matter how many frames were planned.

The distinction this module is built to preserve (amendment area F):

    PLANNED  !=  DECODED  !=  OCR-READ  !=  SEMANTICALLY INTERPRETED

* planned frames come from a sampling plan and prove nothing about content;
* a decoded frame proves the DECODER worked on that timestamp;
* an OCR-read frame proves the engine put glyphs on that frame, and reports honestly when
  it found none ("empty" is a finding, not a failure);
* interpretation stays a separate, later, model-owned step that this module never claims.

Two further refusals, both inherited from the document OCR path:
  * the language is never defaulted. Silently picking English is how Devanagari slides come
    back as Latin noise, so an unaddressable language is a typed refusal;
  * the engine here is Tesseract, which is a text recogniser. It does not recover table
    structure, layout hierarchy or figure meaning, and this module says so in its own
    result rather than letting downstream readers assume otherwise.
"""
from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable

from .. import processes
from ..models.binaries import path_for

# A single PNG frame over this bound is a decoder anomaly, not a frame we should keep
# feeding through a pipe to the OCR engine.
MAX_PNG_BYTES = 32 << 20
FRAME_TIMEOUT_S = 60.0
MAX_FRAMES = 64
MAX_CHARS_PER_FRAME = 20000

FRAME_STATES = ("recognised", "empty", "frame_failed", "ocr_failed",
                "duplicate", "out_of_range", "skipped", "not_run")


class FrameDecodeFailed(Exception):
    """The frame could not be produced. Kind separates a missing decoder from a bad seek."""

    def __init__(self, kind: str, detail: str, human_step: str = "") -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.human_step = human_step


def ffmpeg_frame_command(src: str, time_s: float, ffmpeg: str = "") -> list[str]:
    """One frame to stdout as PNG, at the requested presentation time.

    Measured against the pinned ffmpeg (6.1.1), same findings that forced
    `scenes.ffmpeg_scene_command` to its current spelling: this build rejects `-vsync v0`
    outright, so `-fps_mode passthrough` is used, and `-loglevel error` would hide the only
    diagnostics that explain a failed seek. `-ss` BEFORE `-i` is a keyframe-accurate input
    seek followed by an accurate decode of the first frame at/after the target; the result
    records the REQUESTED time, and the honest caveat lives in `seek` below rather than in a
    claim that the returned frame is exactly the one at that instant.
    """
    exe = ffmpeg or path_for("ffmpeg") or "ffmpeg"
    return [exe, "-hide_banner", "-loglevel", "error", "-nostats", "-nostdin",
            "-ss", f"{float(time_s):.3f}", "-i", src,
            "-frames:v", "1", "-fps_mode", "passthrough",
            "-map", "0:v:0",
            "-f", "image2pipe", "-vcodec", "png", "-"]


def extract_frame_png(src: str, time_s: float, *, ffmpeg: str = "",
                      timeout_s: float = FRAME_TIMEOUT_S, cancel: Any = None) -> bytes:
    """Decode exactly one frame at `time_s` and return its PNG bytes."""
    exe = ffmpeg or path_for("ffmpeg")
    if not exe:
        raise FrameDecodeFailed(
            "ffmpeg_not_installed",
            "no validated ffmpeg copy was found, so no frame can be decoded",
            "install ffmpeg or set RUKE_FFMPEG to a validated copy")
    from ..documents.ocr_tesseract import _cancel_flag
    if _cancel_flag(cancel):
        raise FrameDecodeFailed("cancelled", "cancelled before the frame was decoded")
    cmd = ffmpeg_frame_command(src, time_s, ffmpeg=exe)
    try:
        done = processes.run_captured(cmd, timeout=timeout_s)
    except subprocess.TimeoutExpired as exc:
        raise FrameDecodeFailed(
            "timeout",
            f"ffmpeg exceeded {timeout_s}s seeking to {time_s:.3f}s; a partial frame is not "
            "evidence", "lower the resolution or narrow the requested times") from exc
    except (OSError, ValueError) as exc:
        raise FrameDecodeFailed("spawn_failed", f"{type(exc).__name__}: {exc}",
                                "the resolved ffmpeg copy could not be started") from exc
    png = done.stdout or b""
    if done.returncode != 0:
        raise FrameDecodeFailed(
            "decode_failed",
            f"ffmpeg exited {done.returncode} at {time_s:.3f}s: {(done.stderr or b'')[-300:]!r}",
            "check that the container really carries a video track and that the time is inside it")
    if not png.startswith(b"\x89PNG"):
        raise FrameDecodeFailed(
            "decode_failed",
            f"ffmpeg produced {len(png)} byte(s) that are not a PNG at {time_s:.3f}s",
            "the requested stream may not be a video stream")
    if len(png) > MAX_PNG_BYTES:
        raise FrameDecodeFailed(
            "resource_limit",
            f"frame PNG at {time_s:.3f}s is {len(png)} B, over the {MAX_PNG_BYTES} B frame bound",
            "decode the frame at a lower resolution")
    return png


def png_dimensions(png: bytes) -> tuple[int, int]:
    """(width, height) straight from the IHDR, so a frame's geometry is never a guess."""
    if len(png) >= 24 and png[:8] == b"\x89PNG\r\n\x1a\n" and png[12:16] == b"IHDR":
        return (int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big"))
    return (0, 0)


def frame_digest(png: bytes) -> str:
    return hashlib.sha256(png).hexdigest()[:32]


@dataclass(slots=True)
class FrameReading:
    """One planned instant and what the pipeline ACTUALLY managed at that instant."""
    time_s: float
    state: str
    text: str = ""
    detail: str = ""
    confidence: float | None = None
    lines: list[dict[str, Any]] = field(default_factory=list)
    width: int = 0
    height: int = 0
    digest: str = ""
    engine: str = ""
    language_code: str = ""
    copy_of_time: float | None = None      # set when this frame is a byte-identical duplicate

    def to_dict(self) -> dict[str, Any]:
        return {"time_s": self.time_s, "state": self.state, "text": self.text[:MAX_CHARS_PER_FRAME],
                "detail": self.detail, "confidence": self.confidence,
                "lines": self.lines[:200], "width": self.width, "height": self.height,
                "frame_digest": self.digest, "engine": self.engine,
                "language_code": self.language_code, "copy_of_time": self.copy_of_time,
                "provenance": "frame_ocr", "timebase": "presentation"}

    @property
    def read(self) -> bool:
        return self.state in ("recognised", "duplicate")

    @property
    def unresolved(self) -> bool:
        return self.state not in ("recognised", "empty", "duplicate")


def _engine_ocr(png: bytes, language: str) -> tuple[list[dict[str, Any]], str]:
    from ..documents.ocr_tesseract import ocr_png
    return ocr_png(png, language=language)


def ocr_frames(src: str, times: list[float], *, language: str, duration: float = 0.0,
               ffmpeg: str = "", engine: str = "",
               frame_fn: Callable[[str, float], bytes] | None = None,
               ocr_fn: Callable[[bytes, str], tuple[list[dict[str, Any]], str]] | None = None,
               cancel: Any = None, progress: Callable[[str, str], None] | None = None,
               deadline_at: float = 0.0,
               max_frames: int = MAX_FRAMES) -> tuple[list[FrameReading], dict[str, Any]]:
    """Decode + recognise one frame per requested instant, releasing nothing in between.

    Injectable `frame_fn`/`ocr_fn` exist so the DISPATCH mechanics can be tested without a
    model or an engine; they are not a way to claim quality. Every production caller goes
    through ffmpeg and the validated project-local Tesseract copy, and quality is only ever
    established by the media quality gate on real recordings.
    """
    from ..documents.ocr_tesseract import OcrUnavailable, _cancel_flag, engine_state

    def note(state: str, msg: str = "") -> None:
        if progress is not None:
            try:
                progress(state, msg)
            except Exception:                                   # noqa: BLE001 - progress is advisory
                pass

    planned = [float(t) for t in times][:max(1, int(max_frames))]
    if not planned:
        raise FrameDecodeFailed("input_rejected", "frame OCR needs at least one requested time",
                                "pass explicit source-relative times")
    run_frame = frame_fn or (lambda s, t: extract_frame_png(s, t, ffmpeg=ffmpeg,
                                                            cancel=cancel))
    run_ocr = ocr_fn or (lambda png, lang: _engine_ocr(png, lang))
    eng = engine_state()
    engine_version = str(eng.get("version", "") or "")
    if not eng.get("found") and ocr_fn is None:
        raise OcrUnavailable("engine_missing",
                             "no validated tesseract copy was found, so frames cannot be read",
                             "install the project-local OCR runtime or set RUKE_TESSERACT")
    if ocr_fn is None:
        # Checked ONCE, before any pixel is decoded. The language does not change from frame
        # to frame, so discovering an unaddressable language on frame 1 of 40 would waste 40
        # decodes and invent 40 separate failures for one cause.
        from ..documents.ocr_tesseract import language_is_addressable
        ok, _code, why = language_is_addressable(language)
        if not ok:
            raise OcrUnavailable("unsupported_language", why,
                                 "install the language data for the requested language, or ask "
                                 "about the frames in a language this engine can address")

    out: list[FrameReading] = []
    seen: dict[str, float] = {}
    failures: dict[str, int] = {}
    for index, t in enumerate(planned):
        if _cancel_flag(cancel):
            out.append(FrameReading(t, "skipped", detail="cancelled before this frame"))
            for rest in planned[index + 1:]:
                out.append(FrameReading(rest, "not_run", detail="not run: the job was cancelled"))
            note("cancelled", f"stopped after {index} of {len(planned)} frame(s)")
            break
        if deadline_at and time_left(deadline_at) <= 0:
            out.append(FrameReading(t, "not_run",
                                    detail="job deadline reached before this frame"))
            for rest in planned[index + 1:]:
                out.append(FrameReading(rest, "not_run", detail="not run: the deadline passed"))
            note("deadline_exceeded", f"deadline reached after {index} of {len(planned)} frame(s)")
            break
        if duration and not (0.0 <= t <= duration):
            # A timestamp outside the container is an input error, not a frame with no text.
            failures["out_of_range"] = failures.get("out_of_range", 0) + 1
            out.append(FrameReading(t, "out_of_range",
                                    detail=f"{t:.3f}s lies outside the measured "
                                           f"{duration:.3f}s container"))
            continue
        try:
            png = run_frame(src, t)
        except (FrameDecodeFailed, OcrUnavailable) as exc:
            kind = getattr(exc, "kind", "decode_failed")
            failures[kind] = failures.get(kind, 0) + 1
            if kind == "cancelled":
                out.append(FrameReading(t, "skipped", detail=exc.detail if hasattr(exc, "detail")
                                        else str(exc)))
                for rest in planned[index + 1:]:
                    out.append(FrameReading(rest, "not_run", detail="not run: the job was cancelled"))
                break
            if kind in ("engine_missing", "ffmpeg_not_installed", "unsupported_language",
                        "resource_limit", "input_rejected"):
                # A missing engine/decoder or an unaddressable language is a capability-level
                # condition: repeating it once per frame invents N failures for one cause.
                note("failed", f"{kind}: {exc}")
                for rest in planned[index:]:
                    out.append(FrameReading(rest, "not_run", detail=f"{kind}: {exc}"))
                break
            out.append(FrameReading(t, "frame_failed", detail=f"{kind}: {exc}"))
            note("extracting", f"frame at {t:.3f}s failed: {kind}")
            continue
        digest = frame_digest(png)
        w, h = png_dimensions(png)
        if digest in seen:
            out.append(FrameReading(t, "duplicate", digest=digest, width=w, height=h,
                                    copy_of_time=seen[digest], engine=engine_version,
                                    detail=f"byte-identical to the frame at {seen[digest]:.3f}s; "
                                         "not recognised twice"))
            note("reading", f"{t:.3f}s duplicates {seen[digest]:.3f}s")
            continue
        seen[digest] = t
        try:
            lines, code = run_ocr(png, language)
        except OcrUnavailable as exc:
            kind = getattr(exc, "kind", "engine_failed")
            failures[kind] = failures.get(kind, 0) + 1
            # The frame that hit the condition keeps its own state (it really was decoded);
            # only the later instants are marked not_run. A capability-level condition (no
            # engine, unaddressable language) is reported once instead of retried per frame.
            capability_level = kind in ("engine_missing", "unsupported_language",
                                        "rasterizer_missing", "input_rejected")
            if capability_level:
                note("failed", f"{kind}: {exc}")
                for rest in planned[index + 1:]:
                    out.append(FrameReading(rest, "not_run", detail=f"not run: {kind}"))
            out.append(FrameReading(t, "ocr_failed", digest=digest, width=w, height=h,
                                    detail=f"{kind}: {exc}"))
            if capability_level:
                break
            note("reading", f"{t:.3f}s decoded but not recognised: {kind}")
            continue
        text = "\n".join(str(g.get("text", "")) for g in lines if str(g.get("text", "")).strip())
        text = text[:MAX_CHARS_PER_FRAME]
        confs = [g.get("confidence") for g in lines if isinstance(g.get("confidence"), float)]
        conf = (sum(confs) / len(confs)) if confs else None
        if text.strip():
            out.append(FrameReading(t, "recognised", text=text, confidence=conf, lines=lines,
                                    width=w, height=h, digest=digest, engine=engine_version,
                                    language_code=code))
        else:
            # "The engine ran and found no glyphs" is a measured negative, not a failure.
            out.append(FrameReading(t, "empty", width=w, height=h, digest=digest,
                                    engine=engine_version, language_code=code,
                                    detail="decoded and recognised: no glyph was found"))
        note("reading", f"{index + 1}/{len(planned)} frame(s) at {t:.3f}s")

    read = [f for f in out if f.state == "recognised"]
    report = {
        "engine": engine_version,
        "engine_languages": list(eng.get("languages", []) or []),
        "requested_language": language,
        "planned": len(planned),
        "decoded": sum(1 for f in out if f.digest),
        "recognised": len(read),
        "glyph_free": sum(1 for f in out if f.state == "empty"),
        "duplicates": sum(1 for f in out if f.state == "duplicate"),
        "unresolved": [f.time_s for f in out if f.unresolved],
        "failure_kinds": failures,
        "seek": "ffmpeg -ss before -i: keyframe input seek + accurate decode; each record "
                "carries the REQUESTED presentation time, not a measured frame PTS",
        "character_limit_per_frame": MAX_CHARS_PER_FRAME,
        "note": ("frame OCR reads visible TEXT only. It does not interpret diagrams, recover "
                 "table structure or claim layout fidelity, and N sampled frames cannot "
                 "establish visual coverage of a recording: every un-sampled instant is "
                 "simply unexamined."),
    }
    return out, report


def time_left(deadline_at: float) -> float:
    import time as _t
    return float(deadline_at) - _t.time()
