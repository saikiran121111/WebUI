/**
 * Web-tool session RPC — the TypeScript owner of the web_search/read_page
 * tool loop state (rollback 2026-11-03).
 *
 * When the Rust backend runs a chat turn that needs web tools, the model
 * rounds and SSE framing stay in Rust (generic transport), but the
 * search-specific state — session budgets, tool definitions, guidance text,
 * admission law and execution — lives here, on top of the already-tested
 * lib/web-search/tools.ts primitives. Rust drives this endpoint through
 * create / exec / discover / close actions.
 *
 * Envelope strings that the model sees (invalid_arguments, unknown_tool)
 * are byte-identical to the retired Rust web_loop inline envelopes so the
 * model-facing grammar does not drift.
 */
import {
  makeWebToolSession,
  execWebSearchTool,
  execReadPageTool,
  webToolDefinitions,
  remainingBudget,
  WEB_TOOL_MAX_ROUNDS_CAP,
  type WebToolSession,
  type WebToolDepth,
  type CitationSeed,
} from "@/lib/web-search/tools";
import {
  WEB_TOOL_GUIDANCE,
  WEB_TOOL_FINAL_DIRECTIVE,
} from "@/lib/chat/web-tool-loop";
import { gateDisabledByEnv } from "@/lib/web-search/search-gate";
import type { TaskScope } from "@/lib/decision/task-scope";
import { childLogger } from "@/lib/server/logger";

const log = childLogger("web-tools-rpc");

export interface RpcResult {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Module-level session store. Sessions are per chat-turn and Rust closes
 * them explicitly; the TTL sweep only reaps orphans after a crash.
 * shortcut: single-process in-memory store; upgrade if Next ever runs
 * multi-instance behind the bridge.
 */
interface StoredSession {
  session: WebToolSession;
  lastTouched: number;
}
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, StoredSession>();

function sweep(now: number) {
  for (const [id, entry] of sessions) {
    if (now - entry.lastTouched > SESSION_TTL_MS) sessions.delete(id);
  }
}

function validScope(v: unknown): v is TaskScope {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as TaskScope).intent === "string" &&
    Array.isArray((v as TaskScope).targets)
  );
}

export async function handleWebToolsRpc(
  body: any,
  signal?: AbortSignal,
): Promise<RpcResult> {
  const now = Date.now();
  sweep(now);
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "create") {
    const depth = body.depth;
    if (depth !== "quick" && depth !== "standard" && depth !== "deep") {
      return { status: 400, json: { error: "depth must be quick|standard|deep" } };
    }
    const seed =
      typeof body.citationSeed === "number" && body.citationSeed >= 1
        ? Math.floor(body.citationSeed)
        : 1;
    const question = typeof body.question === "string" ? body.question : "";
    const scope = validScope(body.scope) ? body.scope : null;
    const session = makeWebToolSession(depth as WebToolDepth, seed, question, scope);
    sessions.set(session.searchSessionId, { session, lastTouched: now });
    return {
      status: 200,
      json: {
        sessionId: session.searchSessionId,
        budget: session.budget,
        remainingBudget: remainingBudget(session),
        tools: webToolDefinitions(),
        guidance: WEB_TOOL_GUIDANCE,
        finalDirective: WEB_TOOL_FINAL_DIRECTIVE,
        maxRoundsCap: WEB_TOOL_MAX_ROUNDS_CAP,
      },
    };
  }

  if (action === "exec") {
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    const entry = sessions.get(id);
    const tool = typeof body.tool === "string" ? body.tool : "";
    if (!entry) {
      // Honest degradation: the loop grammar keeps going, the model is told.
      return {
        status: 200,
        json: {
          envelope: {
            ok: false,
            tool,
            error: "session_expired",
            detail:
              "the web tool service restarted or the session timed out; start a fresh search if still needed",
          },
          citations: [],
        },
      };
    }
    const session = entry.session;
    entry.lastTouched = now;
    // Rust counts model rounds (it owns the loop); mirror the higher count
    // so remainingBudget.rounds stays honest across the wire.
    if (typeof body.roundsUsed === "number") {
      session.roundsUsed = Math.max(
        session.roundsUsed,
        Math.max(0, Math.round(body.roundsUsed)),
      );
    }

    const fresh: CitationSeed[] = [];
    let args: unknown;
    try {
      args = JSON.parse(typeof body.argsRaw === "string" ? body.argsRaw : "");
    } catch {
      args = undefined;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return {
        status: 200,
        json: {
          envelope: {
            ok: false,
            tool,
            error: "invalid_arguments",
            detail: "tool arguments are not a JSON object",
            remainingBudget: remainingBudget(session),
          },
          citations: [],
        },
      };
    }

    let envelope: Record<string, unknown>;
    if (tool === "web_search") {
      envelope = await execWebSearchTool(session, args as Record<string, unknown>, fresh);
    } else if (tool === "read_page") {
      envelope = await execReadPageTool(session, args as Record<string, unknown>, fresh);
    } else {
      envelope = {
        ok: false,
        tool,
        error: "unknown_tool",
        detail: "only web_search and read_page are available in this turn",
        remainingBudget: remainingBudget(session),
      };
    }
    return { status: 200, json: { envelope, citations: fresh } };
  }

  if (action === "discover") {
    // ⇔ browser_loop.rs::bounded_destination_discovery: resolve at most two
    // unresolved task-scope phrases against live SERPs (throwaway session —
    // packets/citations are DISCARDED; only the narrowed scope crosses back).
    const scope = validScope(body.scope) ? (body.scope as TaskScope) : null;
    if (!scope) return { status: 200, json: { scope: null } };
    if (gateDisabledByEnv()) return { status: 200, json: { scope } };
    const unresolved = scope.targets
      .filter(
        (t) =>
          t && t.state === "unresolved" && typeof t.phrase === "string" && t.phrase.trim() !== "",
      )
      .slice(0, 2);
    if (unresolved.length === 0) return { status: 200, json: { scope } };

    const question = typeof body.question === "string" ? body.question : "";
    const session = makeWebToolSession("quick", 1, question, scope);
    for (const t of unresolved) {
      if (signal?.aborted) break;
      await execWebSearchTool(
        session,
        {
          queries: [`"${t.phrase}"`],
          missing_claims: [`the official website for "${t.phrase}"`],
          reason: "resolve the task-scope destination before browser navigation",
        },
        [],
      );
    }
    // Admission law already ran inside execWebSearchTool (REAL SERP hosts
    // only — no fabrication). Rust consumes the narrowed scope verbatim.
    log.info(
      { phrases: unresolved.length, intent: session.scope?.intent ?? scope.intent },
      "destination discovery finished",
    );
    return { status: 200, json: { scope: session.scope ?? scope } };
  }

  if (action === "close") {
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    sessions.delete(id);
    return { status: 200, json: { ok: true } };
  }

  return { status: 400, json: { error: "unknown action" } };
}
