//! `lib/skills/frontmatter.ts` — minimal YAML frontmatter reader for
//! SKILL.md files (name + description).
//!
//! Parity notes:
//! - Block regex `/^---\r?\n([\s\S]*?)\r?\n---/` → Rust
//!   `(?s)^---\r?\n(.*?)\r?\n---`. Both anchor at string start only (no
//!   multiline), lazy body, and require a newline sequence BEFORE the
//!   closing `---` ("---\n---" does NOT match in either language).
//! - Line splitting `/\r?\n/` ⇔ `split('\n')` + strip one trailing `\r`
//!   (identical for "\r\r\n" edge: the lone trailing-\r strip reproduces
//!   JS's single-\r consumption).
//! - Keys are lower-cased; later duplicates overwrite (JS `Map.set`);
//!   indented continuation lines append `" " + trim` to the current key.
//!   Field lookup order is irrelevant (only `name`/`description` are read),
//!   so a HashMap matches the observable behavior.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
}

static BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").unwrap());
static KEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$").unwrap());
static CONT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+\S").unwrap());

/// `parseFrontmatter`: `None` ⇔ TS `null` (no frontmatter block).
pub fn parse_frontmatter(markdown: &str) -> Option<SkillFrontmatter> {
    let block = BLOCK_RE.captures(markdown)?;

    let mut fields: HashMap<String, String> = HashMap::new();
    let mut current_key: Option<String> = None;
    for raw_line in block[1].split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(caps) = KEY_RE.captures(line) {
            let key = caps[1].to_ascii_lowercase();
            fields.insert(key.clone(), caps[2].trim().to_string());
            current_key = Some(key);
            continue;
        }
        // Indented continuation line (folded multi-line description).
        if let Some(key) = &current_key {
            if CONT_RE.is_match(line) {
                let prev = fields.get(key).cloned().unwrap_or_default();
                fields.insert(key.clone(), format!("{prev} {}", line.trim()));
            }
        }
    }
    Some(SkillFrontmatter {
        name: fields.get("name").cloned().unwrap_or_default(),
        description: fields.get("description").cloned().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys_lowercased_trimmed_and_folded() {
        let md = "---\r\nname: Demo\r\ndescription: first part\r\n  second part\r\nx Other: ignored\r\n---\nBody";
        let f = parse_frontmatter(md).unwrap();
        assert_eq!(f.name, "Demo");
        assert_eq!(f.description, "first part second part");
    }

    #[test]
    fn missing_block_is_null_and_defaults_empty() {
        assert!(parse_frontmatter("# just a heading").is_none());
        assert!(parse_frontmatter("---\n---").is_none()); // needs the inner newline
        let f = parse_frontmatter("---\ntags: x\n---\n").unwrap();
        assert_eq!(f.name, "");
        assert_eq!(f.description, "");
    }

    #[test]
    fn duplicate_key_last_wins_and_continuation_without_key_ignored() {
        let md = "---\ndescription: one\ndescription: two\n  cont\n---";
        let f = parse_frontmatter(md).unwrap();
        // Map.set overwrite ⇒ "two", then the indented line appends to it.
        assert_eq!(f.description, "two cont");
    }

    #[test]
    fn key_regex_rejects_leading_digit_and_hyphen_start() {
        let md = "---\n9bad: x\n-also: y\nok_key-2: fine\n---";
        let f = parse_frontmatter(md).unwrap();
        assert_eq!(f.name, ""); // no `name` key survived the rejects
    }
}
