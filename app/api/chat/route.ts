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
import { gateDisabledByEnv } from "../../../lib/web-search/search-gate";
import { llmApiUrl, llmApiKey } from "../../../lib/server/settings";
import type { StageEvent } from "../../../lib/types";

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
    Authorization: "Bearer " + llmApiKey(),
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
  searchGate?: ResearchMeta | null,
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
  if (searchGate) {
    headers["X-Search-Gate"] = encodeURIComponent(JSON.stringify(searchGate));
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
  searchGate?: ResearchMeta | null,
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
      searchGate,
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
  searchGate?: ResearchMeta | null,
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
    log.info({ model, mode: decisionMode, url: llmApiUrl() }, "llm stream start");
    const upstream = await fetch(llmApiUrl(), { method: "POST", headers: upstreamHeaders(), body, signal });
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
      searchGate,
    );
  } catch (err) {
    // AbortError is the browser walking away mid-stream — expected, not a fault.
    if ((err as Error)?.name === "AbortError") {
      log.warn({ model }, "llm stream aborted by client");
    } else {
      log.error({ model, err: (err as Error).message }, "llm server unreachable");
    }
    release();
    const host = (() => { try { return new URL(llmApiUrl()).host; } catch { return "the configured port"; } })();
    return NextResponse.json(
      { error: `Could not reach the model server at ${host}.` },
      { status: 503 },
    );
  }
}

/**
 * Live progress channel bound to an already-opened SSE response. The route
 * emits `ruke_stage` frames for every REAL pre-model phase (routing, skill
 * load, attachment retrieval, web-research gate stages) so the browser's
 * progress panel (components/ProgressChip.tsx) reports real activity instead
 * of a dead spinner while the pipeline runs. Carries only measured counts —
 * never estimated ones.
 */
interface ProgressChannel {
  stage(e: StageEvent): void;
  /** Replace the rest of the stream with an honest error frame + [DONE]. */
  fail(message: string): void;
  /** Forward raw upstream bytes (already scrubbed). */
  raw(bytes: Uint8Array): void;
  close(): void;
}

/**
 * The progress-stream twin of forwardStream: headers are already committed,
 * so upstream failures travel as a `ruke_error` SSE frame (the parser maps it
 * to finishReason "error" — the same UI surface a non-200 produced before).
 * Busy-slot and req.signal semantics are identical to forwardStream.
 */
async function forwardStreamInto(
  body: string,
  decisionMode: RendererMode,
  signal: AbortSignal | undefined,
  model: string,
  ch: ProgressChannel,
): Promise<void> {
  beginUserTurn();
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    endUserTurn();
  };
  const started = Date.now();
  let chunks = 0;
  try {
    log.info({ model, mode: decisionMode, url: llmApiUrl() }, "llm stream start");
    const upstream = await fetch(llmApiUrl(), { method: "POST", headers: upstreamHeaders(), body, signal });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      log.error({ model, status: upstream.status }, `llm upstream error: ${errText.slice(0, 200)}`);
      ch.fail("Upstream returned " + upstream.status + (errText ? ": " + errText.slice(0, 200) : ""));
      return;
    }
    if (!upstream.body) {
      log.error({ model }, "llm upstream returned no body");
      ch.fail("No response body from model");
      return;
    }
    // Same per-chunk think-tag scrubber as streamUpstream.
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks++;
      ch.raw(new TextEncoder().encode(scrubThinkTags(new TextDecoder().decode(value))));
    }
    log.info(
      { model, mode: decisionMode, ms: Date.now() - started, sseChunks: chunks },
      "llm stream complete",
    );
    ch.close();
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      log.warn({ model }, "llm stream aborted by client");
      ch.close();
    } else {
      const host = (() => { try { return new URL(llmApiUrl()).host; } catch { return "the configured port"; } })();
      log.error({ model, err: (err as Error).message }, "llm server unreachable");
      ch.fail(`Could not reach the model server at ${host}.`);
    }
  } finally {
    release();
  }
}

/**
 * Image data URLs carried by the last user turn. These feed the Vision-to-
 * Search entity pre-pass (lib/web-search/vision-prepass.ts) when the gate
 * decides to search, and flip SearchGateContext.hasImageAttachment so the
 * Stage 0 image+lookup-intent bypass can fire.
 */
function turnImageParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const u = part?.type === "image_url" ? part?.image_url?.url : null;
    if (typeof u === "string" && u.startsWith("data:")) out.push(u);
  }
  return out;
}

/** Does this turn carry an internal attachment_ref (indexed-document turn)? */
function turnHasAttachmentRef(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part: any) => part?.type === "attachment_ref")
  );
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
    // The per-turn decision pass only needs the gist of prior turns — attachment
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
/**
 * Pre-model turn phases (skill block → attachment evidence → web-search gate)
 * shared by BOTH response shapes: the legacy request/response turn and the
 * progress-stream turn. `stage` receives every real phase event on the
 * progress path and is a no-op otherwise, so the two paths can never drift
 * apart in what they actually run. Returns the web metadata the caller ships
 * via headers (legacy) or a `web_meta` stage frame (progress path).
 */
async function runTurnPipeline(
  payload: any,
  opts: {
    lastUserIdx: number;
    fullText: string;
    env: DecisionEnvelope;
    history: { role: string; content: string }[];
    usedSkill: string | null;
    signal: AbortSignal;
    stage: (e: StageEvent) => void;
    hasAttachmentRefs: boolean;
    model: string;
  },
): Promise<{ webCitationMap: Record<string, any> | null; searchGateMeta: ResearchMeta | null }> {
  const { lastUserIdx, fullText, env, history, usedSkill, signal, stage, hasAttachmentRefs, model } = opts;

  // 4) exactly ONE skill block for this turn (slash user skill wins)
  let skillBlockBytes = 0;
  const skillStarted = Date.now();
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
  if (usedSkill || skillBlockBytes > 0) {
    // Core-tier skill names never travel to the browser (invisibility rule):
    // the slash name is already header-visible, the core block reports
    // namelessly with its real load time.
    stage({ stage: "skill", detail: usedSkill ?? undefined, ms: Date.now() - skillStarted });
  }

  // 5) attachment knowledge retrieval (ephemeral): timestamped passages
  // for THIS question are injected into this turn's payload copy only — the
  // client's stored conversation never sees them, so retrieved evidence never
  // duplicates across historical turns. The user turn now sits at
  // lastUserIdx + 1 (the skill block above shifted it).
  try {
    if (hasAttachmentRefs) stage({ stage: "retrieval" });
    const injected = await buildAttachmentTurn(payload.messages, lastUserIdx + 1, fullText, signal);
    if (injected) log.info({ blocks: injected }, "attachment evidence injected (this turn only)");
    if (hasAttachmentRefs) {
      stage({ stage: "retrieval_done", done: injected ?? 0, total: injected ?? 0 });
    }
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : err }, "attachment retrieval failed");
    if (hasAttachmentRefs) stage({ stage: "retrieval_done", done: 0, total: 0 });
  }

  // 6) Web-search gate (main model only): the main model decides whether
  //    this turn needs live web data and writes the queries. No LFM
  //    router, no verification adjudication of the decision — if it
  //    doesn't need the internet, the turn is pure chat with zero
  //    pipeline latency. beginUserTurn() is called here so background
  //    title jobs yield the local LLM slot to the gate immediately.
  let researchBundle: Awaited<ReturnType<typeof runWebResearch>> = null;
  let inferenceTurnActive = false;
  let webCitationMap: Record<string, any> | null = null;
  let searchGateMeta: ResearchMeta | null = null;
  const webResearchDisabled = gateDisabledByEnv();
  try {
    if (webResearchDisabled) {
      log.info({ prompt: fullText.slice(0, 60) }, "web-research pipeline disabled (WEB_SEARCH_GATE_DISABLED)");
    } else {
    beginUserTurn();
    inferenceTurnActive = true;
    const imageParts = turnImageParts(payload.messages?.[lastUserIdx]?.content);
    researchBundle = await runWebResearch(
      {
        userPrompt: fullText,
        history,
        hasImageAttachment: imageParts.length > 0,
        imageDataUrls: imageParts,
      },
      (p) => {
        log.info({ stage: p.stage, detail: p.detail }, "web-research progress");
        // Live bridge: every real gate/pipeline boundary becomes a client-
        // visible phase event carrying the pipeline's own measured counts.
        stage({
          stage: "web:" + p.stage,
          detail: p.detail,
          total: p.total,
          done: p.done,
          coverage: p.coverage,
          url: p.url,
          domain: p.domain,
        });
      },
      signal,
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
      searchGateMeta = {
        depth: researchBundle.searchGate.decision.depth,
        freshness: researchBundle.searchGate.decision.freshness,
        decidedBy: researchBundle.searchGate.source,
        queries: researchBundle.searchGate.decision.queries.map((q) => ({
          query: q.query,
          intent: q.intent,
        })),
      };
      log.info(
        {
          passages: researchBundle.topPassages.length,
          results: researchBundle.searchResults.length,
          gateSource: researchBundle.searchGate.source,
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

  return { webCitationMap, searchGateMeta };
}

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
  let searchGateMeta: ResearchMeta | null = null;

  // Compaction's own call (lib/chat/compact.ts): forward it VERBATIM.
  // Running the per-turn pipeline over it is actively destructive: the decision
  // pass classifies the STALE last user message inside the history being
  // folded, and a non-chat mode injects a renderer skill contract mid-
  // payload — which collides with the "Context Compaction Engine" system
  // prompt and the model never emits <compacted_context>. The web-research
  // gate then burns minutes of the compaction timeout researching that stale
  // prompt. The compaction system prompt IS the whole contract; the history
  // must reach the model untouched. (No progress frames either: the
  // compaction client parses content deltas only.)
  if (payload?.purpose === "compact") {
    delete payload.purpose; // transport marker: never reaches the upstream
    if (Array.isArray(payload.messages)) stripAttachmentRefs(payload.messages);
    log.info({ model }, "compaction passthrough: skipping decision pipeline");
    return forwardStream(JSON.stringify(payload), null, "standard_chat", req.signal, model);
  }

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
      const decisionStarted = Date.now();
      if (passthrough) {
        env = passthroughEnvelope(passthrough, fullText);
      } else {
        env = await getDecision(fullText.trim() ? fullText : "", history);
      }
      const decisionMs = Date.now() - decisionStarted;
      decisionMode = env.active_mode;

      // 3) The user's EXACT message reaches the main LLM. Since 2026-10-22
      // the in-process router (lib/decision/client.ts) never rewrites the
      // prompt — `env.stripped_prompt` is always the original message, and
      // only the skill-block injection (step 4) shapes what the model sees.
      // The repair-passthrough path (client pinned decision_mode) also keeps
      // the text verbatim, so no branch of this route touches the user turn.
      void env.stripped_prompt; // documented: always === fullText, never applied

      // Non-streaming consumers (e.g. the conversation-title warm-up probe)
      // keep the legacy request/response contract byte-for-byte: real status
      // codes, content type, no progress frames. Streaming turns get an
      // EARLY-OPEN response so the WebUI can show, live, what the server is
      // actually doing before the model's first byte ever arrives.
      if (payload.stream !== false) {
        const hasAttachmentRefs = turnHasAttachmentRef(payload.messages[lastUserIdx]?.content);

        // One combined signal for the whole turn: the browser walking away
        // (stream cancel) or the request aborting kills the gate fetch AND
        // the upstream generation — the same zombie-turn protection
        // forwardStream documents for the legacy path.
        const inner = new AbortController();
        if (req.signal.aborted) inner.abort();
        else req.signal.addEventListener("abort", () => inner.abort(), { once: true });

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            let closed = false;
            const frame = (obj: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
              } catch {
                closed = true; // the client is gone: stop writing
              }
            };
            const ch: ProgressChannel = {
              stage: (e) => frame({ ruke_stage: e }),
              fail: (m) => {
                frame({ ruke_error: { message: m } });
                if (!closed) {
                  closed = true;
                  try {
                    controller.enqueue(enc.encode("data: [DONE]\n\n"));
                    controller.close();
                  } catch {}
                }
              },
              raw: (bytes) => {
                if (closed) return;
                try {
                  controller.enqueue(bytes);
                } catch {
                  closed = true;
                }
              },
              close: () => {
                if (closed) return;
                closed = true;
                try { controller.close(); } catch {}
              },
            };

            try {
              // First frame: the routing wait the client has been measuring
              // since send() — reported with its REAL elapsed ms.
              ch.stage({ stage: "decision_done", mode: env.active_mode, ms: decisionMs });

              const meta = await runTurnPipeline(payload, {
                lastUserIdx,
                fullText,
                env,
                history,
                usedSkill,
                signal: inner.signal,
                stage: ch.stage,
                hasAttachmentRefs,
                model,
              });
              if (meta.webCitationMap && Object.keys(meta.webCitationMap).length > 0) {
                // Web metadata rides the stream now: response headers are
                // written before start(), when the gate has not run yet.
                ch.stage({
                  stage: "web_meta",
                  webCitations: meta.webCitationMap as StageEvent["webCitations"],
                  searchGate: meta.searchGateMeta ?? undefined,
                });
              }

              stripAttachmentRefs(payload.messages);
              await forwardStreamInto(
                JSON.stringify(payload),
                decisionMode,
                inner.signal,
                model,
                ch,
              );
            } catch (err: unknown) {
              log.error(
                { err: err instanceof Error ? err.message : err },
                "progress stream failed",
              );
              ch.fail(
                err instanceof Error && err.message ? err.message : "Generation failed",
              );
            }
          },
          cancel() {
            // The browser walked away: the gate and the upstream generation
            // must die with the response (no zombie turns on the shared slot).
            inner.abort();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: streamHeaders("text/event-stream", usedSkill, decisionMode),
        });
      }

      const meta = await runTurnPipeline(payload, {
        lastUserIdx,
        fullText,
        env,
        history,
        usedSkill,
        signal: req.signal,
        stage: () => {},
        hasAttachmentRefs: turnHasAttachmentRef(payload.messages[lastUserIdx]?.content),
        model,
      });
      webCitationMap = meta.webCitationMap;
      searchGateMeta = meta.searchGateMeta;
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
    (webCitationMap ? searchGateMeta : null),
  );
}
