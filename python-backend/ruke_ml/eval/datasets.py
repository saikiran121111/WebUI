"""Frozen held-out retrieval suite for the Python path.

Authored by hand on 2026-11-16 BEFORE this suite was ever scored, and kept under
version control so a result can be reproduced. Rules that apply to this file:

* Never edit a query, a relevance judgement or a floor to make a run pass. A new
  failure becomes a regression case; a fresh unseen family is added instead.
* Nothing here is model-generated, so the same model is not judging its own work.
* Every family states its own floor and its own denominator; gated capabilities
  are listed separately and can never contribute to a pass rate.

The families deliberately contain hard negatives (same surface words, different
subject), scripts without spaces, vowelled Arabic, exact identifiers, a topic
reset and queries whose answer does not exist in the corpus at all.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class Case:
    qid: str
    query: str
    relevant: tuple[str, ...] = ()          # answer-bearing doc ids
    forbidden_top1: tuple[str, ...] = ()    # must never be the single top hit
    language: str = "en"


@dataclass(frozen=True, slots=True)
class Family:
    name: str
    description: str
    floor: dict[str, float]                 # metric -> required value
    cases: tuple[Case, ...]


@dataclass(frozen=True, slots=True)
class Gated:
    """A capability whose real quality CANNOT be measured in this checkout."""
    name: str
    capability: str
    what_would_be_measured: str
    # The specific candidate that WOULD be measured. A capability can have several
    # adapters and one of them may already run here (the lexical baseline), so the gate
    # reports the install status of THIS named model rather than of the capability.
    model: str = ""


# --------------------------------------------------------------------------- corpus
CORPUS: dict[str, str] = {
    "d_cpp_move": (
        "C++ move semantics transfer a resource through std::move; the moved-from object stays valid but unspecified. "
        "C has no move constructor at all, so C code copies structs with memcpy or an explicit assignment."),
    "d_c_stdio": (
        "The C standard library offers fopen, fgets and fclose for buffered stdio streams. "
        "C99 added designated initialisers and restrict-qualified pointers."),
    "d_rust_versions": (
        "Rust 2021 changed IntoIterator ergonomics for arrays, and rustc 1.83 ships the 2024 edition behind a preview flag. "
        "Cargo resolves semver ranges against the registry index."),
    "d_rust_ownership": (
        "Rust ownership gives every value exactly one owner and rejects aliasing mutable borrows at compile time. "
        "A ZIG-style algebraic enum is not needed for that guarantee; NIM has a different memory model entirely."),
    "d_py_packaging": (
        "pip installs a package version from an index; pip freeze pins the exact versions and pip cache keep the downloaded wheels. "
        "Dependency updates are reviewed in a lock file diff."),
    "d_snake_python": (
        "The reticulated python sheds its skin several times a year, and a python egg hatches after about three months of incubation. "
        "A python constricts prey rather than biting it."),
    "d_cards_deck": (
        "A standard deck of cards holds 52 cards in four suits, so a poker hand is five cards drawn from that deck."),
    "d_deck_ship": (
        "The boat deck of a ferry sits above the waterline and its teak decking is caulked with seam compound."),
    "d_parser_scores": (
        "In a parser combinator library the pattern match scores of competing alternatives rank the parses of the same input by specificity."),
    "d_sport_scores": (
        "Cricket match scores are reported as runs and wickets, and a league table ranks teams by net run rate."),
    "d_linkedin_generic": (
        "A LinkedIn profile lists somebody's roles, skills and recommendations, and a recruiter can search that profile."),
    "d_person_milano": (
        "Elena Marchetti works in Milan, Italy as a hydraulic engineer and wrote a paper about pump cavitation in tidal gates."),
    "d_windows_error": (
        "Windows error 0x80070005 is E_ACCESSDENIED; event id 1001 records the failing image path C:\\Windows\\System32\\svchost.exe."),
    "d_git_rebase": (
        "git rebase -i rewrites the commits on a branch, and git reflog recovers a branch destroyed by a mistaken git reset."),
    "d_invoice_number": (
        "An invoice number such as INV-2024-0007 appears in the header block of a VAT invoice, with the due date thirty days later."),
    "d_pdf_compress": (
        "PDF compression subsets the embedded font and downsamples images to a target dpi, while FlateDecode shortens a stream without changing its text."),
    "d_docx_styles": (
        "DOCX styles keep heading levels, numbering and character formatting in styles.xml; a merged table cell records a gridSpan in its row."),
    "d_pptx_sizes": (
        "PowerPoint stores a 16:9 slide as 12192000 by 6858000 EMU, with entrance animations in the slide's timing tree."),
    "d_ferry_route": (
        "The night sailing between Porto Santo and Madeira leaves at 22:30 and is reserved on the operator's own booking site."),
    "d_market_song": (
        "At the market cross a busker keeps singing a chorus whose hook is the phrase acrobatics fly away."),
    "d_telugu_weather": (
        "హైదరాబాద్ నగరంలో రేపు వర్షం పడే అవకాశం ఉంది, అలాగే గాలి తేలికగా ఉంటుంది."),
    "d_telugu_cinema": (
        "ఆ సినిమా ఓపెనింగ్ షో మొదటి రోజునే అమ్ముడు పోయింది, ప్రేక్షకులు క్యూలో నిలబడ్డారు."),
    "d_hindi_weather": (
        "मौसम विभाग ने लखनऊ में भारी बारिश का पूर्वानुमान जारी किया है और अधिकतम तापमान अट्ठाईस डिग्री रहेगा।"),
    "d_ja_train": (
        "東京駅から渋谷駅まで山手線で約30分かかり、終電は午後0時50分に出ます。"),
    "d_zh_price": (
        "比特币的价格在过去一周内下跌了百分之十二，交易所已经恢复提现功能。"),
    "d_ar_meeting": (
        "تعلن الشركة عن اجتماع الجمعية العمومية يوم الخميس في مقرها بالرياض"),
    "d_es_boiler": (
        "El mantenimiento preventivo de la caldera se realiza cada seis meses e incluye la limpieza del quemador y de la bomba."),
    "d_vi_tuition": (
        "Học phí khóa học tiếng Anh buổi tối là ba triệu đồng mỗi tháng, đóng theo quý."),
    "d_fr_bakery": (
        "La boulangerie du marché ouvre à six heures et le fournil arrête la cuisson du pain à dix-huit heures."),
}

# --------------------------------------------------------------------- frozen floors
FAMILIES: tuple[Family, ...] = (
    Family(
        name="symbol_identifiers",
        description="Symbol-bearing identifiers and versions must not collapse into shorter tokens.",
        floor={"recall_at_5": 0.90, "mrr": 0.60, "forbidden_top1_rate": 0.0},
        cases=(
            Case("s1", "what does std::move change about a C++ object that C would have copied",
                 ("d_cpp_move",), ("d_c_stdio",)),
            Case("s2", "which rustc release previews the 2024 edition", ("d_rust_versions",),
                 ("d_rust_ownership",)),
            Case("s3", "recover a branch after a mistaken git reset", ("d_git_rebase",)),
            Case("s4", "error 0x80070005 event id 1001 svchost.exe", ("d_windows_error",)),
            Case("s5", "how large is a 16:9 slide in EMU units", ("d_pptx_sizes",)),
            Case("s6", "gridSpan merged cell styles.xml", ("d_docx_styles",)),
            Case("s7", "FlateDecode downsample images target dpi", ("d_pdf_compress",)),
        ),
    ),
    Family(
        name="lexical_hard_negatives",
        description="Same surface words, different subject: a lexical hit is not relevance.",
        floor={"recall_at_5": 0.90, "forbidden_top1_rate": 0.0, "mrr": 0.60},
        cases=(
            Case("h1", "package version updates in python", ("d_py_packaging",),
                 ("d_snake_python", "d_rust_versions")),
            Case("h2", "pattern match scores in a parser", ("d_parser_scores",), ("d_sport_scores",)),
            Case("h3", "shuffle a deck of cards", ("d_cards_deck",), ("d_deck_ship",)),
            Case("h4", "C++ versus C struct copy", ("d_cpp_move",), ("d_c_stdio",)),
            Case("h5", "ZIG NIM enum memory model", ("d_rust_ownership",)),
        ),
    ),
    Family(
        name="exact_identifiers",
        description="Rare names, numbers, URLs and codes survive verbatim.",
        floor={"recall_at_5": 1.0, "mrr": 0.75},
        cases=(
            Case("e1", "INV-2024-0007", ("d_invoice_number",)),
            Case("e2", "Elena Marchetti tidal gates", ("d_person_milano",), ("d_linkedin_generic",)),
            Case("e3", "Porto Santo 22:30", ("d_ferry_route",)),
            Case("e4", "acrobatics fly away", ("d_market_song",)),
        ),
    ),
    Family(
        name="scripts_without_spaces",
        description="Han, kana and Indic scripts must be searchable at all, not one opaque run.",
        floor={"recall_at_5": 0.80, "mrr": 0.60},
        cases=(
            Case("j1", "山手線の東京から渋谷までの所要時間", ("d_ja_train",), language="ja"),
            Case("j2", "山手線 終電", ("d_ja_train",), language="ja"),
            Case("z1", "比特币 价格 下跌 百分之十二", ("d_zh_price",), language="zh"),
            Case("t1", "హైదరాబాద్ రేపు వర్షం", ("d_telugu_weather",), ("d_telugu_cinema",),
                 language="te"),
            Case("t2", "సినిమా ఓపెనింగ్ షో", ("d_telugu_cinema",), language="te"),
            Case("h1i", "लखनऊ बारिश पूर्वानुमान तापमान", ("d_hindi_weather",), language="hi"),
        ),
    ),
    Family(
        name="vowels_and_diacritics",
        description="A vowelled query must match a document typed without vowel marks.",
        floor={"recall_at_5": 1.0, "mrr": 0.75},
        cases=(
            Case("a1", "اِجتماعُ الجَمعيّةِ العُموميّةِ متى", ("d_ar_meeting",), language="ar"),
            Case("a2", "اجتماع الجمعية العمومية الرياض", ("d_ar_meeting",), language="ar"),
            Case("v1", "khóa học tiếng Anh buổi tối học phí", ("d_vi_tuition",), language="vi"),
            Case("v2", "TIẾNG ANH BUỔI TỐI GIÁ", ("d_vi_tuition",), language="vi"),
            Case("f1", "Le fournil arrête la cuisson du pain", ("d_fr_bakery",), language="fr"),
        ),
    ),
    Family(
        name="european_natural_questions",
        description="Ordinary phrased questions, terse or polite, must still retrieve.",
        floor={"recall_at_5": 0.80, "mrr": 0.60},
        cases=(
            Case("q1", "¿cada cuánto se hace el mantenimiento de la caldera?", ("d_es_boiler",),
                 language="es"),
            Case("q2", "quand ouvre la boulangerie du marche", ("d_fr_bakery",), language="fr"),
            Case("q3", "where does the busker sing the hook", ("d_market_song",), language="en"),
            Case("q4", "teak decking caulk seam compound", ("d_deck_ship",), ("d_cards_deck",),
                 language="en"),
            Case("q5", "pip freeze pins exact versions lock file", ("d_py_packaging",), language="en"),
        ),
    ),
    Family(
        name="abstention_no_answer_in_corpus",
        description="Nothing relevant exists: the run must abstain instead of presenting top-K as evidence.",
        floor={"abstention_accuracy": 1.0},
        cases=(
            Case("n1", "what causes crazing in a kiln-fired ceramic glaze"),
            Case("n2", "torque specification for a bicycle hub axle nut"),
            Case("n3", "gallium boiling point in a vacuum chamber"),
            Case("n4", "ప్రపంచంలోని అతిపెద్ద నౌకాశ్రయం ఏది", language="te"),
            Case("n5", "الطقس في باريس غدا", language="ar"),
            Case("n6", "donde comprar repuestos de ascensor", language="es"),
        ),
    ),
)

# A model or asset this checkout cannot run, so its quality is reported not_run
# with the exact reason taken from the live model catalog - never as a pass.
GATED: tuple[Gated, ...] = (
    Gated("neural_embedding",
          "embeddings",
          "recall@k / nDCG against the same frozen families with a learned embedder",
          model="Qwen/Qwen3-Embedding-0.6B"),
    Gated("neural_reranking",
          "rerank",
          "answer-bearing passage recall after neural reordering of the same candidates",
          model="Qwen/Qwen3-Reranker-0.6B"),
    Gated("document_layout_ocr",
          "documents.ocr",
          "per-page OCR CER, reading order and table structure on scanned/mixed PDFs",
          model="PaddleOCR-VL"),
    Gated("asr_multilingual",
          "speech.asr",
          "WER/CER per language including Telugu and Hindi on real human recordings",
          model="openai/whisper-large-v3"),
    Gated("speaker_diarization",
          "speech.diarize",
          "DER on overlapping speech (license acceptance also required)",
          model="pyannote/speaker-diarization-community-1"),
    Gated("forced_alignment",
          "speech.align",
          "word-level timestamp error against hand-marked intervals",
          model="Qwen/Qwen3-ForcedAligner-0.6B"),
    Gated("temporal_video_localisation",
          "video.timeline",
          "interval hit rate and mean absolute error on a human-labelled long video",
          model="ruke-video-timeline"),
)


def family_names() -> list[str]:
    return [f.name for f in FAMILIES]
