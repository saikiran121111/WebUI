/**
 * RUKE Rust migration — Part 2 golden-contract harness support.
 *
 * Records the CURRENT TypeScript behavior of app/api/chat (+ /api/decision)
 * behind a deterministic scripted mock upstream, and writes it under
 * rust-backend/fixtures/ as the baseline every Rust part must match.
 *
 * Design rules (MIGRATION-MAP §2/§6):
 *  - Transport chunk boundaries are NOT the contract; logical SSE frames are.
 *    We therefore record BOTH: exact response bytes (byte-exact class where
 *    deterministic) AND the logical frame sequence (structural class).
 *  - Every fixture carries inline `_meta`: scenario, producing harness,
 *    expected semantics, comparison class, env preconditions, normalization.
 *  - Re-runnability: writeJsonFixture FAILS if a recorded fixture would
 *    change, so a second run doubles as a determinism/replay verifier.
 *  - No live Strata is ever contacted: settings are mocked to a fixed
 *    unreachable URL and global fetch is replaced by a scripted stub.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { createSseParser } from "@/lib/stream/sse";

export const FIXTURES_DIR = path.join(process.cwd(), "rust-backend", "fixtures");

export type ComparisonClass = "byte-exact" | "structural" | "semantic" | "approved-deviation";

export interface FixtureMeta {
  scenario: string;
  semantics: string;
  comparison: ComparisonClass;
  harness: string;
  env?: Record<string, string>;
  normalization?: string;
  notes?: string;
  /** Repo files the fixture's byte content is anchored to (skill bodies…). */
  anchors?: { path: string; sha256: string; bytes: number }[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function sha256(buf: string | Uint8Array): string {
  return createHash("sha256").update(buf as never).digest("hex");
}

/** Stable pretty JSON with a trailing newline (canonical fixture encoding). */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Write a JSON fixture with inline metadata. FAILS (determinism violation)
 * if the file exists and the new bytes differ — the corpus is the contract.
 */
export function writeJsonFixture(rel: string, data: unknown, meta: FixtureMeta): void {
  const file = path.join(FIXTURES_DIR, rel);
  ensureDir(path.dirname(file));
  const bytes = stableJson({ _meta: meta, ... (data as object) });
  if (fs.existsSync(file)) {
    const prior = fs.readFileSync(file, "utf8");
    if (prior !== bytes) {
      const a = prior.split("\n");
      const b = bytes.split("\n");
      let at = 0;
      while (at < Math.max(a.length, b.length) && a[at] === b[at]) at++;
      throw new Error(
        `Fixture drift detected in ${rel} (first difference at line ${at + 1}):\n` +
        `  existing: ${JSON.stringify(a[at] ?? "")}\n  recorded: ${JSON.stringify(b[at] ?? "")}`,
      );
    }
    return;
  }
  fs.writeFileSync(file, bytes, "utf8");
}

/** sha256 + byte count of a tracked repo file (skill bodies etc.). */
export function fileAnchor(repoRel: string): { path: string; sha256: string; bytes: number } {
  const buf = fs.readFileSync(path.join(process.cwd(), repoRel));
  return { path: repoRel, sha256: sha256(buf), bytes: buf.length };
}

// ---------------------------------------------------------------------------
// Env preconditions (read at call time by the production code)
// ---------------------------------------------------------------------------

export function setGoldenEnv(opts: { webSearchDisabled?: boolean } = {}): void {
  // Quiet pino during fixture runs (logger reads LOG_LEVEL at import).
  process.env.LOG_LEVEL = "silent";
  // Web-search gate OFF unless a web fixture explicitly re-enables it.
  if (opts.webSearchDisabled !== false) process.env.WEB_SEARCH_GATE_DISABLED = "1";
  else {
    delete process.env.WEB_SEARCH_GATE_DISABLED;
    delete process.env.WEB_SEARCH_LFM_DISABLED;
  }
}

/** The fixed upstream URL the settings mock serves; host appears in error bodies. */
export const MOCK_LLM_URL = "http://127.0.0.1:9/v1/chat/completions";
export const MOCK_LLM_KEY = "golden-key";

// ---------------------------------------------------------------------------
// Scripted mock upstream (the deterministic stand-in for llama.cpp :8080)
// ---------------------------------------------------------------------------

export interface UpstreamScript {
  status?: number;
  headers?: Record<string, string>;
  /** Exact upstream TCP/SSE chunk boundaries: each entry is enqueued as-is. */
  chunks?: (string | Uint8Array)[];
  /** Respond with a null body (exercises the "No response body" branch). */
  emptyBody?: boolean;
  /** fetch() throws this instead of resolving (unreachable-upstream branch). */
  throwOnFetch?: () => Error;
  /**
   * After `chunks`, the stream stays open until the request signal aborts,
   * then rejects with a DOMException named "AbortError" (undici semantics).
   */
  holdUntilAbort?: boolean;
}

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal;
}

export function installUpstream(scripts: UpstreamScript[]): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers as never).entries()),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? undefined,
    });
    const script = scripts[index++];
    if (!script) throw new Error("golden harness: unexpected extra upstream fetch");
    if (script.throwOnFetch) throw script.throwOnFetch();
    const status = script.status ?? 200;
    const headers: Record<string, string> = { "Content-Type": "text/event-stream", ...(script.headers ?? {}) };
    if (script.emptyBody) return new Response(null, { status, headers });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of script.chunks ?? []) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
        // Normal upstreams END (reader sees done). Only abort-hold scripts
        // keep the stream open past the scripted chunks.
        if (!script.holdUntilAbort) c.close();
      },
      pull() {
        if (!script.holdUntilAbort) return;
        return new Promise<void>((_, reject) => {
          const signal = init?.signal;
          const abortErr = () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            return e;
          };
          if (!signal) return;
          if (signal.aborted) return reject(abortErr());
          signal.addEventListener("abort", () => reject(abortErr()), { once: true });
        });
      },
    });
    return new Response(stream, { status, headers });
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Driving the real route handlers
// ---------------------------------------------------------------------------

export interface ChatRun {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  /** UTF-8 lossy decode of the response bytes (replacement chars preserved). */
  text: string;
}

export async function runChat(
  POST: (req: never) => Promise<Response>,
  rawBody: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ChatRun> {
  const req = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
    signal: opts.signal,
  }) as never;
  const res = await POST(req);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    headers: headerMap(res),
    bytes,
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  };
}

/** Response headers as a sorted-key map (header SET is the contract). */
export function headerMap(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of [...res.headers.entries()].sort()) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Logical SSE frame normalization
// ---------------------------------------------------------------------------

export type LogicalFrame =
  | { kind: "stage"; obj: unknown }
  | { kind: "error"; message: string }
  | { kind: "done" }
  | { kind: "data"; obj: unknown | null; raw: string };

export function parseLogical(text: string): { frames: LogicalFrame[]; done: boolean; tail: string } {
  const push = createSseParser();
  const { events, done, tail } = push(text);
  const frames: LogicalFrame[] = [];
  for (const ev of events) {
    if (ev.data === "[DONE]") { frames.push({ kind: "done" }); continue; }
    let obj: unknown = null;
    try { obj = JSON.parse(ev.data); } catch { /* raw/non-JSON upstream passthrough */ }
    if (obj && typeof obj === "object" && "ruke_stage" in (obj as object)) {
      frames.push({ kind: "stage", obj: normalizeMs((obj as { ruke_stage: unknown }).ruke_stage) });
      continue;
    }
    if (obj && typeof obj === "object" && "ruke_error" in (obj as object)) {
      frames.push({ kind: "error", message: String((obj as { ruke_error: { message?: string } }).ruke_error?.message ?? "") });
      continue;
    }
    frames.push({ kind: "data", obj, raw: ev.data });
  }
  return { frames, done, tail };
}

/**
 * Normalize the volatile `ms` digits inside ruke_stage frames OF THE RAW BYTE
 * STREAM (the JSON.stringify'd frame is always single-line), so progress-path
 * response bodies can be stored in a stable text form. Raw upstream data
 * frames are untouched — an ms-shaped number in model content is never rewritten.
 */
export function normalizeBodyMs(text: string): string {
  return text.replace(/data: \{"ruke_stage":\{[^\n]*\}\}\n\n/g, (m) =>
    m.replace(/"ms":-?\d+(\.\d+)?/g, '"ms":"<ms>"'),
  );
}

/** Replace volatile `ms` timing fields with the "<ms>" placeholder. */
export function normalizeMs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMs);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "ms" && typeof v === "number" ? "<ms>" : normalizeMs(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Upstream request-payload normalization (skill bodies become anchors)
// ---------------------------------------------------------------------------

export interface PayloadAnchor {
  id: string;
  kind: "active_skill" | "decision_skill";
  name: string;
  block_sha256: string;
  block_bytes: number;
  sources: { path: string; sha256: string; bytes: number }[];
}

/**
 * Replace whole skill-injection system blocks in the recorded upstream body
 * with anchors (the bodies live in tracked repo files; the fixture pins the
 * EXACT block digest so Rust must reproduce it byte-for-byte from the same
 * files using the same loader rules).
 */
export function anchorSkillBlocks(bodyJson: unknown): { payload: unknown; anchors: PayloadAnchor[] } {
  const anchors: PayloadAnchor[] = [];
  const payload = JSON.parse(JSON.stringify(bodyJson ?? null)) as { messages?: { role?: string; content?: unknown }[] } | null;
  for (const msg of payload?.messages ?? []) {
    if (msg.role !== "system" || typeof msg.content !== "string") continue;
    const block = msg.content;
    let kind: PayloadAnchor["kind"] | null = null;
    let name = "";
    if (block.startsWith('<active_skill name="')) {
      kind = "active_skill";
      name = /name="([^"]+)"/.exec(block)?.[1] ?? "";
    } else if (block.startsWith("<decision_skill ")) {
      kind = "decision_skill";
      name = /mode="([^"]+)"/.exec(block)?.[1] ?? "";
    }
    if (!kind) continue;
    const id = `${kind}:${name || "unknown"}`;
    const sources: PayloadAnchor["sources"] = [];
    if (kind === "active_skill") {
      sources.push(fileAnchor(path.posix.join("skills", name, "SKILL.md")));
    } else {
      // Core tier: the block embeds <core_skill name="X"> when a .cskills
      // bundle was loaded; contract-only blocks anchor to nothing.
      const core = /<core_skill name="([^"]+)">/.exec(block);
      if (core) sources.push(fileAnchor(path.posix.join(".cskills", core[1], "SKILL.md")));
    }
    anchors.push({
      id,
      kind,
      name,
      block_sha256: sha256(block),
      block_bytes: new TextEncoder().encode(block).length,
      sources,
    });
    msg.content = `<${kind}_block id="${id}">`;
  }
  return { payload, anchors };
}

// ---------------------------------------------------------------------------
// Fixture body builders
// ---------------------------------------------------------------------------

/**
 * JSON-safe byte record. `utf8Lossy` is the UTF-8 lossy decode; when it does
 * NOT re-encode to the original bytes (mangled multi-byte splits), the exact
 * bytes are preserved as base64 too.
 */
export function bytesRecord(bytes: Uint8Array): { bytes: number; utf8Lossy: string; base64?: string } {
  const utf8Lossy = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const rec: { bytes: number; utf8Lossy: string; base64?: string } = { bytes: bytes.length, utf8Lossy };
  if (Buffer.compare(Buffer.from(bytes), Buffer.from(utf8Lossy, "utf8")) !== 0) {
    rec.base64 = Buffer.from(bytes).toString("base64");
  }
  return rec;
}

/** TS reference copy of the route's CURRENT (buggy) per-chunk scrubber — used
 *  ONLY to compute the expected-Rust "atomic model" for approved-deviation
 *  vectors. Production behavior stays the oracle; this file never runs it. */
export function thinkScrubAtomicModel(fullText: string): string {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  const parts: string[] = [];
  let i = 0;
  while (i < fullText.length) {
    const open = fullText.indexOf(OPEN, i);
    if (open === -1) { parts.push(fullText.slice(i)); break; }
    parts.push(fullText.slice(i, open));
    const close = fullText.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) break; // unterminated — drop from open onwards (intended semantic)
    i = close + CLOSE.length;
  }
  return parts.join("");
}
