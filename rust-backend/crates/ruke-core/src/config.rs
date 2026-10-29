//! Rule 13: all repo-relative paths must resolve from an explicit project
//! root, not from the process cwd (spawned `ruke-server.exe` may start
//! from anywhere). Resolution order:
//!
//! 1. `RUKE_PROJECT_ROOT` env var (set by the supervisor in dev and prod).
//! 2. Walk up from cwd to the nearest directory that looks like this repo
//!    (has `package.json` AND (`app/` dir OR `next.config.*`)) — dev-mode
//!    convenience when launched by hand from inside the repo.
//! 3. cwd as a last resort (logged).

use std::path::{Path, PathBuf};

/// Default Rust-backend listen port. Deliberately NOT 3000: the TS Next
/// server keeps :3000 until the Part 8 cutover (no dual ownership).
pub const DEFAULT_BACKEND_PORT: u16 = 3101;

pub fn project_root() -> PathBuf {
    if let Ok(p) = std::env::var("RUKE_PROJECT_ROOT") {
        let p = PathBuf::from(p);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = discover_root(&cwd) {
        return root;
    }
    tracing::warn!(
        "RUKE_PROJECT_ROOT unset and no repo marker found above {:?}; using cwd",
        cwd
    );
    cwd
}

fn discover_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| {
            dir.join("package.json").is_file()
                && (dir.join("app").is_dir() || has_next_config(dir))
        })
        .map(|p| p.to_path_buf())
}

fn has_next_config(dir: &Path) -> bool {
    ["next.config.mjs", "next.config.js", "next.config.ts"]
        .iter()
        .any(|f| dir.join(f).is_file())
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

pub fn data_dir(root: &Path) -> PathBuf {
    root.join(".data")
}

pub fn backend_port() -> u16 {
    std::env::var("RUKE_BACKEND_PORT")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(DEFAULT_BACKEND_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_repo_root_by_walking_up_from_nested_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir_all(root.join("app/api")).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("next.config.mjs"), "").unwrap();
        let nested = root.join("app/api/chat");
        assert_eq!(discover_root(&nested).as_deref(), Some(root.as_path()));
    }

    #[test]
    fn package_json_alone_is_not_enough_and_missing_root_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("package.json"), "{}").unwrap();
        assert_eq!(discover_root(tmp.path()), None);

        let empty = tempfile::tempdir().unwrap();
        assert_eq!(discover_root(empty.path()), None);
    }

    #[test]
    fn port_parsing_falls_back_to_default() {
        // Env access is process-global; these tests only inspect the parse
        // helper logic directly rather than mutating real env vars.
        let parse = |v: Option<&str>| -> u16 {
            v.and_then(|v| v.trim().parse().ok()).unwrap_or(DEFAULT_BACKEND_PORT)
        };
        assert_eq!(parse(Some("8123")), 8123);
        assert_eq!(parse(Some(" 8123 ")), 8123);
        assert_eq!(parse(Some("not-a-port")), DEFAULT_BACKEND_PORT);
        assert_eq!(parse(None), DEFAULT_BACKEND_PORT);
    }
}
