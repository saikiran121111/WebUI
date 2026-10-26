#!/usr/bin/env node
/**
 * Emits `crates/ruke-decision/src/contracts_generated.rs` by IMPORTING the
 * live TypeScript oracle (`lib/decision/contracts.ts` → MODE_CONTRACTS).
 * The generated constants are therefore pinned to the real contract bytes
 * — never hand-copied (Part 3 brief §12).
 *
 * Re-run after any change to lib/decision/contracts.ts:
 *   node rust-backend/scripts/gen-mode-contracts.mjs
 *
 * Note on line endings: constants are emitted as ESCAPED Rust string
 * literals (\n / \r escapes), never raw multi-line literals, so git
 * checkout line-ending normalization can never corrupt the pinned bytes.
 */
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", ".."); // repo root (holds lib/)
const rustBackend = path.join(root, "rust-backend"); // cargo workspace root
const { MODE_CONTRACTS } = await import(
  pathToFileURL(path.join(root, "lib", "decision", "contracts.ts")).href
);

// RendererMode string key -> valid Rust identifier (uppercase snake).
const CONST_NAMES = {
  excel: "CONTRACT_EXCEL",
  docs: "CONTRACT_DOCS",
  pdf: "CONTRACT_PDF",
  ppt: "CONTRACT_PPT",
  "3d_asset": "CONTRACT_3D_ASSET",
  cad_blueprint: "CONTRACT_CAD_BLUEPRINT",
  chart: "CONTRACT_CHART",
  html_render: "CONTRACT_HTML_RENDER",
  standard_chat: "CONTRACT_STANDARD_CHAT",
};

/** JS string -> Rust `"..."` literal with \n, \r, \t and \u{…} escapes. */
function rustLiteral(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) out += `\\u{${cp.toString(16)}}`;
    else out += ch; // printable text (incl. é etc.) stays literal
  }
  return out + '"';
}

const chunks = [
  "//! GENERATED — do not edit.\n" +
    "//! Produced by `rust-backend/scripts/gen-mode-contracts.mjs`, which imports the\n" +
    "//! live `lib/decision/contracts.ts` MODE_CONTRACTS table. Re-run it after changing\n" +
    "//! that module. Bytes are emitted as escaped literals so checkout normalization\n" +
    "//! cannot corrupt them; the sha256 comments bind the exact content.\n\n",
];

for (const [mode, contract] of Object.entries(MODE_CONTRACTS)) {
  const name = CONST_NAMES[mode];
  if (!name) throw new Error(`unmapped MODE_CONTRACTS key: ${JSON.stringify(mode)}`);
  if (contract === null || contract === undefined) {
    // Ordinary comment, not /// — a doc comment must attach to an item.
    chunks.push(`// ${mode}: null in MODE_CONTRACTS (no contract block; mapped to None).\n`);
    console.log(`${mode.padEnd(13)} -> ${name} = null`);
    continue;
  }
  if (typeof contract !== "string") {
    throw new Error(`MODE_CONTRACTS[${JSON.stringify(mode)}] is not a string: ${typeof contract}`);
  }
  const sha = createHash("sha256").update(contract, "utf8").digest("hex");
  const bytes = Buffer.byteLength(contract, "utf8");
  chunks.push(
    `/// ${mode} — sha256 ${sha}, ${bytes} bytes, JS length ${contract.length} UTF-16 units.\n` +
      `pub const ${name}: &str = ${rustLiteral(contract)};\n\n`
  );
  console.log(`${mode.padEnd(13)} -> ${name} sha=${sha.slice(0, 16)}… bytes=${bytes}`);
}

const outPath = path.join(rustBackend, "crates", "ruke-decision", "src", "contracts_generated.rs");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, chunks.join(""), "utf8");
console.log(`wrote ${path.relative(root, outPath)}`);
