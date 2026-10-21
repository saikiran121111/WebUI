/**
 * One-shot probe of the general-web engines against a real query, via the
 * same impit TLS layer the pipeline uses. Each engine is probed in parallel
 * (they hit DIFFERENT hosts, so no burst on one host) and we collect
 * per-engine result counts + top domains.
 *
 * Usage:  npx tsx scripts/probe-engines.ts
 */
import {
  ddgSearch,
  bingSearch,
  yahooSearch,
  startpageSearch,
  braveSearch,
  aolSearch,
  mojeekSearch,
  searxSearch,
  redditSearch,
  bingNewsRssSearch,
  githubSearch,
} from "../src/lib/web-search/general-pool";
import type { RawSearchResult } from "../src/lib/web-search/types";

const Q = "best biryani restaurant in Manikonda Hyderabad";

function summarize(results: RawSearchResult[]): string {
  const domains = new Map<string, number>();
  for (const r of results) {
    let d = "";
    try { d = new URL(r.url).hostname.replace(/^www\./, ""); } catch { d = "(bad-url)"; }
    domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([d, n]) => `${d}×${n}`).join(" ");
  return `${results.length} results ${top ? "→ " + top : ""}`;
}

async function probe(
  name: string,
  fn: () => Promise<RawSearchResult[]>,
): Promise<{ name: string; count: number; line: string }> {
  const t0 = Date.now();
  try {
    const results = await fn();
    const ms = Date.now() - t0;
    return {
      name,
      count: results.length,
      line: `[${results.length > 0 ? "★" : " "}] ${name.padEnd(16)} ${String(results.length).padStart(3)}  ${ms}ms  ${summarize(results).slice(0, 80)}`,
    };
  } catch (e) {
    return {
      name,
      count: 0,
      line: `[✗] ${name.padEnd(16)} ERROR ${(e as Error).message?.slice(0, 50)}  ${Date.now() - t0}ms`,
    };
  }
}

async function main() {
  console.log(`Query: "${Q}"\n`);
  const settled = await Promise.all([
    probe("ddgSearch", () => ddgSearch(Q)),
    probe("bingSearch", () => bingSearch(Q)),
    probe("yahooSearch", () => yahooSearch(Q)),
    probe("startpage", () => startpageSearch(Q)),
    probe("braveSearch", () => braveSearch(Q)),
    probe("aolSearch", () => aolSearch(Q)),
    probe("mojeekSearch", () => mojeekSearch(Q)),
    probe("searxSearch", () => searxSearch(Q)),
    probe("redditSearch", () => redditSearch(Q)),
    probe("bingNewsRss", () => bingNewsRssSearch(Q)),
    probe("githubSearch", () => githubSearch(Q)),
  ]);
  settled.sort((a, b) => b.count - a.count);
  for (const s of settled) console.log(s.line);
  const unblocked = settled.filter((s) => s.count > 0);
  console.log(`\n${unblocked.length}/${settled.length} engines unblocked: ${unblocked.map((s) => s.name).join(", ") || "(none)"}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
