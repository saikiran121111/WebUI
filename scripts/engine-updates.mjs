#!/usr/bin/env node
/**
 * Background stable-update check for Ruke's engines (B5 final decision, 2026-11-22).
 *
 * `npm run dev` spawns this DETACHED, unref'd, after the ready banner (see
 * scripts/dev-supervisor.mjs). It reads the tracked engine manifest (engine/manifest.json),
 * asks each engine's declared STABLE channel what the newest stable release is, and writes
 * the findings to .data/python/engine-updates.json next to the pins it compared against.
 *
 * Laws, in order of importance:
 *   * report-only: this script NEVER installs, never activates, never restarts an engine,
 *     and never touches uv/pip. A finding is a line in a JSON file; a human stages and
 *     validates before anything is activated, so the working version survives active jobs,
 *     offline states and failed updates;
 *   * startup-proof: the supervisor never waits on this process, and every network request
 *     has a hard timeout. Offline is a RECORDED per-channel state, not an error state;
 *   * model revisions are pinned independently: a newer upstream model release is reported
 *     as information only - it never changes a pinned revision;
 *   * it never prints to the dev terminal: the supervisor wires its stdio to
 *     .data/python/engine-updates.log.
 *
 * Opt out with RUKE_ENGINE_UPDATES=0 (checked by the supervisor). Run by hand any time:
 *   node scripts/engine-updates.mjs
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "engine", "manifest.json");
const outDir = path.join(root, ".data", "python");
const outPath = process.env.RUKE_ENGINE_REPORT || path.join(outDir, "engine-updates.json");
const REQUEST_TIMEOUT_MS = 15_000;

/** Prerelease/dev labels mark a NOT-stable version; "+cu126"-style local labels do not. */
function isStable(version) {
  return !/(alpha|beta|rc|pre|rev|dev|snapshot|\.a\d|\.b\d)/i.test(version);
}

/** Base of a PEP 440-ish version for comparison: digits and dots up to a local "+". */
function baseVersion(version) {
  return String(version).split("+")[0];
}

/** Numeric segment compare; returns >0 when `a` is newer than `b`. */
function compareVersions(a, b) {
  const pa = baseVersion(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = baseVersion(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 1); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "ruke-engine-updates (report-only)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "ruke-engine-updates (report-only)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** One channel -> { state, latest, detail }. Network failure is recorded, never thrown. */
async function checkChannel(channel) {
  const pinned = channel.pinned || channel.pinned_tag || "";
  try {
    if (channel.kind === "pypi") {
      const data = await getJson(`https://pypi.org/pypi/${channel.package}/json`);
      const stable = Object.keys(data.releases || {})
        .filter(isStable)
        .filter((v) => (data.releases[v] || []).some((f) => f.filename.endsWith(".whl") || f.filename.endsWith(".tar.gz")))
        .sort(compareVersions);
      const latest = stable[stable.length - 1] || "";
      return { state: "ok", latest, newer: Boolean(latest && compareVersions(latest, pinned) > 0), detail: `PyPI stable for ${channel.package}` };
    }
    if (channel.kind === "pypi_simple") {
      const html = await getText(`${channel.index.replace(/\/+$/, "")}/${channel.package}/`);
      // Wheel filenames on a PEP 503 index: `{package}-{version}-cp312-...whl`, where the
      // distribution name in the FILENAME is PEP 425 normalised: runs of `-._` become `_`.
      // The cu126 index ships `paddlepaddle_gpu-3.2.1-cp312-...whl` for the channel named
      // "paddlepaddle-gpu", so each separator in the channel name must match any of `-._`.
      const stem = channel.package.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-._]");
      const named = new RegExp(`${stem}-([0-9][0-9a-zA-Z.]*?)-`, "g");
      const versions = [...html.matchAll(named)].map((m) => m[1]).filter(isStable);
      const latest = [...new Set(versions)].sort(compareVersions).pop() || "";
      return { state: "ok", latest, newer: Boolean(latest && compareVersions(latest, pinned) > 0),
        detail: latest ? `stable wheel index for ${channel.package}` : `stable wheel index for ${channel.package}: NO version parsed (page shape changed?)` };
    }
    if (channel.kind === "github_release") {
      const data = await getJson(`https://api.github.com/repos/${channel.repo}/releases/latest`);
      const latest = data.tag_name || "";
      return { state: "ok", latest, newer: Boolean(latest && compareVersions(latest, pinned) > 0), detail: `GitHub latest release for ${channel.repo}` };
    }
    return { state: "skipped", latest: "", newer: false, detail: `unknown channel kind ${channel.kind}` };
  } catch (err) {
    // Offline, timeout, rate limit: RECORD it. The running engine is untouched.
    return { state: "unreachable", latest: "", newer: false, detail: String(err && err.message || err) };
  }
}

async function main() {
  const report = {
    schema: "ruke-engine-updates/v1",
    checked_at: new Date().toISOString(),
    policy: "report-only: nothing here was installed or activated; the working version survives",
    engines: {},
  };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    report.error = `engine/manifest.json unreadable: ${String(err && err.message || err)}`;
    return report;
  }
  for (const [engine, def] of Object.entries(manifest.engines || {})) {
    const rows = [];
    for (const channel of def.update_channels || []) {
      rows.push({ channel: channel.package || channel.repo || channel.kind, pinned: channel.pinned || channel.pinned_tag || "", ...(await checkChannel(channel)) });
    }
    report.engines[engine] = rows;
  }
  return report;
}

const report = await main();
try {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, outPath);
} catch (err) {
  console.log(`engine-updates: could not write ${outPath}: ${String(err && err.message || err)}`);
}
for (const [engine, rows] of Object.entries(report.engines || {})) {
  for (const row of rows) {
    console.log(`engine-updates: ${engine} ${row.channel} pinned=${row.pinned} latest=${row.latest || "-"} ${row.newer ? "UPDATE AVAILABLE (not installed)" : row.state} (${row.detail})`);
  }
}
process.exitCode = 0;
