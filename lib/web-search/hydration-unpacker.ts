/**
 * Universal SSR / JS framework hydration unpacker.
 *
 * Millions of custom sites (portfolios, SaaS landing pages, indie dev
 * sites) look empty to a basic HTML scraper because the real content
 * lives in SSR hydration payloads. This module extracts readable text
 * and structured fields from every major framework's hydration state.
 *
 * Covers:
 *   - Next.js App Router (React Server Components): `self.__next_f.push`
 *     Flight payloads.
 *   - Next.js Pages Router: `<script id="__NEXT_DATA__">`.
 *   - Nuxt 3 / Vue SSR: `window.__NUXT__` and `<script id="__NUXT_DATA__">`.
 *   - Remix / React Router: `window.__remixContext`.
 *   - SvelteKit / Astro / Gatsby: embedded hydration props & islands data.
 *   - YouTube / video pages: `ytInitialPlayerResponse`, `ytInitialData`.
 *
 * The unpacker runs on the same HTML body the direct fetcher paid for —
 * no extra network round-trip. The output is a clean markdown block that
 * is prepended to the DOM extraction so text trapped in script state
 * is recovered.
 */

/* ── helpers ─────────────────────────────────────────────────────────── */

function docOf(html: string): any {
  // linkedom's parseHTML returns a Window, not a Document.
  try {
    // Lazy import to keep the module's load cost down
    const { parseHTML } = require("linkedom"); // linkedom returns a Window; pull the Document off it
    const w: any = parseHTML(html);
    return w?.document ?? w;
  } catch {
    return null;
  }
}

/**
 * Walk an arbitrary JSON payload (any shape) and pull every leaf string
 * that looks like human-readable text (length > 8, mostly alphabetic).
 * This is the fallback when a framework's payload shape isn't one we
 * specifically know — it catches SvelteKit islands, Gatsby page context,
 * and any custom hydration object.
 */
function harvestStrings(obj: any, depth = 0, budget: string[] = []): string[] {
  if (depth > 6 || budget.length > 200) return budget;
  if (typeof obj === "string") {
    const clean = obj.replace(/\s+/g, " ").trim();
    if (clean.length > 8 && /[a-zA-Z]{4}/.test(clean)) budget.push(clean);
    return budget;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) harvestStrings(v, depth + 1, budget);
    return budget;
  }
  if (obj && typeof obj === "object") {
    // Skip the big binary-ish keys that would swamp the harvest
    for (const [k, v] of Object.entries(obj)) {
      if (
        k === "id" ||
        k === "key" ||
        k === "component" ||
        k.startsWith("__")
      )
        continue;
      harvestStrings(v, depth + 1, budget);
    }
  }
  return budget;
}

/**
 * Convert a harvested string list into a clean markdown summary, deduped
 * and capped. This is the "universal harvest" — it's what you get when a
 * framework's payload shape isn't specifically recognized.
 */
function summarizeStrings(strings: string[]): string {
  const seen = new Set<string>();
  const uniq = strings.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key) || s.length < 10 || s.length > 1500) return false;
    seen.add(key);
    return true;
  });
  if (uniq.length === 0) return "";
  // Group into lines of ~200 chars for readable markdown
  const lines: string[] = uniq
    .slice(0, 60)
    .map((s) => "- " + s.slice(0, 300));
  return "## Hydration text (universal harvest)\n" + lines.join("\n");
}

/* ── framework-specific extractors ─────────────────────────────────── */

/**
 * Next.js App Router (React Server Components): parse the
 * `self.__next_f.push([N, "chunk", ...])` Flight payloads. RSC chunks
 * carry component text, headings, props, and table cells as JSON
 * strings in the push array. We walk every push call and harvest the
 * string leaves.
 */
function nextFlightUnpack(html: string): string {
  const out: string[] = [];
  // Find every self.__next_f.push([1, "..."]) call
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(html)) !== null && count < 40) {
    count++;
    // The chunk is a JSON-escaped string — unescape it
    let chunk: string;
    try {
      chunk = JSON.parse('"' + m[1] + '"');
    } catch {
      chunk = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    // RSC chunks are JSON strings: "[id","type",props]"
    // Harvest all string leaves
    for (const s of harvestStrings(chunk, 0, [])) {
      out.push(s);
    }
  }
  if (out.length === 0) return "";
  return "## Next.js RSC flight payload\n" + summarizeStrings(out);
}

/**
 * Next.js Pages Router: parse `<script id="__NEXT_DATA__" type="application/json">`.
 */
function nextDataUnpack(html: string): string {
  const m = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m || !m[1]) return "";
  let data: any;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    return "";
  }
  const lines: string[] = [];
  const build = data?.props?.pageProps?.buildManifest;
  const page = data?.props?.pageProps;
  const article = page?.article ?? page?.post ?? page?.content;
  if (article) {
    const title = article.title ?? article.name;
    if (title) lines.push("## " + title);
    const body = article.body ?? article.content ?? article.html;
    if (body) {
      lines.push(
        typeof body === "string"
          ? body.replace(/<[^>]+>/g, " ").slice(0, 4000)
          : JSON.stringify(body).slice(0, 4000),
      );
    }
  } else if (page) {
    // Harvest strings from pageProps directly
    lines.push("## __NEXT_DATA__ pageProps");
    lines.push(summarizeStrings(harvestStrings(page, 0, [])));
  }
  void build;
  const md = lines.join("\n\n");
  return md.length >= 40 ? md : "";
}

/**
 * Nuxt 3 / Vue SSR: `window.__NUXT__` (Nuxt 2) and
 * `<script id="__NUXT_DATA__">` (Nuxt 3).
 */
function nuxtUnpack(html: string): string {
  // Nuxt 3: <script id="__NUXT_DATA__" type="application/json">[...]</script>
  const m3 = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (m3 && m3[1]) {
    let data: any;
    try {
      data = JSON.parse(m3[1].trim());
    } catch {
      data = m3[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) {
      return "## Nuxt 3 hydration state\n" + summarizeStrings(strs);
    }
  }

  // Nuxt 2 / legacy: window.__NUXT__ = {...}
  const m2 = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m2 && m2[1]) {
    let data: any;
    try {
      data = JSON.parse(m2[1]);
    } catch {
      data = m2[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) {
      return "## Nuxt hydration state\n" + summarizeStrings(strs);
    }
  }
  return "";
}

/**
 * Remix / React Router: window.__remixContext / window.__reactRouterContext.
 */
function remixUnpack(html: string): string {
  const m =
    html.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\})\s*;/) ??
    html.match(/window\.__reactRouterContext\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m || !m[1]) return "";
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    data = m[1];
  }
  const strs = harvestStrings(data, 0, []);
  if (strs.length === 0) return "";
  return "## Remix hydration state\n" + summarizeStrings(strs);
}

/**
 * SvelteKit / Astro / Gatsby: look for embedded hydration props.
 *   - SvelteKit: `window.__sveltekit__` object payload
 *   - Astro: `astro-islands` div with JSON data
 *   - Gatsby: `window.___gatsby` payload or gatsby-script tag
 */
function sveltekitAstroGatsbyUnpack(html: string): string {
  const lines: string[] = [];

  // SvelteKit
  const mk = html.match(/window\.__sveltekit__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (mk && mk[1]) {
    let data: any;
    try {
      data = JSON.parse(mk[1]);
    } catch {
      data = mk[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## SvelteKit hydration\n" + summarizeStrings(strs));
  }

  // Astro islands
  const ma = html.match(/<div[^>]*id="astro-islands"[^>]*>([\s\S]*?)<\/div>/);
  if (ma && ma[1]) {
    let data: any;
    try {
      data = JSON.parse(ma[1].trim());
    } catch {
      data = ma[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## Astro islands data\n" + summarizeStrings(strs));
  }

  // Gatsby
  const mg =
    html.match(/window\.___gatsby\s*=\s*(\{[\s\S]*?\})\s*;/) ??
    html.match(/<script[^>]*id="gatsby-script"[^>]*>([\s\S]*?)<\/script>/);
  if (mg && mg[1]) {
    let data: any;
    try {
      data = JSON.parse(mg[1]);
    } catch {
      data = mg[1];
    }
    const strs = harvestStrings(data, 0, []);
    if (strs.length > 0) lines.push("## Gatsby hydration\n" + summarizeStrings(strs));
  }

  return lines.join("\n\n");
}

/**
 * YouTube / video pages: parse `ytInitialPlayerResponse` and
 * `ytInitialData` for descriptions, chapters, and metadata.
 */
function youtubeUnpack(html: string): string {
  const out: string[] = [];

  const mpr = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  if (mpr && mpr[1]) {
    let data: any;
    try {
      data = JSON.parse(mpr[1]);
    } catch {
      data = mpr[1];
    }
    const vd = data?.videoDetails;
    if (vd) {
      if (vd.title) out.push("## YouTube video: " + vd.title);
      if (vd.author) out.push("Channel: " + vd.author);
      if (vd.viewCount) out.push("Views: " + vd.viewCount);
      if (vd.shortDescription) out.push("Description: " + vd.shortDescription.slice(0, 2000));
    }
    // Chapters
    const chapters: any[] =
      data?.macros?.chapters ?? data?.chapters ?? [];
    if (chapters.length > 0) {
      out.push("Chapters:");
      for (const ch of chapters.slice(0, 10)) {
        out.push("- " + (ch.title?.simpleText ?? ch.title ?? ""));
      }
    }
  }

  const mdi = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});/);
  if (mdi && mdi[1]) {
    let data: any;
    try {
      data = JSON.parse(mdi[1]);
    } catch {
      data = mdi[1];
    }
    const strs = harvestStrings(data, 0, []).filter((s) => s.length > 20);
    if (strs.length > 0) {
      out.push("## YouTube data (ytInitialData)\n" + summarizeStrings(strs));
    }
  }

  return out.join("\n\n");
}

/* ── public API ─────────────────────────────────────────────────────── */

/**
 * Run every framework-specific hydration unpacker against the raw HTML
 * and return the combined clean markdown. The extractor prepends this to
 * the DOM extraction so content trapped in script state is recovered.
 *
 * This is the universal equivalent of `extractHydrationState()` in
 * domain-adapters.ts — it covers Next.js App Router, Nuxt 3, Remix,
 * SvelteKit, Astro, Gatsby, and YouTube, not just `__NEXT_DATA__` and
 * `ytInitialData`.
 */
export function unpackHydration(html: string): string {
  const parts: string[] = [];

  // Run every unpacker; each returns "" when it doesn't apply
  parts.push(nextFlightUnpack(html));
  parts.push(nextDataUnpack(html));
  parts.push(nuxtUnpack(html));
  parts.push(remixUnpack(html));
  parts.push(sveltekitAstroGatsbyUnpack(html));
  parts.push(youtubeUnpack(html));

  const combined = parts.filter((p) => p && p.length > 0).join("\n\n");
  if (combined.length === 0) return "";
  return "[SSR Hydration Unpack]\n\n" + combined;
}
