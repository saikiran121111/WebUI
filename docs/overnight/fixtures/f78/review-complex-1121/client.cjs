"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// D:/Projects/WebUI/WebUI/lib/chat/client.ts
var client_exports = {};
__export(client_exports, {
  ChatClient: () => ChatClient,
  ChatClientError: () => ChatClientError,
  attachmentParts: () => attachmentParts
});
module.exports = __toCommonJS(client_exports);

// D:/Projects/WebUI/WebUI/lib/stream/sse.ts
function createSseParser() {
  let buffer = "";
  const push = function(chunk) {
    buffer += chunk;
    const events = [];
    let done = false;
    let sep;
    while ((sep = indexOfBoundary(buffer)) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + boundaryLength(buffer, sep));
      const parsed = parseEvent(raw);
      if (parsed) {
        events.push(parsed);
        if (parsed.data === "[DONE]") done = true;
      }
    }
    if (buffer.length > 4e6) buffer = "";
    return { events, done, tail: buffer };
  };
  push.flush = function() {
    const rest = buffer;
    buffer = "";
    const parsed = rest.trim() ? parseEvent(rest) : null;
    const events = parsed ? [parsed] : [];
    return { events, done: parsed?.data === "[DONE]" };
  };
  return push;
}
function indexOfBoundary(buf) {
  const lf = buf.indexOf("\n\n");
  const cr = buf.indexOf("\r\n\r\n");
  if (lf === -1) return cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}
function boundaryLength(buf, at) {
  return buf.startsWith("\r\n\r\n", at) ? 4 : 2;
}
function parseEvent(raw) {
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

// D:/Projects/WebUI/WebUI/lib/stream/thinkTags.ts
var OPEN = "<think>";
var CLOSE = "</think>";
var BACKTICK = "`";
function createThinkSplitter() {
  let inThink = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceQuoted = false;
  let codeIndent = false;
  let lastLineBlank = true;
  let atLineStart = true;
  let held = "";
  const emit = (out, piece) => {
    if (!piece) return;
    if (inThink) out.reasoning += piece;
    else out.content += piece;
  };
  const scanLine = (out, text, i, end) => {
    while (i < end) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const run = nextBacktick(text, i, end);
      if (at !== -1 && at < end && (run === -1 || at < run)) {
        emit(out, text.slice(i, at));
        inThink = !inThink;
        i = at + tag.length;
        continue;
      }
      if (run === -1) {
        emit(out, text.slice(i, end));
        return;
      }
      emit(out, text.slice(i, run));
      const len = runLen(text, run, end);
      const close = findSpanClose(text, run + len, end, len);
      if (close === -1) {
        emit(out, text.slice(run, run + len));
        i = run + len;
        continue;
      }
      emit(out, text.slice(run, close + len));
      i = close + len;
    }
  };
  const scanToBufferEnd = (out, text, i) => {
    while (i < text.length) {
      const tag = inThink ? CLOSE : OPEN;
      const at = text.indexOf(tag, i);
      const run = nextBacktick(text, i, text.length);
      if (at !== -1 && (run === -1 || at < run)) {
        emit(out, text.slice(i, at));
        inThink = !inThink;
        i = at + tag.length;
        continue;
      }
      if (run === -1) {
        const stop = at === -1 ? holdStart(text, i, tag) : at;
        emit(out, text.slice(i, stop));
        held = text.slice(stop);
        return;
      }
      emit(out, text.slice(i, run));
      const len = runLen(text, run, text.length);
      const close = findSpanClose(text, run + len, text.length, len);
      if (close === -1 || run + len >= text.length || close + len >= text.length) {
        held = text.slice(run);
        return;
      }
      emit(out, text.slice(run, close + len));
      i = close + len;
    }
  };
  const finishHeld = (out) => {
    if (!held) return;
    const text = held;
    held = "";
    if (fenceChar) {
      emit(out, text);
      return;
    }
    if (!atLineStart) {
      scanLine(out, text, 0, text.length);
      return;
    }
    const body = stripBlockquote(text);
    if (codeIndent && (isBlankLine(body) || isIndentedCodeLine(body))) {
      emit(out, text);
      return;
    }
    if (codeIndent) codeIndent = false;
    if (isIndentedCodeLine(body) && lastLineBlank) {
      codeIndent = true;
      emit(out, text);
      return;
    }
    const open = parseOpenLine(body);
    if (open) {
      fenceChar = open.char;
      fenceLen = open.len;
      fenceQuoted = body !== text;
      emit(out, text);
      return;
    }
    scanLine(out, text, 0, text.length);
    lastLineBlank = isBlankLine(body);
  };
  const next = function(chunk) {
    const text = held + chunk;
    held = "";
    const out = { content: "", reasoning: "" };
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const terminated = nl !== -1;
      const bodyEnd = terminated ? nl : text.length;
      if (atLineStart) {
        const line = text.slice(i, bodyEnd);
        const body = stripBlockquote(line);
        if (terminated) {
          if (fenceChar) {
            emit(out, text.slice(i, nl + 1));
            if (isCloseLine(line, fenceChar, fenceLen) || fenceQuoted && isCloseLine(body, fenceChar, fenceLen)) {
              fenceChar = "";
              fenceLen = 0;
              fenceQuoted = false;
            }
          } else if (codeIndent && (isBlankLine(body) || isIndentedCodeLine(body))) {
            emit(out, text.slice(i, nl + 1));
          } else if (codeIndent) {
            codeIndent = false;
            const open = parseOpenLine(body);
            if (open) {
              fenceChar = open.char;
              fenceLen = open.len;
              fenceQuoted = body !== line;
              emit(out, text.slice(i, nl + 1));
            } else {
              scanLine(out, text, i, bodyEnd);
              emit(out, "\n");
            }
          } else if (isIndentedCodeLine(body) && lastLineBlank) {
            codeIndent = true;
            emit(out, text.slice(i, nl + 1));
          } else {
            const open = parseOpenLine(body);
            if (open) {
              fenceChar = open.char;
              fenceLen = open.len;
              fenceQuoted = body !== line;
              emit(out, text.slice(i, nl + 1));
            } else {
              scanLine(out, text, i, bodyEnd);
              emit(out, "\n");
            }
          }
          lastLineBlank = isBlankLine(body);
          i = nl + 1;
          continue;
        }
        if (couldBeFenceLine(line, fenceChar)) {
          held = text.slice(i);
          break;
        }
        atLineStart = false;
      }
      if (fenceChar) {
        const stop = terminated ? nl + 1 : text.length;
        emit(out, text.slice(i, stop));
        i = stop;
        atLineStart = terminated;
        continue;
      }
      if (terminated) {
        scanLine(out, text, i, bodyEnd);
        emit(out, "\n");
        i = nl + 1;
        atLineStart = true;
        continue;
      }
      scanToBufferEnd(out, text, i);
      break;
    }
    return out;
  };
  next.flush = function() {
    const out = { content: "", reasoning: "" };
    finishHeld(out);
    return out;
  };
  return next;
}
function couldBeFenceLine(line, fenceChar) {
  if (!line) return false;
  if (line[0] === " " || line[0] === "	" || line[0] === ">") return true;
  return fenceChar ? line[0] === fenceChar : line[0] === "`" || line[0] === "~";
}
function stripBlockquote(line) {
  let p = 0;
  for (; ; ) {
    let q = p;
    while (q < p + 3 && line[q] === " ") q++;
    if (line[q] !== ">") return line.slice(p);
    q++;
    if (line[q] === " " || line[q] === "	") q++;
    p = q;
  }
}
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== " " && c !== "	" && c !== "\r") return false;
  }
  return true;
}
function isIndentedCodeLine(line) {
  if (!line) return false;
  if (line[0] === "	") return true;
  return line.startsWith("    ");
}
function parseOpenLine(line) {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  let p = 0;
  while (p < body.length && p < 4 && body[p] === " ") p++;
  if (p >= body.length || p === 4) return null;
  const c = body[p];
  if (c !== "`" && c !== "~") return null;
  let q = p;
  while (q < body.length && body[q] === c) q++;
  const len = q - p;
  if (len < 3) return null;
  if (c === "`" && body.slice(q).includes("`")) return null;
  return { char: c, len };
}
function isCloseLine(line, fenceChar, fenceLen) {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  let p = 0;
  while (p < body.length && p < 4 && body[p] === " ") p++;
  if (p >= body.length || p === 4) return false;
  if (body[p] !== fenceChar) return false;
  let q = p;
  while (q < body.length && body[q] === fenceChar) q++;
  if (q - p < fenceLen) return false;
  for (let k = q; k < body.length; k++) {
    if (body[k] !== " " && body[k] !== "	") return false;
  }
  return true;
}
function nextBacktick(text, from, limit) {
  const q = text.indexOf(BACKTICK, from);
  return q !== -1 && q < limit ? q : -1;
}
function runLen(text, start, limit) {
  let q = start;
  while (q < limit && text[q] === BACKTICK) q++;
  return q - start;
}
function findSpanClose(text, from, limit, len) {
  let p = from;
  while (p < limit) {
    const q = nextBacktick(text, p, limit);
    if (q === -1) return -1;
    const r = runLen(text, q, limit);
    if (r === len) return q;
    p = q + r;
  }
  return -1;
}
function holdStart(text, from, tag) {
  const max = Math.min(tag.length - 1, text.length - from);
  for (let k = max; k >= 1; k--) {
    if (text.endsWith(tag.slice(0, k))) return text.length - k;
  }
  return text.length;
}

// D:/Projects/WebUI/WebUI/lib/stream/parser.ts
var POST_DONE_DRAIN_MS = 750;
function createStreamParser(opts) {
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let reader = null;
  const decoder = new TextDecoder("utf-8");
  const sse = createSseParser();
  const splitter = createThinkSplitter();
  const acc = new ToolCallAccumulator();
  const queue = [];
  let resolve = null;
  const terminalResult = () => {
    terminalObserved = true;
    return { value: void 0, done: true };
  };
  let done = false;
  let error = null;
  let sawDone = false;
  let sawFinish = false;
  let finishReason = null;
  let serverError = null;
  let transportFailure = null;
  let settlement = null;
  let terminalObserved = false;
  let trailingDrainExpired = false;
  const drainMs = opts.postDoneDrainMs ?? POST_DONE_DRAIN_MS;
  const readChunk = async (rd, graceMs) => {
    const pending = rd.read();
    if (graceMs == null) return await pending;
    let timer;
    const grace = new Promise((res) => {
      timer = setTimeout(() => res({ done: true, grace: true }), graceMs);
    });
    try {
      const raced = await Promise.race([pending, grace]);
      if (raced.grace) {
        trailingDrainExpired = true;
        pending.catch(() => {
        });
        try {
          void Promise.resolve(rd.cancel()).catch(() => {
          });
        } catch {
        }
        return { done: true, grace: true };
      }
      return raced;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const settle = () => {
    if (settlement) return settlement;
    let outcome;
    let message;
    if (transportFailure?.kind === "abort") {
      outcome = "cancelled";
    } else if (serverError || transportFailure) {
      outcome = "error";
      message = transportFailure?.message ?? serverError ?? void 0;
    } else if (finishReason === "abort" || finishReason === "interrupted") {
      outcome = "cancelled";
    } else if (finishReason === "tool_calls" && !sawDone) {
      outcome = "incomplete_tool_round";
      message = "The model asked to use a tool, but the turn ended before the tool ran.";
    } else if (finishReason === "length" || !sawDone && !sawFinish) {
      outcome = "truncated";
    } else {
      outcome = "success";
    }
    settlement = {
      outcome,
      finishReason,
      ...message ? { errorMessage: message } : {},
      ...trailingDrainExpired ? { trailingDrainExpired: true } : {}
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
          ...opts.apiKey ? { Authorization: "Bearer " + opts.apiKey } : {}
        },
        body: JSON.stringify(opts.body),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error("Upstream returned " + res.status + ": " + text.slice(0, 300));
      }
      if (opts.onMeta) {
        try {
          opts.onMeta(res.headers);
        } catch {
        }
      }
      if (!res.body) throw new Error("No response body from upstream");
      reader = res.body.getReader();
      while (true) {
        const { value, done: eof, grace } = await readChunk(
          reader,
          sawDone ? drainMs : void 0
        );
        if (grace) break;
        if (eof) break;
        const { events, done: sseDone } = sse(decoder.decode(value, { stream: true }));
        for (const e of events) deliver(e.data);
        if (sseDone) sawDone = true;
      }
      if (!sawDone) {
        const mid = sse(decoder.decode());
        for (const e of mid.events) deliver(e.data);
        if (mid.done) sawDone = true;
        const rest = sse.flush();
        for (const e of rest.events) deliver(e.data);
        if (rest.done) sawDone = true;
      }
      const sf = splitter.flush();
      if (sf.reasoning) push({ reasoning: sf.reasoning });
      if (sf.content) push({ content: sf.content });
      if (!sawDone && !sawFinish) push({ finishReason: "error" });
      const flushed = acc.flush();
      for (const t of flushed) {
        push({ toolCalls: [{ index: 0, name: t.name, argsChunk: t.args }] });
      }
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
      const kind = e?.name === "AbortError" ? "abort" : "error";
      transportFailure = {
        kind,
        message: kind === "error" ? e?.message || void 0 : void 0
      };
      push({
        finishReason: kind,
        errorMessage: kind === "error" ? e?.message || void 0 : void 0
      });
      settle();
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(terminalResult());
      }
    } finally {
      try {
        reader?.releaseLock();
      } catch {
      }
    }
  };
  const deliver = (data) => {
    if (data === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json?.ruke_stage) {
      push({ stage: json.ruke_stage });
      return;
    }
    if (json?.ruke_error) {
      sawFinish = true;
      const msg = typeof json.ruke_error?.message === "string" ? json.ruke_error.message : "";
      serverError = msg || "Generation failed";
      push({ finishReason: "error", errorMessage: msg || void 0 });
      return;
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta;
    const finish = choice?.finish_reason;
    const detailsText = Array.isArray(delta?.reasoning_details) ? delta.reasoning_details.map((p) => typeof p?.text === "string" ? p.text : "").join("") : "";
    if (detailsText) {
      push({ reasoning: detailsText });
    } else if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
      push({ reasoning: delta.reasoning_content });
    }
    if (delta?.content) {
      const split = splitter(delta.content);
      if (split.reasoning) push({ reasoning: split.reasoning });
      if (split.content) push({ content: split.content });
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        acc.add({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argsChunk: tc.function?.arguments
        });
      }
    }
    if (finish) {
      sawFinish = true;
      if (typeof finish === "string") finishReason = finish;
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
  const push = (e) => {
    queue.push(e);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: queue.shift(), done: false });
    }
  };
  pump();
  return {
    async next() {
      if (queue.length) return { value: queue.shift(), done: false };
      if (done) return terminalResult();
      return new Promise((res) => {
        resolve = res;
      });
    },
    abort() {
      controller.abort();
    },
    settled() {
      return terminalObserved ? settlement : null;
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
function normaliseUsage(u, timings) {
  return {
    promptTokens: u?.prompt_tokens,
    completionTokens: u?.completion_tokens,
    totalTokens: u?.total_tokens,
    tokensPerSecond: timings?.predicted_per_second
  };
}
var ToolCallAccumulator = class {
  constructor() {
    this.map = /* @__PURE__ */ new Map();
  }
  add(d) {
    const cur = this.map.get(d.index) ?? { args: "" };
    if (d.id) cur.id = d.id;
    if (d.name) cur.name = d.name;
    if (d.argsChunk) cur.args += d.argsChunk;
    this.map.set(d.index, cur);
  }
  /** Returns and forgets the accumulated calls. */
  flush() {
    const out = [];
    for (const [, v] of this.map) {
      out.push({
        id: v.id ?? "call_" + Math.random().toString(36).slice(2, 10),
        name: v.name ?? "",
        args: v.args,
        status: "complete"
      });
    }
    this.map.clear();
    return out;
  }
};

// D:/Projects/WebUI/WebUI/lib/chat/client.ts
var DEFAULT_URL = "/api/chat";
var ChatClientError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "ChatClientError";
  }
};
var ChatClient = class {
  constructor(url = DEFAULT_URL, apiKey = "no-key", model = "") {
    this.url = url;
    this.apiKey = apiKey;
    this.model = model;
  }
  async chat(req, onEvent, signal, onMeta) {
    const body = this.buildBody(req);
    const handle = createStreamParser({
      url: this.url,
      apiKey: this.apiKey,
      body,
      signal,
      onMeta
    });
    for await (const ev of iterate(handle)) {
      onEvent(ev);
    }
    return handle.settled() ?? { outcome: "truncated", finishReason: null };
  }
  abort(handle) {
    handle.abort();
  }
  buildBody(req) {
    const messages = [];
    for (const m of req.messages) {
      const atts = m.attachments;
      const entry = { role: m.role, content: messageContent(m.content, atts) };
      if (m.reasoning_content) entry.reasoning_content = m.reasoning_content;
      if (m.tool_calls) entry.tool_calls = m.tool_calls;
      if (m.role === "tool") entry.tool_call_id = m.tool_call_id;
      messages.push(entry);
    }
    const body = {
      model: req.model ?? this.model,
      messages,
      stream: req.stream ?? true
    };
    if (req.temperature !== void 0) body.temperature = req.temperature;
    if (req.top_p !== void 0) body.top_p = req.top_p;
    if (req.max_tokens !== void 0) body.max_tokens = req.max_tokens;
    if (req.reasoning_effort && req.reasoning_effort !== "off") {
      body.reasoning_effort = req.reasoning_effort;
    }
    if (req.tools?.length) body.tools = req.tools;
    if (req.decision_mode) body.decision_mode = req.decision_mode;
    if (req.purpose) body.purpose = req.purpose;
    if (req.browser_session) body.browser_session = req.browser_session;
    if (req.browser_armed === true) body.browser_armed = true;
    if (req.timezone) body.timezone = req.timezone;
    if (body.stream) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }
};
function messageContent(text, atts) {
  if (!atts?.length) return text ?? "";
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const att of atts) parts.push(...attachmentParts(att));
  return parts;
}
function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(r).padStart(2, "0")}`;
}
var VIDEO_MOMENTS_LAW = " The images are isolated moments: the record holds no evidence about the time between, before or after them. Never claim that something is visible throughout a video, always or never shown, or unchanged across any stretch between two shown moments; when asked about such a stretch, answer from the shown moments and say the rest cannot be confirmed.";
var NUMERIC_FIDELITY_LAW = "When quoting a figure from the material, keep its exact digits and digit grouping. When restating a figure in different units or a different grouping convention, state the exact conversion being applied and verify the restated figure has the same value; never give two versions of one figure that have different values. This applies to every restated version anywhere in the answer, including brief asides.";
function attachmentParts(att) {
  const label = `Attached file: ${att.name}`;
  if (att.indexed) {
    const timed = att.category === "audio" || att.category === "video";
    const isVideo = att.category === "video";
    const preview = att.transcript ?? att.text;
    const parts = [
      {
        type: "text",
        text: `${label} \u2014 this ${isVideo ? "video" : timed ? "recording" : "document"} is long, so its complete content is kept in a local knowledge index (nothing was discarded). You are shown its structural map and its opening; passages relevant to each question are supplied as timestamped evidence when needed.` + (isVideo ? ` This video's complete saved record is kept whole in the index; you are shown parts of it: the images below are moments from it, and its spoken content is part of the record. Speak of the video as a whole \u2014 never claim to have watched it yourself, never mention frames, sampled images, keyframes, an audio track or transcription, and never attribute content to a particular frame.` + VIDEO_MOMENTS_LAW : "")
      }
    ];
    if (isVideo) {
      if (att.durationSec && att.durationSec > 0) {
        parts.push({ type: "text", text: `Video length: ${fmtClock(att.durationSec)}.` });
      }
      parts.push({ type: "text", text: "Moments from the video:" });
      for (const f of att.frames ?? []) {
        parts.push({
          type: "text",
          text: `At ${fmtClock(f.at)} in the video this is what is happening on screen \u2014 speak of it as the video at that time, never as an image or a still:`
        });
        parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      }
    }
    if (att.spine) parts.push({ type: "text", text: `Structural map of ${label}:
${att.spine}` });
    if (preview) {
      parts.push({
        type: "text",
        text: `Opening of the content:
[content begins]
${preview}
[content continues \u2014 the remainder is indexed, not shown]`
      });
    }
    parts.push({
      type: "attachment_ref",
      att_id: att.indexId ?? att.id,
      name: att.name,
      category: att.category ?? "text"
    });
    return parts;
  }
  switch (att.category) {
    case "image":
      return att.dataUrl ? [
        { type: "text", text: `${label} (image)` },
        { type: "image_url", image_url: { url: att.dataUrl } }
      ] : [{ type: "text", text: `${label} \u2014 the image could not be read` }];
    case "video": {
      const parts = [
        {
          type: "text",
          text: `${label} \u2014 you are given its complete saved record. The images below are moments from it` + (att.transcript ? ", and after them is what is spoken in it" : "") + `.
Describe the video from this record: what happens, what appears on screen, what is said. Never claim to have watched it yourself; never mention frames, sampled images, keyframes, an audio track, transcription or speech recognition, and never attribute content to "the first frame" or "this frame" \u2014 the visuals and the speech belong to the video as one whole. Give video timestamps only when the user asks for them or when a time reference genuinely helps the answer.` + VIDEO_MOMENTS_LAW
        }
      ];
      if (att.durationSec && att.durationSec > 0) {
        parts.push({ type: "text", text: `Video length: ${fmtClock(att.durationSec)}.` });
      }
      for (const f of att.frames ?? []) {
        parts.push({
          type: "text",
          text: `At ${fmtClock(f.at)} in the video this is what is happening on screen \u2014 speak of it as the video at that time, never as an image or a still:`
        });
        parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      }
      if (!att.frames?.length) parts.push({ type: "text", text: "No visuals could be read from this video." });
      if (att.transcript)
        parts.push({
          type: "text",
          text: `What is spoken in this video:
[spoken content begins]
${att.transcript}
[spoken content ends]`
        });
      return parts;
    }
    case "audio":
      if (!att.transcript)
        return [
          {
            type: "text",
            text: `${label} (audio) \u2014 no spoken words could be read from this recording. Do NOT state that it is silent or that it contains no speech: an unreadable speech track and an absent one are different claims, and this one is unknown. Answer from what the user says about it, or say plainly that its speech could not be read.`
          }
        ];
      return [
        {
          type: "text",
          text: `${label} (audio recording \u2014 its complete spoken content, taken directly from the recording, follows)
[spoken content begins]
${att.transcript}
[spoken content ends]
Answer in terms of what the recording says and what the speakers say. Never claim to have listened to it yourself, never mention a transcript or speech recognition, and never tell the user you cannot access its spoken content.`
        }
      ];
    default: {
      if (!att.text) return [{ type: "text", text: `${label} \u2014 no readable text was found` }];
      const body = `${label}
[file content begins]
${att.text}
[file content ends]` + (att.truncated ? "\n[the file was truncated]" : "") + `
${NUMERIC_FIDELITY_LAW}`;
      return [{ type: "text", text: body }];
    }
  }
}
async function* iterate(handle) {
  while (true) {
    const result = await handle.next();
    if (result.done) break;
    yield result.value;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChatClient,
  ChatClientError,
  attachmentParts
});
