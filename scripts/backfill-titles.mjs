#!/usr/bin/env node
/**
 * Re-runnable title backfill for existing conversations.
 *
 * Talks to the RUNNING WebUI server (which owns the model call, validation,
 * persistence and the manual-title guard) instead of touching the disk
 * directly — so it is safe to re-run at any time: manual titles and titles
 * that already look machine-fresh are skipped server-side, messages are
 * never modified, conversation ids never change.
 *
 * Requires `npm run dev` and the main model server (LLM_API_URL) to be up.
 *
 * Usage:
 *   npm run titles:backfill
 *   npm run titles:backfill -- --base http://localhost:3000
 */

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const BASE = (baseIdx >= 0 ? args[baseIdx + 1] : process.env.WEBUI_BASE_URL) ?? "http://localhost:3000";
const MODEL = process.env.NEXT_PUBLIC_MODEL_ID ?? "default";

async function main() {
  let rows;
  try {
    const res = await fetch(`${BASE}/api/conversations`);
    if (!res.ok) throw new Error(`GET /api/conversations -> HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    console.error(`Cannot reach the WebUI server at ${BASE}. Start "npm run dev" first.\n${err.message}`);
    process.exit(1);
  }

  console.log(`Backfilling titles for ${rows.length} conversation(s) via ${BASE} (model: ${MODEL}).`);
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential on purpose: the server queue is serial anyway, and one-at-a-
  // time keeps the shared inference slot free for whoever is chatting.
  for (const row of rows) {
    const id = row?.id;
    if (!id) continue;
    let out;
    try {
      const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}/title?force=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL }),
      });
      out = await res.json().catch(() => ({}));
    } catch (err) {
      failed++;
      console.log(`  ${id}: request failed (${err.message})`);
      continue;
    }
    if (out.queued && out.ok) {
      generated++;
      console.log(`  ${id}: "${out.title}"`);
    } else if (out.queued) {
      failed++;
      console.log(`  ${id}: job failed (${out.reason ?? "unknown"})`);
    } else {
      skipped++;
      console.log(`  ${id}: skipped (${out.reason ?? "n/a"})`);
    }
  }

  console.log(`\nBackfill done: ${generated} regenerated, ${skipped} skipped, ${failed} failed (of ${rows.length}).`);
  if (failed > 0) process.exit(2);
}

main();
