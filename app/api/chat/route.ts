import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "../../../lib/server/logger";
import {
  applySlashSkillRouting,
  extractUserText,
  injectSystemBefore,
  lastUserIndex,
} from "../../../lib/skills/lazy";
import { getDecision } from "../../../lib/decision/client";
import { beginUserTurn, endUserTurn } from "../../../lib/server/inference-busy";
import { buildDecisionSkillBlock } from "../../../lib/decision/skill-loader";
import { buildAttachmentTurn, stripAttachmentRefs } from "../../../lib/server/attachindex/turn";
import {
  MODE_FENCE,
  MODE_SKILL,
  RENDERER_MODES,
  isRendererMode,
  type DecisionEnvelope,
  type RendererMode,
} from "../../../lib/decision/types";
import { runWebResearch, buildMainModelContext } from "../../../lib/web-search/pipeline";

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

/** Search-gate summary surfaced in the Research Trail card. */
interface ResearchMeta {
  depth: string;
  freshness: string;
  decidedBy?: string;
  queries: { query: string; intent: string }[];
}

function streamHeaders(
  contentType: string | null,
  usedSkill: string | null,
  decisionMode: RendererMode,
  webCitations?: Record<string, any> | null,
  researchLfm?: ResearchMeta | null,
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
  // Web-research citations: the [S1]…[Sn] marker map the UI uses to turn
  // inline citations into clickable pills + the Research Trail card.
  if (webCitations && Object.keys(webCitations).length > 0) {
    headers["X-Web-Citations"] = encodeURIComponent(JSON.stringify(webCitations));
  }
  // Search-gate summary: shown collapsed in the Research Trail card.
  if (researchLfm) {
    headers["X-Research-Lfm"] = encodeURIComponent(JSON.stringify(researchLfm));
  }
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
  onSettled: () => void,
  webCitations?: Record<string, any> | null,
  researchLfm?: ResearchMeta | null,
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
  // pipeTo (not pipeThrough) so the busy-slot release fires on EVERY path:
  // normal completion, upstream error, and client disconnect (the pipe
  // rejects when the Response cancels the readable side).
  upstream
    .body!.pipeTo(scrubber.writable)
    .catch(() => {})
    .finally(onSettled);
  return new Response(scrubber.readable, {
    status: 200,
    headers: streamHeaders(
      upstream.headers.get("Content-Type"),
      usedSkill,
      decisionMode,
      webCitations,
      researchLfm,
    ),
  });
}

async function forwardStream(
  body: string,
  usedSkill: string | null,
  decisionMode: RendererMode,
  signal?: AbortSignal,
  model = "default",
  webCitations?: Record<string, any> | null,
  researchLfm?: ResearchMeta | null,
): Promise<Response> {
  // Claim the shared inference slot for the user's turn: this aborts any
  // in-flight background title call (user traffic always wins) and blocks
  // new title jobs until this stream settles. Released exactly once, when
  // the stream completes, errors, or the client disconnects.
  beginUserTurn();
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    endUserTurn();
  };
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
      release();
      return upstreamErrorResponse(upstream.status, errText);
    }
    if (!upstream.body) {
      log.error({ model }, "llm upstream returned no body");
      release();
      return NextResponse.json({ error: "No response body from model" }, { status: 502 });
    }
    return streamUpstream(
      upstream,
      usedSkill,
      decisionMode,
      model,
      release,
      webCitations,
      researchLfm,
    );
  } catch (err) {
    // AbortError is the browser walking away mid-stream — expected, not a fault.
    if ((err as Error)?.name === "AbortError") {
      log.warn({ model }, "llm stream aborted by client");
    } else {
      log.error({ model, err: (err as Error).message }, "llm server unreachable");
    }
    release();
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
    lfm_latency_ms: 0,
  };
}

function historyBefore(messages: any[], lastUserIdx: number): { role: string; content: string }[] {
  const history: { role: string; content: string }[] = [];
  for (let i = 0; i < lastUserIdx; i++) {
    const role = messages[i]?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = extractUserText(messages[i]?.content);
    // The LFM router only needs the gist of prior turns — attachment
    // spine/preview blocks can be long, so each entry is capped.
    if (content.trim()) history.push({ role, content: content.slice(0, 500) });
  }
  return history;
}

/**
 * The user's actual question: the FIRST text part. messageContent() puts the
 * typed text first and attachment parts after, so the 1.2B router never sees
 * an attachment's spine/preview block (which would pollute classification).
 */
function firstTextPart(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) return part.text;
    }
  }
  return "";
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
 *  2. getDecision() classifies the turn into one RendererMode (LFM2.5-1.2B
 *     single-model router), strips conversational noise and names the ONE
 *     core skill + output contract to inject.
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

  const model = typeof payload?.model === "string" && payload.model ? payload.model : "default";
  let usedSkill: string | null = null;
  let decisionMode: RendererMode = "standard_chat";
  let webCitationMap: Record<string, any> | null = null;
  let researchLfmMeta: ResearchMeta | null = null;

  if (payload && Array.isArray(payload.messages) && payload.messages.length > 0) {
    // 1) user-tier slash skill (explicit intent, zero tokens otherwise)
    try {
      usedSkill = await applySlashSkillRouting(payload);
    } catch (err: unknown) {
      log.error({ err: err instanceof Error ? err.message : err }, "slash skill routing failed");
    }

    const lastUserIdx = lastUserIndex(payload.messages);
    if (lastUserIdx !== -1) {
      const fullText = firstTextPart(payload.messages[lastUserIdx]?.content);

      // 2) decision: repair passthrough (mode pinned by the client) or engine
      const passthrough = isRendererMode(payload.decision_mode) ? payload.decision_mode : null;
      delete payload.decision_mode;
      let env: DecisionEnvelope;
      // History is computed for BOTH branches: the web-search gate must
      // resolve follow-ups ("give me a direct link for it") even on turns
      // where the client pinned a decision_mode (passthrough) — a
      // mode-pinned turn is still a follow-up turn, and a gate that cannot
      // see the earlier entity says "no search" and invites a fabricated
      // link instead.
      const history = historyBefore(payload.messages, lastUserIdx);
      if (passthrough) {
        env = passthroughEnvelope(passthrough, fullText);
      } else {
        env = await getDecision(fullText.trim() ? fullText : "", history);
      }
      decisionMode = env.active_mode;

      // 3) The user's EXACT message reaches the main LLM. Since 2026-10-22
      // the in-process router (lib/decision/client.ts) never rewrites the
      // prompt — `env.stripped_prompt` is always the original message, and
      // only the skill-block injection (step 4) shapes what the model sees.
      // The repair-passthrough path (client pinned decision_mode) also keeps
      // the text verbatim, so no branch of this route touches the user turn.
      void env.stripped_prompt; // documented: always === fullText, never applied

      // 4) exactly ONE skill block for this turn (slash user skill wins)
      let skillBlockBytes = 0;
      if (!usedSkill) {
        try {
          const block = await buildDecisionSkillBlock(env);
          if (block) {
            injectSystemBefore(payload.messages, lastUserIdx, block);
            skillBlockBytes = block.length;
          }
        } catch (err: unknown) {
          log.error({ err: err instanceof Error ? err.message : err }, "decision skill load failed");
        }
      }

      // 5) attachment knowledge retrieval (ephemeral): timestamped passages
      // for THIS question are injected into this turn's payload copy only —
      // the client's stored conversation never sees them, so retrieved
      // evidence never duplicates across historical turns. The user turn now
      // sits at lastUserIdx + 1 (the skill block above shifted it).
      try {
        const injected = await buildAttachmentTurn(payload.messages, lastUserIdx + 1, fullText, req.signal);
        if (injected) log.info({ blocks: injected }, "attachment evidence injected (this turn only)");
      } catch (err: unknown) {
        log.error({ err: err instanceof Error ? err.message : err }, "attachment retrieval failed");
      }

      // 6) Web-search gate (main model only): the main model decides whether
      //    this turn needs live web data and writes the queries. No LFM
      //    router, no verification adjudication of the decision — if it
      //    doesn't need the internet, the turn is pure chat with zero
      //    pipeline latency. beginUserTurn() is called here so background
      //    title jobs yield the local LLM slot to the gate immediately.
      let researchBundle: Awaited<ReturnType<typeof runWebResearch>> = null;
      let inferenceTurnActive = false;
      const webResearchDisabled = process.env.WEB_SEARCH_LFM_DISABLED === "1";
      try {
        if (webResearchDisabled) {
          log.info({ prompt: fullText.slice(0, 60) }, "web-research pipeline disabled (WEB_SEARCH_LFM_DISABLED)");
        } else {
        beginUserTurn();
        inferenceTurnActive = true;
        researchBundle = await runWebResearch(
          { userPrompt: fullText, history },
          (p) => {
            log.info({ stage: p.stage, detail: p.detail }, "web-research progress");
          },
          req.signal,
        );
        if (researchBundle) {
          const { systemBlock } = buildMainModelContext(researchBundle);
          injectSystemBefore(
            payload.messages,
            lastUserIdx + 1,
            systemBlock,
          );
          // Build the [S#] → {url, title, domain} map the browser UI uses
          // to turn inline citation markers into clickable pills. Every
          // retrieved source is included so an [S#] marker can never dangle.
          webCitationMap = {};
          for (const packet of researchBundle.packets) {
            webCitationMap[packet.sourceId] = {
              sourceId: packet.sourceId,
              url: packet.url,
              title: packet.title,
              domain: packet.domain,
              publishedAt: packet.publishedAt,
            };
          }
          // No post-stream claim audit since 2026-10-22: the answer carries
          // [S#] citations and the model's own honest wording, which is the
          // whole verification story now.
          researchLfmMeta = {
            depth: researchBundle.lfm.decision.depth,
            freshness: researchBundle.lfm.decision.freshness,
            decidedBy: researchBundle.lfm.source,
            queries: researchBundle.lfm.decision.queries.map((q) => ({
              query: q.query,
              intent: q.intent,
            })),
          };
          log.info(
            {
              passages: researchBundle.topPassages.length,
              results: researchBundle.searchResults.length,
              gateSource: researchBundle.lfm.source,
              fromCache: researchBundle.fromCache,
              citations: Object.keys(webCitationMap).length,
              gapSearch: researchBundle.gapSearchFired,
            },
            "web research evidence injected",
          );
        }
        } // end if (!webResearchDisabled)
      } catch (err: unknown) {
        // A failed research run must not kill the chat turn: the main model
        // still answers from its own knowledge.
        log.error(
          { err: err instanceof Error ? err.message : err },
          "web research pipeline failed — proceeding without web evidence",
        );
      } finally {
        if (inferenceTurnActive) endUserTurn();
      }

      // One-line routing log: mode + deciding source + skill actually injected.
      log.info(
        { mode: env.active_mode, by: env.decided_by, skill: usedSkill, skillBytes: skillBlockBytes, model },
        "turn decision",
      );
    }
  }

  // attachment_ref is an internal routing hint for this process; the
  // upstream chat template only accepts text/image_url parts, so every ref
  // must be gone before the payload leaves (indexed turn or not).
  if (payload && Array.isArray(payload.messages)) stripAttachmentRefs(payload.messages);

  return forwardStream(
    payload ? JSON.stringify(payload) : raw,
    usedSkill,
    decisionMode,
    req.signal,
    model,
    webCitationMap,
    (webCitationMap ? researchLfmMeta : null),
  );
}
