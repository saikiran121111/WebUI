import { NextRequest, NextResponse } from "next/server";
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
): Response {
  const scrubber = new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      controller.enqueue(new TextEncoder().encode(scrubThinkTags(text)));
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
): Promise<Response> {
  try {
    const upstream = await fetch(LLM_URL, { method: "POST", headers: upstreamHeaders(), body });
    if (!upstream.ok) return upstreamErrorResponse(upstream.status, await upstream.text().catch(() => ""));
    if (!upstream.body) return NextResponse.json({ error: "No response body from model" }, { status: 502 });
    return streamUpstream(upstream, usedSkill, decisionMode);
  } catch {
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
      console.error("[api/chat] slash skill routing failed:", err instanceof Error ? err.message : err);
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
      if (!passthrough && env.stripped_prompt.trim() && env.stripped_prompt !== fullText) {
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
          console.error("[api/chat] decision skill load failed:", err instanceof Error ? err.message : err);
        }
      }

      console.log(
        `[api/chat] decision: mode=${env.active_mode} conf=${env.confidence} by=${env.decided_by} ` +
          `skill=${usedSkill ?? env.skill_to_load ?? "none"} slash=${usedSkill ?? "-"}`,
      );
    }
  }

  return forwardStream(payload ? JSON.stringify(payload) : raw, usedSkill, decisionMode);
}
