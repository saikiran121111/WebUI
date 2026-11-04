//! Purely-lexical stand-ins for the two Node `path` calls the skill
//! loaders use: `path.resolve(dir, rel)` (absolute `dir`, no cwd, no
//! filesystem) and the containment test `abs.startsWith(dir + path.sep)`.

use std::path::{Component, Path, PathBuf};

/// Node `path.resolve(dir, rel)` for an absolute `dir`: pure component
/// arithmetic (`.` dropped, `..` pops, names push). Callers pre-filter
/// `rel` values starting with `/` or `http`, and TS's `path.resolve` never
/// touches the filesystem either.
pub fn resolve_lexically(dir: &Path, rel: &str) -> PathBuf {
    let mut out = dir.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            // Defensive: absolute/prefixed rel never reaches here (the
            // callers filter '/'); keep the function total if it does.
            other => out = out.join(other.as_os_str()),
        }
    }
    out
}

/// `abs.startsWith(dir + path.sep)`: a STRICT child of `dir`. `abs == dir`
/// fails (a path can never start with itself + separator), and sibling
/// names sharing a string prefix (`…/xlsx` vs `…/xlsx2`) are compared by
/// component, matching the separator-bounded JS string test.
pub fn is_strict_child(abs: &Path, dir: &Path) -> bool {
    abs != dir && abs.starts_with(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_is_purely_lexical() {
        let dir = Path::new(r"D:\root\.cskills\xlsx");
        assert_eq!(
            resolve_lexically(dir, "ref.md"),
            PathBuf::from(r"D:\root\.cskills\xlsx\ref.md")
        );
        assert_eq!(
            resolve_lexically(dir, "./docs/guide.md"),
            PathBuf::from(r"D:\root\.cskills\xlsx\docs\guide.md")
        );
        assert_eq!(
            resolve_lexically(dir, "../linked.md"),
            PathBuf::from(r"D:\root\.cskills\linked.md")
        );
        assert_eq!(
            resolve_lexically(dir, "a/./b/../c.md"),
            PathBuf::from(r"D:\root\.cskills\xlsx\a\c.md")
        );
    }

    #[test]
    fn strict_child_edge_table() {
        let dir = Path::new(r"D:\root\.cskills\xlsx");
        assert!(is_strict_child(&PathBuf::from(r"D:\root\.cskills\xlsx\ref.md"), dir));
        assert!(!is_strict_child(dir, dir));
        // Sibling sharing the dir's string prefix must NOT count (JS's
        // dir+sep test rejects it; component compare rejects it too).
        assert!(!is_strict_child(
            &PathBuf::from(r"D:\root\.cskills\xlsx2\ref.md"),
            dir
        ));
        assert!(!is_strict_child(&PathBuf::from(r"D:\root\.cskills\ref.md"), dir));
    }
}
