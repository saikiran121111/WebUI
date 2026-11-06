//! Phase 2 (Playwright MCP driver): the model-facing actuation path runs
//! through Microsoft's official Playwright MCP server, pinned to
//! `@playwright/mcp@0.0.84` (Apache-2.0, microsoft/playwright-mcp), spoken
//! to as a stdio MCP CLIENT via the official Rust SDK (`rmcp` 3.9.0,
//! client + child-process transport only).
//!
//! The same-browser gate that makes this legal in the Ruke engine was
//! proven live in `.ai-coordination/mcp-attach-proto.mjs` and
//! `mcp-extitle-proto.mjs`: the MCP server ATTACHES to Ruke's own
//! Chromium over loopback CDP (`--cdp-endpoint http://127.0.0.1:<port>`),
//! so there is exactly ONE interactive browser and one browser owner.
//! Ruke keeps the CDP connection, the event pump, the registry, the
//! screenshot path (Phase 1), every READ (dom_cua visible DOM, pw
//! predicate/box reads, aria snapshots) and the lifecycle; only the
//! actuation primitives route through MCP.
//!
//! Fail-closed package discipline (plan §Phase 2 "verify real upstream
//! packages"): the CLI is resolved from `node_modules` by walking up from
//! the engine root, and the package's own `package.json` must report the
//! pinned name+version EXACTLY — a stale or wrong tree is an
//! `Unavailable` error naming `npm ci`, never a silent drift onto a new
//! upstream release. `RUKE_MCP_CLI` / `RUKE_MCP_NODE` override the paths
//! for CI. The server process is `kill_on_drop` (no zombie node children,
//! even on abort) and rmcp's `ChildWithCleanup` reaps it on service drop.
//!
//! `browser_run_code_unsafe` is NEVER called (it evaluates arbitrary JS
//! in the server process; every need Ruke has is covered by the typed
//! tools), and Ruke never calls `browser_snapshot`/`browser_take_screenshot`
//! — observation stays on Ruke's own native reads so the model-visible
//! state contract (and the Phase-1 screenshot transport) is unchanged.
//!
//! Cancellation note: when a turn is cancelled mid-call the in-flight
//! Playwright action is not abortable at the protocol layer (the MCP
//! cancel notification only carries a request id rmcp owns internally);
//! the caller surfaces a typed error stating the action MAY have applied
//! and that fresh observation is required before retrying — never a
//! silent "not applied" claim.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, ContentBlock};
use rmcp::service::{serve_client, RunningService};
use rmcp::transport::TokioChildProcess;
use rmcp::RoleClient;
use serde_json::{json, Map, Value};
use tokio::process::Command;

/// Pinned upstream package (recorded in `integrations/playwright-mcp/`
/// with license + exact version; `package.json` carries the same pin).
pub const MCP_PACKAGE: &str = "@playwright/mcp";
pub const MCP_VERSION: &str = "0.0.84";

/// Env overrides for CI / non-standard layouts; the pinned-version check
/// still applies unless RUKE_MCP_CLI names the cli.js directly.
pub const ENV_MCP_CLI: &str = "RUKE_MCP_CLI";
pub const ENV_MCP_NODE: &str = "RUKE_MCP_NODE";

/// Per-tool call budgets. Actuation gets the same budget the Playwright
/// action timeouts use server-side (`--timeout-action 10000`) plus the
/// client-side queueing headroom; list/select and evaluate are quick
/// reads capped tighter so a wedged probe can never stall a turn.
pub const ACT_TIMEOUT: Duration = Duration::from_secs(15);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(8);
pub const EVAL_TIMEOUT: Duration = Duration::from_secs(8);

/// The MCP tool names this crate is allowed to call (the ones whose
/// schemas were captured verbatim into `.ai-coordination/mcp-tools-dump.txt`
/// during recon — the bridge must only send arguments those schemas
/// declare).
pub mod tool {
    pub const TABS: &str = "browser_tabs";
    pub const NAVIGATE: &str = "browser_navigate";
    pub const CLICK: &str = "browser_click";
    pub const TYPE: &str = "browser_type";
    pub const FILL_FORM: &str = "browser_fill_form";
    pub const PRESS_KEY: &str = "browser_press_key";
    pub const SELECT_OPTION: &str = "browser_select_option";
    pub const HOVER: &str = "browser_hover";
    pub const MOUSE_MOVE_XY: &str = "browser_mouse_move_xy";
    pub const MOUSE_CLICK_XY: &str = "browser_mouse_click_xy";
    pub const MOUSE_WHEEL: &str = "browser_mouse_wheel";
    pub const MOUSE_DOWN: &str = "browser_mouse_down";
    pub const MOUSE_UP: &str = "browser_mouse_up";
    pub const MOUSE_DRAG_XY: &str = "browser_mouse_drag_xy";
    pub const EVALUATE: &str = "browser_evaluate";
    pub const WAIT_FOR: &str = "browser_wait_for";
    // Modal-state tools. The bridge calls FILE_UPLOAD with explicit
    // paths to apply files the driver's page saw, with NO paths to
    // cancel an orphan chooser, and HANDLE_DIALOG to close a dialog
    // the driver is blocking on that Ruke's registry never recorded.
    pub const FILE_UPLOAD: &str = "browser_file_upload";
    pub const HANDLE_DIALOG: &str = "browser_handle_dialog";
}

/// One browser tool response: the text blocks joined (the MCP text the
/// Ruke bridge parses or maps to typed errors) plus the server's
/// `isError` flag. Image blocks are IGNORED here on purpose — the model
/// never receives MCP screenshots; observation belongs to Ruke's native
/// reads (module docs).
#[derive(Clone, Debug)]
pub struct McpCall {
    pub text: String,
    pub is_error: bool,
}

/// MCP-layer failures, before the command surface maps them to
/// [`crate::errors::BrowserError`].
#[derive(Clone, Debug, thiserror::Error)]
pub enum McpError {
    /// The pinned CLI/node could not be found or the found tree is not
    /// the pinned version. Fail-closed: names the fix (`npm ci`).
    #[error("Playwright MCP is unavailable: {why}")]
    Unavailable { why: String },
    /// The MCP call exceeded its client-side budget. The action may have
    /// applied; the caller's message must say so.
    #[error("Playwright MCP tool {tool} timed out after {timeout_ms} ms")]
    Timeout { tool: String, timeout_ms: u64 },
    /// The server ran the tool and reported a tool-level error
    /// (`isError`); `text` is the server's message (recon captured the
    /// shapes, e.g. `Error: strict mode violation: …`).
    #[error("Playwright MCP tool {tool} failed: {text}")]
    Tool { tool: String, text: String },
    /// rmcp service-layer failure (initialize, dispatch, connection).
    #[error("Playwright MCP service error: {detail}")]
    Service { detail: String },
}

/// Resolved launch inputs for the MCP server child.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpCli {
    pub cli: PathBuf,
    pub node: PathBuf,
}

/// Locate and PROVE the pinned `@playwright/mcp` CLI. Walks up from
/// `from` looking for `node_modules/@playwright/mcp/package.json` and
/// checks the package's own manifest reports EXACTLY the pinned
/// name+version before trusting it. Never invents a path and never runs
/// an unpinned tree.
pub fn resolve_mcp_cli(from: &Path) -> Result<McpCli, McpError> {
    let node = std::env::var_os(ENV_MCP_NODE)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));

    if let Some(v) = std::env::var_os(ENV_MCP_CLI) {
        let p = PathBuf::from(&v);
        if !p.is_file() {
            return Err(McpError::Unavailable {
                why: format!(
                    "{ENV_MCP_CLI} points at {} which is not a file",
                    p.display()
                ),
            });
        }
        return Ok(McpCli { cli: p, node });
    }

    let mut dir = Some(from.to_path_buf());
    while let Some(d) = dir {
        let pkg_dir = d.join("node_modules").join("@playwright").join("mcp");
        let pkg_json = pkg_dir.join("package.json");
        if pkg_json.is_file() {
            let raw = std::fs::read_to_string(&pkg_json).map_err(|e| McpError::Unavailable {
                why: format!("cannot read {}: {e}", pkg_json.display()),
            })?;
            let manifest: Value =
                serde_json::from_str(&raw).map_err(|e| McpError::Unavailable {
                    why: format!("malformed {}: {e}", pkg_json.display()),
                })?;
            let name = manifest.get("name").and_then(Value::as_str).unwrap_or("");
            let version = manifest
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("");
            if name != MCP_PACKAGE || version != MCP_VERSION {
                return Err(McpError::Unavailable {
                    why: format!(
                        "{} found {name}@{version} at {}; Ruke pins {MCP_PACKAGE}@{MCP_VERSION} — run `npm ci` at {}",
                        MCP_PACKAGE,
                        pkg_dir.display(),
                        d.display()
                    ),
                });
            }
            // `bin` is a string or a {name: path} map in npm manifests;
            // fall back to the package's known entry file.
            let bin = match manifest.get("bin") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Object(m)) => m
                    .values()
                    .filter_map(Value::as_str)
                    .next()
                    .unwrap_or("cli.js")
                    .to_string(),
                _ => "cli.js".to_string(),
            };
            let cli = pkg_dir.join(&bin);
            if !cli.is_file() {
                return Err(McpError::Unavailable {
                    why: format!(
                        "{} declares bin {bin} but {} is missing",
                        MCP_PACKAGE,
                        cli.display()
                    ),
                });
            }
            return Ok(McpCli { cli, node });
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    Err(McpError::Unavailable {
        why: format!(
            "{MCP_PACKAGE}@{MCP_VERSION} not found under node_modules walking up from {}; run `npm ci` at the project root",
            from.display()
        ),
    })
}

/// Attach a fresh MCP server to Ruke's OWN running Chromium.
///
/// `cdp_port` is the loopback DevTools port of the launched host
/// (`host.rs` DevToolsActivePort handshake — the same port the raw CDP
/// bridge uses). `--caps vision` unlocks the coordinate tools the cua/
/// dom_cua bridge needs; `--no-webmcp` keeps the in-page WebMCP surface
//  off (Ruke's `webmcp_disabled` contract); `--image-responses allow`
/// only matters for tools Ruke never calls, and their image blocks are
/// dropped in `call()` anyway. `--allow-unrestricted-file-access` lets
/// `browser_file_upload` accept the absolute paths Ruke's file-chooser
/// flow validates itself. The server's stderr is inherited so it
/// lands in the supervisor log next to the server's own lines.
pub struct McpSession {
    service: RunningService<RoleClient, ()>,
}

impl McpSession {
    pub async fn attach(
        from_dir: &Path,
        cdp_port: u16,
        headless: bool,
        out_dir: &Path,
    ) -> Result<Self, McpError> {
        let cli = resolve_mcp_cli(from_dir)?;
        std::fs::create_dir_all(out_dir).map_err(|e| McpError::Unavailable {
            why: format!("cannot create MCP output dir {}: {e}", out_dir.display()),
        })?;
        let mut cmd = Command::new(&cli.node);
        cmd.arg(&cli.cli);
        cmd.args([
            "--cdp-endpoint",
            &format!("http://127.0.0.1:{cdp_port}"),
            "--caps",
            "vision",
            "--no-webmcp",
            "--image-responses",
            "allow",
            "--output-dir",
            &out_dir.to_string_lossy(),
            "--timeout-action",
            "10000",
            "--timeout-navigation",
            "30000",
            // Recon latency: the default settle-after-action is fine for
            // Playwright's own assertions but the bridge re-reads state
            // natively, so a short settle keeps actuation cheap.
            "--timeout-settle",
            "500",
            // Upload paths come from Ruke's own flows (temp and
            // profile trees outside the server's output + workspace
            // roots); 0.0.84's `checkFile` guard refuses them
            // without this flag (`File access denied: … is outside
            // allowed roots` — root-caused live in
            // `.ai-coordination/mcp-chooser-proto.mjs`). The attach
            // is loopback same-host and Ruke validates every path.
            "--allow-unrestricted-file-access",
        ]);
        if headless {
            cmd.arg("--headless");
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::inherit());
        cmd.kill_on_drop(true);

        let transport = TokioChildProcess::new(cmd).map_err(|e| McpError::Unavailable {
            why: format!(
                "cannot spawn {} via {}: {e}",
                MCP_PACKAGE,
                cli.node.display()
            ),
        })?;
        // `serve_client` performs initialize + the initialized
        // notification for us (recon proved the raw-protocol shape:
        // the notification must carry no id — rmcp gets this right).
        let service = serve_client((), transport)
            .await
            .map_err(|e| McpError::Service {
                detail: e.to_string(),
            })?;
        tracing::info!(
            cdp_port,
            cli = %cli.cli.display(),
            "Playwright MCP attached to the Ruke browser (same Chromium)"
        );
        Ok(Self { service })
    }

    /// One MCP tool call under a client-side budget. Tool-level failure
    /// is returned as `Ok(McpCall { is_error: true })` — the callers map
    /// the server's message text to the right typed error (strict
    /// violation vs timeout vs generic) and some grammars (tab list)
    /// parse text out of non-error responses too.
    pub async fn call(
        &self,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<McpCall, McpError> {
        let mut map = Map::new();
        if let Value::Object(m) = args {
            map = m;
        }
        let params = CallToolRequestParams::new(name.to_string()).with_arguments(map);
        let fut = self.service.peer().call_tool(params);
        let result = tokio::time::timeout(timeout, fut).await;
        let result = match result {
            Err(_elapsed) => {
                return Err(McpError::Timeout {
                    tool: name.to_string(),
                    timeout_ms: timeout.as_millis() as u64,
                })
            }
            Ok(Err(e)) => {
                return Err(McpError::Service {
                    detail: e.to_string(),
                })
            }
            Ok(Ok(r)) => r,
        };
        let text = result
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(McpCall {
            text,
            is_error: result.is_error.unwrap_or(false),
        })
    }

    /// `call` + the is_error check folded: the locator-actuation bridge
    /// treats any tool error as a bridge error and maps the text.
    pub async fn call_ok(
        &self,
        name: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<McpCall, McpError> {
        let r = self.call(name, args, timeout).await?;
        if r.is_error {
            return Err(McpError::Tool {
                tool: name.to_string(),
                text: r.text.trim().to_string(),
            });
        }
        Ok(r)
    }

    pub async fn tabs_list(&self) -> Result<Vec<TabLine>, McpError> {
        let r = self
            .call_ok(tool::TABS, json!({ "action": "list" }), LIST_TIMEOUT)
            .await?;
        Ok(parse_tab_list(&r.text))
    }

    pub async fn tabs_select(&self, index: usize) -> Result<(), McpError> {
        self.call_ok(
            tool::TABS,
            json!({ "action": "select", "index": index }),
            LIST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }
}

/// Dropping the session drops the rmcp service, whose `ChildWithCleanup`
/// reaps the node child (belt: `kill_on_drop` on the Command).

/// One line of the `browser_tabs` list grammar, captured verbatim by
/// `.ai-coordination/mcp-tabs-proto.mjs`:
/// `- <index>: [(current) ]\[Title](URL)` — the `(current)` marker is a
/// literal token inside the line, the title may be empty (`[]`), and
/// frame-qualified snapshot refs never appear on these lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabLine {
    pub index: usize,
    pub current: bool,
    pub title: String,
    pub url: String,
}

/// Parse the tab-list text. Lines are matched by shape (`- <digits>: `),
/// which bounds the grammar to the tab list itself; the first line seen
/// for an index wins (the list appears once per response; the `new`
/// action's extra `### Ran Playwright code` section cannot produce
/// colliding lines).
pub fn parse_tab_list(text: &str) -> Vec<TabLine> {
    let mut seen: Vec<TabLine> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_start();
        let Some(rest) = line.strip_prefix("- ") else {
            continue;
        };
        let Some((idx_str, tail)) = rest.split_once(": ") else {
            continue;
        };
        if idx_str.is_empty() || !idx_str.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let index = match idx_str.parse::<usize>() {
            Ok(i) => i,
            Err(_) => continue,
        };
        if seen.iter().any(|t| t.index == index) {
            continue;
        }
        let (tail, current) = match tail.strip_prefix("(current) ") {
            Some(t) => (t, true),
            None => (tail, false),
        };
        // Link form `[title](url)`; split at the LAST "](" so titles
        // containing "](" cannot truncate the URL.
        let Some(open) = tail.strip_prefix('[') else {
            continue;
        };
        let Some(close) = open.rfind("](") else {
            continue;
        };
        let title = &open[..close];
        // Trailing whitespace first: the captured list pads lines
        // (`[Title](URL) \n`), and pin matching compares URLs exactly.
        let url = open[close + 2..].trim().trim_end_matches(')');
        seen.push(TabLine {
            index,
            current,
            title: title.to_string(),
            url: url.to_string(),
        });
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verbatim captured response from mcp-tabs-proto (three tabs,
    /// fresh attach): grammar must parse index, current marker, title,
    /// URL exactly.
    #[test]
    fn parses_captured_three_tab_list() {
        let text = "### Open tabs\n- 0: (current) [PG /](http://127.0.0.1:51234/) \n- 1: [PG /alpha](http://127.0.0.1:51234/alpha)\n- 2: [PG /beta](http://127.0.0.1:51234/beta)\n\n### Current tab\n- Page URL: http://127.0.0.1:51234/\n";
        let tabs = parse_tab_list(text);
        assert_eq!(tabs.len(), 3);
        assert_eq!(tabs[0].index, 0);
        assert!(tabs[0].current);
        assert_eq!(tabs[0].title, "PG /");
        assert_eq!(tabs[0].url, "http://127.0.0.1:51234/");
        assert!(!tabs[1].current);
        assert_eq!(tabs[1].url, "http://127.0.0.1:51234/alpha");
        assert_eq!(tabs[2].index, 2);
        assert_eq!(tabs[2].url, "http://127.0.0.1:51234/beta");
    }

    /// The select response repeats the list with a different current
    /// marker; duplicate index lines must not double-count.
    #[test]
    fn parses_select_confirmation() {
        let text = "### Open tabs\n- 0: [PG /](http://a/)\n- 1: (current) [PG /alpha](http://a/alpha)\n- 2: [PG /beta](http://a/beta)\n\n### Ran Playwright code\n```js\nawait page.setActiveTab(1);\n```\n";
        let tabs = parse_tab_list(text);
        assert_eq!(tabs.len(), 3);
        assert!(!tabs[0].current);
        assert!(tabs[1].current);
        assert!(!tabs[2].current);
    }

    /// Empty title (`[]`) and a URL containing parens: link split keeps
    /// the URL whole.
    #[test]
    fn parses_empty_title_and_paren_url() {
        let text = "- 0: (current) [](http://x/q(year)/1)\n";
        let tabs = parse_tab_list(text);
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].title, "");
        assert_eq!(tabs[0].url, "http://x/q(year)/1");
        assert!(tabs[0].current);
    }

    /// Out-of-range select is an Error response, not a list — parse
    /// yields nothing and the caller maps the tool error.
    #[test]
    fn error_text_yields_no_lines() {
        assert!(parse_tab_list("### Error\nError: Tab 99 not found").is_empty());
    }

    #[test]
    fn resolver_fails_closed_without_a_tree() {
        let dir = tempfile::tempdir().unwrap();
        let e = resolve_mcp_cli(dir.path()).unwrap_err();
        assert!(matches!(e, McpError::Unavailable { .. }));
        let msg = e.to_string();
        assert!(msg.contains("@playwright/mcp@0.0.84"), "{msg}");
        assert!(msg.contains("npm ci"), "{msg}");
    }

    #[test]
    fn resolver_accepts_the_pinned_manifest_and_rejects_drift() {
        let root = tempfile::tempdir().unwrap();
        let pkg = root.path().join("node_modules/@playwright/mcp");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("cli.js"), "// fake").unwrap();

        let write_manifest = |pkg_dir: &Path, name: &str, version: &str| {
            std::fs::write(
                pkg_dir.join("package.json"),
                json!({ "name": name, "version": version, "bin": "cli.js" }).to_string(),
            )
            .unwrap();
        };

        // Drift: found newer version ⇒ typed refusal naming npm ci.
        write_manifest(&pkg, "@playwright/mcp", "9.9.9");
        let e = resolve_mcp_cli(root.path()).unwrap_err();
        assert!(matches!(e, McpError::Unavailable { .. }));
        assert!(e.to_string().contains("9.9.9"));

        // Pinned: resolves, walking up from a nested start dir.
        write_manifest(&pkg, "@playwright/mcp", MCP_VERSION);
        let nested = root.path().join("rust-backend/target/debug");
        std::fs::create_dir_all(&nested).unwrap();
        let cli = resolve_mcp_cli(&nested).unwrap();
        assert_eq!(cli.cli, pkg.join("cli.js"));
    }
}
