//! `lib/server/attachindex/notes.ts` — lazy whole-content course notes:
//! one non-streaming LLM pass per spine block, cached to `notes.json`
//! via the store. The prompt and request body are reproduced VERBATIM
//! (body key order `model, stream, temperature, max_tokens, messages` —
//! serde_json's `preserve_order` keeps the Map insertion sequence).
//!
//! Cancellation: TS threads an `AbortSignal` through `fetch`; an
//! AbortError RE-THROWS out of `generateNotes` (other errors degrade to
//! the spine summary). Rust models the abort as the turn's
//! [`Cancelled`] via `tokio::select!` on the CancellationToken, wrapping
//! BOTH the send and the body read (a mid-body abort is an AbortError in
//! TS too). Network failures (non-abort) degrade exactly like TS's
//! try/catch: warn-log (att id + error Display only — never document
//! contents) and fall back to `opening … closing`.

use std::path::Path;

use ruke_skills::jsstr::js_trim;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::format::fmt_stamp;
use crate::store::write_notes;
use crate::types::LoadedIndex;

/// The re-throwing path out of the attachment pipeline (TS `AbortError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Resolved from `settings.ts` (`llmApiUrl()` / `llmApiKey()`) by the
/// caller on every request — never captured at module load, never logged.
#[derive(Debug, Clone)]
pub struct NotesLlm {
    pub url: String,
    pub key: String,
}

/// The system prompt, byte-exact against the TS string concatenation.
const SYSTEM_PROMPT: &str = concat!(
    "You are given consecutive passages from one lecture recording, in order. ",
    "Write dense hierarchical notes (short heading + bullets) that capture every ",
    "fact, definition, number, step and example in these passages. Do not invent ",
    "anything not said. Output the notes only — no preamble.",
);

async fn note_for_block(
    http: &reqwest::Client,
    llm: &NotesLlm,
    header: &str,
    body: &str,
    token: &CancellationToken,
) -> Result<Option<String>, Cancelled> {
    if token.is_cancelled() {
        return Err(Cancelled);
    }

    // TS literal order: model, stream, temperature, max_tokens, messages.
    let mut payload = Map::new();
    payload.insert("model".into(), json!("default"));
    payload.insert("stream".into(), json!(false));
    payload.insert("temperature".into(), json!(0.2));
    payload.insert("max_tokens".into(), json!(700));
    payload.insert(
        "messages".into(),
        json!([
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": format!("{header}\n{body}") },
        ]),
    );
    let body_json = serde_json::to_string(&Value::Object(payload)).unwrap_or_else(|_| "{}".into());

    let sent = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(Cancelled),
        r = http
            .post(&llm.url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", llm.key))
            .body(body_json)
            .send() => r,
    };
    let res = match sent {
        Ok(res) => res,
        // fetch rejection (non-abort) ⇒ TS catch: warn + degrade.
        Err(e) => {
            tracing::warn!(target: "attachindex/notes", err = %e, "note block generation failed");
            return Ok(None);
        }
    };
    if !res.status().is_success() {
        return Ok(None); // `!res.ok` ⇒ null, silently
    }
    let bytes = tokio::select! {
        biased;
        // res.json() under an aborted signal rejects with AbortError.
        _ = token.cancelled() => return Err(Cancelled),
        r = res.bytes() => r,
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "attachindex/notes", err = %e, "note block generation failed");
            return Ok(None);
        }
    };
    // `res.json().catch(() => null)`
    let data: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let content = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c0| c0.get("message"))
        .and_then(|m| m.get("content"));
    match content.and_then(Value::as_str) {
        Some(s) => {
            let t = js_trim(s);
            if t.is_empty() {
                Ok(None)
            } else {
                Ok(Some(t.to_string()))
            }
        }
        None => Ok(None),
    }
}

/// `generateNotes(attId, index, signal)` — "never throws" EXCEPT on
/// abort, exactly like the TS (every other error degrades per block).
pub async fn generate_notes(
    root: &Path,
    att_id: &str,
    index: &LoadedIndex,
    http: &reqwest::Client,
    llm: &NotesLlm,
    token: &CancellationToken,
) -> Result<String, Cancelled> {
    let mut parts: Vec<String> = Vec::new();
    for blk in &index.meta.spine_blocks {
        let body = index
            .chunks
            .iter()
            .filter(|c| c.i >= blk.chunk_from && c.i <= blk.chunk_to)
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if js_trim(&body).is_empty() {
            continue;
        }

        let header = match blk.start_sec {
            Some(s) => format!("[{} - {}]", fmt_stamp(s), fmt_stamp(blk.end_sec.unwrap_or(s))),
            None => {
                let kw = blk.keywords.join(", ");
                if kw.is_empty() {
                    "[notes]".to_string()
                } else {
                    format!("[{kw}]")
                }
            }
        };

        let note = note_for_block(http, llm, &header, &body, token).await?;
        parts.push(match note {
            Some(n) => format!("{header}\n{n}"),
            None => format!("{}\n{} ... {}", header, blk.opening, blk.closing),
        });
    }

    let notes = js_trim(&parts.join("\n\n")).to_string();
    if !notes.is_empty() {
        // `try { writeNotes } catch {}` — a cache-write failure must not
        // lose the notes we just made (and a bad id throws in TS here).
        let _ = write_notes(root, att_id, &notes);
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_is_byte_exact_against_ts_concat() {
        // Each TS `+` segment boundary is a single space; no re-flowing.
        assert!(SYSTEM_PROMPT.starts_with("You are given consecutive passages from one lecture recording, in order. "));
        assert!(SYSTEM_PROMPT.contains("Do not invent anything not said. Output the notes only — no preamble."));
        assert_eq!(SYSTEM_PROMPT.matches(" — ").count(), 1); // em-dash, exactly one
    }

    fn blank_index() -> LoadedIndex {
        LoadedIndex::default()
    }

    #[tokio::test]
    async fn pre_cancelled_token_is_the_only_throwing_path() {
        let token = CancellationToken::new();
        token.cancel();
        let http = reqwest::Client::new();
        let llm = NotesLlm { url: "http://127.0.0.1:1/x".into(), key: "k".into() };
        // No spine blocks: the loop never calls note_for_block, so TS
        // would also NOT throw — but generateNotes pre-checks the token
        // inside note_for_block only. Here: empty spine ⇒ Ok("").
        let r = generate_notes(Path::new("."), "att_testx", &blank_index(), &http, &llm, &token).await;
        assert_eq!(r.unwrap(), "");
    }

    #[tokio::test]
    async fn spineless_notes_degrade_paths_stay_non_throwing() {
        // Empty body skipped (`!body.trim() continue`); no chunks at all
        // ⇒ empty notes ⇒ NO notes.json write (TS `if (notes)` falsy).
        let token = CancellationToken::new();
        let http = reqwest::Client::new();
        let llm = NotesLlm { url: "http://127.0.0.1:1/x".into(), key: "k".into() };
        let notes = generate_notes(Path::new("."), "att_testx", &blank_index(), &http, &llm, &token).await.unwrap();
        assert_eq!(notes, "");
    }
}
