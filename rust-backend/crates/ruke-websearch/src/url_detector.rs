//! Parity port of `lib/web-search/url-detector.ts` — universal bare-domain
//! + URL detector. tldts (TS) → the `psl` crate (Rust).
//!
//! DEPENDENCY NOTE: MIGRATION-MAP §5 prescribed "tldts → the tldrs crate"
//! — that crate (tldrs v0.1.3 on crates.io) is an LLM README generator and
//! has NOTHING to do with public suffixes. `psl` embeds the full Public
//! Suffix List (including the PRIVATE section, marked `Type::Private`),
//! which matches tldts' registrable/publicSuffix reporting for the pinned
//! vectors (`.vercel.app` / `.github.io` wildcard-suffixes are PSL public
//! entries). `psl::domain_str` ⇔ tldts `domain`; `psl::suffix_str` ⇔ tldts
//! `publicSuffix`; unknown TLD ⇒ `None` ⇒ token rejected
//! (tldts reports `domain: null`). Micro-divergence: tldts with default
//! options does not treat PSL-PRIVATE entries as valid suffixes while
//! `psl` does (Type::Private still yields a registrable) — recorded, not
//! fixed; no pinned vector exercises it.
//!
//! The `\w`/`\b`/`\d` portions of the token regexes are scoped with
//! `(?-u:…)` so they keep ASCII semantics exactly like JavaScript's
//! `\w`/`\d` (Rust's defaults are Unicode-aware and WOULD over-match
//! non-ASCII words). The `[^\s"'<>\[\]]` tail classes stay in Unicode
//! mode: JS `\s` is Unicode-aware, and a `(?-u)` negated class would
//! reject non-ASCII URL path characters the JS regex accepts. (`\[` is
//! escaped because the regex crate nests unescaped `[` inside classes.)

use regex::Regex;
use std::sync::OnceLock;

/// File/code extensions that must never be mistaken for TLDs.
/// VERBATIM list — NB: "sh" is deliberately NOT guarded (.sh is the Saint
/// Helena ccTLD; user spec requires site.sh detection).
const FILE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "txt", "css", "scss", "less", "html",
    "xml", "yml", "yaml", "toml", "py", "rb", "java", "c", "cpp", "h", "rs", "go", "cs", "kt",
    "swift", "php", "bat", "ps1", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "pdf", "zip",
    "tar", "gz", "rar", "7z", "exe", "msi", "dmg", "apk", "gguf", "onnx", "bin", "dat", "model",
    "env", "ini", "cfg", "conf",
];

/// `DetectedUrl` — one detected URL / bare domain token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedUrl {
    /// The original token as it appeared in the prompt (per TS: pass-3
    /// raw is the LOWERCASED host + tail-punct-stripped path).
    pub raw: String,
    /// Normalized https:// URL.
    pub url: String,
    /// Parsed domain (e.g. "skiran.dev").
    pub domain: String,
    /// True when the token already carried http(s)://.
    pub has_scheme: bool,
}

fn re_url() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>\[\]]+"#).unwrap())
}

fn re_www() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?-u:\bwww\.[\w-]+(?:\.[\w-]+)+)(?:/[^\s"'<>\[\]]*)?"#,
        )
        .unwrap()
    })
}

fn re_bare() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?-u:\b((?:[a-z0-9][a-z0-9-]*\.){1,6}[a-z]{2,24}))(/[^\s"'<>\[\]]*)?"#,
        )
        .unwrap()
    })
}

fn re_version() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u)^v?\d+\.").unwrap())
}

/// JS `String.replace(re, "")` on an UNANCHORED `/…]+$/` — the TS regex is
/// anchored to `$`; the regex crate has no `exec` lastIndex semantics here,
/// so strip the longest trailing run via find at end.
fn strip_tail(t: &str) -> String {
    // The TS regex anchors to end-of-string; emulate by scanning from the
    // tail (the char class is single-codepoint wide).
    let cut = t
        .char_indices()
        .rev()
        .take_while(|(_, c)| ",.;:!?)]}'\"`".chars().any(|d| &d == c))
        .count();
    t[..t.len() - cut].to_string()
}

/// JS `String.length` — UTF-16 code units (parity with `.length < 4/5`
/// guards; hosts reaching this point are punycode/ASCII in practice).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Extract all URLs and bare domains from a prompt string.
///
/// `exclude_file_tokens` — default true; skip tokens whose public suffix
/// matches a known file/code extension.
pub fn detect_urls_and_domains(prompt: &str, exclude_file_tokens: bool) -> Vec<DetectedUrl> {
    if prompt.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<DetectedUrl> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Pass 1: full URLs with scheme.
    for m in re_url().find_iter(prompt) {
        let raw = strip_tail(m.as_str());
        if let Ok(u) = url::Url::parse(&raw) {
            let host = u.host_str().unwrap_or("").to_lowercase();
            if js_len(&host) < 4 {
                continue; // skip localhost, IP-like short names
            }
            if !seen.insert(host.clone()) {
                continue;
            }
            out.push(DetectedUrl {
                raw: raw.clone(),
                url: raw,
                domain: host,
                has_scheme: true,
            });
        }
        // malformed URL token — skip
    }

    // Pass 2: www.-prefixed tokens (no scheme), optional path preserved.
    for m in re_www().find_iter(prompt) {
        let raw = strip_tail(m.as_str());
        // raw.slice(4) — "www." is 4 ASCII bytes (regex guarantees the
        // `\bwww\.` prefix), then take the host up to the first '/'.
        let host = raw[4..].split('/').next().unwrap_or("").to_lowercase();
        if !seen.insert(host.clone()) {
            continue;
        }
        out.push(DetectedUrl {
            raw: raw.clone(),
            // QUIRK (verbatim): the URL lowercases the WHOLE token,
            // including any path — path casing is lost.
            url: format!("https://{}", raw.to_lowercase()),
            domain: host,
            has_scheme: false,
        });
    }

    // Pass 3: bare domain tokens (skiran.dev, lite.ego.app, rbi.org.in),
    // optional path preserved.
    for caps in re_bare().captures_iter(prompt) {
        let host = caps[1].to_lowercase();
        let path = match caps.get(2) {
            Some(m) => strip_tail(m.as_str()),
            None => String::new(),
        };

        // Skip tokens already found in pass 1/2.
        if seen.contains(&host) {
            continue;
        }

        // Skip tokens that look like file paths or dotted identifiers that
        // are not domains: "v1.2.3", "e.g.", "i.e."
        if js_len(&host) < 5 {
            continue;
        }
        if re_version().is_match(&host) {
            continue; // version number
        }
        if host.ends_with(".e.g") || host.ends_with(".i.e") {
            continue;
        }

        // tldts.parse ⇔ psl::domain_str (registrable domain) +
        // psl::suffix_str (publicSuffix). Unknown suffix ⇒ None ⇒ reject.
        let Some(reg) = psl::domain_str(&host) else {
            continue; // parsed.domain === null
        };
        // Accept host === domain or host ends with "." + domain (the token
        // may be a subdomain of the registrable domain — still a site).
        if host != reg && !host.ends_with(&format!(".{reg}")) {
            continue;
        }
        let pub_suffix: &str = psl::suffix_str(&host).unwrap_or("");
        // TS checks these tldts special-suffix sentinels (dead with default
        // tldts options, kept verbatim for parity):
        if pub_suffix == "invalid" || pub_suffix == "unlisted" {
            continue;
        }

        // Code-filename guard (load-bearing for "main.rs": tldts/psl read
        // ".rs"/".me"/".io" ccTLDs as valid suffixes).
        if exclude_file_tokens && FILE_EXTENSIONS.contains(&pub_suffix) {
            continue;
        }

        seen.insert(host.clone());
        out.push(DetectedUrl {
            raw: host.clone() + &path,
            url: "https://".to_string() + &host + &path,
            domain: host,
            has_scheme: false,
        });
    }

    out
}

/// Convenience: just the normalized https:// URLs. Empty when nothing
/// detected.
pub fn detect_prompt_urls(prompt: &str) -> Vec<String> {
    detect_urls_and_domains(prompt, true).into_iter().map(|d| d.url).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 8 vectors from `__tests__/web-search/url-detector.test.ts`,
    /// ported verbatim (pinning parity).
    #[test]
    fn detects_bare_domain_in_exact_user_report_sentence() {
        let out = detect_urls_and_domains(
            "Here is the thing skiran.dev can you search this portfolio and tell me about him",
            true,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].domain, "skiran.dev");
        assert_eq!(out[0].url, "https://skiran.dev");
        assert!(!out[0].has_scheme);
    }

    #[test]
    fn detects_wide_spread_of_tlds_and_multipart_suffixes() {
        for token in [
            "blinkit.com",
            "zepto.co.in",
            "rbi.org.in",
            "lite.ego.app",
            "openai.com",
            "site.gg",
            "site.sh",
            "netlify.dev",
        ] {
            let out = detect_urls_and_domains(&format!("look at {token} quickly"), true);
            let domains: Vec<&str> = out.iter().map(|d| d.domain.as_str()).collect();
            assert!(domains.contains(&token), "{token} → {domains:?}");
        }
    }

    #[test]
    fn detects_wildcard_suffix_subdomains() {
        let out = detect_urls_and_domains("my deploy lives on my-site.vercel.app and repo.github.io", true);
        let domains: Vec<&str> = out.iter().map(|d| d.domain.as_str()).collect();
        assert!(domains.contains(&"my-site.vercel.app"), "{domains:?}");
        assert!(domains.contains(&"repo.github.io"), "{domains:?}");
    }

    #[test]
    fn keeps_scheme_urls_with_path_and_dedupes_repeats() {
        let out = detect_urls_and_domains(
            "compare https://skiran.dev/projects and skiran.dev plus www.example.co.uk",
            true,
        );
        let urls: Vec<&str> = out.iter().map(|d| d.url.as_str()).collect();
        assert!(urls.contains(&"https://skiran.dev/projects"), "{urls:?}");
        // bare repeat of an already-detected host is skipped
        assert_eq!(urls.iter().filter(|u| **u == "https://skiran.dev").count(), 0);
        assert!(urls.contains(&"https://www.example.co.uk"), "{urls:?}");
    }

    #[test]
    fn code_filename_guard_rejects_file_tokens() {
        for token in [
            "app.ts",
            "report.pdf",
            "main.rs",
            "index.html",
            "weights.gguf",
            "config.json",
        ] {
            let out = detect_urls_and_domains(&format!("read {token} now"), true);
            assert!(out.is_empty(), "{token} → {out:?}");
        }
    }

    #[test]
    fn guard_exempts_scheme_and_www_prefixed_file_urls() {
        let urls = detect_prompt_urls("fetch https://example.com/app.ts and www.example.com/index.html");
        assert!(urls.iter().any(|u| u.starts_with("https://example.com/app.ts")), "{urls:?}");
        assert!(urls.iter().any(|u| u.starts_with("https://www.example.com/index.html")), "{urls:?}");
    }

    #[test]
    fn skips_version_numbers_and_short_dotted_noise() {
        let out = detect_urls_and_domains("v1.2.3 of the v2.11.0 release, e.g. this, i.e. that", true);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn no_false_positive_on_ordinary_prose() {
        let out = detect_urls_and_domains("tell me about recursion in plain English, no web needed", true);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn strip_tail_and_utf16_length_helpers() {
        assert_eq!(strip_tail("https://x.dev/path."), "https://x.dev/path");
        assert_eq!(strip_tail("main.rs,"), "main.rs");
        assert_eq!(strip_tail("no tail punctuation"), "no tail punctuation");
        // JS .length is UTF-16 code units (emoji = 2).
        assert_eq!(js_len("😀"), 2);
        assert_eq!(js_len("skiran.dev"), 10);
    }
}
