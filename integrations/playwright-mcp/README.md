# Provider integration: Microsoft Playwright MCP

Ruke's browser interactive actions run through the **official Microsoft
Playwright MCP server** as the single interactive action driver
(plan: "Playwright MCP replaces custom interactive actions").

## Upstream reference (verified live, not hand-copied)

| Item | Value |
| --- | --- |
| Source | https://github.com/microsoft/playwright-mcp |
| npm package | `@playwright/mcp` |
| Pinned version | **`0.0.84`** (exact pin in root `package.json` dependencies; lockfile-enforced) |
| License | Apache-2.0 (LICENSE shipped in the package; header verified: "Apache License Version 2.0") |
| Server identity | `serverInfo: {"name":"Playwright","version":"1.65.0-alpha-2026-10-30"}` (observed via `tools/list` handshake) |
| Tool inventory | **31 tools** (captured live; subset assertions in `smoke.mjs`) |
| Platforms | Windows x64, Linux x64, macOS (arm64/x64) — the package is pure JS; the browser it drives is Ruke's own vendored Chromium |

## Rust client (Ruke side)

- crate: **`rmcp = "3.9.0"`** (crates.io, official Rust SDK),
  `default-features = false, features = ["client", "transport-child-process", "base64"]`
  (`rust-backend/crates/ruke-browser/Cargo.toml`).
- Session code: `rust-backend/crates/ruke-browser/src/mcp.rs` (product logic stays in
  the crate per the integration layout rule; this directory holds the integration
  files and upstream references).
- CLI resolution (`mcp.rs::locate_cli`): walks up from the server cwd looking for
  `node_modules/@playwright/mcp/package.json`, **proves the version equals the pin**,
  and refuses to start with an honest error otherwise. `RUKE_MCP_CLI` overrides the
  path directly.

## Setup (commands that were actually run)

```bash
npm ci                                  # installs @playwright/mcp@0.0.84 per package-lock
npx playwright install chromium         # already part of Ruke setup; vendored in .data/ms-playwright
node integrations/playwright-mcp/smoke.mjs   # the smoke test below
```

Verification actually observed on this machine (2026-11-06):

```text
npm ls @playwright/mcp   → webui-chat@0.2.0 └── @playwright/mcp@0.0.84
node -e require version  → @playwright/mcp 0.0.84 Apache-2.0 git+https://github.com/microsoft/playwright-mcp.git
```

## Smoke test — `smoke.mjs`

`node integrations/playwright-mcp/smoke.mjs` (exit 0 = green). It proves, against the
real upstream package with no mocks and no model involvement:

1. package identity (name/version/license/CLI entry in `node_modules`),
2. Chromium launched with **Ruke's own host.rs mechanism** (`--remote-debugging-port=0`
   + `DevToolsActivePort` handshake),
3. MCP stdio handshake (`initialize` → line-delimited JSON-RPC),
4. the pinned tool inventory (31 tools; asserts every tool Ruke's bridge calls exists),
5. a navigate → tabs-new → `browser_fill_form` (batched) → click-submit → snapshot
   readback → tabs list/select → vision screenshot → `browser_wait_for` cycle, and
6. **same-browser proof**: an independent raw CDP `/json/list` read shows the
   MCP-driven page targets inside the same Chromium (loopback CDP attach, no second
   browser).

Latest run: **17/17 PASS, `SMOKE: ALL GREEN`, exit 0.**

## How Ruke attaches (production)

One global `BrowserRuntime` (ruke-server `main.rs`) = one shared Chromium + one MCP
child session (16 GB-laptop law: session count is irrelevant to memory; isolation is
Ruke's registry + pin law, not separate browsers). `mcp.rs` spawns:

```text
node node_modules/@playwright/mcp/cli.js
  --cdp-endpoint http://127.0.0.1:<port>     # the SAME authorized Chromium (DevToolsActivePort)
  --caps vision --no-webmcp --image-responses allow
  --output-dir <runtime-root>/mcp-out
  --timeout-action 10000 --timeout-navigation 30000 --timeout-settle 500
  --allow-unrestricted-file-access           # see compatibility notes
  [--headless when Ruke's host runs headless]
```

`kill_on_drop` guarantees the child dies with the session.

## Compatibility notes (all root-caused live)

- **Modal-state gate:** while a file chooser or JS dialog is open on the driver's
  current tab, 0.0.84 refuses every other tab tool ("Tool "X" does not handle the
  modal state"). Ruke's bridge (`bridge.rs::modal_state_recovery`) clears driver-side
  orphans (chooser → cancel upload; dialog → settle/recheck/accept) and retries the
  blocked call exactly once; state that Ruke's own registries own is answered by the
  model-facing command, never silently swallowed.
- **`--allow-unrestricted-file-access`:** required for `browser_file_upload` to accept
  absolute paths outside the MCP output/workspace roots (0.0.84 `checkFile` guard).
  Upload paths in Ruke are Ruke-validated temp/profile paths on the same loopback
  host; the flag re-enables the pre-existing product flow, it does not widen the
  attack surface (attach is `--cdp-endpoint` to Ruke's own Chromium).
- **Dialog self-heal:** a CDP-handled JS dialog broadcasts `Page.javascriptDialogClosed`
  to all attached CDP clients, so Ruke's own dialog handling also clears MCP's modal
  state.
- **Retired in favor of MCP tools:** the legacy custom interactive action driver
  (`ax_action.rs`, `tab_ax_action`, `tab_ax_get_state`, the pw.rs locator click/fill/
  press/select actuators). Retained app glue (plan: "one interactive action driver and
  a short rationale for retained app glue"): the bridge keeps NATIVE pre-resolution
  (typed locator errors, actionability, force flags), tab/ownership/permission
  gating, downloads (MCP drives the page; Ruke's CDP listeners attribute the artifact
  per tab), login handoff, the live preview panel, and read-back-of-outcome — MCP
  never observes a page state Ruke then acts on blindly.
- **Never called by the bridge:** `browser_snapshot`, `browser_take_screenshot`
  (Ruke has its own honest-metadata capture, and the model's observation contract is
  Ruke's), `browser_run_code_unsafe` (not exposed).

## Troubleshooting

- Version mismatch error at startup → run `npm ci`; or point `RUKE_MCP_CLI` at a
  matching `cli.js` (the version proof still applies unless the env names cli.js
  directly — in that case the pin law is on you).
- `does not handle the modal state` in a refusal → expected grammar; the bridge
  recovers automatically once; a second refusal names the real owner
  (`browser_file_upload` / `browser_handle_dialog`).
- Fixture server reuse law: any already-listening `:3210` is reused by test launchers —
  kill stale fixture servers after editing `tests/fixtures/browser/server.mjs`.
