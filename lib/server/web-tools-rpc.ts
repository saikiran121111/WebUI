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
  seedSessionSourceAliases,
  execWebSearchTool,
  execReadPageTool,
  webToolDefinitions,
  remainingBudget,
  recordAction,
  summarizeActionLedger,
  WEB_TOOL_MAX_ROUNDS_CAP,
  type WebToolConversation,
  type WebToolSession,
  type WebToolDepth,
  type CitationSeed,
} from "@/lib/web-search/tools";
import {
  WEB_TOOL_GUIDANCE,
  WEB_TOOL_FINAL_DIRECTIVE,
} from "@/lib/chat/web-tool-loop";
import { gateDisabledByEnv } from "@/lib/web-search/search-gate";
import { retrievalModeForFreshness } from "@/lib/web-search/types";
import type { TaskScope } from "@/lib/decision/task-scope";
import {
  readResearchJournal,
  selectPriorEvidence,
  buildPriorEvidenceBlock,
} from "@/lib/persistence/research-journal";
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
// Pinned to globalThis (2026-11-04 audit fix): Next dev hot-reload
// re-evaluates this module on any file edit, which used to wipe the Map
// MID-TURN and surface a false "session_expired" envelope to the model —
// the live-turn session_expired was reload amnesia, not the 30-min TTL.
const g = globalThis as unknown as { __webuiWebToolsSessions?: Map<string, StoredSession> };
const sessions: Map<string, StoredSession> =
  (g.__webuiWebToolsSessions ??= new Map<string, StoredSession>());

function sweep(now: number) {
  for (const [id, entry] of sessions) {
    if (now - entry.lastTouched > SESSION_TTL_MS) sessions.delete(id);
  }
}

// (audit 2026-11-04) DTO hardening: the old check accepted ANY object with
// a string `intent` and ANY array `targets` — [null] or targets whose host
// was a number sailed through and crashed (or corrupted) the scope
// enforcement layer downstream. Validate against the actual TaskScope
// contract in lib/decision/task-scope.ts; anything malformed degrades to
// "no scope" (the honest miss), never to a half-trusted scope.
const SCOPE_INTENTS = new Set(["none", "research", "site_info", "operate", "compare_sites"]);
const TARGET_STATES = new Set(["unresolved", "resolved", "ambiguous"]);
const TARGET_PROVENANCE = new Set([
  "none", "explicit_url", "explicit_domain", "resolved_search", "resolved_cache", "ambiguous",
]);
function stringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function validScope(v: unknown): v is TaskScope {
  if (!v || typeof v !== "object") return false;
  const s = v as TaskScope;
  if (!SCOPE_INTENTS.has(s.intent)) return false;
  if (!Array.isArray(s.targets)) return false;
  for (const t of s.targets) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.phrase !== "string") return false;
    if (!TARGET_STATES.has(t.state)) return false;
    if (typeof t.host !== "string" || typeof t.url !== "string") return false;
    if (!stringArray(t.candidates)) return false;
    if (!TARGET_PROVENANCE.has(t.provenance)) return false;
  }
  return stringArray(s.excludedPhrases) && stringArray(s.authorizedHosts);
}

// Conversation DTO gate (same fail-closed law as validScope): a malformed
// conversation degrades to "no journaling", never to a half-trusted id.
function validConversation(v: unknown): WebToolConversation | null {
  if (!v || typeof v !== "object") return null;
  const c = v as { id?: unknown; currentDate?: unknown };
  if (typeof c.id !== "string" || c.id.trim() === "") return null;
  return {
    id: c.id.trim().slice(0, 200),
    currentDate: typeof c.currentDate === "string" ? c.currentDate.slice(0, 32) : "",
  };
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
    // §9 (audit 2026-11-04): the gate's freshness rides the bridge (⇔ Rust
    // web_loop.rs create payload) so the session honors the live_required
    // page-cache law on read_page. Freshness→retrieval-mode stays a TS law
    // (no Rust mirror); anything unrecognized maps to cached_preferred.
    const freshness = typeof body.freshness === "string" ? body.freshness : "any";
    const liveRequired = retrievalModeForFreshness(freshness) === "live_required";
    // Repair (brief 2026-11-05 §5): the conversation rides the bridge so
    // the session journals its own findings (see tools.ts), and the create
    // response carries the prior-evidence rehydration for this turn — the
    // journal law stays a TS law, the Rust transport just consumes it.
    const conversation = validConversation(body.conversation);
    // Citation-numbering law (design-review fix): prior journaled aliases
    // are numbered FIRST, starting clear of the caller's seed, and the
    // session's OWN mint then continues after the highest prior alias —
    // two citations must never share an [S#] label on one turn.
    let priorAliasMax = seed - 1;
    let priorEvidence: { block: string; citations: Record<string, unknown> } | null = null;
    if (conversation) {
      const priorTurns = selectPriorEvidence(readResearchJournal(conversation.id), question);
      if (priorTurns.length > 0) {
        const built = buildPriorEvidenceBlock(priorTurns, `S${Math.max(0, priorAliasMax)}`);
        if (built.block.trim() !== "") {
          priorEvidence = { block: built.block, citations: built.citations };
          for (const alias of Object.keys(built.citations)) {
            const n = /(\d+)$/.exec(alias);
            if (n) priorAliasMax = Math.max(priorAliasMax, Number(n[1]));
          }
        }
      }
    }
    const session = makeWebToolSession(
      depth as WebToolDepth,
      priorAliasMax + 1,
      question,
      scope,
      liveRequired,
      conversation,
    );
    // MHR-E: prior-turn [S#] aliases seed the source registry so a
    // re-fetched document keeps ONE alias across waves (mirrors the chat
    // loop's seedSessionSourceAliases call). docStore stays turn-scoped.
    seedSessionSourceAliases(
      session,
      priorEvidence?.citations as Record<string, { url?: unknown; sourceId?: unknown }> | undefined,
    );
    sessions.set(session.searchSessionId, { session, lastTouched: now });
    return {
      status: 200,
      json: {
        sessionId: session.searchSessionId,
        priorEvidence,
        budget: session.budget,
        remainingBudget: remainingBudget(session),
        // §9: observable freshness policy (Rust ignores it; the suite pins
        // the freshness→live_required mapping through this field).
        liveRequired: session.liveRequired,
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
    // Cancellation (2026-11-04 audit fix): req.signal is threaded from
    // app/api/internal/web-tools/route.ts but was never consulted, so a
    // stopped Rust turn kept burning browser + inference for the full tool
    // call. shortcut: only pre-dispatch cancellation is honored — the
    // primitives in lib/web-search/tools.ts carry no AbortSignal; upgrade
    // path is threading the signal into exec*Tool if mid-call cancellation
    // ever matters. In-flight calls stay bounded by the pipeline's own
    // per-request deadlines.
    if (signal?.aborted) {
      if (entry) {
        recordAction(entry.session, { tool, ok: false, error: "cancelled", requested: 0, retrieved: 0, failed: 0 });
      }
      return {
        status: 200,
        json: {
          envelope: {
            ok: false,
            tool,
            error: "cancelled",
            detail: "the turn was stopped before this tool ran",
          },
          citations: [],
        },
      };
    }
    if (!entry) {
      // shortcut: session_expired has no session to ledger — the record
      // cannot attach anywhere; the honest envelope in-conversation covers
      // the model, and no ledger frame follows this turn. Upgrade path:
      // none needed while the RPC session store is turn-scoped.
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
      recordAction(session, { tool, ok: false, error: "invalid_arguments", requested: 0, retrieved: 0, failed: 0 });
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
          ledger: session.actionLedger,
          ledgerSummary: summarizeActionLedger(session),
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
      recordAction(session, { tool, ok: false, error: "unknown_tool", requested: 0, retrieved: 0, failed: 0 });
    }
    // P3b: the action record rides every exec response so the Rust loop
    // (which owns the loop grammar) never reconstructs it and can stamp
    // it on web_meta / inject it on the forced final round.
    return {
      status: 200,
      json: {
        envelope,
        citations: fresh,
        ledger: session.actionLedger,
        ledgerSummary: summarizeActionLedger(session),
      },
    };
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
