//! Port of `lib/server/titles/generate.ts` — title planning through the
//! MAIN model, single-call for ≤12 000-char transcripts and map-reduce
//! (summarize chunks → title the summaries) above that.
//!
//! Seam model: TS `CallModel` returns `null` on upstream failure and
//! THROWS only when its inner controller aborts (the 150 s timer aborts
//! the INNER controller; the outer signal is bridged to it). `planTitle`
//! catches any throw → `null`, and the QUEUE separately checks the outer
//! AbortController to classify "yielded to user inference". Rust models
//! the seam as `Option<String>`: timeout, abort, connect failure and bad
//! responses all yield `None` — the queue's yield detection rides the
//! token itself, which only the inference-slot registry cancels, so a
//! 150 s timeout keeps the RETRY path (never yields), exactly like TS.
//!
//! RECORDED MICRO-DIVERGENCES:
//! - The Rust guards below are hand-built from the EXACT ECMAScript `\s`
//!   member set (see `WSI`) instead of the regex crate's `\s`, so the
//!   collapse/prose guards carry no U+0085-in / U+FEFF-out drift. `\d`
//!   is likewise pinned to ASCII `[0-9]`.
//! - `\b` in the refusal guard: JS is ASCII-word (`\w` = [A-Za-z0-9_]),
//!   Rust is Unicode-word. Divergence only for titles where a Unicode
//!   letter/digit sits directly against the I/we or can't/know edges.
//! - JS's quote-strip is one global alternation `^q+|q+$`; Rust runs the
//!   head strip then the tail strip. The scanner semantics coincide for
//!   these two anchored branches (each branch can match at exactly one
//!   position, and a head match never removes characters that would have
//!   been members of the tail's quote class).
//! - The TS `planTitle` catch logs a warn when the fetch rejects
//!   (connect error / abort / timeout); Rust logs the equivalent warns
//!   inside [`HttpTitleModel`] instead. Log placement differs, plan
//!   result identical.

use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::{Map, Number, Value};
use tokio_util::sync::CancellationToken;

use ruke_core::settings::SettingsStore;
use ruke_skills::jsstr;

use crate::titles::transcript::{build_transcript, chunk_turns, format_transcript, transcript_chars};

pub const TITLE_TRANSCRIPT_CHARS: usize = 12000;
pub const TITLE_CHUNK_CHARS: usize = 5000;
pub const TITLE_CALL_TIMEOUT_MS: u64 = 150_000;

pub const TITLE_SYSTEM: &str = concat!(
    "You write the single best sidebar title for one past conversation. ",
    "Read the whole conversation in order and name its central, recurring subject — ",
    "not the first message, not the latest message, not the longest reply. ",
    "Title rules: 3 to 7 words; at most 60 characters; specific (name the actual ",
    "subject or task); natural and human-readable; never copy a prompt sentence; ",
    "one topic only, no subtopic lists; factual, invent nothing; no quotes, no ",
    "\"Title:\" prefix, no trailing punctuation, no explanation. ",
    "Reply with ONLY the title text on a single line.",
);

pub const SUMMARY_SYSTEM: &str = concat!(
    "These are consecutive messages from one part of a longer conversation. ",
    "In ONE line of at most 15 words, state what this part is about, including ",
    "any topic shift. Reply with the line only — no preamble, no quotes.",
);

/// ECMAScript regex `\s` members (WhiteSpace ∪ LineTerminator ∪ Zs ∪
/// FEFF; NO U+0085) as a regex class-body fragment — identical to
/// `jsstr::is_js_ws` (see the note there), NOT the regex crate's `\s`.
const WSI: &str = r"\u{9}\u{a}\u{b}\u{c}\u{d}\u{20}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

static TITLE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)^[{WSI}]*(?:suggested[{WSI}]+)?(?:conversation[{WSI}]+)?title[{WSI}]*[:\-–—][{WSI}]*")).unwrap()
});
static BULLET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{WSI}]*[-*•][{WSI}]+")).unwrap()
});
static NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{WSI}]*[0-9]+[.)][{WSI}]+")).unwrap()
});
static INTRO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^[{WSI}]*(?:this|the)[{WSI}]+conversation[{WSI}]+(?:is[{WSI}]+about|covers|discusses|deals[{WSI}]+with|is[{WSI}]+regarding|revolves[{WSI}]+around)[{WSI}]+"
    )).unwrap()
});
static TRAIL_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?;:]+\z").unwrap());
static QUOTES_HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\A[\x22\x27\x{201c}\x{201d}\x{2018}\x{2019}\x60]+"#).unwrap());
static QUOTES_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\x22\x27\x{201c}\x{201d}\x{2018}\x{2019}\x60]+\z"#).unwrap());
static PROSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"\.[{WSI}]+[^{WSI}]")).unwrap()
});
static REFUSAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)\b(?:I|we)[{WSI}]+(?:can(?:not|'t)|will[{WSI}]+not|am[{WSI}]+unable|don'?t[{WSI}]+know)\b")).unwrap()
});
static CUT_TRAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"[.!?;:,{WSI}]+\z")).unwrap()
});

/// `raw.split(/\r?\n/)[0]` — JS `/\r?\n/` splits ONLY at "\n" (a lone "\r"
/// is not a separator); a "\r" directly before the "\n" belongs to the
/// separator.
fn first_line(s: &str) -> &str {
    match s.find('\n') {
        Some(i) if i > 0 && &s[i - 1..i] == "\r" => &s[..i - 1],
        Some(i) => &s[..i],
        None => s,
    }
}

/// `cut.lastIndexOf(" ")` — UTF-16 unit index of the last SPACE char
/// (precisely U+0020, not any whitespace).
fn last_space_unit(s: &str) -> Option<usize> {
    let mut units = 0usize;
    let mut last = None;
    for c in s.chars() {
        if c == ' ' {
            last = Some(units);
        }
        units += if (c as u32) > 0xFFFF { 2 } else { 1 };
    }
    last
}

/// `normalizeTitle` — the verbatim guard ladder. `None`/`""` ⇒ `null`
/// (`if (!raw) return null`).
pub fn normalize_title(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let mut t = first_line(raw).to_string();
    t = TITLE_PREFIX.replace(&t, "").into_owned();
    t = BULLET.replace(&t, "").into_owned();
    t = NUM.replace(&t, "").into_owned();
    t = INTRO.replace(&t, "").into_owned();
    // `.replace(/[.!?;:]+$/, "").replace(/^["'…]+|["'…]+$/g, "").replace(/[.!?;:]+$/, "")`
    t = TRAIL_PUNCT.replace(&t, "").into_owned();
    t = QUOTES_HEAD.replace(&t, "").into_owned();
    t = QUOTES_TAIL.replace(&t, "").into_owned();
    t = TRAIL_PUNCT.replace(&t, "").into_owned();
    let collapsed = jsstr::js_collapse(&t);
    t = jsstr::js_trim(&collapsed).to_string();
    if jsstr::js_len(&t) < 2 {
        return None;
    }
    if PROSE.is_match(&t) {
        return None; // "Foo. Bar" ⇒ still reads like prose ⇒ the model failed the brief
    }
    if REFUSAL.is_match(&t) {
        return None;
    }
    if jsstr::js_len(&t) > 60 {
        let cut = jsstr::js_slice_head(&t, 60);
        let base = match last_space_unit(&cut) {
            Some(u) if u >= 40 => jsstr::js_slice_head(&cut, u),
            _ => cut.clone(),
        };
        let stripped = CUT_TRAIL.replace(&base, "");
        t = jsstr::js_trim(&stripped).to_string();
    }
    if jsstr::js_split_ws(&t).len() > 12 {
        return None;
    }
    if jsstr::js_len(&t) >= 2 {
        Some(t)
    } else {
        None
    }
}

/// The upstream seam. TS contract: resolve `null` on a failed/empty
/// upstream call; the OUTER token is cancelled only by the inference-slot
/// registry (user inference steals the slot) — the 150 s timer never
/// touches it, so a timeout is a failed ATTEMPT, not a yield.
pub trait TitleCallModel: Send + Sync + 'static {
    fn call(
        &self,
        system: String,
        user: String,
        model: String,
        max_tokens: u32,
        token: CancellationToken,
    ) -> BoxFuture<'static, Option<String>>;
}

/// Stand-in for builds/tests without an upstream (TS has no equivalent —
/// the real module always talks to the main model).
pub struct UnconfiguredTitleModel;

impl TitleCallModel for UnconfiguredTitleModel {
    fn call(
        &self,
        _system: String,
        _user: String,
        _model: String,
        _max_tokens: u32,
        _token: CancellationToken,
    ) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

/// `callMainModel` → the real main-model HTTP call. Settings are read
/// PER CALL (a settings change mid-queue takes effect on the next
/// attempt, as in TS). Body key order is verbatim: model, stream,
/// temperature, max_tokens, reasoning_effort, messages.
pub struct HttpTitleModel {
    pub http: reqwest::Client,
    pub settings: Arc<SettingsStore>,
}

impl TitleCallModel for HttpTitleModel {
    fn call(
        &self,
        system: String,
        user: String,
        model: String,
        max_tokens: u32,
        token: CancellationToken,
    ) -> BoxFuture<'static, Option<String>> {
        let http = self.http.clone();
        let settings = Arc::clone(&self.settings);
        Box::pin(async move {
            let url = settings.llm_api_url();
            let key = settings.llm_api_key();
            let mut body = Map::new();
            // `model: model || "default"` — empty is falsy in JS.
            body.insert("model".into(), Value::String(if model.is_empty() { "default".to_string() } else { model }));
            body.insert("stream".into(), Value::Bool(false));
            body.insert("temperature".into(), Number::from_f64(0.2).map(Value::Number).unwrap());
            body.insert("max_tokens".into(), Value::Number(Number::from(max_tokens as u64)));
            body.insert("reasoning_effort".into(), Value::String("none".into()));
            let mut messages = Vec::with_capacity(2);
            for (role, content) in [("system", system), ("user", user)] {
                let mut msg = Map::new();
                msg.insert("role".into(), Value::String(role.into()));
                msg.insert("content".into(), Value::String(content));
                messages.push(Value::Object(msg));
            }
            body.insert("messages".into(), Value::Array(messages));

            let fut = {
                let url = url.clone();
                async move {
                    let res = match http
                        .post(&url)
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
                        .body(serde_json::to_string(&body).unwrap_or_default())
                        .send()
                        .await
                    {
                        Ok(r) => r,
                        // TS: fetch rejects → planTitle catch (warn + null).
                        Err(e) => {
                            tracing::warn!("title model request to {url} failed: {e}");
                            return None;
                        }
                    };
                    if !res.status().is_success() {
                        return None; // `if (!res.ok) return null` — silent
                    }
                    // `res.json()` ⇔ text + parse (the reqwest `json`
                    // feature is off workspace-wide); read or parse failure
                    // rides the same catch.
                    let text = match res.text().await {
                        Ok(t) => t,
                        Err(_) => return None,
                    };
                    let data: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => return None, // `res.json().catch(() => null)`
                    };
                    let content = data.get("choices")?.get(0)?.get("message")?.get("content")?;
                    // `typeof content === "string" && content.trim() ? content : null`
                    // — the RAW (untrimmed) content wins when it trims non-empty.
                    match content {
                        Value::String(s) if !jsstr::js_trim(s).is_empty() => Some(s.clone()),
                        _ => None,
                    }
                }
            };

            // biased: token first ⇒ a pre-aborted signal issues NO request
            // (Node: fetch on an already-aborted signal rejects outright).
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    tracing::warn!("title model call aborted (user inference) for {url}");
                    None
                }
                r = tokio::time::timeout(Duration::from_millis(TITLE_CALL_TIMEOUT_MS), fut) => {
                    match r {
                        Err(_) => {
                            // TS: the 150 s timer aborts the INNER fetch ⇒
                            // reject ⇒ warn + null; the outer signal is untouched.
                            tracing::warn!("title model call timed out after {TITLE_CALL_TIMEOUT_MS} ms for {url}");
                            None
                        }
                        Ok(v) => v,
                    }
                }
            }
        })
    }
}

/// `planTitle` — never fails upward (TS catches every throw → null; the
/// Rust seam already swallows everything into `None`).
pub async fn plan_title(
    messages: &Value,
    model: Option<&str>,
    call: &dyn TitleCallModel,
    token: &CancellationToken,
) -> Option<String> {
    let turns = build_transcript(messages);
    if !turns.iter().any(|t| t.role == "assistant") {
        return None; // nothing the model can summarize into a title
    }
    let model: &str = match model {
        Some(m) if !m.is_empty() => m, // `opts.model || "default"`
        _ => "default",
    };
    if transcript_chars(&turns) <= TITLE_TRANSCRIPT_CHARS {
        let raw = call.call(TITLE_SYSTEM.to_string(), format_transcript(&turns), model.to_string(), 24, token.clone()).await;
        return normalize_title(raw.as_deref());
    }
    let chunks = chunk_turns(&turns, TITLE_CHUNK_CHARS);
    let n = chunks.len();
    let mut summaries: Vec<String> = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let raw = call.call(
            SUMMARY_SYSTEM.to_string(),
            format!("Part {} of {}:\n{}", i + 1, n, format_transcript(chunk)),
            model.to_string(),
            48,
            token.clone(),
        )
        .await;
        if let Some(s) = raw {
            // `const line = s?.replace(/\s+/g, " ").trim(); if (line) summaries.push(line);`
            let collapsed = jsstr::js_collapse(&s);
            let line = jsstr::js_trim(&collapsed);
            if !line.is_empty() {
                summaries.push(line.to_string());
            }
        }
    }
    if summaries.is_empty() {
        return None;
    }
    let raw = call.call(TITLE_SYSTEM.to_string(), summaries.join("\n"), model.to_string(), 24, token.clone()).await;
    normalize_title(raw.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(raw: Option<&str>) -> Option<String> {
        normalize_title(raw)
    }

    #[test]
    fn first_line_pins_js_split_semantics() {
        assert_eq!(first_line("a\nb"), "a");
        assert_eq!(first_line("a\r\nb"), "a");
        // JS /\r?\n/ consumes ONE \r as part of the separator; a lone \r never splits.
        assert_eq!(first_line("a\r\r\nb"), "a\r");
        assert_eq!(first_line("only\r\n"), "only");
        assert_eq!(first_line("lone \r cr"), "lone \r cr");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn normalize_title_guard_ladder() {
        assert_eq!(n(None), None);
        assert_eq!(n(Some("")), None);
        assert_eq!(n(Some("  ")), None); // collapses+trims to "" ⇒ <2
        assert_eq!(n(Some("Line one\nLine two")), Some("Line one".into())); // FIRST line only
        assert_eq!(n(Some("Title: Rust Porting Plan")), Some("Rust Porting Plan".into()));
        assert_eq!(
            n(Some("Suggested conversation title — Sidebar Titles")),
            Some("Sidebar Titles".into())
        );
        assert_eq!(n(Some("title - ok two words")), Some("ok two words".into()));
        assert_eq!(n(Some("- Bullet Titled")), Some("Bullet Titled".into()));
        assert_eq!(n(Some("3) Numbered Titled")), Some("Numbered Titled".into()));
        assert_eq!(n(Some("This conversation is about Rust ports")), Some("Rust ports".into()));
        assert_eq!(
            n(Some("The conversation revolves around Sidebar Titles")),
            Some("Sidebar Titles".into())
        );
        assert_eq!(n(Some("Rust porting plan!!")), Some("Rust porting plan".into()));
        assert_eq!(n(Some("\"quoted title\"")), Some("quoted title".into()));
        assert_eq!(n(Some("“smart quoted”")), Some("smart quoted".into()));
        // Trailing punct OUTSIDE quotes: first punct strip takes it, then quotes —
        // and the double punct strip keeps "…\"." variants converging:
        assert_eq!(n(Some("\"quoted title\".")), Some("quoted title".into()));
        // Ellipsis is NOT in the punct class ⇒ kept (JS [.!?;:] excludes …).
        assert_eq!(n(Some("Hmm ok…")), Some("Hmm ok…".into()));
        // first_line runs FIRST: "a\n\nb" ⇒ "a" ⇒ too short ⇒ null (the
        // collapse never sees line 2 — TS `raw.split(/\r?\n/)[0]`).
        assert_eq!(n(Some("a\n\nb")), None);
        // In-line collapse (\s+ → one space) only for same-line whitespace:
        assert_eq!(n(Some("x\t\ty z")), Some("x y z".into()));
        assert_eq!(n(Some("x y")), Some("x y".into()));
        assert_eq!(n(Some("a b")), Some("a b".into()));
        // FEFF is JS \s ⇒ stripped by collapse (Rust \s in a regex would NOT cover it).
        assert_eq!(n(Some("\u{feff}Ok feff\u{feff}")), Some("Ok feff".into()));
    }

    #[test]
    fn normalize_title_semantic_guards() {
        // Prose gate: a sentence period followed by whitespace + non-space.
        assert_eq!(n(Some("Two sentences. Right here")), None);
        assert_eq!(n(Some("Ends. With trailing punct")), None);
        assert_eq!(n(Some("Trailing dot.")), Some("Trailing dot".into())); // punct stripped BEFORE the prose test
        // Refusal gate (case-insensitive, \b-guarded).
        assert_eq!(n(Some("I cannot do that")), None);
        assert_eq!(n(Some("we CAN'T answer this")), None);
        assert_eq!(n(Some("We don't know the answer")), None);
        assert_eq!(n(Some("I am unable to help")), None);
        // 'I' inside a word is NOT a boundary ⇒ kept.
        assert_eq!(n(Some("Paris trip planner")), Some("Paris trip planner".into()));
        // Word-count gate: 13 short words fit under 60 chars ⇒ no cut, still >12.
        assert_eq!(n(Some("a b c d e f g h i j k l m")), None);
        // 12 words allowed.
        assert!(n(Some("a b c d e f g h i j k l")).is_some());
    }

    #[test]
    fn normalize_title_sixty_char_cut() {
        // 62 chars ⇒ cut at 60; the space at unit 47 ≥ 40 ⇒ word cut, edge strip.
        let t = "a".repeat(47) + " " + &"b".repeat(14);
        assert_eq!(n(Some(&t)).as_deref(), Some("a".repeat(47).as_str()));
        // Space at 41 (≥40): slice(0,41) ⇒ 41 x's.
        let hard = "x".repeat(41) + " " + &"y".repeat(30); // 72 chars
        assert_eq!(n(Some(&hard)).as_deref(), Some("x".repeat(41).as_str()));
        // Space at 2 (<40) ⇒ keep the hard 60-char cut ("ab " + 57 c's).
        let early = "ab ".to_string() + &"c".repeat(57) + "d"; // 60 units exactly +1 = 61 ⇒ cut keeps 57 c's? recompute below
        // length = 3 + 57 + 1 = 61 ⇒ cut = 60 = "ab " + 57 c; last space 2 ⇒ hard ⇒ no trailing punct/ws
        assert_eq!(n(Some(&early)).as_deref(), Some(("ab ".to_string() + &"c".repeat(57)).as_str()));
        // Hard-cut edge punct stripped by CUT_TRAIL ([.!?;:,] + JS ws):
        let hard_punct = "ab ".to_string() + &"c".repeat(55) + "!!!"; // 61 chars, no space past 2
        let cut_expect = "ab ".to_string() + &"c".repeat(55); // cut 60 = …55 c + "!!" wait compute: 3+55+3=61 ⇒ cut 60 = 3+55+2 "!" ⇒ CUT_TRAIL strips "!!" ⇒ "ab "+55 c
        assert_eq!(n(Some(&hard_punct)).as_deref(), Some(cut_expect.as_str()));
    }

    // ---- plan_title flow (scripted seam) --------------------------------

    struct Scripted {
        calls: std::sync::atomic::AtomicUsize,
        answers: Vec<Option<String>>,
        prompts: std::sync::Mutex<Vec<(String, String)>>,
    }

    impl Scripted {
        fn new(answers: Vec<Option<String>>) -> Self {
            Self {
                calls: std::sync::atomic::AtomicUsize::new(0),
                answers,
                prompts: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl TitleCallModel for Scripted {
        fn call(
            &self,
            system: String,
            user: String,
            _model: String,
            _max_tokens: u32,
            _token: CancellationToken,
        ) -> BoxFuture<'static, Option<String>> {
            let i = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.prompts.lock().unwrap().push((system, user));
            let ans = self.answers.get(i).cloned().flatten();
            Box::pin(async move { ans })
        }
    }

    fn msgs(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    /// 15 alternating user/assistant turns of ~400 chars ⇒ transcript >12 000
    /// chars ⇒ map-reduce with ≥2 chunks.
    fn long_msgs() -> Value {
        let mut parts: Vec<String> = Vec::new();
        for _ in 0..15 {
            parts.push(format!(r#"{{"role":"user","content":"{}"}}"#, "u".repeat(400)));
            parts.push(format!(r#"{{"role":"assistant","content":"{}"}}"#, "a".repeat(400)));
        }
        msgs(&format!("[{}]", parts.join(",")))
    }

    #[tokio::test]
    async fn plan_small_doc_single_call() {
        let m = Scripted::new(vec![Some("Sidebar Title Plan".into())]);
        let token = CancellationToken::new();
        let out = plan_title(
            &msgs(r#"[{"role":"user","content":"make titles server owned"},{"role":"assistant","content":"done, with a policy"}]"#),
            None,
            &m,
            &token,
        )
        .await;
        assert_eq!(out.as_deref(), Some("Sidebar Title Plan"));
        assert_eq!(m.count(), 1);
        let prompts = m.prompts.lock().unwrap();
        assert_eq!(prompts[0].0, TITLE_SYSTEM);
        assert_eq!(prompts[0].1, "user: make titles server owned\nassistant: done, with a policy");
    }

    #[tokio::test]
    async fn plan_requires_assistant_and_survives_empty_seam() {
        let m = Scripted::new(vec![]);
        let token = CancellationToken::new();
        // No assistant turn ⇒ no call at all.
        let out = plan_title(&msgs(r#"[{"role":"user","content":"hi"}]"#), None, &m, &token).await;
        assert_eq!(out, None);
        assert_eq!(m.count(), 0);
        // Seam None ⇒ plan None.
        let m = Scripted::new(vec![None]);
        let out = plan_title(
            &msgs(r#"[{"role":"user","content":"hi there now"},{"role":"assistant","content":"reply yes"}]"#),
            None,
            &m,
            &token,
        )
        .await;
        assert_eq!(out, None);
        assert_eq!(m.count(), 1);
    }

    #[tokio::test]
    async fn plan_long_doc_map_reduce() {
        let m = long_msgs();
        let turns = build_transcript(&m);
        assert!(transcript_chars(&turns) > TITLE_TRANSCRIPT_CHARS);
        let chunks = chunk_turns(&turns, TITLE_CHUNK_CHARS);
        assert!(chunks.len() >= 2);
        // answers: one summary per chunk, then the final title.
        let mut answers: Vec<Option<String>> =
            (0..chunks.len()).map(|i| Some(format!("Summary line number {i}"))).collect();
        answers.push(Some("Long Conversation Title".into()));
        let s = Scripted::new(answers);
        let token = CancellationToken::new();
        let out = plan_title(&m, Some("gpt-ish"), &s, &token).await;
        assert_eq!(out.as_deref(), Some("Long Conversation Title"));
        assert_eq!(s.count(), chunks.len() + 1);
        let prompts = s.prompts.lock().unwrap();
        assert_eq!(prompts[0].0, SUMMARY_SYSTEM);
        assert!(prompts[0].1.starts_with(&format!("Part 1 of {}:\n", chunks.len())));
        // Final call: TITLE_SYSTEM + the whitespace-collapsed summaries joined by \n.
        let (sys, user) = prompts.last().unwrap();
        assert_eq!(sys, TITLE_SYSTEM);
        assert_eq!(
            user.as_str(),
            (0..chunks.len())
                .map(|i| format!("Summary line number {i}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[tokio::test]
    async fn plan_summaries_blank_or_none_gates_out() {
        // Every summary null or whitespace ⇒ NO final call, plan None.
        let m = long_msgs();
        let turns = build_transcript(&m);
        let chunks = chunk_turns(&turns, TITLE_CHUNK_CHARS);
        let answers: Vec<Option<String>> =
            (0..chunks.len()).map(|i| if i == 0 { Some("   ".into()) } else { None }).collect();
        let s = Scripted::new(answers);
        let token = CancellationToken::new();
        let out = plan_title(&m, None, &s, &token).await;
        assert_eq!(out, None);
        assert_eq!(s.count(), chunks.len()); // NO final call
    }

    // ---- HttpTitleModel against a loopback mock -------------------------

    /// Minimal HTTP/1.1 responder: reads one request (headers + body),
    /// replies with `status_line` + `body`, and hands the raw request back
    /// through `rx`. One connection per call.
    fn mock_upstream(status_line: &'static str, body: &'static str) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                use std::io::{Read, Write};
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read until end of headers.
                let header_end = loop {
                    let read = stream.read(&mut chunk).unwrap_or(0);
                    if read == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&chunk[..read]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(pos + 4);
                    }
                };
                let Some(hs) = header_end else { continue };
                let head = String::from_utf8_lossy(&buf[..hs]).to_lowercase();
                let cl: usize = head
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                while buf.len() < hs + cl {
                    let read = stream.read(&mut chunk).unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..read]);
                }
                let _ = tx.send(buf);
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
        (format!("http://{addr}/v1/chat/completions"), rx)
    }

    fn store_with(url: &str) -> (Arc<SettingsStore>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Arc::new(SettingsStore::new(tmp.path().join("settings.json")));
        s.set_upstream_override(url, "golden-key");
        (s, tmp)
    }

    #[tokio::test]
    async fn http_model_golden_request_and_raw_content() {
        let (url, rx) = mock_upstream("200 OK", r#"{"choices":[{"message":{"content":"  Trim Me  "}}]}"#);
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        let token = CancellationToken::new();
        // plan_title end-to-end with the real HTTP seam:
        let out = plan_title(
            &msgs(r#"[{"role":"user","content":"first ask here"},{"role":"assistant","content":"reply body"}]"#),
            Some("chosen-model"),
            &model,
            &token,
        )
        .await;
        assert_eq!(out.as_deref(), Some("Trim Me")); // RAW content (untrimmed) → normalize trims
        let req = rx.recv().unwrap();
        let req = String::from_utf8_lossy(&req).into_owned();
        let head = req.split("\r\n\r\n").next().unwrap().to_string();
        assert!(head.contains("POST /v1/chat/completions"));
        assert!(head.contains("authorization: Bearer golden-key"));
        assert!(head.contains("content-type: application/json"));
        let body_json: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap().trim()).unwrap();
        // Exact key ORDER (preserve_order keeps serde insertion order ⇔ the JS literal order).
        let keys: Vec<&String> = body_json.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["model", "stream", "temperature", "max_tokens", "reasoning_effort", "messages"]);
        assert_eq!(body_json["model"], Value::String("chosen-model".into()));
        assert_eq!(body_json["temperature"], serde_json::json!(0.2));
        assert_eq!(body_json["max_tokens"], serde_json::json!(24));
        assert_eq!(body_json["reasoning_effort"], Value::String("none".into()));
        assert_eq!(body_json["messages"][0]["role"], Value::String("system".into()));
        assert_eq!(body_json["messages"][0]["content"], Value::String(TITLE_SYSTEM.into()));
        assert_eq!(body_json["messages"][1]["content"], Value::String("user: first ask here\nassistant: reply body".into()));
    }

    #[tokio::test]
    async fn http_model_non_ok_and_bad_content_yield_none() {
        let token = CancellationToken::new();
        let (url, _rx) = mock_upstream("503 Service Unavailable", "{}");
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        assert_eq!(model.call("s".into(), "u".into(), "m".into(), 24, token.clone()).await, None);
        // 200 but content null ⇒ None (no throw).
        let (url, _rx) = mock_upstream("200 OK", r#"{"choices":[{"message":{"content":null}}]}"#);
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        assert_eq!(model.call("s".into(), "u".into(), "m".into(), 24, token.clone()).await, None);
        // content that trims empty (FEFF is JS ws) ⇒ None.
        let (url, _rx) = mock_upstream("200 OK", r#"{"choices":[{"message":{"content":" \u{a0} "}}]}"#);
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        assert_eq!(model.call("s".into(), "u".into(), "m".into(), 24, token.clone()).await, None);
        // 200 but NOT json ⇒ res.json().catch(()=>null) ⇒ None.
        let (url, _rx) = mock_upstream("200 OK", "not json at all");
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        assert_eq!(model.call("s".into(), "u".into(), "m".into(), 24, token).await, None);
    }

    #[tokio::test]
    async fn http_model_pre_cancelled_token_issues_no_request() {
        let (url, rx) = mock_upstream("200 OK", r#"{"choices":[{"message":{"content":"X"}}]}"#);
        let (settings, _t) = store_with(&url);
        let model = HttpTitleModel { http: reqwest::Client::new(), settings };
        let token = CancellationToken::new();
        token.cancel(); // TS: outer signal already aborted ⇒ inner.abort() ⇒ fetch rejects WITHOUT network I/O
        let out = model.call("s".into(), "u".into(), "m".into(), 24, token).await;
        assert_eq!(out, None);
        assert!(rx.try_recv().is_err()); // nothing reached the upstream
    }
}
