/**
 * Incremental SSE frame parser.
 * Keeps a byte buffer and only ever returns *complete* events.
 *
 * SINGLE BUFFER OWNERSHIP (I01): the parser holds the incomplete-frame buffer
 * itself. Callers must feed ONLY newly decoded bytes on every push — never a
 * previously returned `tail`. Feeding a tail back in would prepend it twice
 * and corrupt the frame (this was the byte-split delta-loss bug). `tail` is
 * returned purely for observability; the parser is the only consumer of it.
 * At end-of-stream, call `flush()` once to parse whatever remains as a final
 * unterminated record — the caller must not re-feed the tail manually.
 */

export interface SseMessage {
  data: string;
}

export interface SsePushResult {
  events: SseMessage[];
  done: boolean;
  /** Observability only — already owned by the parser; never re-feed it. */
  tail: string;
}

export interface SseParser {
  (chunk: string): SsePushResult;
  /** End-of-stream: parse the remaining buffer as a final unterminated record. */
  flush(): { events: SseMessage[]; done: boolean };
}

export function createSseParser(): SseParser {
  let buffer = "";

  const push = function (chunk: string): SsePushResult {
    buffer += chunk;

    const events: SseMessage[] = [];
    let done = false;

    let sep: number;
    while ((sep = indexOfBoundary(buffer)) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + boundaryLength(buffer, sep));
      const parsed = parseEvent(raw);
      if (parsed) {
        events.push(parsed);
        if (parsed.data === "[DONE]") done = true;
      }
    }

    if (buffer.length > 4_000_000) buffer = "";

    return { events, done, tail: buffer };
  } as SseParser;

  push.flush = function (): { events: SseMessage[]; done: boolean } {
    const rest = buffer;
    buffer = "";
    const parsed = rest.trim() ? parseEvent(rest) : null;
    const events = parsed ? [parsed] : [];
    return { events, done: parsed?.data === "[DONE]" };
  };

  return push;
}

function indexOfBoundary(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const cr = buf.indexOf("\r\n\r\n");
  if (lf === -1) return cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}

function boundaryLength(buf: string, at: number): number {
  return buf.startsWith("\r\n\r\n", at) ? 4 : 2;
}

function parseEvent(raw: string): SseMessage | null {
  let data = "";
  let saw = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const v = line.slice(5).replace(/^ /, "");
      data = saw ? data + "\n" + v : v;
      saw = true;
    }
  }
  return saw ? { data } : null;
}
