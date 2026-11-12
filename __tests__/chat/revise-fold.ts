/**
 * Streaming-reliability law (2026-11-12) test kit: folds an interleaved
 * WebProgressChannel log into the text the BROWSER ends up displaying —
 * live content deltas accumulate in wire order and `web:content_revise`
 * frames cut-and-replace, exactly the client reducer's law (useChat's
 * revise handler: flush queued appends, then slice(0, cut) + replacement).
 * A revise frame mis-ordered against the content it retracts would leave
 * that content in the fold — so an exact expected fold doubles as the
 * live-before-revise ORDERING pin. Raw log entries are byte chunks split
 * arbitrarily, so frames are only parsed once their `\n\n` terminator has
 * fully arrived.
 */
export type LoopEvent = { t: "raw"; s: string } | { t: "stage"; e: any };

export function foldDisplay(events: LoopEvent[]): string {
  let text = "";
  let buf = "";
  const drain = () => {
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const body = line.slice(6);
        if (body === "[DONE]") continue;
        try {
          const c = JSON.parse(body)?.choices?.[0]?.delta?.content;
          if (typeof c === "string") text += c;
        } catch {
          // The server swallows these lines too — the fold mirrors what
          // actually reached the browser.
        }
      }
    }
  };
  for (const ev of events) {
    if (ev.t === "stage") {
      drain(); // a revise only lands at a round boundary: buffer drained
      if (ev.e?.stage === "web:content_revise") {
        const cut = Math.max(0, Math.min(ev.e.contentCutTo ?? 0, text.length));
        text = text.slice(0, cut) + (ev.e.contentText ?? "");
      }
      continue;
    }
    buf += ev.s;
    drain();
  }
  drain();
  return text;
}
