//! F152 targeted-reread TRANSPORT (ruke-attach owns the decision,
//! resolution and durability law — see `ruke_attach::reread`). This is the
//! seam the chat pipeline hands to `build_attachment_turn`: it runs the
//! `documents.parse` ML job scoped to EXACTLY the region ids it is handed
//! (⇔ TS `readDocumentViaCapability(src, { regions })` in
//! `lib/server/attachindex/reread.ts`) and resolves the envelope into
//! [`RegionFrame`]s. Every failure — endpoint unconfigured, transport
//! fault, contract drift, cancellation — resolves to an empty Vec: a failed
//! reread leaves the cached evidence standing and NEVER throws into the
//! turn.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use ruke_attach::reread::{RegionFrame, RegionInspector};

use crate::ml_bridge::endpoint_from_env;
use crate::ml_job::{run_job, JobSpec};

/// ⇔ TS `DOCUMENT_PARSE_CAPABILITY` / `DOCUMENT_PARSE_DEADLINE_MS`.
const DOCUMENT_PARSE_CAPABILITY: &str = "documents.parse";
const DOCUMENT_PARSE_DEADLINE_S: u64 = 90;
/// ⇔ TS `DOCUMENT_OCR_LANGUAGE_ENV`.
const DOCUMENT_OCR_LANGUAGE_ENV: &str = "RUKE_DOCUMENT_OCR_LANGUAGE";

/// Stateless inspector: each call resolves the backend endpoint from the
/// environment (same rule as the media/speech jobs) and posts the scoped
/// documents.parse envelope.
pub struct MlRegionInspector;

static NEXT_REREAD_ID: AtomicU64 = AtomicU64::new(1);

/// Hand-rolled standard-alphabet base64 decode — the workspace
/// deliberately carries no base64 crate (same law as `turn.rs`'s
/// `b64_std` encoder). Padding-aware; strict: any byte outside the
/// alphabet yields `None` (the payloads here are machine-written).
/// Crate-visible: the F153 visual-seek transport decodes frame pixels with
/// this same law.
pub(crate) fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u64> {
        match b {
            b'A'..=b'Z' => Some(b as u64 - b'A' as u64),
            b'a'..=b'z' => Some(b as u64 - b'a' as u64 + 26),
            b'0'..=b'9' => Some(b as u64 - b'0' as u64 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let pad = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    let body = &bytes[..bytes.len() - pad];
    if pad > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out: Vec<u8> = Vec::with_capacity(body.len() / 4 * 3 + 2);
    for chunk in body.chunks(4) {
        // Each char lands 6 bits higher, top-aligned in a 24-bit register:
        // char k at shift 18-6k, so byte j sits at 16-8j.
        let mut acc: u64 = 0;
        for (k, &b) in chunk.iter().enumerate() {
            acc |= val(b)? << (18 - 6 * k);
        }
        let nbytes = chunk.len() * 6 / 8;
        for j in 0..nbytes {
            out.push(((acc >> (16 - 8 * j)) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// The unit a region id names: "pptx:2:ppt/media/image-2-1.png" → 2.0.
fn region_unit(region: &str) -> Option<f64> {
    region.split(':').nth(1)?.parse::<f64>().ok()
}

impl RegionInspector for MlRegionInspector {
    fn inspect(
        &self,
        src: &Path,
        regions: &[String],
        token: &CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Vec<RegionFrame>> + Send + '_>> {
        // The trait's `+ '_` pins the future to `&self`: take owned copies
        // of the call's arguments BEFORE the block so `async move` captures
        // values, not the call's references (the region list is small; a
        // cloned token is linked to the caller's, so cancellation still
        // propagates).
        let regions: Vec<String> = regions.to_vec();
        let token = token.clone();
        // Synchronous resolution BEFORE the future so it captures an owned
        // path, not the call's `&src` (the trait's `+ '_` pins to `&self`).
        let canonical = match std::fs::canonicalize(src) {
            Ok(p) => p,
            Err(_) => return Box::pin(std::future::ready(Vec::new())), // ⇔ TS resolves, python's containment rejects
        };
        Box::pin(async move {
            let Ok(endpoint) = endpoint_from_env() else {
                return Vec::new(); // capability pair unconfigured
            };
            let root: PathBuf = canonical
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            let n = NEXT_REREAD_ID.fetch_add(1, Ordering::Relaxed);
            let mut payload = json!({
                "path": canonical.to_string_lossy(),
                "root": root.to_string_lossy(),
                "regions": regions,
            });
            if let Some(lang) = std::env::var(DOCUMENT_OCR_LANGUAGE_ENV)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                payload["language"] = json!(lang);
            }
            let spec = JobSpec {
                request_id: format!("rr-req-{n}"),
                run_id: format!("rr-run-{n}"),
                job_id: format!("rr-job-{n}"),
                capability: DOCUMENT_PARSE_CAPABILITY.to_string(),
                payload,
                deadline_s: DOCUMENT_PARSE_DEADLINE_S,
            };
            let env = tokio::select! {
                biased;
                _ = token.cancelled() => return Vec::new(),
                r = run_job(&endpoint, &spec) => match r {
                    Ok(v) => v,
                    Err(_) => return Vec::new(), // transport fault: cached evidence stands
                },
            };
            if env.get("state").and_then(Value::as_str) != Some("ready") {
                return Vec::new();
            }
            let payload = env.pointer("/result/payload");
            let Some(payload) = payload.filter(|_| true) else {
                return Vec::new();
            };
            let blocks = payload
                .pointer("/document/blocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let visual = payload
                .pointer("/visual_pages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut out: Vec<RegionFrame> = Vec::new();
            for region in &regions {
                let Some(vp) = visual.iter().find(|v| v.get("region").and_then(Value::as_str) == Some(region)) else {
                    continue;
                };
                let png = match vp.get("png_base64").and_then(Value::as_str).and_then(b64_decode) {
                    Some(b) if !b.is_empty() => b,
                    _ => continue,
                };
                // The unit this region belongs to; OCR provenance blocks for
                // that unit carry the recovered text, engine and language
                // (⇔ normalizeDocument's ocr_text grouping: loc.page ??
                // loc.slide ?? loc.sheet ?? loc.unit).
                let unit = region_unit(region);
                let mut texts: Vec<String> = Vec::new();
                let mut engine = String::new();
                let mut language = String::new();
                for b in &blocks {
                    if b.get("kind").and_then(Value::as_str) != Some("ocr_text") {
                        continue;
                    }
                    let loc = b.get("loc").cloned().unwrap_or(Value::Null);
                    let bu = ["page", "slide", "sheet", "unit"]
                        .iter()
                        .find_map(|k| loc.get(*k).and_then(Value::as_f64));
                    if bu.is_none() || bu != unit {
                        continue;
                    }
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            texts.push(t.trim().to_string());
                        }
                    }
                    if engine.is_empty() {
                        engine = loc.get("engine").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                    if language.is_empty() {
                        language = loc
                            .get("language_code")
                            .and_then(Value::as_str)
                            .or_else(|| loc.get("language").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string();
                    }
                }
                let text = texts.join("\n").trim().to_string();
                // ⇔ TS `vp.region_state ?? (text ? "recognised" : "skipped")`.
                let state = vp
                    .get("region_state")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| if text.is_empty() { "skipped".into() } else { "recognised".into() });
                out.push(RegionFrame {
                    region: region.clone(),
                    state,
                    png,
                    text,
                    engine,
                    language,
                });
            }
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_decode_is_the_inverse_of_turs_b64_std_encoder() {
        // The turn.rs encoder's recorded fixtures decode byte-for-byte.
        assert_eq!(b64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(b64_decode("QQ==").unwrap(), b"A");
        assert_eq!(b64_decode("Qg==").unwrap(), b"B");
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB");
        assert_eq!(b64_decode("").unwrap(), Vec::<u8>::new());
        // A real 1x1 PNG (the reread spec's refreshed pixels) decodes to PNG magic.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let bytes = b64_decode(png).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // Strict: a foreign byte in the alphabet is a decode failure, not garbage.
        assert!(b64_decode("QUJ*").is_none());
        assert!(b64_decode("Q").is_none());
    }

    #[test]
    fn region_units_parse_the_region_id_law() {
        assert_eq!(region_unit("pptx:2:ppt/media/image-2-1.png"), Some(2.0));
        assert_eq!(region_unit("pdf:12:page"), Some(12.0));
        assert_eq!(region_unit("image:1:x.png"), Some(1.0));
        assert_eq!(region_unit("nocolon"), None);
        assert_eq!(region_unit("pptx:notanumber:x"), None);
    }
}
