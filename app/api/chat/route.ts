import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "../../../lib/server/logger";
import {
  applySlashSkillRouting,
  extractUserText,
  injectSystemBefore,
  lastUserIndex,
} from "../../../lib/skills/lazy";
import { getDecision } from "../../../lib/decision/client";
import { buildDecisionSkillBlock } from "../../../lib/decision/skill-loader";
import {
  MODE_FENCE,
  MODE_SKILL,
  RENDERER_MODES,
  isRendererMode,
  type DecisionEnvelope,
  type RendererMode,
} from "../../../lib/decision/types";

const LLM_URL = process.env.LLM_API_URL ?? "http://127.0.0.1:8080/v1/chat/completions";
const API_KEY = process.env.LLM_API_KEY ?? "no-key";

const log = childLogger("api/chat");

const OPEN  = "<think>";
const CLOSE = "</think>";

function scrubThinkTags(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(OPEN, i);
    if (open === -1) { parts.push(text.slice(i)); break; }
    parts.push(text.slice(i, open));
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) break;  // unterminated — drop from open onwards
    i = close + CLOSE.length;
  }
  return parts.join("");
}

function upstreamHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + API_KEY,
    Accept: "text/event-stream",
  };
}

function streamHeaders(
  contentType: string | null,
  usedSkill: string | null,
  decisionMode: RendererMode,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType ?? "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    // The ONE mode the UI may render/validate for this turn. Core-tier skill
    // names never travel to the browser (invisibility rule); the mode does.
    "x-decision-mode": decisionMode,
  };
  // User-tier skill metadata for the UI: the client reads this and shows the pill.
  if (usedSkill) headers["X-Used-Skill"] = usedSkill;
  return headers;
}

function upstreamErrorResponse(status: number, errText: string): NextResponse {
  return NextResponse.json(
    { error: "Upstream returned " + status + (errText ? ": " + errText.slice(0, 200) : "") },
    { status },
  );
}

/** Stream the upstream SSE byte-for-byte through the think-tag scrubber. */
function streamUpstream(
  upstream: Response,
  usedSkill: string | null,
  decisionMode: RendererMode,
  model: string,
): Response {
  const started = Date.now();
  let chunks = 0;
  const scrubber = new TransformStream({
    transform(chunk, controller) {
      chunks++;
      const text = new TextDecoder().decode(chunk);
      controller.enqueue(new TextEncoder().encode(scrubThinkTags(text)));
    },
    flush() {
      // Main-model turn finished (or the pipe closed): one honest line per
      // generation with the real wall-clock the shared backend spent.
      log.info(
        { model, mode: decisionMode, ms: Date.now() - started, sseChunks: chunks },
        "llm stream complete",
      );
    },
  });
  return new Response(upstream.body!.pipeThrough(scrubber), {
    status: 200,
    headers: streamHeaders(upstream.headers.get("Content-Type"), usedSkill, decisionMode),
  });
}

async function forwardStream(
  body: string,
  usedSkill: string | null,
  decisionMode: RendererMode,
  signal?: AbortSignal,
  model = "default",
): Promise<Response> {
  try {
    // req.signal: when the browser walks away mid-stream (page close, Stop
    // generating, a test navigating on), the upstream generation MUST die
    // with it. Without it the local llama.cpp server keeps generating for
    // the abandoned request — a zombie turn that starves/pollutes every
    // following turn on the single inference slot (observed in three full
    // Playwright runs: an abandoned chart stream left the next real-model
    // test's two turns hanging with empty replies).
    log.info({ model, mode: decisionMode, url: LLM_URL }, "llm stream start");
    const upstream = await fetch(LLM_URL, { method: "POST", headers: upstreamHeaders(), body, signal });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      log.error({ model, status: upstream.status }, `llm upstream error: ${errText.slice(0, 200)}`);
      return upstreamErrorResponse(upstream.status, errText);
    }
    if (!upstream.body) {
      log.error({ model }, "llm upstream returned no body");
      return NextResponse.json({ error: "No response body from model" }, { status: 502 });
    }
    return streamUpstream(upstream, usedSkill, decisionMode, model);
  } catch (err) {
    // AbortError is the browser walking away mid-stream — expected, not a fault.
    if ((err as Error)?.name === "AbortError") {
      log.warn({ model }, "llm stream aborted by client");
    } else {
      log.error({ model, err: (err as Error).message }, "llm server unreachable");
    }
    return NextResponse.json(
      { error: "Could not reach the model server. Is it running on port 8080?" },
      { status: 503 },
    );
  }
}

/**
 * Fence-repair follow-ups already know their mode (it is pinned to the failed
 * deliverable): re-running the Decision Engine on an error message could
 * misroute it and stripping would destroy the exact error text. So the client
 * passes decision_mode through and we build a passthrough envelope instead.
 */
function passthroughEnvelope(mode: RendererMode, text: string): DecisionEnvelope {
  return {
    active_mode: mode,
    confidence: 1,
    decided_by: "repair-passthrough",
    stripped_prompt: text,
    skill_to_load: MODE_SKILL[mode],
    allowed_code_fence: MODE_FENCE[mode],
    disable_validators: RENDERER_MODES.filter((m) => m !== mode) as RendererMode[],
    enable_validator: mode,
    task_constraints: [],
    extracted_entities: [],
    needle_latency_ms: 0,
    lfm_latency_ms: 0,
  };
}

function historyBefore(messages: any[], lastUserIdx: number): { role: string; content: string }[] {
  const history: { role: string; content: string }[] = [];
  for (let i = 0; i < lastUserIdx; i++) {
    const role = messages[i]?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = extractUserText(messages[i]?.content);
    if (content.trim()) history.push({ role, content });
  }
  return history;
}

/** Swap the last user turn's text for the engine's stripped_prompt in place. */
function replaceLastUserText(messages: any[], index: number, text: string): void {
  const message = messages[index];
  if (!message) return;
  if (typeof message.content === "string") {
    message.content = text;
    return;
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part?.text === "string") { part.text = text; return; }
    }
    message.content.unshift({ type: "text", text });
  }
}

/**
 * Proxies chat completions to the local LLM, streaming SSE byte-for-byte.
 * The Hybrid Decision Engine runs BEFORE the main LLM on every turn:
 *
 *  1. Explicit "/<skill-name>" (user tier) strips the prefix and injects that
 *     skill's body — the only keyword-free user-tier trigger left.
 *  2. getDecision() classifies the turn into one RendererMode (Needle 3 prior
 *     -> LFM2.5 gate), strips conversational noise and names the ONE core
 *     skill + output contract to inject.
 *  3. The last user message is replaced by the stripped_prompt; exactly one
 *     skill block rides ahead of it.
 *  4. active_mode travels back via the x-decision-mode header; the UI renders
 *     and validates ONLY that mode's renderer — every other validator is
 *     disabled for this stream, no matter what the text contains.
 *
 * No keyword routers, no load_skill tool loop, no core-skill name in headers.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON: forward as-is (no decision possible).
  }

  let usedSkill: string | null = null;
  let decisionMode: RendererMode = "standard_chat";

  if (payload && Array.isArray(payload.messages) && payload.messages.length > 0) {
    // 1) user-tier slash skill (explicit intent, zero tokens otherwise)
    try {
      usedSkill = await applySlashSkillRouting(payload);
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : err }, "slash skill routing failed");
    }

    const lastUserIdx = lastUserIndex(payload.messages);
    if (lastUserIdx !== -1) {
      const fullText = extractUserText(payload.messages[lastUserIdx]?.content);

      // 2) decision: repair passthrough (mode pinned by the client) or engine
      const passthrough = isRendererMode(payload.decision_mode) ? payload.decision_mode : null;
      delete payload.decision_mode;
      let env: DecisionEnvelope;
      if (passthrough) {
        env = passthroughEnvelope(passthrough, fullText);
      } else {
        const history = historyBefore(payload.messages, lastUserIdx);
        env = await getDecision(fullText.trim() ? fullText : "", history);
      }
      decisionMode = env.active_mode;

      // 3) noise-stripped task reaches the main LLM. BEFORE the block insert —
      // injectSystemBefore shifts lastUserIdx, so replacing after it would
      // overwrite the skill block instead of the user turn.
      // Attachment turns forward the user's text VERBATIM: the inlined file
      // content rides in extra parts, and the LFM's 180-token summary of a
      // long [file content] block drops it while inventing constraint filler
      // ("financial/tabular words") — which derails the small main model on
      // read-the-file journeys (observed: YES -> NO). The decision still
      // selects the render mode; only the rewrite is skipped.
      const hasAttachmentParts = Array.isArray(payload.messages[lastUserIdx]?.content);
      if (!passthrough && !hasAttachmentParts && env.stripped_prompt.trim() && env.stripped_prompt !== fullText) {
        // task_constraints must never be dropped: append any constraint the
        // model listed that isn't already present verbatim in the stripped text.
        const constraints = (env.task_constraints ?? []).filter(
          (c) => c.trim() && !env.stripped_prompt.toLowerCase().includes(c.trim().toLowerCase()),
        );
        const forwarded = constraints.length
          ? `${env.stripped_prompt}\n\nRequired Specs: ${constraints.join("; ")}`
          : env.stripped_prompt;
        replaceLastUserText(payload.messages, lastUserIdx, forwarded);
      }

      // 4) exactly ONE skill block for this turn (slash user skill wins)
      if (!usedSkill) {
        try {
          const block = await buildDecisionSkillBlock(env);
          if (block) injectSystemBefore(payload.messages, lastUserIdx, block);
        } catch (err: unknown) {
          log.error({ err: err instanceof Error ? err.message : err }, "decision skill load failed");
        }
      }

      // What the two decision models actually did this turn:
      //   Needle 3  — fast prior (always runs, stage 1)
      //   LFM2.5    — deep gate + noise-strip (stage 2; decided_by shows whether
      //               it decided, failed, or a guard/multi-turn override moved it)
      log.info(
        {
          needleMs: env.needle_latency_ms,
          lfmMs: env.lfm_latency_ms,
          mode: env.active_mode,
          conf: env.confidence,
          by: env.decided_by,
          skill: usedSkill ?? env.skill_to_load ?? null,
          stripped: env.stripped_prompt.slice(0, 140),
          constraints: env.task_constraints.length ? env.task_constraints : undefined,
        },
        "decision: needle3 prior → lfm2.5 gate",
      );
    }
  }

  const model = typeof payload?.model === "string" && payload.model ? payload.model : "default";
  return forwardStream(payload ? JSON.stringify(payload) : raw, usedSkill, decisionMode, req.signal, model);
}
