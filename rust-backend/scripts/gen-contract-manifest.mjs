#!/usr/bin/env node
/**
 * Part 9 — contract drift protection: emits the cross-language contract
 * manifest `rust-backend/fixtures/contracts/manifest.json`.
 *
 * Canonical sources (extracted, never hand-copied where extractable):
 *   - lib/decision/types.ts   runtime RENDERER_MODES / MODE_SKILL / MODE_FENCE
 *                             + DecisionRequest / DecisionEnvelope interfaces
 *   - lib/types.ts            StageEvent interface
 *   - lib/server/settings.ts  SettingsShape interface
 * The `headers`, `sseFrames` and `rpc` ledgers are the single canonical copy
 * of the wire facts that exist only as string literals in handler code; the
 * Rust tests (`crates/ruke-contracts/tests/manifest_drift.rs`,
 * `crates/ruke-websearch/tests/manifest_drift.rs`) and the vitest suite
 * (`__tests__/rust-golden/contract-manifest.test.ts`) both bind their side's
 * actual code to this manifest — change a spelling on either side and that
 * side's test fails until both sides and the manifest move together.
 *
 * Determinism: no timestamps, fixed key insertion order, stable 2-space
 * JSON. Re-running must produce byte-identical output (that IS the drift
 * gate: `npm run contracts:check`).
 *
 * Usage:  node rust-backend/scripts/gen-contract-manifest.mjs [--check]
 *   --check  compare against the committed file; exit 1 on any drift.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { extractInterface } from "./contractParse.mjs";

const root = path.resolve(import.meta.dirname, "..", ".."); // repo root (holds lib/)
const OUT_REL = path.join("rust-backend", "fixtures", "contracts", "manifest.json");
const OUT = path.join(root, OUT_REL);

const read = (p) => readFileSync(path.join(root, p), "utf8");

// ── Extracted from live TS ─────────────────────────────────────────────────
const { RENDERER_MODES, MODE_SKILL, MODE_FENCE } = await import(
  pathToFileURL(path.join(root, "lib", "decision", "types.ts")).href
);

const envelopeFields = extractInterface(read("lib/decision/types.ts"), "export interface DecisionEnvelope");
const decisionRequestFields = extractInterface(read("lib/decision/types.ts"), "export interface DecisionRequest");
const stageEventFields = extractInterface(read("lib/types.ts"), "export interface StageEvent");
const settingsFields = extractInterface(read("lib/server/settings.ts"), "interface SettingsShape");

// ── Canonical cross-language ledger (see header comment) ──────────────────
const manifest = {
  $schema: "ruke-contract-manifest/v1",
  note: "GENERATED — do not edit by hand. Regenerate with `npm run contracts:generate`; drift gate: `npm run contracts:check`. Rust binders: crates/ruke-contracts/tests/manifest_drift.rs, crates/ruke-websearch/tests/manifest_drift.rs. TS binder: __tests__/rust-golden/contract-manifest.test.ts.",
  decisionModes: {
    order: [...RENDERER_MODES],
    skill: Object.fromEntries(RENDERER_MODES.map((m) => [m, MODE_SKILL[m]])),
    fence: Object.fromEntries(RENDERER_MODES.map((m) => [m, MODE_FENCE[m]])),
    contractBlocks:
      "per-mode prompt blocks are TS-owned (lib/decision/contracts.ts MODE_CONTRACTS), generated into crates/ruke-decision/src/contracts_generated.rs by gen-mode-contracts.mjs; byte identity is pinned by fixtures/skills/06-mode-contracts-hashes.json + ruke-decision/tests/fixture_replay.rs — not duplicated here",
  },
  decisionRequest: {
    sourceFile: "lib/decision/types.ts",
    fields: decisionRequestFields,
  },
  decisionEnvelope: {
    sourceFile: "lib/decision/types.ts",
    rule: "optional fields are OMITTED when absent (JSON.stringify drops undefined; Rust skip_serializing_if=none); always-present nullable fields serialize as explicit JSON null on both sides; array/spelling order preserved; confidence renders via JS-number rules (integral -> integer literal, e.g. 1 not 1.0)",
    fields: envelopeFields,
  },
  stageEvent: {
    sourceFile: "lib/types.ts",
    rule: "every optional field omitted-when-absent on both sides; camelCase wire casing",
    fields: stageEventFields,
    legacyReadOnlyFields: [
      {
        field: "researchLfm",
        reason: "deprecated pre-rename (2026-10-23) fallback READ by the TS client only; the server (TS and Rust) never emits it, so it is deliberately absent from the Rust StageEvent",
      },
    ],
  },
  settings: {
    sourceFile: "lib/server/settings.ts",
    fields: settingsFields,
  },
  sseFrames: {
    stageFrameKey: "ruke_stage",
    errorFrameKey: "ruke_error",
    doneMarker: "[DONE]",
    note: "exactly one [DONE] per error frame; the proxy/route never appends its own [DONE] after raw upstream bytes; frames are byte-pinned by fixtures/sse + ruke-server sse.rs tests",
  },
  headersCaseRule:
    "HTTP field names are case-insensitive; this ledger pins the lowercase canonical spelling. The Rust http crate forces lowercase (HeaderName::from_static); the TS chat route writes X-Used-Skill/X-Web-Citations/X-Search-Gate in PascalCase — binders therefore compare case-insensitively and catch RENAME drift, not case restyles.",
  headers: [
    { name: "x-decision-mode", emitted: "every chat response (TS and Rust), stream and non-stream" },
    { name: "x-used-skill", emitted: "chat response only when a USER-tier skill was injected" },
    { name: "x-web-citations", encoding: "url-encoded JSON", emitted: "legacy non-stream path only; streamed turns carry web_meta stage frames instead" },
    { name: "x-search-gate", encoding: "url-encoded JSON", emitted: "legacy non-stream path only; progress path never carries web headers" },
    { name: "x-ruke-internal-secret", emitted: "internal RPC legs only (Rust bridge -> Next /api/internal/*); loopback-only; NEVER browser-visible and NEVER logged (Rule 17)" },
  ],
  rpc: {
    secretHeader: "x-ruke-internal-secret",
    env: {
      rustBridgeBaseUrl: "RUKE_BROWSER_BRIDGE_BASE_URL",
      rustBridgeSecret: "RUKE_BROWSER_BRIDGE_SECRET",
      nextArmSwitch: "RUKE_RUST_BACKEND",
      backendPort: "RUKE_BACKEND_PORT",
      rustProjectRoot: "RUKE_PROJECT_ROOT",
      serverBinOverride: "RUKE_SERVER_BIN",
    },
    browserRead: {
      path: "/api/internal/browser-read",
      method: "POST",
      requestFields: ["url", "timeoutMs"],
      timeoutDefaultMs: 40000,
      clientDeadlineSlackMs: 20000,
      deadlineRule: "Rust client request timeout = timeoutMs (default 40000) + 20000 slack (browser_bridge.rs deadline_ms); the Next leg owns nav/response-size budgets",
      errors: { unauthorized: "unauthorized", malformedBody: "Malformed JSON body", urlRequired: "url required" },
      responseFields: [
        "url", "finalUrl", "title", "status", "bodyText", "ariaSnapshot",
        "jsonLd", "meta", "windowState", "ok", "error",
      ],
      responseFieldsSource:
        "producer: extractPageInOnePass in lib/web-search/extractor.ts; consumer: OnePassExtraction in crates/ruke-websearch/src/browser_bridge.rs (camelCase, deny_unknown_fields, every non-url field #[serde(default)], error omitted-on-success on both sides)",
    },
    youtubeEvidence: {
      path: "/api/internal/youtube-evidence",
      method: "POST",
      requestFields: ["videoId"],
      deadlineMs: 90000,
      deadlineRule: "const RPC_DEADLINE_MS in crates/ruke-websearch/src/youtube_bridge.rs, compile-time-guarded to the 70000..120000 band",
      errors: { unauthorized: "unauthorized", malformedBody: "Malformed JSON body", videoIdRequired: "videoId required (11-char id)" },
      responseFields: ["videoId", "info", "transcript", "comments", "captionSource"],
    },
    mediaTranscript: {
      path: "/api/internal/media-transcript",
      method: "POST",
      requestFields: ["url"],
      errors: { unauthorized: "unauthorized", malformedBody: "Malformed JSON body", urlRequired: "url required" },
      responseFields: ["ok", "url", "transcript"],
    },
  },
  proxyFailureContract: {
    rule: "lib/server/rustProxy.ts classifies three ways: (A) downstream cancellation -> no response delivered, debug line never says 'unreachable'; (B) genuine connectivity failure -> console.error 'unreachable [<code>]' + honest 502; (C) real Rust responses pass through untouched. NO silent TS fallback.",
    unreachableBody: { error: "Rust backend unreachable at <base>" },
    status: 502,
  },
};

const serialized = JSON.stringify(manifest, null, 2) + "\n";

if (process.argv.includes("--check")) {
  if (!existsSync(OUT)) {
    console.error(`DRIFT: ${OUT_REL} is missing — run \`npm run contracts:generate\`.`);
    process.exit(1);
  }
  const committed = readFileSync(OUT, "utf8");
  if (committed === serialized) {
    console.log(`contracts:check OK — ${OUT_REL} is up to date`);
    process.exit(0);
  }
  // First differing line, for a human-readable failure.
  const a = committed.split("\n"), b = serialized.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.error(
    `DRIFT: ${OUT_REL} is stale (first difference at line ${i + 1}):\n` +
      `  committed: ${JSON.stringify(a[i] ?? "<eof>")}\n` +
      `  generated: ${JSON.stringify(b[i] ?? "<eof>")}\n` +
      "If this change is intended: regenerate (`npm run contracts:generate`), " +
      "commit the new manifest, and update both language sides together."
  );
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, serialized, "utf8");
console.log(`wrote ${OUT_REL} (${Buffer.byteLength(serialized)} bytes)`);
