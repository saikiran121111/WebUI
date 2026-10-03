import { createSseParser } from "./sse";
import { createThinkSplitter } from "./thinkTags";
import type { StreamEvent, StreamToolCallDelta, ToolCall, Usage } from "../types";

export interface StreamHandle {
  /** Pulls the next event from the wire. */
  next(): Promise<IteratorResult<StreamEvent, void>>;
  /** Aborts the request and closes the reader. */
  abort(): void;
}

export interface StreamOptions {
  url: string;
  apiKey?: string;
  body: unknown;
  signal?: AbortSignal;
}

/**
 * Build a transport-independent stream over a fetch response. The caller
 * receives one normalised event per logical delta, plus a final `done`-ish
 * terminator when the upstream closes.
 */
export function createStreamParser(opts: StreamOptions): StreamHandle & AsyncIterable<StreamEvent> {
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const decoder = new TextDecoder("utf-8");
  const sse = createSseParser();
  const splitter = createThinkSplitter();
  const acc = new ToolCallAccumulator();

  // We resolve to an iterator-friendly queue.
  const queue: StreamEvent[] = [];
  let resolve: ((v: IteratorResult<StreamEvent, void>) => void) | null = null;
  let done = false;
  let error: unknown = null;

  const pump = async () => {
    try {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(opts.apiKey ? { Authorization: "Bearer " + opts.apiKey } : {}),
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error("Upstream returned " + res.status + ": " + text.slice(0, 300));
      }
      if (!res.body) throw new Error("No response body from upstream");

      reader = res.body.getReader();
      let buf = "";

      while (true) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        const { events, done: sseDone, tail } = sse(buf);
        buf = tail;                       // keep only the incomplete trailing frame
        for (const e of events) deliver(e.data);
        if (sseDone) break;
      }

      // Flush anything still buffered as the last incomplete frame.
      if (buf) {
        const { events } = sse(buf);
        for (const e of events) deliver(e.data);
      }

      // Finalise any tool calls still mid-stream.
      const flushed = acc.flush();
      for (const t of flushed) {
        push({ toolCalls: [{ index: 0, name: t.name, argsChunk: t.args }] });
        // tool calls are surfaced via toolCallComplete below
      }
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    } catch (e) {
      error = e;
      done = true;
      push({ finishReason: (e as Error)?.name === "AbortError" ? "abort" : "error" });
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    } finally {
      try { reader?.releaseLock(); } catch {}
    }
  };

  const deliver = (data: string) => {
    if (data === "[DONE]") return;
    let json: any;
    try { json = JSON.parse(data); } catch { return; }

    const choice = json?.choices?.[0];
    const delta = choice?.delta;
    const finish = choice?.finish_reason;

    if (delta?.reasoning_content) {
      push({ reasoning: delta.reasoning_content });
    }
    if (delta?.content) {
      const split = splitter(delta.content);
      if (split.reasoning) push({ reasoning: split.reasoning });
      if (split.content)   push({ content:   split.content });
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        acc.add({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argsChunk: tc.function?.arguments,
        });
      }
    }
    if (finish) {
      // Flush all tool calls at finish.
      const flushed = acc.flush();
      for (const t of flushed) {
        push({ toolCalls: [{ index: 0, name: t.name + ":" + t.args, argsChunk: t.args }] });
      }
      push({ finishReason: finish });
    }

    if (json?.usage) {
      push({ usage: normaliseUsage(json.usage, json.timings) });
    }
  };

  const push = (e: StreamEvent) => {
    queue.push(e);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: queue.shift()!, done: false });
    }
  };

  pump();

  return {
    async next() {
      if (queue.length) return { value: queue.shift()!, done: false };
      if (done) return { value: undefined, done: true };
      return new Promise((res) => { resolve = res; });
    },
    abort() { controller.abort(); },
    [Symbol.asyncIterator]() { return this; },
  };
}

function normaliseUsage(u: any, timings?: any): Usage {
  return {
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    totalTokens: u?.total_tokens,
    tokensPerSecond: timings?.predicted_per_second,
  };
}

/**
 * Accumulates streamed tool-call deltas into complete ToolCall records.
 * Indexed so multiple parallel tool calls (and out-of-order chunks) work.
 */
class ToolCallAccumulator {
  private map = new Map<number, { id?: string; name?: string; args: string }>();

  add(d: StreamToolCallDelta) {
    const cur = this.map.get(d.index) ?? { args: "" };
    if (d.id) cur.id = d.id;
    if (d.name) cur.name = d.name;
    if (d.argsChunk) cur.args += d.argsChunk;
    this.map.set(d.index, cur);
  }

  /** Returns and forgets the accumulated calls. */
  flush(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const [, v] of this.map) {
      out.push({
        id: v.id ?? "call_" + Math.random().toString(36).slice(2, 10),
        name: v.name ?? "",
        args: v.args,
        status: "complete",
      });
    }
    this.map.clear();
    return out;
  }
}
