/**
 * System-derived local context for the research path (user instruction
 * 2026-11-04: "if it require the location it can take the current
 * location from user system it can also take the current time from user
 * system as its considered as a local app... send all these current
 * things to ai so it would understand").
 *
 * This app runs the server on the USER's own machine, so the runtime
 * Intl locale/timezone IS the user's real-world context — the same
 * trust basis the chat path already uses for the <runtime_clock> block
 * (lib/chat/clock-context.ts, fed by the browser-reported timezone).
 * Pure Intl reads: zero dependencies, zero network, nothing leaves
 * the process. Region naming is COARSE (country level) — the §11.17/
 * §11.22 privacy law still forbids coordinates, addresses, or any
 * account data reaching a search provider.
 */

function resolved(): Intl.ResolvedDateTimeFormatOptions | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions();
  } catch {
    return null;
  }
}

export function systemTimezone(): string {
  return resolved()?.timeZone ?? "";
}

export function systemLocale(): string {
  return resolved()?.locale ?? "en-US";
}

/**
 * Region subtag of a BCP-47 tag: first 2-letter part AFTER the language
 * ("en-IN" → "IN", "zh-Hans-CN" → "CN" — script subtags are 4 letters,
 * so a standalone 2-letter part at index >=1 is the region by shape).
 * null when the tag carries none. Shared by every consumer that needs
 * the machine's country WITHOUT inventing one (§5h locale-scope law).
 */
function regionSubtag(locale: string): string | null {
  const parts = locale.split(/[-_]/);
  const i = parts.findIndex((p, idx) => idx >= 1 && /^[A-Za-z]{2}$/.test(p));
  return i < 0 ? null : parts[i].toUpperCase();
}

/**
 * Coarse country name from the OS locale's region subtag
 * ("en-IN" → "India"). null when the locale carries no region subtag
 * or the platform cannot name it.
 */
export function systemRegionName(): string | null {
  const cc = regionSubtag(systemLocale());
  if (!cc) return null;
  try {
    return new Intl.DisplayNames([systemLocale()], { type: "region" }).of(cc) ?? null;
  } catch {
    return null;
  }
}

/** ISO alpha-2 country code of a locale's region subtag ("en-IN" → "IN");
 *  null when there is no region — callers must then treat region as
 *  ABSENT, never guess. Injectable locale for deterministic tests. */
export function systemRegionCC(locale: string = systemLocale()): string | null {
  return regionSubtag(locale);
}

/* ── §5h (2026-11-13 brief): explicit task region wins over the hint ──
 *
 * The machine locale is a CONTEXT HINT, never a retrieval constant. A
 * prompt that explicitly names a region outranks it. Detection is
 * deliberately restricted to UNAMBIGUOUS forms:
 *   - multi-word region names ("united kingdom", "united states",
 *     "united arab emirates", "south korea") — never person names;
 *   - well-known short forms/aliases that are never given names
 *     ("uk", "usa", "uae", ...).
 * Single-word official names (Jordan, India, Georgia, Chad...) are
 * intentionally NOT matched: these prompts are PERSON lookups, and a
 * given name that doubles as a country name would flip the retrieval
 * region on a false positive. An un-detected explicit mention still
 * rides on in the query text — the law is "never FORCE a region", and
 * silence here forces nothing.
 */
const REGION_ALIASES: Record<string, string> = {
  uk: "GB",
  usa: "US",
  uae: "AE",
  england: "GB",
  holland: "NL",
  russia: "RU",
  burma: "MM",
  "south korea": "KR",
  "north korea": "KP",
};

/* Multi-word English country/territory names: a CLOSED, centuries-stable
 * set (never person names — that is the whole point of restricting to
 * multi-word). Platform enumeration is not an option: Intl only exposes
 * DisplayNames lookup BY code, and the old V8-only
 * `Intl.supportedValuesOf("region")` enumeration key has been removed. */
const MULTIWORD_REGIONS: Array<[string, string]> = [
  ["united kingdom", "GB"],
  ["united states", "US"],
  ["united states of america", "US"],
  ["united arab emirates", "AE"],
  ["south korea", "KR"],
  ["north korea", "KP"],
  ["new zealand", "NZ"],
  ["south africa", "ZA"],
  ["south sudan", "SS"],
  ["saudi arabia", "SA"],
  ["sri lanka", "LK"],
  ["sierra leone", "SL"],
  ["costa rica", "CR"],
  ["papua new guinea", "PG"],
  ["equatorial guinea", "GQ"],
  ["dominican republic", "DO"],
  ["central african republic", "CF"],
  ["north macedonia", "MK"],
  ["czech republic", "CZ"],
  ["puerto rico", "PR"],
];

let _regionPhraseTable: Array<[string, string]> | null = null;

/** Multi-word region names + the alias table, merged with any extra
 *  multi-word names the platform's DisplayNames can enumerate (additive
 *  best-effort; absent on platforms without a region enumeration key). */
function regionPhraseTable(): Array<[string, string]> {
  if (_regionPhraseTable) return _regionPhraseTable;
  const pairs: Array<[string, string]> = [...MULTIWORD_REGIONS];
  try {
    if (typeof (Intl as any).supportedValuesOf === "function") {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      for (const code of (Intl as any).supportedValuesOf("region") as string[]) {
        if (!/^[A-Z]{2}$/.test(code)) continue; // skip sub-divisions (GBENG etc.)
        const name = dn.of(code)?.toLowerCase().trim();
        if (name && name.includes(" ")) pairs.push([name, code]);
      }
    }
  } catch {
    /* platform without region enumeration — the curated table stands */
  }
  for (const [alias, code] of Object.entries(REGION_ALIASES)) pairs.push([alias, code]);
  _regionPhraseTable = pairs.sort((a, b) => b[0].length - a[0].length); // longest phrase wins
  return _regionPhraseTable;
}

/** ISO alpha-2 of an UNAMBIGUOUS explicit region mention in the text;
 *  null when none (see the ambiguity law above). */
export function explicitRegionCc(text: string): string | null {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim()} `;
  for (const [phrase, code] of regionPhraseTable()) {
    if (hay.includes(` ${phrase} `)) return code;
  }
  return null;
}

/* Browser identity (§5h): the stealth pool must claim the MACHINE's
 * language chain, not the developer's. Pure derivation so the pinned
 * en-IN values survive byte-identically on an en-IN machine (measured
 * WAF law) while every other machine gets its own honest identity. */

/** Chrome-shaped navigator.languages for a locale tag.
 *  en-IN → ["en-IN","en-US","en"] (byte-identical to the old constant);
 *  en-US → ["en-US","en"]; te-IN → ["te-IN","te","en"]; de → ["de","en"]. */
export function browserLanguagesFor(locale: string): string[] {
  const parts = locale.split(/[-_]/).filter(Boolean);
  const lang = (parts[0] || "en").toLowerCase();
  const out = [locale];
  if (lang === "en") {
    if (locale.toLowerCase() !== "en-us") out.push("en-US");
    out.push("en");
  } else {
    if (parts.length > 1) out.push(lang);
    out.push("en");
  }
  return [...new Set(out)];
}

/** Matching Accept-Language header (q-chain descending).
 *  en-IN → "en-IN,en-US;q=0.9,en;q=0.8" (byte-identical to the old
 *  constant); en-US → "en-US,en;q=0.9". */
export function acceptLanguageFor(locale: string): string {
  const [first, ...rest] = browserLanguagesFor(locale);
  return [first, ...rest.map((l, i) => `${l};q=${(0.9 - 0.1 * i).toFixed(1)}`)].join(",");
}

/**
 * One-line system context for LLM prompts (gate + any research prompt
 * builder that wants "what is happening right now, where"). The chat
 * main model gets its equivalent from <runtime_clock>; this covers the
 * TS retrieval-side models, which previously saw only a bare UTC date.
 */
export function localContextLine(now: Date = new Date()): string {
  const tz = systemTimezone();
  const locale = systemLocale();
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      ...(tz ? { timeZone: tz } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    });
    return (
      `Local user context: this app runs on the user's machine — system timezone ${tz || "unknown"}, ` +
      `system locale ${locale}, local date-time ${fmt.format(now)}. ` +
      `Interpret "today", "now", "latest", "near", and current/offers against this context.`
    );
  } catch {
    return `Local user context: system timezone ${tz || "unknown"}, system locale ${locale}.`;
  }
}
