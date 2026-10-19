/** Shared timestamp rendering: citations and spine both use [HH:MM:SS]. */
export function fmtStamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** First sentence of a passage, clipped for spine lines. */
export function firstSentence(text: string, max = 90): string {
  const m = /^[^.!?]+[.!?]?/.exec(text.trim());
  const s = (m?.[0] ?? text).trim();
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}

export function lastSentence(text: string, max = 90): string {
  const parts = text.trim().match(/[^.!?]+[.!?]?/g) ?? [];
  const s = (parts[parts.length - 1] ?? text).trim();
  return s.length > max ? "…" + s.slice(-max).trimStart() : s;
}
