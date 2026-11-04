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
 * Coarse country name from the OS locale's region subtag
 * ("en-IN" → "India"). null when the locale carries no region subtag
 * or the platform cannot name it.
 */
export function systemRegionName(): string | null {
  const locale = systemLocale();
  // Region subtag: first 2-letter part AFTER the language (script
  // subtags are 4 letters, variants 4+ alphanumeric, so a standalone
  // 2-letter part at index >=1 is the region by BCP-47 shape).
  const parts = locale.split(/[-_]/);
  const region = parts.findIndex((p, i) => i >= 1 && /^[A-Za-z]{2}$/.test(p));
  if (region < 0) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(parts[region].toUpperCase()) ?? null;
  } catch {
    return null;
  }
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
