import { createSseParser } from "./sse";
import { createThinkSplitter } from "./thinkTags";
import type { StreamEvent, StreamToolCallDelta, ToolCall, Usage } from "../types";

export interface StreamHandle {
  /** Pulls the next event from the wire. */
  next(): Promise<IteratorResult<StreamEvent, void>>;
  /** Aborts the request and closes the reader. */
  abort(): void;
  /**
   * F16 (2026-11-15): the turn's EXPLICIT terminal outcome, available once the
   * stream settles — i.e. from the moment the iterator reports `done: true`
   * onwards, never earlier. `null` while the stream is still running.
   * Consumers MUST NOT infer success from "the iterator ended": an upstream
   * error, a client abort, a truncated answer and an orphaned tool-call EOF
   * all end the iterator too.
   */
  settled(): StreamSettlement | null;
}

/** F16: the five ways a turn can actually end (TS ⇄ Rust `Outcome` shapes). */
export type TurnOutcome =
  | "success"
  | "error"
  | "cancelled"
  | "truncated"
  | "incomplete_tool_round";

export interface StreamSettlement {
  outcome: TurnOutcome;
  /** The finish_reason the wire actually carried, if any. */
  finishReason: string | null;
  /** Truthful detail for error-ish outcomes; never invented. */
  errorMessage?: string;
  /** True when the post-`[DONE]` drain window expired before EOF. */
  trailingDrainExpired?: boolean;
}

export interface StreamOptions {
  url: string;
  apiKey?: string;
  body: unknown;
  signal?: AbortSignal;
  /** Fired once with the response headers (used to read X-Used-Skill). */
  onMeta?: (headers: Headers) => void;
  /**
   * F16: how long to keep reading AFTER `data: [DONE]` so trailing metadata
   * (usage, final stage frames) that the upstream puts in a LATER TCP read is
   * not silently dropped. Default {@link POST_DONE_DRAIN_MS}.
   */
  postDoneDrainMs?: number;
}

/**
 * F16 drain bound. A well-behaved server closes right after `[DONE]`, so EOF
 * arrives immediately and this bound costs nothing; it only bites a server that
 * holds the connection open, and then it bounds the wait instead of hanging
 * the turn forever or truncating the metadata.
 */
export const POST_DONE_DRAIN_MS = 750;

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
  /**
   * F16: the single terminal of the iterator. Pulling it is what makes the
   * turn's settlement observable via `settled()` — a consumer can therefore
   * never mark a turn complete while events it has not read are still queued.
   */
  const terminalResult = (): IteratorResult<StreamEvent, void> => {
    terminalObserved = true;
    return { value: undefined, done: true };
  };
  let done = false;
  let error: unknown = null;
  // Stream-completion flags (shared between pump() and deliver()).
  let sawDone = false;    // [DONE] sentinel seen
  let sawFinish = false;  // a finish_reason (incl. ruke_error) was delivered
  // F16: what the wire actually said, tracked separately from the event queue
  // so the terminal outcome is derived AFTER every frame was delivered.
  let finishReason: string | null = null;
  let serverError: string | null = null;   // a ruke_error frame ended the turn
  let transportFailure: { kind: "abort" | "error"; message?: string } | null = null;
  let settlement: StreamSettlement | null = null;
  // F16: true once the consumer has pulled the iterator's terminal. Until the
  // terminal is observable, `settled()` reports nothing.
  let terminalObserved = false;
  let trailingDrainExpired = false;
  const drainMs = opts.postDoneDrainMs ?? POST_DONE_DRAIN_MS;

  /**
   * Read one chunk. After `data: [DONE]` the read is bounded by `graceMs`:
   * the upstream may still be sending usage/metadata bytes in a LATER read,
   * and dropping those (F16: "delivered when coalesced in one read, lost when
   * split into a subsequent read") is chunking-dependent data loss — the same
   * wire bytes MUST produce the same events whatever the network did.
   */
  const readChunk = async (
    rd: ReadableStreamDefaultReader<Uint8Array>,
    graceMs?: number,
  ): Promise<{ value?: Uint8Array; done: boolean; grace?: boolean }> => {
    const pending = rd.read();
    if (graceMs == null) return await pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<{ done: true; grace: true }>((res) => {
      timer = setTimeout(() => res({ done: true, grace: true }), graceMs);
    });
    try {
      const raced = await Promise.race([pending, grace]);
      if ((raced as { grace?: boolean }).grace) {
        trailingDrainExpired = true;
        // The abandoned read must not surface as an unhandled rejection, and
        // the connection is released deterministically instead of left open.
        pending.catch(() => {});
        try {
          void Promise.resolve(rd.cancel()).catch(() => {});
        } catch {
          /* already released */
        }
        return { done: true, grace: true };
      }
      return raced;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** F16: derive the turn's outcome from the delivered facts, exactly once. */
  const settle = (): StreamSettlement => {
    if (settlement) return settlement;
    let outcome: TurnOutcome;
    let message: string | undefined;
    if (transportFailure?.kind === "abort") {
      outcome = "cancelled";
    } else if (serverError || transportFailure) {
      outcome = "error";
      message = transportFailure?.message ?? serverError ?? undefined;
    } else if (finishReason === "abort" || finishReason === "interrupted") {
      outcome = "cancelled";
    } else if (finishReason === "tool_calls" && !sawDone) {
      // ORPHANED tool-call EOF: the upstream closed the turn on a tool call
      // that nothing executed (no `[DONE]`, no tool round). The conversation
      // is mid-round, NOT complete — never report this as success. (A capped
      // research round that the SERVER deliberately terminated closes with a
      // `[DONE]` it emitted itself: that is a finished turn, so `sawDone`
      // separates the honest cap from a real orphan.)
      outcome = "incomplete_tool_round";
      message = "The model asked to use a tool, but the turn ended before the tool ran.";
    } else if (finishReason === "length" || (!sawDone && !sawFinish)) {
      outcome = "truncated";
    } else {
      outcome = "success";
    }
    settlement = {
      outcome,
      finishReason,
      ...(message ? { errorMessage: message } : {}),
      ...(trailingDrainExpired ? { trailingDrainExpired: true } : {}),
    };
    return settlement;
  };

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
      if (opts.onMeta) {
        try { opts.onMeta(res.headers); } catch {}
      }
      if (!res.body) throw new Error("No response body from upstream");

      reader = res.body.getReader();

      // I01: the SSE parser owns the incomplete-frame buffer. Feed ONLY the
      // newly decoded bytes each read — never a returned tail.
      while (true) {
        const { value, done: eof, grace } = await readChunk(
          reader,
          sawDone ? drainMs : undefined,
        );
        if (grace) break; // bounded post-[DONE] window elapsed: keep what arrived
        if (eof) break;
        const { events, done: sseDone } = sse(decoder.decode(value, { stream: true }));
        for (const e of events) deliver(e.data);
        // F16 ordering law: `[DONE]` ends the model's TOKENS, not the read
        // loop. Keep draining (bounded) until EOF so trailing usage/metadata
        // frames ride through; the iterator's single terminal is emitted only
        // after every metadata event has been pushed.
        if (sseDone) sawDone = true;
      }

      if (!sawDone) {
        // EOF without [DONE]: flush the decoder (incomplete multibyte tail),
        // then let the SSE parser parse its remaining buffer once as the
        // final unterminated record.
        const mid = sse(decoder.decode());
        for (const e of mid.events) deliver(e.data);
        if (mid.done) sawDone = true;
        const rest = sse.flush();
        for (const e of rest.events) deliver(e.data);
        if (rest.done) sawDone = true;
      }

      // Release any text the think-splitter was holding back (partial tag at
      // end of stream is literal text, not a delimiter).
      const sf = splitter.flush();
      if (sf.reasoning) push({ reasoning: sf.reasoning });
      if (sf.content) push({ content: sf.content });

      // The upstream closed without ever ending the turn — the stream was
      // truncated. Say so instead of pretending the answer completed.
      if (!sawDone && !sawFinish) push({ finishReason: "error" });

      // Finalise any tool calls still mid-stream.
      const flushed = acc.flush();
      for (const t of flushed) {
        push({ toolCalls: [{ index: 0, name: t.name, argsChunk: t.args }] });
        // tool calls are surfaced via toolCallComplete below
      }
      // F16: every content/status/metadata event is already queued; settle from
      // what was DELIVERED, and expose it only once the iterator reports done.
      settle();
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(terminalResult());
      }
    } catch (e) {
      error = e;
      console.error("[PARSER] error:", e);
      done = true;
      const kind = (e as Error)?.name === "AbortError" ? "abort" : "error";
      transportFailure = {
        kind,
        message: kind === "error" ? (e as Error)?.message || undefined : undefined,
      };
      push({
        finishReason: kind,
        errorMessage: kind === "error" ? (e as Error)?.message || undefined : undefined,
      });
      settle();
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(terminalResult());
      }
    } finally {
      try { reader?.releaseLock(); } catch {}
    }
  };

  const deliver = (data: string) => {
    if (data === "[DONE]") return;
    let json: any;
    try { json = JSON.parse(data); } catch { return; }

    // Route-level progress phases (app/api/chat/route.ts). Upstream JSON never
    // carries these keys, so mock specs and third-party streams are untouched.
    if (json?.ruke_stage) { push({ stage: json.ruke_stage }); return; }
    if (json?.ruke_error) {
      // Same surface as today's non-200 upstream: finishReason "error" —
      // plus the server's ACTUAL failure detail. The wire always carried
      // `{ruke_error:{message}}`; the parser used to drop it so the UI
      // printed a generic label over a specific reason (brief 2026-11-13).
      sawFinish = true;
      // F16: a `ruke_error` frame is a turn-ending FACT, not just an event.
      // Without this the settlement would read "success" merely because the
      // upstream then closed cleanly with `[DONE]`.
      const msg =
        typeof json.ruke_error?.message === "string" ? json.ruke_error.message : "";
      serverError = msg || "Generation failed";
      push({ finishReason: "error", errorMessage: msg || undefined });
      return;
    }

    const choice = json?.choices?.[0];
    const delta = choice?.delta;
    const finish = choice?.finish_reason;

    // Reasoning fields are STRUCTURALLY exclusive per delta (F17,
    // 2026-11-15): a provider mirroring the same reasoning through BOTH
    // `reasoning_content` and `reasoning_details` must not duplicate the
    // UI channel. Precedence follows protocol shape — prefer the
    // structured `reasoning_details` text when it carries any, else the
    // scalar `reasoning_content`. NEVER string-matching dedupe.
    const detailsText = Array.isArray(delta?.reasoning_details)
      ? delta.reasoning_details
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .join("")
      : "";
    if (detailsText) {
      push({ reasoning: detailsText });
    } else if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
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
      sawFinish = true;
      if (typeof finish === "string") finishReason = finish;
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
      if (done) return terminalResult();
      return new Promise((res) => { resolve = res; });
    },
    abort() { controller.abort(); },
    settled() { return terminalObserved ? settlement : null; },
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
