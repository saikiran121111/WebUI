//! Payload-shape helpers used by the chat handler/pipeline. Oracle:
//! `stripAttachmentRefs` (`lib/server/attachindex/turn.ts:53`),
//! `turnHasAttachmentRef` / `firstTextPart` / `historyBefore`
//! (`app/api/chat/route.ts:308/355/337`).

use serde_json::{Map, Value};

use ruke_skills::jsstr::{js_slice_head, js_trim};
use ruke_skills::lazy::extract_user_text;

/// `attachment_ref` parts are an internal routing hint; the upstream chat
/// template only accepts text/image_url parts, so every ref is stripped
/// before the payload leaves this process (both paths, always).
pub fn strip_attachment_refs(messages: &mut [Value]) {
    for m in messages.iter_mut() {
        if let Some(parts) = m.get_mut("content").and_then(Value::as_array_mut) {
            parts.retain(|p| p.get("type").and_then(Value::as_str) != Some("attachment_ref"));
        }
    }
}

/// `turnHasAttachmentRef(content)`: computed by the HANDLER before the
/// pipeline mutates the payload (route.ts:644/:758) — it decides whether
/// the `retrieval` / `retrieval_done` frames open and close the pair.
pub fn turn_has_attachment_ref(content: Option<&Value>) -> bool {
    content.and_then(Value::as_array).is_some_and(|a| {
        a.iter()
            .any(|p| p.get("type").and_then(Value::as_str) == Some("attachment_ref"))
    })
}

/// `firstTextPart(content)`: a string content is itself; an array content
/// yields the FIRST part whose `text` is a non-blank string, VERBATIM
/// (untrimmed — the trim only tests truthiness).
pub fn first_text_part(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            for p in parts {
                if let Some(t) = p.get("text").and_then(Value::as_str) {
                    if !js_trim(t).is_empty() {
                        return t.to_string();
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// `historyBefore(messages, lastUserIdx)`: prior user/assistant turns,
/// text extracted through `extractUserText`, blank-dropped, sliced to the
/// first 500 UTF-16 code units (JS `slice` semantics).
pub fn history_before(messages: &[Value], last_user_idx: usize) -> Vec<Value> {
    let mut history = Vec::new();
    for m in messages.iter().take(last_user_idx.min(messages.len())) {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = extract_user_text(m.get("content").unwrap_or(&Value::Null));
        if js_trim(&content).is_empty() {
            continue;
        }
        history.push(serde_json::json!({ "role": role, "content": js_slice_head(&content, 500) }));
    }
    history
}

/// JSON `delete obj[key]` with the TS object's key ORDER preserved.
///
/// `serde_json::Map` (preserve_order ⇒ indexmap-backed) `remove` is a
/// SWAP-remove: it would reorder the remaining keys and break the
/// byte-exact `JSON.stringify` comparison in `fixtures/chat/06a`
/// (`{"decision_mode":…,"stream":false,"messages":[…]}` must forward as
/// `{"stream":false,"messages":[…]}`, never `{"messages":…,"stream":…}`).
/// `retain` shifts instead of swapping, so order is preserved.
pub fn remove_key_preserving_order(map: &mut Map<String, Value>, key: &str) -> Option<Value> {
    let taken = map.get(key).cloned();
    map.retain(|k, _| k != key);
    taken
}

/// Object-safe wrapper: no-op when `v` is not an object (JS `delete` on a
/// non-object is a no-op too).
pub fn remove_key(v: &mut Value, key: &str) -> Option<Value> {
    v.as_object_mut()
        .and_then(|o| remove_key_preserving_order(o, key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_only_attachment_ref_parts_keeps_order() {
        let mut msgs = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "fold this history" },
                { "type": "attachment_ref", "attachmentId": "att_golden1a", "name": "deck.pdf", "kind": "text" },
                { "type": "image_url", "image_url": { "url": "x" } }
            ]
        })];
        strip_attachment_refs(&mut msgs);
        let parts = msgs[0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
    }

    #[test]
    fn string_content_untouched_and_missing_content_safe() {
        let mut msgs = vec![
            json!({ "role": "assistant", "content": "ok" }),
            json!({ "role": "user" }),
        ];
        strip_attachment_refs(&mut msgs);
        assert_eq!(msgs[0]["content"], "ok");
        assert!(msgs[1].get("content").is_none());
    }

    #[test]
    fn attachment_ref_predicate() {
        assert!(turn_has_attachment_ref(Some(
            &json!([{ "type": "attachment_ref" }])
        )));
        assert!(!turn_has_attachment_ref(Some(&json!([{ "type": "text" }]))));
        assert!(!turn_has_attachment_ref(Some(&json!("string content"))));
        assert!(!turn_has_attachment_ref(None));
    }

    #[test]
    fn first_text_part_verbatim_first_nonblank() {
        assert_eq!(first_text_part(Some(&json!("hi"))), "hi");
        assert_eq!(
            first_text_part(Some(
                &json!([{ "type": "text", "text": "  " }, { "type": "text", "text": " real " }])
            )),
            " real ",
            "returns the untrimmed text"
        );
        assert_eq!(first_text_part(Some(&json!([]))), "");
        assert_eq!(first_text_part(None), "");
    }

    #[test]
    fn history_skips_system_and_blanks_and_slices_500() {
        let long = "y".repeat(600);
        let msgs = vec![
            json!({ "role": "user", "content": "first" }),
            json!({ "role": "system", "content": "ignore me" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": &long }] }),
            json!({ "role": "user", "content": "   " }),
            json!({ "role": "user", "content": "pin" }),
        ];
        let h = history_before(&msgs, 4);
        assert_eq!(
            h.len(),
            2,
            "system role drops, blank user turn drops, the pinned turn itself is excluded"
        );
        assert_eq!(h[0], json!({ "role": "user", "content": "first" }));
        assert_eq!(h[1]["role"], "assistant");
        assert_eq!(h[1]["content"].as_str().unwrap().chars().count(), 500);
    }

    #[test]
    fn removal_preserves_remaining_key_order_unlike_map_remove() {
        // The 06a fixture case: decision_mode is the FIRST of three keys.
        let mut payload = json!({ "decision_mode": "chart", "stream": false, "messages": [] });
        remove_key(&mut payload, "decision_mode");
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            r#"{"stream":false,"messages":[]}"#,
            "JS `delete` keeps insertion order of the survivors"
        );
        // sanity: the naive swap-remove WOULD reorder (documents the hazard)
        let mut m = serde_json::Map::new();
        m.insert("a".into(), json!(1));
        m.insert("b".into(), json!(2));
        m.insert("c".into(), json!(3));
        m.remove("a");
        let naive: Vec<&String> = m.keys().collect();
        assert_eq!(naive, vec![&"c".to_string(), &"b".to_string()]);

        let mut p2 = json!({ "purpose": "compact", "messages": [] });
        remove_key(&mut p2, "purpose");
        assert_eq!(serde_json::to_string(&p2).unwrap(), r#"{"messages":[]}"#);
    }
}
