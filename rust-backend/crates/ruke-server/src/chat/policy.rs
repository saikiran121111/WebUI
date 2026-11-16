//! F01 (brief 2026-11-15) - the ONE standing response policy, byte-identical to
//! `lib/chat/response-policy.ts`. The constant below is GENERATED FROM that
//! source (no hand-transcription), and [`tests::response_policy_bytes_match_the_ts_oracle`]
//! re-reads the TS file on every test run, so the two prompts cannot drift
//! silently. The policy is injected into every model-visible turn immediately
//! before the user turn (step 7, ahead of the clock block): it is the whole of
//! the application-owned answer-shape law. No greeting whitelist, no canned
//! reply, no fixed sentence count, no extra rewrite call per answer.

/// The policy header line (same bytes as the TS export).
pub const RESPONSE_POLICY_HEADER: &str = "RESPONSE POLICY FOR THIS ASSISTANT:";

/// The full standing response policy block.
pub const RESPONSE_POLICY: &str = "RESPONSE POLICY FOR THIS ASSISTANT:\n- Answer the request that was actually made, at the depth it asks for: a short question gets a short, direct answer; an explicit request for detail, comparison or steps gets the detail.\n- Ordinary small talk and status questions stay brief and natural. Do not convert them into a report, a plan, or a list.\n- Do not advertise capabilities, tools, integrations or services unless the human asks what you can do or what is available.\n- Never describe work that is not actually happening: no claimed searches, files, background jobs, indexing or progress that did not run.\n- If something is not possible here, say so plainly in one line instead of replacing it with a broader offer.";

#[cfg(test)]
mod tests {
    use super::*;

    /// Re-derive the policy straight from the TypeScript oracle source.
    fn ts_policy_from_source() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../lib/chat/response-policy.ts"
        );
        let src = std::fs::read_to_string(path)
            .expect("TS response-policy source must exist for the parity lock");
        let header = {
            let m = regex_free_capture(&src, "export const RESPONSE_POLICY_HEADER = \"", "\"")
                .expect("header const");
            m
        };
        let start = src.find("const LINES").expect("LINES array");
        let end = start + src[start..].find("];").expect("LINES array terminator") + 2;
        let mut lines: Vec<String> = Vec::new();
        for line in src[start..end].lines() {
            let t = line.trim();
            if t.starts_with('"') && t.ends_with("\",") {
                let inner = t.trim_start_matches('"').trim_end_matches("\",");
                lines.push(unescape_ts(inner));
            }
        }
        assert_eq!(lines.len(), 5, "the policy must keep exactly five law lines");
        format!("{}\n{}", header, lines.join("\n"))
    }

    /// The five TS string literals are plain text; keep the escape handling
    /// explicit so a future edit that adds `\"` or `\n` still matches Rust.
    fn unescape_ts(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut it = s.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        out
    }

    /// Minimal helper: first text between `open` and the next `close`.
    fn regex_free_capture(hay: &str, open: &str, close: &str) -> Option<String> {
        let i = hay.find(open)? + open.len();
        let j = hay[i..].find(close)?;
        Some(hay[i..i + j].to_string())
    }

    #[test]
    fn response_policy_bytes_match_the_ts_oracle() {
        assert_eq!(RESPONSE_POLICY, ts_policy_from_source());
        assert!(RESPONSE_POLICY.starts_with(RESPONSE_POLICY_HEADER));
    }

    #[test]
    fn policy_covers_both_reproduced_f01_symptoms() {
        // (a) a bare status question came back as a capability advertisement;
        // (b) the answer described work that was not actually happening.
        assert!(RESPONSE_POLICY.contains("Do not advertise capabilities"));
        assert!(RESPONSE_POLICY.contains("Never describe work that is not actually happening"));
        assert!(RESPONSE_POLICY.contains("at the depth it asks for"));
    }
}
