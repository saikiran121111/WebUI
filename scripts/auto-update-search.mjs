#!/usr/bin/env node
/**
 * Manual updater for the open-source search stack (audit item 21, 2026-11-04).
 *
 *   npm run search:update  →  this script
 *
 * OPT-IN ONLY by law: it used to ride the `predev` hook with a 6h
 * due-gate, which silently mutated node_modules (and package-lock) behind
 * every `npm run dev` — an unpinned, unreviewed dependency change in the
 * middle of development, and a cold install every dev session was at the
 * mercy of whatever the registry served that morning. The hook and the
 * time gate are gone: you run it when YOU want the stack current, and a
 * failure now reports a non-zero exit so the command is honest about
 * itself instead of pretending success. .data/last-search-update.json is
 * kept purely as a last-run record.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = [
  "got-scraping",
  "header-generator",
  "@crawlee/playwright",
  "fingerprint-generator",
  "fingerprint-injector",
  "@mozilla/readability",
  "linkedom",
  "turndown",
  "turndown-plugin-gfm",
  "cheerio",
  "youtubei.js",
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = join(repoRoot, ".data", "last-search-update.json");

console.log(`[search:update] updating ${PKGS.length} search-stack packages...`);
try {
  execFileSync("npm", ["update", ...PKGS, "--no-fund", "--no-audit"], {
    cwd: repoRoot,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    shell: process.platform === "win32",
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      { lastUpdate: new Date().toISOString(), packages: PKGS },
      null,
      2,
    ),
  );
  console.log("[search:update] search stack is up to date.");
} catch (err) {
  console.error(
    "[search:update] update failed — the installed versions remain in place:",
    err?.message ?? String(err),
  );
  process.exit(1);
}
