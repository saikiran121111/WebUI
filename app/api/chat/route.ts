import { NextRequest, NextResponse } from "next/server";
import { activateSkillFromToolCall, applySkillRouting } from "../../../lib/skills/lazy";
import { applyCoreSkillRouting } from "../../../lib/skills/coreRouter";
import { projectRoot } from "../../../lib/skills/registry";

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

function streamHeaders(contentType: string | null, usedSkill: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType ?? "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  // Skill metadata for the UI: the client reads this and shows the pill.
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
function streamUpstream(upstream: Response, usedSkill: string | null): Response {
  const scrubber = new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      controller.enqueue(new TextEncoder().encode(scrubThinkTags(text)));
    },
  });
  return new Response(upstream.body!.pipeThrough(scrubber), {
    status: 200,
    headers: streamHeaders(upstream.headers.get("Content-Type"), usedSkill),
  });
}

async function forwardStream(body: string, usedSkill: string | null): Promise<Response> {
  try {
    const upstream = await fetch(LLM_URL, { method: "POST", headers: upstreamHeaders(), body });
    if (!upstream.ok) return upstreamErrorResponse(upstream.status, await upstream.text().catch(() => ""));
    if (!upstream.body) return NextResponse.json({ error: "No response body from model" }, { status: 502 });
    return streamUpstream(upstream, usedSkill);
  } catch {
    return NextResponse.json(
      { error: "Could not reach the model server. Is it running on port 8080?" },
      { status: 503 },
    );
  }
}

/** Pull a load_skill(skill_name) call out of a buffered SSE round. */
function extractLoadSkillCall(sseText: string): string | null {
  const names = new Map<number, string>();
  const args = new Map<number, string>();
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: any;
    try { event = JSON.parse(data); } catch { continue; }
    for (const call of event?.choices?.[0]?.delta?.tool_calls ?? []) {
      const idx = typeof call.index === "number" ? call.index : 0;
      if (typeof call.function?.name === "string") names.set(idx, (names.get(idx) ?? "") + call.function.name);
      if (typeof call.function?.arguments === "string") args.set(idx, (args.get(idx) ?? "") + call.function.arguments);
    }
  }
  for (const [idx, name] of names) {
    if (name !== "load_skill") continue;
    try {
      const parsed = JSON.parse(args.get(idx) ?? "{}");
      if (typeof parsed.skill_name === "string" && parsed.skill_name) return parsed.skill_name;
    } catch {
      // Malformed arguments: treat as no tool call.
    }
  }
  return null;
}

/**
 * Proxies chat completions to the local LLM, streaming SSE byte-for-byte,
 * with the Universal Skill Engine's strict lazy loading applied first:
 *
 *  - "/<skill-name> ..."  -> strip the prefix, inject that skill's SKILL.md
 *    (+ linked .md files) as <active_skill> for this turn only.
 *  - autoUse skills        -> keyword pre-router injects the body directly on
 *    a strong match; otherwise a <skill_router> block (name + whenToUse only,
 *    never the body) plus a load_skill tool is offered. A tool call triggers
 *    a buffered round 1, then the skill body is injected for round 2. If the
 *    local model skips the tool call, round 1's SSE is replayed untouched.
 *  - everything else       -> forwarded byte-for-byte, zero skill tokens.
 *
 * The fired skill name travels back via the X-Used-Skill response header so
 * the chat UI can show the "Used skill" pill.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON: forward as-is (no routing possible).
  }

  let usedSkill: string | null = null;
  let toolLoopRequired = false;
  if (payload) {
    try {
      const routing = await applySkillRouting(payload);
      usedSkill = routing.usedSkill;
      toolLoopRequired = routing.toolLoopRequired;
    } catch (err: unknown) {
      console.error("[api/chat] skill routing failed:", err instanceof Error ? err.message : err);
    }
    // Core hidden tier: fires only through this router, never listed in the UI.
    try {
      const core = await applyCoreSkillRouting(payload);
      if (core.usedSkills.length > 0) {
        usedSkill = [usedSkill, ...core.usedSkills].filter(Boolean).join(",");
      }
    } catch (err: unknown) {
      console.error("[api/chat] core skill routing failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!toolLoopRequired) {
    return forwardStream(payload ? JSON.stringify(payload) : raw, usedSkill);
  }

  // ---- load_skill tool loop (round 1 is buffered, not streamed) ----------
  try {
    const round1 = await fetch(LLM_URL, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(payload),
    });
    if (!round1.ok) return upstreamErrorResponse(round1.status, await round1.text().catch(() => ""));

    const sseText = round1.body ? await new Response(round1.body).text() : "";
    const requestedSkill = extractLoadSkillCall(sseText);
    if (requestedSkill) {
      const activated = await activateSkillFromToolCall(payload, requestedSkill, projectRoot());
      if (activated) {
        usedSkill = activated;
        const round2 = await fetch(LLM_URL, {
          method: "POST",
          headers: upstreamHeaders(),
          body: JSON.stringify(payload),
        });
        if (round2.ok && round2.body) return streamUpstream(round2, usedSkill);
      }
    }

    // Model skipped the tool call (or round 2 failed): replay round 1 verbatim.
    return new Response(scrubThinkTags(sseText), { status: 200, headers: streamHeaders(null, usedSkill) });
  } catch {
    // Round 1 never reached the model: retry once without the tool contract.
    delete payload.tools;
    delete payload.tool_choice;
    return forwardStream(JSON.stringify(payload), null);
  }
}
