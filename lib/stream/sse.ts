/**
 * Incremental SSE frame parser.
 * Keeps a byte buffer and only ever returns *complete* events.
 */

export interface SseMessage {
  data: string;
}

export function createSseParser() {
  let buffer = "";

  return function push(chunk: string): { events: SseMessage[]; done: boolean; tail: string } {
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
  };
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
