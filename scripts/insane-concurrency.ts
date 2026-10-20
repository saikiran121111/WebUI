/**
 * Side-effect module: set the web-search limiter env vars from the CLI flag
 * so the global pLimit pools (extractor.ts + metasearch.ts) are built at
 * full concurrency when the insane stress runner imports them.
 *
 * This file is imported FIRST in insane-stress-test.ts — ahead of the
 * `../src/lib/web-search/index` import — because those modules read the
 * env vars at module-load time. TS hoists `import` statements above
 * in-module code, so a plain `process.env.X = ...` in the main file would
 * run too late. A separate module guarantees the assignment runs before
 * the heavy import resolves.
 *
 * Strictly a test-side effect: it does NOT touch any production default.
 * The env vars are only read inside extractor.ts / metasearch.ts when
 * explicitly set; without them the production caps (4/6/8) stand.
 */
function flag(name: string, def: string): string {
  const arg = process.argv.find((a) => a.startsWith("--" + name + "="));
  return arg ? arg.slice(name.length + 3) : process.env[name.toUpperCase()] ?? def;
}

const CONCURRENCY = parseInt(flag("concurrency", "64"), 10);

// All three limiter pools track the worker-pool size:
//  - WEB_SEARCH_CONCURRENCY      → extractor.ts DOM-extraction pLimit
//  - WEB_SEARCH_JINA_CONCURRENCY → extractor.ts Jina-fallback pLimit
//  - WEB_SEARCH_ENGINE_CONCURRENCY → metasearch.ts engine-source pLimit
process.env.WEB_SEARCH_CONCURRENCY = String(CONCURRENCY);
process.env.WEB_SEARCH_JINA_CONCURRENCY = String(CONCURRENCY);
process.env.WEB_SEARCH_ENGINE_CONCURRENCY = String(CONCURRENCY);

// eslint-disable-next-line no-console
console.log(
  `══ INSANE-STRESS limiter caps raised to ${CONCURRENCY} ` +
    `(DOM extraction + Jina + engine pool) ══`,
);

export {};
