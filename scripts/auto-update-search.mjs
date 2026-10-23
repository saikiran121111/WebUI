#!/usr/bin/env node
/**
 * predev auto-updater for the open-source search stack.
 *
 * Keeps the scraping/extraction NPM stack current without ever requiring
 * a manual update step or any paid service:
 *
 *   npm run dev  →  predev hook  →  this script
 *
 * Throttled to at most once per 6 hours via .data/last-search-update.json.
 * Pass --force (or set WEB_SEARCH_UPDATE_FORCE=1) to update right now.
 * Failures never block `npm run dev` — the app must still start offline.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = join(repoRoot, ".data", "last-search-update.json");

function lastUpdateMs() {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    const ms = Date.parse(raw?.lastUpdate ?? "");
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}

function forceRequested() {
  return (
    process.argv.includes("--force") ||
    process.env.WEB_SEARCH_UPDATE_FORCE === "1"
  );
}

const now = Date.now();
const last = lastUpdateMs();
const due = forceRequested() || now - last > SIX_HOURS_MS;

if (!due) {
  const ageMin = Math.round((now - last) / 60000);
  console.log(
    `[auto-update-search] last update ${ageMin} min ago (< 6h) — skipping. Use --force to update now.`,
  );
  process.exit(0);
}

console.log(
  `[auto-update-search] updating ${PKGS.length} search-stack packages${forceRequested() ? " (--force)" : ""}...`,
);
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
    JSON.stringify({ lastUpdate: new Date().toISOString(), packages: PKGS }, null, 2),
  );
  console.log("[auto-update-search] search stack is up to date.");
} catch (err) {
  // Never break `npm run dev` — an offline or registry-flaky box still starts.
  console.warn(
    "[auto-update-search] update failed (continuing with the versions already installed):",
    err?.message ?? String(err),
  );
}
process.exit(0);
