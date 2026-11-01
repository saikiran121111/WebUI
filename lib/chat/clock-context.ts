/**
 * P1 (OpenAI web-search parity — clock grounding; defects RC1/RC8).
 *
 * ruke's main model has NEVER received a live clock: the search gate knows
 * the date (`gateCurrentDate`) but nothing reaches the answering model, so
 * "what time is it?" gets either a refusal ("I don't have a clock") or a
 * ~35 s web-search detour that cannot find the local wall clock anyway.
 * This helper builds the authoritative per-turn time block the chat route
 * injects into EVERY normal model turn (never the `purpose="compact"`
 * passthrough, which must reach the model verbatim).
 *
 * Pure and injectable: `now` is a parameter so tests never read the wall
 * clock. The Rust twin is crates/ruke-server/src/chat/clock.rs — the block
 * text there is byte-identical to `block()` here for the same inputs.
 */

/** Resolve the session IANA timezone: the browser-provided name when it is
 *  a valid zone (hooks/useChat sends
 *  `Intl.DateTimeFormat().resolvedOptions().timeZone`), otherwise the
 *  server's own zone. Never throws on client-supplied garbage. */
export function resolveSessionTimezone(browserTimezone?: string): string {
  const t = browserTimezone?.trim();
  if (t) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: t });
      return t;
    } catch {
      // invalid IANA name from the client: fall through to the server zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zoneParts(now: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(now)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** Signed `±HH:MM` UTC offset for `now` inside `timeZone`
 *  (zone wall clock minus real UTC; DST-aware via Intl). */
export function utcOffset(now: Date, timeZone: string): string {
  const p = zoneParts(now, timeZone);
  const wallMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((wallMs - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The per-turn `<runtime_clock>` system block. Wording law: this text and
 * the Rust `clock.rs` block are byte-identical apart from the live values —
 * changing one without the other breaks the Rust-mirror parity tests.
 */
export function buildClockContext(opts: { browserTimezone?: string; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const tz = resolveSessionTimezone(opts.browserTimezone);
  const p = zoneParts(now, tz);
  return buildClockBlock(p.weekday, `${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}:${p.second}`, utcOffset(now, tz), tz);
}

/** The shared text assembly, split out so the Rust mirror's unit tests can
 *  pin the exact wording with fixed inputs (same five fields as there). */
export function buildClockBlock(
  weekday: string,
  date: string,
  time: string,
  offset: string,
  timezoneLabel: string,
): string {
  return (
    "<runtime_clock>\n" +
    `Current date/time: ${weekday} ${date} ${time} (UTC${offset}) — session timezone: ${timezoneLabel} (IANA).\n` +
    "This clock is authoritative and live: the server injects it fresh into every turn, immediately before the current user message.\n" +
    "Answer any current-time, date, or day-of-week question directly from this line, in the session timezone shown. " +
    "NEVER claim that you lack a clock, cannot see the current time, or that your knowledge is frozen at a training cutoff.\n" +
    'Use this clock — never a web search — whenever you reason about "today", "now", "this year", or staleness.\n' +
    "</runtime_clock>"
  );
}
