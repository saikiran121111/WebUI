/**
 * Omnibox history ranking (Browser Use, Phase 13) — pure leaf, no I/O.
 * The engine's `browser_history` command already filters (case-
 * insensitive substrings against URL/title, newest-first) over the real
 * Chromium History DB; this helper applies the omnibox ordering rule
 * only: entries whose URL or title START with the typed text rank
 * above plain contains-matches, ties keep the engine's recency order,
 * URLs dedupe (a site visited five times shows once), and the list is
 * capped so one row per recent site beats a wall of history.
 */
export const OMNIBOX_MAX_RESULTS = 8;

/** Minimal row shape accepted (the engine's HistoryEntry fits). */
export interface OmniboxSuggestEntry {
  url: string;
  title?: string;
}

/** Rank `entries` (assumed newest-first, as the engine returns them)
 *  for the omnibox dropdown against the typed text. Empty text yields
 *  no suggestions — the omnibox never shows history unprompted. */
export function omniboxSuggest<T extends OmniboxSuggestEntry>(
  text: string,
  entries: T[],
): T[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const e of entries) {
    if (seen.has(e.url)) continue;
    const url = e.url.toLowerCase();
    // Prefix rank compares the SCHEME-LESS URL ("github.com/…" ranks
    // for "git") — every stored URL starts with "https://", so a raw
    // url.startsWith could never fire and typing a domain name would
    // lose the ranking omniboxes are judged on.
    const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const title = (e.title ?? "").toLowerCase();
    if (!url.includes(q) && !title.includes(q)) continue;
    seen.add(e.url);
    if (bare.startsWith(q) || title.startsWith(q)) prefix.push(e);
    else contains.push(e);
  }
  return [...prefix, ...contains].slice(0, OMNIBOX_MAX_RESULTS);
}
