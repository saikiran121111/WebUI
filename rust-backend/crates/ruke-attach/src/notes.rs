//! `lib/server/attachindex/notes.ts` — lazy whole-content course notes:
//! one non-streaming LLM pass per spine block, cached to `notes.json`
//! via the store. The prompt and request body are reproduced VERBATIM
//! (body key order `model, stream, temperature, max_tokens, messages` —
//! serde_json's `preserve_order` keeps the Map insertion sequence).
//!
//! Cache versioning (I24): the notes cache is keyed by a `notesVersion`
//! fingerprint of (model, chunk count, total content length, spine block
//! boundaries); a cached note is only served while the fingerprint still
//! matches, and a run where ANY block degraded to the spine summary is
//! never written at all — the model gets another chance on a later turn.
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

use ruke_skills::jsstr::{js_len, js_trim};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::format::fmt_stamp;
use crate::store::write_notes;
use crate::types::LoadedIndex;

/// The re-throwing path out of the attachment pipeline (TS `AbortError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Resolved from `settings.ts` (`llmApiUrl()` / `llmApiKey()`) plus the
/// request's chat model by the caller on every request — never captured
/// at module load, never logged. `model` (I24) is both the request's
/// `model` field and a component of the notes-cache fingerprint: notes
/// distilled by one model must never be served for another.
#[derive(Debug, Clone)]
pub struct NotesLlm {
    pub url: String,
    pub key: String,
    pub model: String,
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
    payload.insert("model".into(), json!(&llm.model));
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

/// `notesVersion(index, model)` (I24) — the notes-cache fingerprint:
/// `v1|<model>|<chunkCount>|<totalChars>|<blockCount>:<b0>,<b1>,…`.
/// `totalChars` counts UTF-16 code units (JS `.length`), and every field
/// is an INTEGER on purpose: float durations would drift the fingerprint
/// across re-stamps of identical content. Chunk count, total content
/// length, and block count + boundaries cover everything the notes pass
/// actually consumes. Mirror of `notes.ts::notesVersion`.
pub fn notes_version(index: &LoadedIndex, model: &str) -> String {
    let total_chars: usize = index.chunks.iter().map(|c| js_len(&c.text)).sum();
    let blocks = &index.meta.spine_blocks;
    let ranges: Vec<String> = blocks
        .iter()
        .map(|b| format!("{}-{}", b.chunk_from, b.chunk_to))
        .collect();
    format!(
        "v1|{}|{}|{}|{}:{}",
        model,
        index.chunks.len(),
        total_chars,
        blocks.len(),
        ranges.join(",")
    )
}

/// `generateNotes(attId, index, signal, model)` — "never throws" EXCEPT
/// on abort, exactly like the TS (every other error degrades per block).
/// The model (I24) rides on the LLM request AND on the cache fingerprint,
/// so two models never share one notes cache.
pub async fn generate_notes(
    root: &Path,
    att_id: &str,
    index: &LoadedIndex,
    http: &reqwest::Client,
    llm: &NotesLlm,
    token: &CancellationToken,
) -> Result<String, Cancelled> {
    let mut parts: Vec<String> = Vec::new();
    // I24: a degraded run (ANY block fell back to the spine summary) must
    // never poison the cache — the model gets another chance next turn.
    let mut all_model_produced = true;
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
            Some(s) => format!(
                "[{} - {}]",
                fmt_stamp(s),
                fmt_stamp(blk.end_sec.unwrap_or(s))
            ),
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
            None => {
                all_model_produced = false;
                format!("{}\n{} ... {}", header, blk.opening, blk.closing)
            }
        });
    }

    let notes = js_trim(&parts.join("\n\n")).to_string();
    if !notes.is_empty() && all_model_produced {
        // `if (notes && allModelProduced) writeNotes(attId, notes,
        // notesVersion(index, model))` (I24) — the fingerprint is stamped
        // alongside the notes so a chunking/spine/model change invalidates
        // the cache. `try { writeNotes } catch {}` — a cache-write failure
        // must not lose the notes we just made (bad id throws in TS here).
        let _ = write_notes(
            root,
            att_id,
            &notes,
            Some(&notes_version(index, &llm.model)),
        );
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::read_notes_with_version;
    use crate::types::{IndexChunk, SpineBlock};
    use std::io::{Read, Write};

    #[test]
    fn system_prompt_is_byte_exact_against_ts_concat() {
        // Each TS `+` segment boundary is a single space; no re-flowing.
        assert!(SYSTEM_PROMPT.starts_with(
            "You are given consecutive passages from one lecture recording, in order. "
        ));
        assert!(SYSTEM_PROMPT
            .contains("Do not invent anything not said. Output the notes only — no preamble."));
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
        let llm = NotesLlm {
            url: "http://127.0.0.1:1/x".into(),
            key: "k".into(),
            model: "default".into(),
        };
        // No spine blocks: the loop never calls note_for_block, so TS
        // would also NOT throw — but generateNotes pre-checks the token
        // inside note_for_block only. Here: empty spine ⇒ Ok("").
        let r = generate_notes(
            Path::new("."),
            "att_testx",
            &blank_index(),
            &http,
            &llm,
            &token,
        )
        .await;
        assert_eq!(r.unwrap(), "");
    }

    #[tokio::test]
    async fn spineless_notes_degrade_paths_stay_non_throwing() {
        // Empty body skipped (`!body.trim() continue`); no chunks at all
        // ⇒ empty notes ⇒ NO notes.json write (TS `if (notes)` falsy).
        let token = CancellationToken::new();
        let http = reqwest::Client::new();
        let llm = NotesLlm {
            url: "http://127.0.0.1:1/x".into(),
            key: "k".into(),
            model: "default".into(),
        };
        let notes = generate_notes(
            Path::new("."),
            "att_testx",
            &blank_index(),
            &http,
            &llm,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(notes, "");
    }

    // ── I24: cache fingerprinting + degraded runs must not poison ──────
    #[test]
    fn notes_version_fingerprint_matches_ts() {
        let mut idx = LoadedIndex::default();
        idx.chunks = (0..2i64)
            .map(|i| IndexChunk {
                i,
                text: format!("chunk body {i}"),
                ..Default::default()
            })
            .collect();
        idx.meta.spine_blocks = vec![SpineBlock {
            chunk_from: 0,
            chunk_to: 1,
            ..Default::default()
        }];
        // "chunk body 0" + "chunk body 1" = 24 UTF-16 units; one boundary.
        assert_eq!(notes_version(&idx, "default"), "v1|default|2|24|1:0-1");
        // Every consumed input flips the fingerprint.
        assert_ne!(notes_version(&idx, "llama-3"), "v1|default|2|24|1:0-1");
        idx.chunks.push(IndexChunk {
            i: 2,
            text: "x".into(),
            ..Default::default()
        });
        assert_ne!(notes_version(&idx, "default"), "v1|default|2|24|1:0-1");
        idx.chunks.pop();
        idx.meta.spine_blocks[0].chunk_to = 2;
        assert_ne!(notes_version(&idx, "default"), "v1|default|2|24|1:0-1");
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("ruke-notes-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn spine_index() -> LoadedIndex {
        let mut idx = LoadedIndex::default();
        idx.chunks = vec![
            IndexChunk {
                i: 0,
                text: "cell membrane details".into(),
                ..Default::default()
            },
            IndexChunk {
                i: 1,
                text: "mitosis steps".into(),
                ..Default::default()
            },
        ];
        idx.meta.spine_blocks = vec![SpineBlock {
            chunk_from: 0,
            chunk_to: 1,
            opening: "we begin".into(),
            closing: "the cycle closes".into(),
            ..Default::default()
        }];
        idx
    }

    #[tokio::test]
    async fn degraded_notes_return_but_are_never_cached_i24() {
        // Unreachable upstream ⇒ every block degrades to the spine
        // summary. The notes are still RETURNED (non-empty), but the I24
        // gate must not write them: the model gets another chance later.
        let root = temp_root("degraded");
        let dir = root.join(".data").join("attach-index").join("att_degr01");
        std::fs::create_dir_all(&dir).unwrap();
        let idx = spine_index();
        let token = CancellationToken::new();
        let http = reqwest::Client::new();
        let llm = NotesLlm {
            url: "http://127.0.0.1:1/x".into(),
            key: "k".into(),
            model: "default".into(),
        };
        let notes = generate_notes(&root, "att_degr01", &idx, &http, &llm, &token)
            .await
            .unwrap();
        assert!(notes.contains("we begin ... the cycle closes"), "{notes}");
        assert!(
            !dir.join("notes.json").exists(),
            "a degraded run must never cache"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn model_produced_notes_cache_with_the_fingerprint_i24() {
        // One-shot canned completion: one spine block ⇒ one request, and
        // the responder thread ends after it (connection: close ⇒ reqwest
        // reads exactly one body and completes).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let canned: &'static str = "{\"choices\":[{\"message\":{\"content\":\"MODEL NOTE\"}}]}";
        std::thread::spawn(move || {
            if let Ok(mut stream) = listener.accept() {
                // Drain the request BEFORE answering: closing with unread
                // bytes in the receive queue makes Windows reset the
                // connection, and reqwest reports a reset instead of the
                // canned body. Parse the headers + Content-Length body so
                // the drain is deterministic, never a guess.
                let mut acc: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    if let Some(h) = acc.windows(4).position(|w| w == b"\r\n\r\n") {
                        let cl = String::from_utf8_lossy(&acc[..h])
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().to_owned())
                            })
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        if acc.len() >= h + 4 + cl {
                            break;
                        }
                    }
                    match stream.0.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => acc.extend_from_slice(&chunk[..n]),
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    canned.len(),
                    canned
                );
                let _ = stream.0.write_all(resp.as_bytes());
                let _ = stream.0.shutdown(std::net::Shutdown::Both);
            }
        });
        let root = temp_root("cached");
        let dir = root.join(".data").join("attach-index").join("att_cach01");
        std::fs::create_dir_all(&dir).unwrap();
        let idx = spine_index();
        let token = CancellationToken::new();
        let http = reqwest::Client::new();
        let llm = NotesLlm {
            url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
            key: "k".into(),
            model: "default".into(),
        };
        let notes = generate_notes(&root, "att_cach01", &idx, &http, &llm, &token)
            .await
            .unwrap();
        assert_eq!(notes, "[notes]\nMODEL NOTE");
        let ver = notes_version(&idx, "default");
        let raw = std::fs::read_to_string(dir.join("notes.json")).unwrap();
        assert!(raw.contains(&format!("\"version\":\"{ver}\"")), "{raw}");
        assert_eq!(
            read_notes_with_version(&root, "att_cach01", &ver).as_deref(),
            Some(notes.as_str())
        );
        assert_eq!(
            read_notes_with_version(&root, "att_cach01", "v1|other-model|2|31|1:0-1"),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
