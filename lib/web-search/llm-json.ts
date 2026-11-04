/**
 * Shared ONE-SHOT JSON completion helper for the main model (:8080).
 *
 * Any background call (search gate, claim audit, …) needs the same two
 * things, learned the hard way against this exact backend:
 *   1. thinking must be forced OFF, or a thinking model spends the whole
 *      output budget inside `reasoning_content` and `message.content` comes
 *      back null;
 *   2. a hard timeout, so a cold model load can never hold the single
 *      inference slot indefinitely (see lib/server/inference-busy.ts).
 *
 * `THINKING_OFF_BODY` lives here so the search gate and the claim audit send
 * byte-identical flags.
 */
import { childLogger } from "@/lib/server/logger";
import { llmApiUrl, llmApiKey } from "@/lib/server/settings";
import {
  registerTitleCall,
  unregisterTitleCall,
} from "@/lib/server/inference-busy";

const log = childLogger("web-search/llm-json");

/**
 * Live model endpoint — settings.json > env > fallback. Function form (not a
 * module-level const) so a settings.json change is picked up without a
 * Next.js server restart.
 */
export const MAIN_LLM_ENDPOINT = (): string => llmApiUrl();
export const LLM_API_KEY = (): string => llmApiKey();

export const THINKING_OFF_BODY = {
  reasoning_effort: "none",
  chat_template_kwargs: { enable_thinking: false },
} as const;

export interface JsonCompletionOptions {
  system: string;
  user: string;
  /** llama.cpp structured-output grammar. Strongly recommended: small models
   *  drift out of JSON otherwise. */
  jsonSchema?: unknown;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  endpoint?: string;
  /** Label for the log line ("search-gate", "claim-audit"). */
  label?: string;
  signal?: AbortSignal;
}

/** Strip code fences / prose around a JSON payload the model wrapped anyway. */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  // Strip thinking blocks (terminated or orphan-truncated) BEFORE brace
  // scanning — a thinking model's chain-of-thought can contain braces that
  // would otherwise poison the JSON window.
  const cleaned = text.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/gi, "");
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : cleaned;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * One non-streaming JSON call. Resolves to the parsed object, or null on ANY
 * failure (unreachable, non-200, timeout, unparseable) — a background call
 * must never be able to break the turn that shares the slot with it.
 *
 * The AbortController is registered with the inference-slot registry (the
 * same set the title jobs use) so a NEW user turn aborts this call instead of
 * queueing behind it: user traffic always owns the single local slot.
 */
export async function jsonCompletion<T = Record<string, unknown>>(
  o: JsonCompletionOptions,
): Promise<T | null> {
  const label = o.label ?? "json-call";
  const endpoint = o.endpoint ?? MAIN_LLM_ENDPOINT();
  const timeoutMs = o.timeoutMs ?? 30_000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (o.signal) {
    if (o.signal.aborted) ctrl.abort();
    else o.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  registerTitleCall(ctrl);

  const body: Record<string, unknown> = {
    model: "default",
    stream: false,
    temperature: o.temperature ?? 0,
    max_tokens: o.maxTokens ?? 400,
    ...THINKING_OFF_BODY,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ],
  };
  if (o.jsonSchema) {
    body.response_format = { type: "json_object", json_schema: o.jsonSchema };
    // Top-level json_schema is what llama.cpp's structured-output path reads.
    body.json_schema = o.jsonSchema;
  }

  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LLM_API_KEY(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.warn({ label, status: res.status }, "json call non-200");
      return null;
    }
    const data: any = await res.json().catch(() => null);
    const msg = data?.choices?.[0]?.message ?? {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const raw = extractJsonObject(content) ?? extractJsonObject(reasoning);
    if (!raw) {
      log.warn({ label, ms: Date.now() - started }, "json call returned no JSON object");
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as T;
      log.info({ label, ms: Date.now() - started }, "json call complete");
      return parsed;
    } catch {
      log.warn({ label, ms: Date.now() - started }, "json call returned unparseable JSON");
      return null;
    }
  } catch (err: unknown) {
    const name = (err as Error)?.name;
    log.warn(
      { label, ms: Date.now() - started, err: name === "AbortError" ? `timeout/abort (${timeoutMs}ms)` : (err as Error).message },
      "json call failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
    unregisterTitleCall(ctrl);
  }
}
