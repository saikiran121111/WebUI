//! Core-tier bundle loading — the `.cskills` half of
//! `lib/decision/skill-loader.ts` (`stripFrontmatter`,
//! `stripExecutableSections`, `loadCoreSkillBundle`).
//!
//! JS↔Rust regex parity notes (the multi-line strip regexes are the subtle
//! part of this port — the golden replays compare the resulting block
//! bytes exactly):
//!
//! - JS multiline `^` fires after `\n` AND after a lone `\r` (and
//!   ` / `); Rust `(?m)^` fires only after `\n`. Likewise JS `$`
//!   sits before `\n`, `\r`, ` / ` while Rust `(?m)$` sits only
//!   before `\n`. Lone-`\r` line separators are a documented residual
//!   divergence (the repo's skill corpus is LF/CRLF only — verified with
//!   `cat -A`), so pinned fixtures never hit it.
//! - Fence strip (`^```[ \t]*$` closing): JS's `$` sits BEFORE the `\r` of
//!   a CRLF, so the JS match ENDS BEFORE `\r` and the `\r\n` survives the
//!   removal. Rust's `$` can't stop before `\r`, so we consume the whole
//!   eol into `(?P<eol>...)` and re-emit it — the surviving text is
//!   identical either way.
//! - CLI-line strip (`[^\n]*$` tail): the opposite asymmetry — JS's greedy
//!   `[^\n]*` SWALLOWS the `\r` (only `\n` is excluded) and `$` then fires
//!   before `\n`, so a CRLF CLI line's `\r` IS deleted. Rust therefore
//!   uses an explicit `(?P<cr>\r)?(?P<nl>\n|$)` tail and the replacement
//!   re-emits ONLY the newline. Uniformly re-emitting the eol here would
//!   NOT be equivalent.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::jsstr;
use crate::jspath::{is_strict_child, resolve_lexically};
use crate::registry::{is_safe_skill_name, read_utf8_file, LINK_RE};

/// `CORE_SKILLS_DIR` in skill-loader.ts.
const CORE_SKILLS_DIR: &str = ".cskills";
/// `MAX_SKILL_BUNDLE_BYTES` — JS length cap in UTF-16 units (see `jsstr`).
const MAX_SKILL_BUNDLE_BYTES: usize = 9_000;

/// `SCRIPT_CONTRACT_SKILLS` in skill-loader.ts: only these get the
/// executable-stripping pass (both for the main file and for linked ones).
pub fn is_script_contract_skill(name: &str) -> bool {
    matches!(name, "xlsx" | "docx" | "pdf" | "pptx" | "archify")
}

pub fn core_skill_dir(root: &Path, name: &str) -> PathBuf {
    root.join(CORE_SKILLS_DIR).join(name)
}

/// `stripFrontmatter`: removes a leading `---` block only.
static FRONTMATTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n[\s\S]*?\r?\n---\r?\n").unwrap());

pub fn strip_frontmatter(md: &str) -> String {
    FRONTMATTER_RE.replace(md, "").into_owned()
}

/// TS source: `/^```(?:bash|…|py)\b[\s\S]*?^```[ \t]*$/gim`. The Rust
/// `regex` crate has no look-around, so JS's zero-width `\b` after the
/// language token is ported as a CONSUMING class: whichever char JS leaves
/// for `[\s\S]*?` to swallow, Rust consumes it first — the match span (and
/// therefore the replacement output) is byte-identical, since the whole
/// region up to the closing fence is removed either way. `pythonx`/`pyx`
/// still never match because the boundary class rejects word chars.
static FENCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?im)^```(?:bash|sh|shell|console|powershell|ps1|cmd|bat|python|py)",
        r"(?:[^A-Za-z0-9_]|$)[\s\S]*?^```[ \t]*(?P<eol>\r\n?|\n|$)"
    ))
    .unwrap()
});

static CLI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?im)^[ \t]*(?:\$[ \t]|pip[3]? install|python[3]? \S*\.py|libreoffice ",
        r"|--headless|markitdown |uv run |npm install )[^\r\n]*",
        r"(?P<cr>\r)?(?P<nl>\n|$)"
    ))
    .unwrap()
});

static NL_RUN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// `stripExecutableSections`: fenced command blocks removed (whole fence
/// lines included, eol restored), command-looking lines removed (their
/// trailing `\r` in CRLF files included, newline restored), 3+ LF runs
/// collapsed to 2, then JS `.trim()`.
pub fn strip_executable_sections(bundle: &str) -> String {
    // Owned String returns: `m.as_str()` borrows the Captures temporary,
    // not the haystack, so `&str` can't escape the closure.
    let no_fences = FENCE_RE.replace_all(bundle, |c: &Captures| {
        c.name("eol").map_or_else(String::new, |m| m.as_str().to_string())
    });
    let no_cli = CLI_RE.replace_all(&no_fences, |c: &Captures| {
        c.name("nl").map_or_else(String::new, |m| m.as_str().to_string())
    });
    let collapsed = NL_RUN_RE.replace_all(&no_cli, "\n\n");
    jsstr::js_trim(&collapsed).to_string()
}

/// `loadCoreSkillBundle(root, name)`: fresh read every call (the TS has no
/// cache). Unsafe names and unreadable `SKILL.md` yield `None`.
pub fn load_core_skill_bundle(root: &Path, name: &str) -> Option<String> {
    if !is_safe_skill_name(name) {
        return None;
    }
    let dir = core_skill_dir(root, name);
    let main = read_utf8_file(&dir.join("SKILL.md"))?;
    let is_script = is_script_contract_skill(name);

    let mut bundle = strip_frontmatter(&main);
    if is_script {
        bundle = strip_executable_sections(&bundle);
    }

    // Links are scanned from the ORIGINAL main text (TS `main.matchAll`),
    // not the stripped bundle.
    for caps in LINK_RE.captures_iter(&main) {
        if jsstr::js_len(&bundle) >= MAX_SKILL_BUNDLE_BYTES {
            break;
        }
        let rel = &caps[1];
        if rel.starts_with("http") || rel.starts_with('/') {
            continue;
        }
        let abs = resolve_lexically(&dir, rel);
        if !is_strict_child(&abs, &dir) {
            continue;
        }
        let Some(mut linked) = read_utf8_file(&abs) else {
            continue; // TS catch -> continue
        };
        if is_script {
            linked = strip_executable_sections(&linked);
        }
        bundle.push_str("\n\n");
        bundle.push_str(&linked);
    }

    if jsstr::js_len(&bundle) <= MAX_SKILL_BUNDLE_BYTES {
        return Some(bundle);
    }
    // JS: const cut = bundle.lastIndexOf("\n", 9000);
    //     return cut > 4500 ? bundle.slice(0, cut) : bundle.slice(0, 9000);
    // The `cut > 4500` comparison happens on the UTF-16 index; the
    // fallback hard slice may snap a surrogate pair (documented deviation).
    if let Some((units, byte_at_nl)) =
        jsstr::last_newline_at_or_below(&bundle, MAX_SKILL_BUNDLE_BYTES)
    {
        if units > MAX_SKILL_BUNDLE_BYTES / 2 {
            return Some(bundle[..byte_at_nl].to_string());
        }
    }
    Some(jsstr::js_slice_head(&bundle, MAX_SKILL_BUNDLE_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn strip(bundle: &str) -> String {
        strip_executable_sections(bundle)
    }

    #[test]
    fn frontmatter_strip_is_anchored_and_crlf_tolerant() {
        assert_eq!(strip_frontmatter("---\r\nname: x\r\n---\r\nBody"), "Body");
        assert_eq!(strip_frontmatter("---\nx\n---\nBody"), "Body");
        // Not at byte 0 -> untouched (JS anchored single replace).
        assert_eq!(strip_frontmatter("a\n---\nx\n---\nBody"), "a\n---\nx\n---\nBody");
        // BOM defeats the anchor in JS and here (parity).
        assert_eq!(strip_frontmatter("\u{feff}---\nx\n---\nB"), "\u{feff}---\nx\n---\nB");
        // Unterminated frontmatter -> no strip.
        assert_eq!(strip_frontmatter("---\nno end"), "---\nno end");
    }

    #[test]
    fn fence_blocks_removed_including_both_fence_lines_lf() {
        let out = strip("intro\n```bash\n$ echo hi\nls\n```\nkeep");
        assert_eq!(out, "intro\n\nkeep");
    }

    #[test]
    fn fence_blocks_removed_crlf_js_match_ends_before_cr() {
        // JS: closing `^```[ \t]*$` ends BEFORE the \r -> \r\n survives.
        // Rust: consumes \r\n into eol, re-emits it -> identical result.
        let out = strip("intro\r\n```bash\r\n$ echo hi\r\n```\r\nkeep\r\n");
        assert_eq!(out, "intro\r\n\r\nkeep");
    }

    #[test]
    fn fence_language_boundary_ascii_like_js_word() {
        // ```pythonx must NOT match (JS \b is ASCII, python|py branches
        // both blocked by the following 'x'); plain ```py must match.
        let kept = strip("a\n```pythonx\ncmd\n```\nb");
        assert!(kept.contains("pythonx"));
        let gone = strip("a\n```py\ncmd\n```\nb");
        assert!(!gone.contains("cmd"));
        assert_eq!(gone, "a\n\nb");
    }

    #[test]
    fn cli_line_strip_swallows_crlr_lf_restored() {
        // The restored newline survives the line surgery but the FINAL
        // JS `.trim()` pass then eats a leading blank — parity output.
        // LF line: match excludes \n, so the newline survives until trim.
        assert_eq!(strip("$ cmd\nnext"), "next");
        // CRLF line: JS [^\n]* CONSUMED the \r then `$` fired before \n,
        // so the \r is deleted; Rust drops (?P<cr>), keeps (?P<nl>).
        assert_eq!(strip("$ cmd\r\nnext"), "next");
        // Indented CLI line, and a mid-line `$ ` which is NOT line-anchored.
        assert_eq!(strip("  $ ls\nkeep $ 5"), "keep $ 5");
        // Bare "$" without following space/tab: no match (JS `\$[ \t]`).
        assert_eq!(strip("$5\nnext"), "$5\nnext");
    }

    #[test]
    fn known_cli_tokens_all_stripped() {
        for line in [
            "pip install openpyxl",
            "pip3 install pypdf",
            "python3 make.py",
            "libreoffice --headless x",
            "--headless mode",
            "markitdown f.docx",
            "uv run tool",
            "npm install pkg",
        ] {
            let out = strip(&format!("{line}\nkeep"));
            assert_eq!(out, "keep", "token line not stripped: {line}");
        }
    }

    #[test]
    fn collapse_and_trim_like_js_final_passes() {
        assert_eq!(strip("a\n\n\n\nb"), "a\n\nb");
        // \r characters interrupt LF runs: collapse must NOT fire across
        // \r\n\r\n sequences (each run is only \n{2}).
        assert_eq!(strip("a\r\n\r\n\r\nb"), "a\r\n\r\n\r\nb");
        assert_eq!(strip("  \n  hi  \r\n"), "hi");
    }

    fn core_skill_fixture(root: &Path, name: &str, main: &str) -> PathBuf {
        let dir = core_skill_dir(root, name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), main).unwrap();
        dir
    }

    #[test]
    fn bundle_script_stripping_and_linked_append_fresh_read() {
        let tmp = TempDirHolder::new();
        let dir = core_skill_fixture(
            tmp.path(),
            "xlsx",
            "---\nname: xlsx\n---\nGuide [ref](ref.md)\n```bash\n$ run\n```\n",
        );
        fs::write(dir.join("ref.md"), "Ref\n$ run2\n").unwrap();
        let bundle = load_core_skill_bundle(tmp.path(), "xlsx").unwrap();
        assert!(bundle.starts_with("Guide"));
        assert!(!bundle.contains("```"));
        assert!(!bundle.contains("$ run"));
        assert!(!bundle.contains("run2")); // script skills strip LINKED too
        assert!(bundle.contains("Ref"));
        // Second call re-reads (no cache, like TS): change the file, see
        // the change reflected.
        fs::write(dir.join("SKILL.md"), "Changed").unwrap();
        assert!(load_core_skill_bundle(tmp.path(), "xlsx")
            .unwrap()
            .starts_with("Changed"));
    }

    #[test]
    fn non_script_skill_keeps_executables() {
        let tmp = TempDirHolder::new();
        core_skill_fixture(tmp.path(), "html-viewer", "A\n```bash\n$ run\n```\nB");
        let bundle = load_core_skill_bundle(tmp.path(), "html-viewer").unwrap();
        assert!(bundle.contains("$ run"));
    }

    #[test]
    fn over_cap_uses_lastnewline_above_half_else_hard_cut() {
        let tmp = TempDirHolder::new();
        // Newline at unit 8000 > 4500 -> cut at the newline (length 8000).
        let main = format!("{}\n{}", "x".repeat(8000), "y".repeat(5000));
        core_skill_fixture(tmp.path(), "pdf", &main);
        let b = load_core_skill_bundle(tmp.path(), "pdf").unwrap();
        assert_eq!(jsstr::js_len(&b), 8000);

        // Newline only at unit 4000 (<= 4500) -> hard cut at 9000.
        let main = format!("{}\n{}", "x".repeat(4000), "y".repeat(6000));
        core_skill_fixture(tmp.path(), "pdf", &main);
        let b = load_core_skill_bundle(tmp.path(), "pdf").unwrap();
        assert_eq!(jsstr::js_len(&b), 9000);
    }

    #[test]
    fn over_cap_astral_boundary_snaps_below_cut_documented_deviation() {
        let tmp = TempDirHolder::new();
        // Pair straddles unit 9000: JS would emit a lone surrogate there;
        // Rust snaps to the complete char below (unit length 8999).
        let main = format!("{}\u{1D54F}z", "x".repeat(8999));
        core_skill_fixture(tmp.path(), "pdf", &main);
        let b = load_core_skill_bundle(tmp.path(), "pdf").unwrap();
        assert_eq!(jsstr::js_len(&b), 8999);
        assert!(!b.ends_with('z'));
    }

    #[test]
    fn linked_breaks_check_before_append_and_skips_outside_http_abs() {
        let tmp = TempDirHolder::new();
        let dir = core_skill_fixture(
            tmp.path(),
            "archify",
            &format!(
                "{}\n[a](big1.md) [b](big2.md) [c](http://x/y.md) [d](/y.md) [e](../out.md)",
                "m".repeat(8900)
            ),
        );
        fs::write(dir.join("big1.md"), "1".repeat(500)).unwrap();
        fs::write(dir.join("big2.md"), "2".repeat(500)).unwrap();
        fs::write(tmp.path().join("out.md"), "MUST-NOT-LOAD").unwrap();
        let b = load_core_skill_bundle(tmp.path(), "archify").unwrap();
        // main = 8900 m + '\n' + 70-char link line = 8971 units (<9000, so
        // iteration 1 appends: +2 +500 = 9473). Iteration 2 sees 9473 >=
        // 9000 and BREAKS before big2. Final bundle is over cap, so the
        // newline-cut fires: lastIndexOf("\n", 9000) = 8972 (the first of
        // the appended "\n\n") > 4500 -> slice(0, 8972). JS prunes the
        // just-appended block the same way — the 1s do NOT survive:
        assert_eq!(jsstr::js_len(&b), 8972);
        assert!(b.contains("[a](big1.md)")); // scan text stays in the bundle
        assert!(!b.contains(&"1".repeat(500))); // pruned by the newline cut
        assert!(!b.contains(&"2".repeat(500))); // loop broke before second
        assert!(!b.contains("MUST-NOT-LOAD")); // ../out.md is not strict-child
    }

    // Small local holder so tests don't import tempfile at module top.
    struct TempDirHolder(tempfile::TempDir);
    impl TempDirHolder {
        fn new() -> Self {
            Self(tempfile::TempDir::new().unwrap())
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
    }
}
