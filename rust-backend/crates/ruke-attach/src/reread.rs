//! `lib/server/attachindex/reread.ts` — F152 targeted reread, ported for
//! parity. The user (or model) asks for a CLOSER read of one figure in an
//! indexed document THIS turn. The law:
//!  - resolve the region(s) the question aims at — when the question NAMES a
//!    unit ("the legend on slide 2"), that unit WINS (retrieval's cue set can
//!    be wider: adjacency expansion pulls a neighbour passage in, and a
//!    closer read of one figure must never re-inspect the neighbour); a
//!    request naming no unit falls back to the units the retrieved passages
//!    name;
//!  - run ONLY the needed inspection: the inspector receives the exact
//!    region ids, so every other region's cached evidence stands untouched;
//!  - use the result in the SAME answer (returned lines ride this turn's
//!    evidence block);
//!  - refresh ONLY the selected region durably (pixels + state + recovered
//!    passage) via [`store::apply_region_reread`], so ordinary follow-ups
//!    reuse the cached evidence.
//!
//! Recovered text persists with its unit header, engine and region id —
//! merged with source location, never fused into native text.
//!
//! The inspection TRANSPORT is a seam ([`RegionInspector`]): this crate owns
//! the decision, resolution and durability law; ruke-server owns the ML-job
//! call (the capability backend is the server's, per the frozen boundary).
//! Both regexes are ASCII-only so the pattern bytes match the TS port
//! one-for-one. Every failure (no source, transport fault, cancel) degrades
//! to the empty outcome — a reread NEVER throws into the turn.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};
use tokio_util::sync::CancellationToken;

use crate::store::{self, RegionRereadUpdate};
use crate::types::{FrameEntry, LoadedIndex};
use crate::QueryEmbedder;

/// `REREAD_REQUEST` — conservative explicit-request scan (ASCII, mirrors the
/// TS literal one-for-one). Only an unambiguous closer-read phrasing
/// triggers work; an ordinary visual question rides the cached evidence, and
/// a count, threshold, filename or topic never decides anything.
fn reread_request() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        RegexBuilder::new(
            r"(look|read|show|check|inspect)\s+(it\s+)?(closer|closely|up\s+close|again)|closer\s+look|re-?read|zoom(\s+in)?|enlarg|in\s+more\s+detail|more\s+detail|can\s+you\s+read|read\s+(the|this|that)\s+(label|text|figure|chart|legend)",
        )
        .case_insensitive(true)
        .build()
        .expect("static pattern")
    })
}

/// The unit a question names: "slide 2", "page 12", "figure 3", "sheet 4",
/// "unit 7" (TS `/(?:slide|page|sheet|unit|figure)\s*#?\s*(\d+)/gi`). The
/// keyword group is NON-capturing so the digit is capture 1, exactly like
/// the TS literal.
fn named_unit_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        RegexBuilder::new(r"(?:slide|page|sheet|unit|figure)\s*#?\s*(\d+)")
            .case_insensitive(true)
            .build()
            .expect("static pattern")
    })
}

/// Words a label shares with every frame of its unit — naming one figure needs more.
fn unit_word_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^(pages?|slides?|sheets?|paragraphs?|cells?|figures?|units?|images?)$")
            .expect("static pattern")
    })
}

/// `pickRegionFrames`: a page/slide/sheet can carry SEVERAL figures, and a
/// closer read of ONE of them must leave the neighbour's cached evidence
/// untouched (selecting by unit re-inspected every picture on the page and
/// mixed their text). Within each named unit, frames the question points at
/// are picked by the figure ordinal ("figure 2" → the region ending
/// "/image:1") and by a word the frame's label carries that the question also
/// uses ("the picture at C4" matches "sheet 2, cell C4"). When the question
/// names none of them the whole unit stays in scope — the established
/// unit-level law, never narrowed to nothing. Mirrors the TS port byte-for-byte.
fn pick_region_frames<'a>(frames: Vec<&'a FrameEntry>, question: &str) -> Vec<&'a FrameEntry> {
    let q = question.to_lowercase();
    fn tokens(s: &str) -> Vec<String> {
        static T: OnceLock<Regex> = OnceLock::new();
        let re = T.get_or_init(|| Regex::new(r"[a-z0-9]+").expect("static pattern"));
        re.find_iter(s).map(|m| m.as_str().to_string()).collect()
    }
    let q_tokens: Vec<String> = tokens(&q);
    let ordinals: Vec<u64> = {
        static O: OnceLock<Regex> = OnceLock::new();
        let re = O.get_or_init(|| {
            RegexBuilder::new(r"figure\s*#?\s*(\d+)").case_insensitive(true).build().expect("static pattern")
        });
        let mut out: Vec<u64> = Vec::new();
        for c in re.captures_iter(&q) {
            if let Some(m) = c.get(1) {
                if let Ok(n) = m.as_str().parse::<u64>() {
                    if !out.contains(&n) {
                        out.push(n);
                    }
                }
            }
        }
        out
    };
    static IMG: OnceLock<Regex> = OnceLock::new();
    let image_re = IMG.get_or_init(|| Regex::new(r"/image:(\d+)$").expect("static pattern"));

    let mut units: Vec<(f64, Vec<&FrameEntry>)> = Vec::new();
    for f in frames {
        match units.iter_mut().find(|(at, _)| *at == f.at) {
            Some((_, list)) => list.push(f),
            None => units.push((f.at, vec![f])),
        }
    }
    let mut out: Vec<&FrameEntry> = Vec::new();
    for (_at, list) in units {
        if list.len() < 2 {
            out.extend(list);
            continue;
        }
        let hits: Vec<&FrameEntry> = list
            .iter()
            .copied()
            .filter(|f| {
                let region = f.region.clone().unwrap_or_default();
                if let Some(c) = image_re.captures(&region) {
                    if let Some(m) = c.get(1) {
                        if let Some(n) = m.as_str().parse::<u64>().ok() {
                            if ordinals.contains(&(n + 1)) {
                                return true;
                            }
                        }
                    }
                }
                let label = f.label.clone().unwrap_or_default().to_lowercase();
                tokens(&label).into_iter().any(|t| {
                    // Digits name the UNIT ordinal, not the figure.
                    !unit_word_re().is_match(&t)
                        && t.parse::<u64>().is_err()
                        && q_tokens.iter().any(|q| *q == t)
                })
            })
            .collect();
        if hits.is_empty() {
            out.extend(list);
        } else {
            out.extend(hits);
        }
    }
    out.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// One region's fresh inspection, as the transport resolved it. `state`
/// carries the shipped region state with the TS fallback already applied
/// (`region_state ?? (text ? "recognised" : "skipped")`).
#[derive(Debug, Clone)]
pub struct RegionFrame {
    pub region: String,
    pub state: String,
    pub png: Vec<u8>,
    pub text: String,
    pub engine: String,
    pub language: String,
}

/// The inspection seam. Async in the BoxFuture form (the workspace carries
/// no async-trait dependency): the ruke-server implementation runs the
/// documents.parse ML job scoped to EXACTLY the region ids it is handed, and
/// resolves to an empty Vec on every failure (transport fault, cancel,
/// contract drift) — the reread never throws.
pub trait RegionInspector: Send + Sync {
    fn inspect(
        &self,
        src: &Path,
        regions: &[String],
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Vec<RegionFrame>> + Send + '_>>;
}

/// `RereadOutcome` — per-region lines for this turn's evidence block, and
/// the region ids actually re-inspected (the invocation proof).
#[derive(Debug, Clone, Default)]
pub struct RereadOutcome {
    pub lines: Vec<String>,
    pub regions: Vec<String>,
}

/// `rereadRegions`. `cue_units` are the retrieved passages' unit cues
/// (ev.pageCues); the question-named unit wins over them (see module docs).
/// `missing_passage` = THIS attachment's retrieval came up empty: F153 §3,
/// a MISSING retrieved passage is a reason to try a targeted read when the
/// original is available. The question's own named unit is the targeting
/// (the cue set is empty when nothing was retrieved); a missing-passage
/// question naming no unit targets nothing and runs ZERO inspection.
pub async fn reread_regions(
    root: &Path,
    embedder: &dyn QueryEmbedder,
    inspector: &dyn RegionInspector,
    att_id: &str,
    question: &str,
    index: &LoadedIndex,
    cue_units: &[f64],
    missing_passage: bool,
    token: &CancellationToken,
) -> RereadOutcome {
    // Region resolution: when the question itself names a unit ("the legend
    // on slide 2"), THAT is the requested figure. A request that names no
    // unit falls back to the units the retrieved passages name.
    let mut named: Vec<f64> = Vec::new();
    for c in named_unit_re().captures_iter(question) {
        if let Some(m) = c.get(1) {
            if let Ok(n) = m.as_str().parse::<f64>() {
                if n.is_finite() && n > 0.0 && !named.contains(&n) {
                    named.push(n);
                }
            }
        }
    }
    // F153 §3 (⇔ reread.ts): a missing retrieved passage is a targeted-read
    // reason; the question's own named unit is the targeting. Naming no unit
    // targets nothing.
    let targets_named = missing_passage && !named.is_empty();
    let units: Vec<f64> = if !named.is_empty() {
        named
    } else {
        cue_units.to_vec()
    };
    let frames: Vec<&FrameEntry> = pick_region_frames(
        index
            .meta
            .frames
            .iter()
            .filter(|f| f.region.is_some() && f.label.is_some() && units.contains(&f.at))
            .collect(),
        question,
    );
    if frames.is_empty() || !(reread_request().is_match(question) || targets_named) {
        return RereadOutcome::default();
    }
    let Some(src): Option<PathBuf> = store::upload_path(root, att_id) else {
        return RereadOutcome::default();
    };
    let regions: Vec<String> = frames.iter().filter_map(|f| f.region.clone()).collect();
    let inspected = inspector.inspect(&src, &regions, token).await;
    if token.is_cancelled() {
        return RereadOutcome::default(); // ⇔ TS abort: no durable writes after cancel
    }

    let mut updates: Vec<RegionRereadUpdate> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for f in &frames {
        let Some(region) = f.region.as_ref() else { continue };
        let Some(vf) = inspected.iter().find(|v| v.region == *region) else {
            continue;
        };
        let label = f.label.clone().unwrap_or_default();
        let text = vf.text.trim().to_string();
        let eng = [vf.engine.as_str(), vf.language.as_str()]
            .iter()
            .filter(|p| !p.is_empty())
            .cloned()
            .collect::<Vec<&str>>()
            .join(" / ");
        // Dedup law: identical text already persisted for THIS region id is
        // reused, never appended twice; identical labels in DIFFERENT places
        // stay separate because region ids (the dedup key) differ.
        let head: String = text.chars().take(80).collect();
        let needle = format!("region {region}]");
        let already = !head.is_empty()
            && index
                .chunks
                .iter()
                .any(|c| c.text.contains(&needle) && c.text.contains(&head));
        if vf.png.is_empty() {
            continue;
        }
        let eng_label = if eng.is_empty() {
            "the selected engine".to_string()
        } else {
            eng.clone()
        };
        let chunk_text = if !text.is_empty() && !already {
            Some(format!(
                "### {label}\n[text re-read by {eng_label}, region {region}]\n{text}"
            ))
        } else {
            None
        };
        let mut vec: Vec<f64> = Vec::new();
        if let Some(ct) = &chunk_text {
            // embed unavailable: the text serves THIS turn only; no
            // half-vector chunk.
            vec = embedder.embed_one(ct, token).unwrap_or_default();
        }
        updates.push(RegionRereadUpdate {
            file: f.file.clone(),
            bytes: vf.png.clone(),
            state: vf.state.clone(),
            text: chunk_text,
            vec,
        });
        if !text.is_empty() && !already {
            let eng_part = if eng.is_empty() {
                String::new()
            } else {
                format!(", engine {eng}")
            };
            lines.push(format!(
                "[re-read of {label}, region {region}{eng_part}]\n{text}"
            ));
        } else if text.is_empty() {
            lines.push(format!(
                "[re-read of {label}, region {region}]: the inspection ran again and \
                 recovered no text (state {}); the refreshed picture is what this turn \
                 answers from.",
                vf.state
            ));
        }
        // already → the passage is retrieved as cached evidence; no
        // duplicate line.
    }
    if !updates.is_empty() {
        store::apply_region_reread(root, att_id, &updates);
    }
    let out_regions = if updates.is_empty() {
        Vec::new()
    } else {
        frames
            .iter()
            .filter(|f| updates.iter().any(|u| u.file == f.file))
            .filter_map(|f| f.region.clone())
            .collect()
    };
    RereadOutcome {
        lines,
        regions: out_regions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEmbedder;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::path::PathBuf;

    const PNG_B64_HINT: &[u8] = b"OLD";
    const NEW_PNG: &[u8] = b"NEW";
    const OCR_TEXT: &str = "VOLTAGE 240 legend for the intake chart";

    /// Records the region scopes of every inspection call and answers with
    /// fresh pixels + recovered text for EXACTLY the regions handed in
    /// (mirrors the python `payload.regions` filter the TS spec mocks).
    struct MockInspector {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl RegionInspector for MockInspector {
        fn inspect(
            &self,
            _src: &Path,
            regions: &[String],
            _token: &CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Vec<RegionFrame>> + Send + '_>> {
            let regs = regions.to_vec();
            Box::pin(async move {
                self.calls.lock().push(regs.clone());
                regs.into_iter()
                    .map(|r| RegionFrame {
                        region: r,
                        state: "recognised".into(),
                        png: NEW_PNG.to_vec(),
                        text: OCR_TEXT.into(),
                        engine: "tesseract".into(),
                        language: "eng".into(),
                    })
                    .collect()
            })
        }
    }

    /// Seed one attachment: two slides (each a region frame), the durable
    /// upload, and frame bytes on disk — the frozen TS spec's shape.
    fn seed(root: &Path, att: &str, r1: &str, r2: &str) {
        let dir = crate::store::index_dir(root, att).unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames/d_001.png"), PNG_B64_HINT).unwrap();
        std::fs::write(dir.join("frames/d_002.png"), PNG_B64_HINT).unwrap();
        let meta = json!({
            "attId": att, "name": "deck.pptx", "category": "office", "createdAt": 0,
            "chunkCount": 2, "spine": "", "spineBlocks": [],
            "frames": [
                {"at": 1.0, "file": "frames/d_001.png", "label": "slide 1", "region": r1, "state": "recognised"},
                {"at": 2.0, "file": "frames/d_002.png", "label": "slide 2", "region": r2, "state": "skipped"},
            ],
        });
        std::fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
        let pad = |s: &str| {
            let mut t = s.to_string();
            while t.len() < 200 {
                t.push('q');
            }
            t
        };
        let lines = [
            json!({"i": 0, "startSec": null, "endSec": null, "vec": [], "text": pad("### slide 1\nInspection image: the AMBER CLOSE trend chart marker.")}),
            json!({"i": 1, "startSec": null, "endSec": null, "vec": [], "text": pad("### slide 2\nQuarterly staffing roster for the depot: intake and output.")}),
        ];
        std::fs::write(
            dir.join("chunks.jsonl"),
            format!("{}\n", lines.map(|l| l.to_string()).join("\n")),
        )
        .unwrap();
        let up = root.join(".data").join("uploads");
        std::fs::create_dir_all(&up).unwrap();
        std::fs::write(up.join(format!("{att}.pptx")), b"deck bytes").unwrap();
    }

    fn read_meta_frames(root: &Path, att: &str) -> serde_json::Value {
        let dir: PathBuf = crate::store::index_dir(root, att).unwrap();
        let m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        m["frames"].clone()
    }

    fn read_chunk_lines(root: &Path, att: &str) -> Vec<String> {
        let dir: PathBuf = crate::store::index_dir(root, att).unwrap();
        std::fs::read_to_string(dir.join("chunks.jsonl"))
            .unwrap()
            .split('\n')
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    }

    #[tokio::test]
    async fn only_the_question_named_region_re_runs_and_serves_this_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr10", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        // Cue set WIDER than the asked figure (adjacency expansion): the
        // question naming slide 2 must win — slide 1 is never re-inspected.
        let index = crate::store::read_index(root, "att_rr10").unwrap();
        let q = "look closer at the staffing roster on slide 2 — what does the small legend label say?";
        let out = reread_regions(root, &embed, &insp, "att_rr10", q, &index, &[1.0, 2.0], false, &token).await;

        assert_eq!(insp.calls.lock().clone(), vec![vec![r2.to_string()]]);
        assert_eq!(out.regions, vec![r2.to_string()]);
        let joined = out.lines.join("\n");
        assert!(joined.contains(OCR_TEXT));
        assert!(joined.contains(&format!("region {r2}")));
        assert!(joined.contains("engine tesseract / eng"));

        // Durable refresh: ONLY the selected region changes.
        let frames = read_meta_frames(root, "att_rr10");
        assert_eq!(frames[1]["state"], json!("recognised"));
        assert_eq!(frames[0]["state"], json!("recognised")); // seeded, untouched
        let dir = crate::store::index_dir(root, "att_rr10").unwrap();
        assert_eq!(std::fs::read(dir.join("frames/d_002.png")).unwrap(), NEW_PNG);
        assert_eq!(std::fs::read(dir.join("frames/d_001.png")).unwrap(), PNG_B64_HINT);

        // The recovered passage persists with its unit header + region id,
        // exactly once, on the TEXT axis (startSec null).
        let chunks = read_chunk_lines(root, "att_rr10");
        assert_eq!(chunks.len(), 3);
        assert!(chunks[2].contains("### slide 2"));
        assert!(chunks[2].contains(&format!("region {r2}]")));
        assert!(chunks[2].contains(OCR_TEXT));
        let v: serde_json::Value = serde_json::from_str(&chunks[2]).unwrap();
        assert_eq!(v["startSec"], serde_json::Value::Null);
        assert_eq!(v["vec"], json!([0.5, 0.25]));
    }

    #[tokio::test]
    async fn a_request_naming_no_unit_falls_back_to_the_cue_units() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr20", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr20").unwrap();
        let out = reread_regions(root, &embed, &insp, "att_rr20", "zoom in", &index, &[2.0], false, &token).await;
        assert_eq!(insp.calls.lock().clone(), vec![vec![r2.to_string()]]);
        assert_eq!(out.regions, vec![r2.to_string()]);
    }

    #[tokio::test]
    async fn a_missing_passage_named_unit_is_a_read_reason_without_closer_read_phrasing() {
        // F153 §3: retrieval found NOTHING; the question names slide 2.
        // That alone triggers the targeted read of the named region — no
        // closer-read phrasing, no cue units. ⇔ the TS spec's att_reread5.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr25", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr25").unwrap();
        let q = "According to attached deck, what does small legend on slide 2 say?";
        let out = reread_regions(root, &embed, &insp, "att_rr25", q, &index, &[], true, &token).await;
        assert_eq!(insp.calls.lock().clone(), vec![vec![r2.to_string()]],
                   "the named unit's region only; slide 1 ran ZERO invocations");
        assert_eq!(out.regions, vec![r2.to_string()]);
        assert!(out.lines.join("\n").contains(OCR_TEXT));
    }

    #[tokio::test]
    async fn a_missing_passage_naming_no_unit_runs_zero_inspection() {
        // F153 §3 targeting guard: a missing passage with no named unit
        // targets NOTHING — the read never becomes a whole-document sweep.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr26", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr26").unwrap();
        let out = reread_regions(
            root, &embed, &insp, "att_rr26",
            "what does the small legend say?", &index, &[], true, &token,
        ).await;
        assert!(out.lines.is_empty() && out.regions.is_empty());
        assert!(insp.calls.lock().is_empty(), "zero inspections, not a sweep");
    }

    #[tokio::test]
    async fn an_ordinary_question_with_evidence_names_a_unit_and_still_runs_zero_inspection() {
        // Control for the same gate: naming a unit is NOT a reason while
        // retrieval HAS passages (missing_passage = false) and the question
        // carries no closer-read phrasing — cached evidence stands.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr27", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr27").unwrap();
        let q = "According to attached deck, what does small legend on slide 2 say?";
        let out = reread_regions(root, &embed, &insp, "att_rr27", q, &index, &[2.0], false, &token).await;
        assert!(out.lines.is_empty() && out.regions.is_empty());
        assert!(insp.calls.lock().is_empty());
    }

    #[tokio::test]
    async fn a_repeat_reread_refreshes_pixels_but_never_duplicates_the_text() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr30", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let q = "look closer at the legend on slide 2";
        let first = reread_regions(root, &embed, &insp, "att_rr30", q, &crate::store::read_index(root, "att_rr30").unwrap(), &[2.0], false, &token).await;
        assert_eq!(first.regions, vec![r2.to_string()]);
        assert!(first.lines.join("\n").contains(OCR_TEXT));

        let index2 = crate::store::read_index(root, "att_rr30").unwrap();
        let second = reread_regions(root, &embed, &insp, "att_rr30", q, &index2, &[2.0], false, &token).await;
        assert_eq!(insp.calls.lock().len(), 2); // the inspection ran again (that's the request)
        assert!(second.lines.is_empty()); // identical text is reused, not appended twice
        let chunks = read_chunk_lines(root, "att_rr30");
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks.iter().filter(|c| c.contains(OCR_TEXT)).count(), 1);
    }

    #[tokio::test]
    async fn no_closer_read_phrasing_and_no_source_run_zero_inspections() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pptx:1:ppt/media/image-1-1.png";
        let r2 = "pptx:2:ppt/media/image-2-1.png";
        seed(root, "att_rr40", r1, r2);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let q = "According to the attached deck, what does the AMBER CLOSE marker on slide 1 mean?";
        let out = reread_regions(root, &embed, &insp, "att_rr40", q, &crate::store::read_index(root, "att_rr40").unwrap(), &[1.0], false, &token).await;
        assert!(out.lines.is_empty() && out.regions.is_empty());
        assert!(insp.calls.lock().is_empty());

        // A document whose original bytes are gone: no source to re-render.
        std::fs::remove_file(root.join(".data").join("uploads").join("att_rr40.pptx")).unwrap();
        let q2 = "zoom in on the slide 2 legend";
        let out2 = reread_regions(root, &embed, &insp, "att_rr40", q2, &crate::store::read_index(root, "att_rr40").unwrap(), &[2.0], false, &token).await;
        assert!(out2.lines.is_empty() && out2.regions.is_empty());
        assert!(insp.calls.lock().is_empty());
    }

    /// Seed TWO figures on the SAME page (the amended brief's exact case).
    fn seed_same_page(root: &Path, att: &str, labels: [(&str, &str); 2]) {
        let dir = crate::store::index_dir(root, att).unwrap();
        std::fs::create_dir_all(dir.join("frames")).unwrap();
        std::fs::write(dir.join("frames/d_001.png"), PNG_B64_HINT).unwrap();
        std::fs::write(dir.join("frames/d_002.png"), PNG_B64_HINT).unwrap();
        let meta = json!({
            "attId": att, "name": "survey.pdf", "category": "document", "createdAt": 0,
            "chunkCount": 1, "spine": "", "spineBlocks": [],
            "frames": [
                {"at": 1.0, "file": "frames/d_001.png", "label": labels[0].0, "region": labels[0].1, "state": "recognised"},
                {"at": 1.0, "file": "frames/d_002.png", "label": labels[1].0, "region": labels[1].1, "state": "skipped"},
            ],
        });
        std::fs::write(dir.join("meta.json"), meta.to_string()).unwrap();
        let pad = |s: &str| {
            let mut t = s.to_string();
            while t.len() < 200 {
                t.push('q');
            }
            t
        };
        std::fs::write(
            dir.join("chunks.jsonl"),
            format!("{}\n", json!({"i": 0, "startSec": null, "endSec": null, "vec": [],
                "text": pad("### page 1\nProse: the survey ran eleven trials; KAPPA crossed the threshold.")})),
        )
        .unwrap();
        let up = root.join(".data").join("uploads");
        std::fs::create_dir_all(&up).unwrap();
        std::fs::write(up.join(format!("{att}.pdf")), b"pdf bytes").unwrap();
    }

    #[tokio::test]
    async fn two_figures_on_one_page_reread_names_exactly_one() {
        // Selecting by UNIT re-inspected EVERY picture on the page and mixed
        // their text. The figure ordinal in the question must scope the job to
        // EXACTLY one region; the neighbour ran ZERO invocations.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pdf:1:page:1/image:0";
        let r2 = "pdf:1:page:1/image:1";
        seed_same_page(root, "att_rr50", [("page 1, figure 1", r1), ("page 1, figure 2", r2)]);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr50").unwrap();
        let q = "zoom in on figure 2 on page 1 — what does its label say?";
        let out = reread_regions(root, &embed, &insp, "att_rr50", q, &index, &[1.0], false, &token).await;
        assert_eq!(insp.calls.lock().clone(), vec![vec![r2.to_string()]],
                   "the named figure's crop only; the neighbour ran ZERO invocations");
        assert_eq!(out.regions, vec![r2.to_string()]);
        assert!(out.lines.join("\n").contains(OCR_TEXT));
        let frames = read_meta_frames(root, "att_rr50");
        assert_eq!(frames[1]["state"], json!("recognised"));
        assert_eq!(frames[0]["state"], json!("recognised")); // seeded, untouched
        assert_eq!(std::fs::read(
            crate::store::index_dir(root, "att_rr50").unwrap().join("frames/d_001.png")).unwrap(),
            PNG_B64_HINT, "the neighbour's pixels stand untouched");
    }

    #[tokio::test]
    async fn a_question_naming_a_cell_anchor_scopes_to_that_figure() {
        // Office labels name the anchor ("sheet 2, cell C4"): the word the
        // question shares with ONE label selects it; the digit (the unit
        // ordinal) never decides.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let rc4 = "xlsx:2:xl/media/image2-1.png";
        let rd9 = "xlsx:2:xl/media/image2-2.png";
        seed_same_page(root, "att_rr60", [("sheet 2, cell C4", rc4), ("sheet 2, cell D9", rd9)]);
        // Both frames sit on unit 2 for this scenario.
        let dir = crate::store::index_dir(root, "att_rr60").unwrap();
        let mut m: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        m["frames"][0]["at"] = json!(2.0);
        m["frames"][1]["at"] = json!(2.0);
        std::fs::write(dir.join("meta.json"), m.to_string()).unwrap();
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr60").unwrap();
        let q = "look closer at the picture at C4";
        let out = reread_regions(root, &embed, &insp, "att_rr60", q, &index, &[2.0], false, &token).await;
        assert_eq!(insp.calls.lock().clone(), vec![vec![rc4.to_string()]]);
        assert_eq!(out.regions, vec![rc4.to_string()]);
    }

    #[tokio::test]
    async fn a_question_naming_no_figure_keeps_the_whole_unit_in_scope() {
        // The narrowing must never shrink scope to nothing: a closer read that
        // names the page but no figure re-inspects BOTH figures.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r1 = "pdf:1:page:1/image:0";
        let r2 = "pdf:1:page:1/image:1";
        seed_same_page(root, "att_rr70", [("page 1, figure 1", r1), ("page 1, figure 2", r2)]);
        let insp = MockInspector { calls: Mutex::new(Vec::new()) };
        let embed = FixedEmbedder(vec![0.5, 0.25]);
        let token = CancellationToken::new();
        let index = crate::store::read_index(root, "att_rr70").unwrap();
        let out = reread_regions(root, &embed, &insp, "att_rr70", "zoom in on page 1", &index, &[1.0], false, &token).await;
        let calls = insp.calls.lock().clone();
        assert_eq!(calls, vec![vec![r1.to_string(), r2.to_string()]]);
        assert_eq!(out.regions, vec![r1.to_string(), r2.to_string()]);
    }

    #[test]
    fn reread_request_matches_only_explicit_closer_reads() {
        let hit = |q: &str| reread_request().is_match(q);
        // Explicit requests (the TS literal's own branches).
        assert!(hit("look closer at the legend"));
        assert!(hit("take a closer look at slide 2"));
        assert!(hit("re-read that label"));
        assert!(hit("zoom in"));
        assert!(hit("Zoom In on the chart"));
        assert!(hit("enlarge the figure"));
        assert!(hit("in more detail please"));
        assert!(hit("give me more detail on the roster"));
        assert!(hit("can you read the small print"));
        assert!(hit("read the label on the chart"));
        assert!(hit("inspect it closer"));
        assert!(hit("show it up close"));
        // Ordinary questions ride the cached evidence: ZERO work.
        assert!(!hit("which coloured line crosses the threshold?"));
        assert!(!hit("what does the AMBER CLOSE marker mean?"));
        assert!(!hit("how many slides mention the depot?"));
        assert!(!hit("summarize the deck"));
    }

    #[test]
    fn named_units_take_the_digit_group_case_insensitively() {
        let units = |q: &str| -> Vec<f64> {
            let mut out = Vec::new();
            for c in named_unit_re().captures_iter(q) {
                if let Some(m) = c.get(1) {
                    if let Ok(n) = m.as_str().parse::<f64>() {
                        if n.is_finite() && n > 0.0 && !out.contains(&n) {
                            out.push(n);
                        }
                    }
                }
            }
            out
        };
        assert_eq!(units("the legend on Slide 2"), vec![2.0]);
        assert_eq!(units("page #12 and PAGE 13"), vec![12.0, 13.0]);
        assert_eq!(units("figure 3, sheet 4, unit 5"), vec![3.0, 4.0, 5.0]);
        // A "page " prefix with no digits is not a unit; no naming → empty.
        assert_eq!(units("a page of prose with no digits"), Vec::<f64>::new());
    }
}
