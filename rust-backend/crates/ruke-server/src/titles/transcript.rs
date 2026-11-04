//! Port of `lib/server/titles/transcript.ts` — the chronological,
//! per-turn-capped transcript the title model reads. Caps are JS
//! `slice(0, N)` = UTF-16 units; collapse+trim uses the ECMAScript `\s`
//! set via `jsstr` (no Rust-regex `\s` drift).
//!
//! The assistant text is `String(m?.content ?? "")`: absent OR null
//! content ⇒ "" (never `String(null)` — that path never runs at these
//! sites), other JSON values stringify like `js_to_string` (numbers,
//! arrays via join, objects → "[object Object]").

use serde_json::Value;

use ruke_skills::jsstr;

/// User turns carry their text + attachment names up to this many units.
pub const USER_TURN_CHARS: usize = 500;
/// Assistant turns carry this many units.
pub const ASSISTANT_TURN_CHARS: usize = 400;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptTurn {
    pub role: &'static str,
    pub text: String,
}

/// `userTurnText`: raw string content, or the first parts-array part whose
/// text trims non-empty; then the `[attached: …]` note; then
/// collapse/trim/cap-500.
fn user_turn_text(m: &Value) -> String {
    let mut text = String::new();
    match m.get("content") {
        Some(Value::String(s)) => text = s.clone(),
        Some(Value::Array(parts)) => {
            for part in parts {
                if let Some(Value::String(t)) = part.get("text") {
                    if !jsstr::js_trim(t).is_empty() {
                        text = t.clone();
                        break;
                    }
                }
            }
        }
        _ => {}
    }
    let names: Vec<String> = match m.get("attachments") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|a| a.get("name").and_then(Value::as_str).map(str::to_string))
            .filter(|n| !n.is_empty()) // JS .filter(Boolean) on ""
            .collect(),
        _ => Vec::new(),
    };
    if !names.is_empty() {
        text = format!("{} [attached: {}]", text, names.join(", "));
    }
    jsstr::js_slice_head(jsstr::js_trim(&jsstr::js_collapse(&text)), USER_TURN_CHARS)
}

/// `buildTranscript`: user/assistant turns only, blank turns dropped.
pub fn build_transcript(messages: &Value) -> Vec<TranscriptTurn> {
    let Some(arr) = messages.as_array() else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for m in arr {
        // `'static` literals (not the borrowed match string) so
        // TranscriptTurn.role stays `&'static str`.
        let role: &'static str = match m.get("role").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue, // system/tool/missing/other-string roles skipped
        };
        let text = if role == "user" {
            user_turn_text(m)
        } else {
            let raw = match m.get("content") {
                // `String(m?.content ?? "")` — absent or null ⇒ "".
                None | Some(Value::Null) => String::new(),
                Some(v) => jsstr::js_to_string(v),
            };
            jsstr::js_slice_head(
                jsstr::js_trim(&jsstr::js_collapse(&raw)),
                ASSISTANT_TURN_CHARS,
            )
        };
        if text.is_empty() {
            continue;
        }
        turns.push(TranscriptTurn { role, text });
    }
    turns
}

/// `turnChars` — `text.length + role.length + 3` ("role: " separator + newline accounting
/// lives in the TS formula verbatim; the +3 IS the whole separator budget).
fn turn_chars(t: &TranscriptTurn) -> usize {
    jsstr::js_len(&t.text) + t.role.len() + 3
}

/// `transcriptChars` — sum of turn chars.
pub fn transcript_chars(turns: &[TranscriptTurn]) -> usize {
    turns.iter().map(turn_chars).sum()
}

/// `formatTranscript` — "role: text" joined by "\n".
pub fn format_transcript(turns: &[TranscriptTurn]) -> String {
    turns
        .iter()
        .map(|t| format!("{}: {}", t.role, t.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `chunkTurns` — greedy packing; an over-long single turn still forms its
/// own chunk (the `cur.len &&` guard prevents empty leading chunks).
pub fn chunk_turns(turns: &[TranscriptTurn], max_chars: usize) -> Vec<Vec<TranscriptTurn>> {
    let mut chunks: Vec<Vec<TranscriptTurn>> = Vec::new();
    let mut cur: Vec<TranscriptTurn> = Vec::new();
    let mut size = 0usize;
    for t in turns {
        let len = turn_chars(t);
        if !cur.is_empty() && size + len > max_chars {
            chunks.push(std::mem::take(&mut cur));
            size = 0;
        }
        cur.push(t.clone());
        size += len;
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn roles_filtered_and_blanks_dropped() {
        let m = msgs(
            r#"[
            {"role":"system","content":"sys prompt"},
            {"role":"tool","content":"tool out"},
            {"role":"user","content":"   "},
            {"role":"assistant","content":"  "},
            {"role":"user","content":"real question"},
            {"role":"assistant","content":"  lots   of\n\n spaces  "}
        ]"#,
        );
        let t = build_transcript(&m);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].role, "user");
        assert_eq!(t[0].text, "real question");
        // collapse \s+ → single spaces (NBSP/U+2028 ARE JS ws), then trim.
        assert_eq!(t[1].text, "lots of spaces");
    }

    #[test]
    fn assistant_content_stringification_parity() {
        // Null and absent content ⇒ "" ⇒ dropped (NOT "null").
        let t = build_transcript(&msgs(
            r#"[{"role":"assistant"},{"role":"assistant","content":null}]"#,
        ));
        assert!(t.is_empty());
        // Numbers/arrays stringify via js_to_string.
        let t = build_transcript(&msgs(
            r#"[{"role":"assistant","content":42},{"role":"assistant","content":[1,null,"x"]}]"#,
        ));
        assert_eq!(t[0].text, "42");
        // JS Array.prototype.toString = join(","): null/undefined render as
        // the EMPTY string ("1,,x"), not "null"/"undefined".
        assert_eq!(t[1].text, "1,,x");
        let t = build_transcript(&msgs(r#"[{"role":"assistant","content":{"a":1}}]"#));
        assert_eq!(t[0].text, "[object Object]");
    }

    #[test]
    fn user_turn_attachment_note_and_parts() {
        let t = build_transcript(&msgs(
            r#"[{
            "role":"user",
            "content":[{"text":"  ","attachments":[]},{"text":"build \n\n this","other":1}],
            "attachments":[{"name":"spec.md"},{"name":""},{"nope":1},{"name":"img.png"}]
        }]"#,
        ));
        assert_eq!(t[0].text, "build this [attached: spec.md, img.png]");
    }

    #[test]
    fn caps_count_utf16_units() {
        // Pure astral run: every char is a surrogate pair (2 units), so the
        // 500-unit cap lands exactly on a char boundary (no surrogate snap).
        let long = "\u{1D54F}".repeat(300); // 600 units
        let t = build_transcript(&msgs(&format!(r#"[{{"role":"user","content":"{long}"}}]"#)));
        assert_eq!(jsstr::js_len(&t[0].text), 500);
        let a = build_transcript(&msgs(&format!(
            r#"[{{"role":"assistant","content":"{long}"}}]"#
        )));
        assert_eq!(jsstr::js_len(&a[0].text), 400);
    }

    #[test]
    fn chars_format_and_chunking() {
        let turns = vec![
            TranscriptTurn {
                role: "user",
                text: "aa".into(),
            }, // 2+4+3 = 9
            TranscriptTurn {
                role: "assistant",
                text: "bbb".into(),
            }, // 3+9+3 = 15
        ];
        assert_eq!(transcript_chars(&turns), 24);
        assert_eq!(format_transcript(&turns), "user: aa\nassistant: bbb");

        let chunks = chunk_turns(&turns, 20);
        assert_eq!(chunks.len(), 2); // 9 fits; 9+15 > 20 ⇒ flush
        assert_eq!(chunks[0].len(), 1);
        assert_eq!(chunks[1][0].role, "assistant");

        // Oversized turn alone; empty input ⇒ no chunks (never an empty first chunk).
        let big = vec![TranscriptTurn {
            role: "assistant",
            text: "z".repeat(100),
        }];
        let chunks = chunk_turns(&big, 10);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 1);
        assert!(chunk_turns(&[], 10).is_empty());
    }
}
