"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import {
  compactConversation,
  type CompactResult,
  type CompactMode,
} from "../lib/chat/compact";
import {
  loadCompactThresholds,
  saveCompactThresholds,
  fetchCompactThresholds,
  type CompactThresholds,
} from "../lib/chat/compactConfig";
import { estimateConversationTokens, formatTokens } from "../lib/chat/tokens";
import {
  MAX_FENCE_REPAIRS,
  applyFenceRepair,
  extractFenceBody,
  fenceRepairRequest,
  findBrokenRenderFences,
  findFenceByLang,
  type BrokenFence,
} from "../lib/render/fenceRepair";
import { isRendererMode, type RendererMode } from "../lib/decision/types";
import { extractBrowserApiFence } from "../lib/browser/browserToolProtocol";
import { lastBrowserApiOutcome } from "../lib/browser/panelState";
import { buildResearchToolDefs, decodeSseHeaders } from "../lib/chat/streamHelpers";
import {
  computeBaselines,
  TurnProgressTracker,
  type TurnProgressSnapshot,
} from "../lib/progress/turnProgress";

/**
 * The continuation line the browser agent loop sends as each automatic
 * step. Deliberately terse: the action result + the current page's ref
 * map are injected SERVER-side (app/api/chat/route.ts standing browser
 * block, step 5b), so the wire payload stays small and the model only
 * has to re-decide the next move.
 */
const BROWSER_CONTINUE_MSG =
  "[agent loop] That step was executed — the result and the current page's ref map are in your context. " +
  "Continue the user's browser task now: emit the next fence (prefer batch or fill_form to combine steps). " +
  "If the task is complete, report the outcome to me in plain words; if you need consent, a login, or a " +
  "choice from me, ask and stop. Never repeat an action that already succeeded.";

export type SendStatus = "streaming" | "submitted" | "complete" | "error" | "aborted";

export interface UseChatOptions {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  /**
   * The web pipeline hit a login wall (web:auth_required stage) — the page
   * opens its in-app Browser panel targeted at the walled URL (Part 3).
   */
  onAuthRequired?: (info: { url?: string; domain?: string }) => void;
}

export interface UseChatReturn {
  messages: Message[];
  status: SendStatus;
  error: string | null;
  isThinking: boolean;
  reasoningContent: string;
  load: (conversation: Conversation) => void;
  clear: () => void;
  send: (text: string, opts?: { mode?: ChatMode; attachments?: any[] }) => void;
  stop: () => void;
  retry: () => void;
  edit: (id: string, newContent: string) => void;
  clearError: () => void;
  setEffort: (level: EffortLevel) => void;
  effort: EffortLevel;
  requestFenceRepair: (assistantId: string, info: { lang: string; body: string; error: string }) => void;
  /** Live honest turn progress for the top-right chip/panel (null when none). */
  turnProgress: TurnProgressSnapshot | null;
  /** Hide the chip/panel once the turn has ended. */
  dismissProgress: () => void;
  /** Run a manual or auto compaction over the active LLM history. */
  compact: (mode?: CompactMode) => Promise<CompactResult | null>;
  /** State of the last compaction + divider badge position. */
  compactState: {
    lastRun: CompactResult | null;
    isCompacting: boolean;
    badgeAt: number;
  };
  /** Token count of the active LLM history (estimate). */
  activeTokenCount: () => number;
  compactThresholds: CompactThresholds | null;
  setCompactThresholds: (t: CompactThresholds) => void;
}

function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export function useChat({
  model = "",
  apiUrl,
  apiKey,
  onAuthRequired,
}: UseChatOptions = {}): UseChatReturn {
  // Stable ref: handleEvent stays dependency-free but always sees the
  // page's latest auth-required handler.
  const onAuthRequiredRef = useRef(onAuthRequired);
  onAuthRequiredRef.current = onAuthRequired;

  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus]   = useState<SendStatus>("complete");
  const [error, setError]     = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [reasoningContent, setReasoningContent] = useState("");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [turnProgress, setTurnProgress] = useState<TurnProgressSnapshot | null>(null);

  // ── Auto-compact context ─────────────────────────────────────────────
  // TWO histories live here:
  //   • `messages` (state)  — the FULL original conversation. It is what
  //     the UI renders and what gets persisted, so the user can always
  //     scroll back and read every old turn. Compaction NEVER touches it.
  //   • `llmHistoryRef`      — the array actually SENT to the model. After a
  //     compaction it becomes
  //     [system?, compacted-context message, ...recent tail, ...new turns].
  const compactThresholdsRef = useRef<CompactThresholds | null>(null);
  const compactingRef = useRef(false);

  // Post-turn rebuild of the model-facing history, applied LAZILY. When a
  // turn ends we remember the LLM array as it stood BEFORE the turn (the
  // mirror, or a compacted replacement) plus the UI length it covers. At the
  // next send/compact — by which point React has committed every streamed
  // and repair update into messagesRef — the finished turn's messages are
  // appended onto that base. Mirroring `messagesRef` at turn END instead
  // would (a) race the last rAF-batched deltas and (b) silently UNDO a
  // compaction by shipping the full UI history back to the model.
  const llmPendingRef = useRef<{ base: Message[]; uiLen: number } | null>(null);

  const materializeLlmHistory = useCallback(() => {
    const p = llmPendingRef.current;
    if (p) {
      llmPendingRef.current = null;
      llmHistoryRef.current = [...p.base, ...messagesRef.current.slice(p.uiLen)];
    }
  }, []);
  const [compactState, setCompactState] = useState<{
    /** The last compaction result (null = never compacted this session). */
    lastRun: CompactResult | null;
    /** True while a compaction call is in flight. */
    isCompacting: boolean;
    /**
     * Index in the UI message list where the compaction divider belongs —
     * i.e. the number of original messages that preceded the compaction.
     */
    badgeAt: number;
  }>({ lastRun: null, isCompacting: false, badgeAt: -1 });
  const compactStateRef = useRef(compactState);
  compactStateRef.current = compactState;

  /** Wire shape (role + content) of a UI message, as the model receives it. */
  const wireMessage = useCallback((m: Message) => ({
    role: m.role as string,
    content: m.content,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.usage?.promptTokens ? { usage: { promptTokens: m.usage.promptTokens } } : {}),
  }), []);

  /**
   * Run the sliding-window compaction pipeline over the ACTIVE LLM history
   * and replace it with [system?, compacted context, ...recent tail].
   *
   * The UI/persisted history is deliberately left alone — the user keeps
   * scrolling through the real conversation; only what the model sees
   * changes. A divider badge is rendered at `badgeAt` to make the swap
   * visible.
   */
  const compact = useCallback(async (
    mode: CompactMode = "manual",
    opts: { badgeAt?: number } = {},
  ): Promise<CompactResult | null> => {
    if (compactingRef.current) return null;
    compactingRef.current = true;

    // Fold the finished previous turn into the active LLM array first, so
    // compaction always runs against the real model-facing history.
    materializeLlmHistory();
    // The divider position is fixed NOW, synchronously — and published with
    // isCompacting so the in-flight spinner actually renders (badgeAt must
    // already be set for the badge to mount). The message list re-renders
    // during the multi-second compaction call, and reading messagesRef
    // afterwards would place the divider after the in-flight turn's bubbles
    // instead of before them.
    const badgeAt = opts.badgeAt ?? messagesRef.current.length;
    setCompactState((s) => ({ ...s, isCompacting: true, badgeAt }));

    // Refresh the in-memory threshold mirror if it has never been loaded.
    if (!compactThresholdsRef.current) {
      try {
        compactThresholdsRef.current = await fetchCompactThresholds();
      } catch {
        compactThresholdsRef.current = loadCompactThresholds();
      }
    }

    try {
      const result = await compactConversation(
        llmHistoryRef.current.map(wireMessage),
        { model, apiUrl, apiKey, mode },
      );

      if (result.compacted) {
        // The LLM array becomes: [system?, compacted context, ...recent tail].
        // The compacted-context block rides as a `user` message — that is the
        // role the compaction model itself authored it for.
        llmHistoryRef.current = result.replacementLlmMessages.map((lm, i) => ({
          id: i === 0 ? "compact_" + Date.now().toString(36) : "compact_tail_" + i,
          conversationId: "",
          role: lm.role as Message["role"],
          content: lm.content,
          reasoning: "",
          attachments: [],
          toolCalls: [],
          citations: [],
          createdAt: Date.now(),
          state: "complete",
          mode: "chat",
        }));
        setCompactState((s) => ({ ...s, lastRun: result, badgeAt }));
      } else {
        // Failure OR "already fits": still publish badgeAt — a silent
        // failure is indistinguishable from "nothing happened", which is
        // exactly how this bug went unnoticed at 100k context.
        setCompactState((s) => ({ ...s, lastRun: result, badgeAt }));
      }
      return result;
    } catch (e) {
      const failed: CompactResult = {
        ok: false,
        compacted: false,
        context: "",
        compactedMessages: 0,
        replacementLlmMessages: [],
        beforeTokens: 0,
        afterTokens: 0,
        label: "Compaction failed",
        error: e instanceof Error ? e.message : String(e),
      };
      setCompactState((s) => ({ ...s, lastRun: failed, badgeAt }));
      return failed;
    } finally {
      compactingRef.current = false;
      setCompactState((s) => ({ ...s, isCompacting: false }));
    }
  }, [model, apiUrl, apiKey, wireMessage, materializeLlmHistory]);

  /**
   * The token count of the ACTIVE LLM history — what the threshold is
   * compared against.
   */
  const activeTokenCount = useCallback(
    () => estimateConversationTokens(llmHistoryRef.current),
    [],
  );


  // Honest progress engine (lib/progress/turnProgress.ts). Mutated by real
  // signals only: ruke_stage frames, streamed bytes, repair rounds. The React
  // snapshot refreshes on stage events + a 1 s tick (NOT per token — the rAF
  // batching in §5.3 stays intact; a snapshot is a cheap object).
  const progressRef = useRef<TurnProgressTracker | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fenceOpenedRef = useRef(false);

  const flushProgress = useCallback(() => {
    const t = progressRef.current;
    if (t) setTurnProgress(t.snapshot(Date.now()));
  }, []);

  const stopProgressTick = useCallback(() => {
    if (progressTimerRef.current != null) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const finishProgress = useCallback((state: "complete" | "error" | "aborted") => {
    const t = progressRef.current;
    stopProgressTick();
    if (!t) return;
    t.finish(state);
    setTurnProgress(t.snapshot(Date.now()));
  }, [stopProgressTick]);

  const dismissProgress = useCallback(() => {
    if (progressRef.current && progressRef.current.snapshot(Date.now()).state === "running") return;
    progressRef.current = null;
    setTurnProgress(null);
  }, []);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastInputRef = useRef<{ text: string; mode: ChatMode; attachments: any[] } | null>(null);
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const assistantIdRef = useRef<string | null>(null);
  const streamContentRef = useRef<string>("");
  const reasoningStartRef = useRef<number | null>(null);
  const sendBusyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const decisionModeRef = useRef<RendererMode | null>(null);

  // The array actually sent to the model. Normally a mirror of `messages`;
  // after a compaction it diverges — it holds [system?, compacted context,
  // ...recent tail] while `messages` keeps the full original history.
  // Kept in a ref (not state) because it never drives a re-render on its own.
  const llmHistoryRef = useRef<Message[]>([]);

  // Phase 4: rAF-batched stream delta. content/reasoning accumulate in a
  // mutable ref and flush to React state at most once per animation frame,
  // eliminating re-render thrashing on fast local LLMs.
  const pendingContentRef = useRef("");
  const pendingReasoningRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const reasoningContentStateRef = useRef("");

  const flushPending = useCallback((immediate = false) => {
    const content = pendingContentRef.current;
    const reasoning = pendingReasoningRef.current;
    if (!content && !reasoning) return;
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";

    const id = assistantIdRef.current;
    setMessages(prev => prev.map(m => {
      if (m.id !== id) return m;
      const next = { ...m };
      if (content) next.content = (m.content as string) + content;
      if (reasoning) next.reasoning = (m.reasoning as string) + reasoning;
      if (reasoning && m.reasoningMs == null && reasoningStartRef.current != null) {
        next.reasoningMs = Date.now() - reasoningStartRef.current;
      }
      return next;
    }));
    if (reasoning) {
      reasoningContentStateRef.current += reasoning;
      setReasoningContent(reasoningContentStateRef.current);
    }
    if (immediate || rafRef.current != null) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      flushPending(false);
    });
  }, [flushPending]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const load = useCallback((conversation: Conversation) => {
    setMessages(conversation.messages ?? []);
    messagesRef.current = conversation.messages ?? [];
    // A new conversation always starts with a fresh LLM history that
    // mirrors the UI messages (no compaction state crosses conversations).
    llmHistoryRef.current = conversation.messages ?? [];
    llmPendingRef.current = null;
    compactThresholdsRef.current = null;
    setCompactState({ lastRun: null, isCompacting: false, badgeAt: -1 });
    lastInputRef.current = null;
    setStatus("complete");
    setError(null);
    setIsThinking(false);
    setReasoningContent("");
    reasoningContentStateRef.current = "";
    reasoningStartRef.current = null;
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    stopProgressTick();
    progressRef.current = null;
    fenceOpenedRef.current = false;
    setTurnProgress(null);
  }, [stopProgressTick]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearBrowserLoop(); // deps intentionally not extended: the const is
    // declared later in this hook; referencing it inside the callback body
    // is safe (called post-render), listing it as a dep would TDZ-crash.
    setMessages([]);
    messagesRef.current = [];
    llmHistoryRef.current = [];
    llmPendingRef.current = null;
    compactThresholdsRef.current = null;
    setCompactState({ lastRun: null, isCompacting: false, badgeAt: -1 });
    lastInputRef.current = null;
    assistantIdRef.current = null;
    streamContentRef.current = "";
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    setStatus("complete");
    setError(null);
    setIsThinking(false);
    setReasoningContent("");
    reasoningContentStateRef.current = "";
    reasoningStartRef.current = null;
    stopProgressTick();
    progressRef.current = null;
    fenceOpenedRef.current = false;
    setTurnProgress(null);
  }, [stopProgressTick]);

  const handleEvent = useCallback((ev: any, abort: AbortController | null) => {
    if (abort?.signal.aborted) return;

    // Server phase frames (ruke_stage): real counts into the tracker, plus
    // web metadata that streamed turns deliver in-band instead of headers.
    if (ev.stage) {
      if (ev.stage.stage === "web_meta") {
        const id = assistantIdRef.current;
        const gateMeta = ev.stage.searchGate ?? ev.stage.researchLfm;
        if (id && (ev.stage.webCitations || gateMeta)) {
          setMessages(prev => prev.map(m => m.id === id ? {
            ...m,
            ...(ev.stage.webCitations ? { webCitations: ev.stage.webCitations } : {}),
            ...(gateMeta ? { searchGate: gateMeta } : {}),
          } : m));
        }
      }
      if (ev.stage.stage === "web:auth_required") {
        // Login-wall report (Part 3): surface the Browser panel aimed at the
        // walled page. The progress tracker already shows the info band.
        onAuthRequiredRef.current?.({ url: ev.stage.url, domain: ev.stage.domain });
      }
      const t = progressRef.current;
      if (t) {
        t.noteStage(ev.stage);
        setTurnProgress(t.snapshot(Date.now()));
      }
      return;
    }

    if (ev.reasoning) {
      if (reasoningStartRef.current == null) {
        reasoningStartRef.current = Date.now();
        progressRef.current?.noteReasoningStart();
      }
      pendingReasoningRef.current += ev.reasoning;
      setIsThinking(true);
      scheduleFlush();
    }
    if (ev.content) {
      streamContentRef.current += ev.content;
      pendingContentRef.current += ev.content;
      setIsThinking(false);
      const t = progressRef.current;
      if (t) {
        t.noteContent(streamContentRef.current.length);
        // A fence opening in the stream = a real output artifact appearing.
        if (!fenceOpenedRef.current && streamContentRef.current.includes("```")) {
          fenceOpenedRef.current = true;
          t.openOutput();
        }
      }
      scheduleFlush();
    }
    if (ev.usage) {
      // Stored on the message: feeds the next turn's honest ETA baselines
      // (persistence is verbatim, so they accumulate across sessions).
      const id = assistantIdRef.current;
      if (id) {
        setMessages(prev => prev.map(m => m.id === id ? { ...m, usage: ev.usage } : m));
      }
    }
    if (ev.finishReason === "abort" || ev.finishReason === "error") {
      setStatus(ev.finishReason === "abort" ? "aborted" : "error");
      setError(ev.finishReason === "error" ? "Generation failed" : null);
      setIsThinking(false);
    }
  }, [scheduleFlush]);

  // ── Browser agent loop ───────────────────────────────────────────────
  // A ```browser_api fence is executed by the renderer (BrowserApiBlock);
  // its outcome reaches the model through the NEXT turn's standing browser
  // block (app/api/chat/route.ts step 5b). Without an automatic follow-up
  // turn the loop stops at the first action: the model emits a fence, the
  // action runs, and silence follows. These rounds close act → see → act:
  // when a streamed turn ends having executed a browser fence, schedule a
  // bounded agent round whose user message is the fixed BROWSER_CONTINUE
  // line; the result/ref-map context rides the server-injected block. The
  // loop self-stops the moment the model answers without a fence (final
  // report, question, or parked consent) and is hard-capped regardless.
  const MAX_BROWSER_AGENT_STEPS = 10;
  // Outcome wait: navigate blocks until the page fully loads; give a
  // generous ceiling so a slow page delays — never silences — the step.
  const BROWSER_OUTCOME_WAIT_MS = 90_000;

  // round = agent rounds run for the CURRENT task (reset per fresh ask).
  // consumedWhen = outcome timestamp the loop has already accounted for.
  const browserLoopRef = useRef({ round: 0, consumedWhen: 0 });
  const browserLoopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every real user send and on Stop — a scheduled round whose
  // generation changed was superseded by the human and must not fire.
  const turnGenRef = useRef(0);

  const clearBrowserLoop = useCallback(() => {
    turnGenRef.current++;
    if (browserLoopTimerRef.current != null) {
      clearTimeout(browserLoopTimerRef.current);
      browserLoopTimerRef.current = null;
    }
    browserLoopRef.current = { round: 0, consumedWhen: 0 };
  }, []);

  /** A user pressed send: kill any scheduled round; a fresh browser ask
   *  (or any non-browser message) re-arms the step budget. Mid-task follow-
   *  ups ("yes", "keep going") keep the budget so the cap can't be evaded. */
  const noteUserSend = useCallback((text: string) => {
    turnGenRef.current++;
    if (browserLoopTimerRef.current != null) {
      clearTimeout(browserLoopTimerRef.current);
      browserLoopTimerRef.current = null;
    }
    const isFreshBrowserAsk =
      /\b(browser|new tab|web ?page|web ?site|website|webapp)\b|https?:\/\//i.test(text);
    if (isFreshBrowserAsk) {
      browserLoopRef.current = { round: 0, consumedWhen: 0 };
    }
  }, []);

  // Mutual recursion (round → continue-check → next round) through stable
  // refs so timers always call the freshest closures.
  const runBrowserRoundRef = useRef<((round: number, gen: number) => void) | null>(null);
  const maybeContinueRef = useRef<((content: string, isRealUserTurn: boolean) => void) | null>(null);

  const runBrowserRound = useCallback(async (round: number, genAtSchedule: number) => {
    const loop = browserLoopRef.current;

    // Wait for THIS round's fence outcome (BrowserApiBlock records it when
    // its POST resolves) so the model sees real results. Timeout still
    // proceeds: the SERVER records outcomes too, and the model's block is
    // server-injected regardless of this client mirror.
    const t0 = Date.now();
    while (Date.now() - t0 < BROWSER_OUTCOME_WAIT_MS) {
      if (turnGenRef.current !== genAtSchedule) return; // the user spoke — they own the loop now
      const o = lastBrowserApiOutcome();
      if (o && o.when > loop.consumedWhen) { loop.consumedWhen = o.when; break; }
      await new Promise(r => setTimeout(r, 400));
    }
    if (turnGenRef.current !== genAtSchedule || sendBusyRef.current) return;

    // Fold the previous round into the model-facing history, then build
    // this round exactly like send(): visible user + assistant bubbles,
    // request = materialized llmHistory + the new user message.
    materializeLlmHistory();
    const uiLenBeforeRound = messagesRef.current.length;
    const userMsg: Message = {
      id: uid("u_"),
      conversationId: "",
      role: "user",
      content: BROWSER_CONTINUE_MSG,
      reasoning: "",
      attachments: [],
      toolCalls: [],
      citations: [],
      createdAt: Date.now(),
      state: "complete",
      mode: "chat",
    };
    const assistantMsg: Message = {
      id: uid("a_"),
      conversationId: "",
      role: "assistant",
      content: "",
      reasoning: "",
      reasoningMs: undefined,
      attachments: [],
      toolCalls: [],
      citations: [],
      createdAt: Date.now(),
      state: "streaming",
      mode: "chat",
      fenceRepair: `🌐 Browser step ${round}/${MAX_BROWSER_AGENT_STEPS}`,
    };
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setStatus("streaming");
    setError(null);
    setReasoningContent("");
    reasoningContentStateRef.current = "";
    reasoningStartRef.current = null;
    setIsThinking(true);
    assistantIdRef.current = assistantMsg.id;
    streamContentRef.current = "";
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    // decisionModeRef keeps the mode pinned by the previous turn; the
    // standing browser block rides the server-side injection regardless.
    sendBusyRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const client = new ChatClient(apiUrl, apiKey, model);
    const curEffort = effortRef.current;
    try {
      await client.chat(
        {
          messages: [...llmHistoryRef.current, userMsg],
          model,
          stream: true,
          reasoning_effort: curEffort === "off" ? undefined : curEffort,
          ...(decisionModeRef.current ? { decision_mode: decisionModeRef.current } : {}),
        },
        (ev) => handleEvent(ev, controller),
        controller.signal,
      );
      flushPending(true);
      if (!controller.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now(), fenceRepair: undefined } : m
        ));
        setStatus("complete");
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id && m.state === "streaming"
            ? { ...m, state: "complete", finishedAt: Date.now(), fenceRepair: undefined }
            : m
        ));
        setStatus("aborted");
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        const msg = e?.message ?? "Browser step failed";
        setError(msg);
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "error", error: msg, fenceRepair: undefined } : m
        ));
        setStatus("error");
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id && m.state === "streaming"
            ? { ...m, state: "complete", fenceRepair: undefined }
            : m
        ));
        setStatus("aborted");
      }
    } finally {
      // Deferred LLM rebuild — same pattern as send(): the finished turn's
      // bubbles are folded in lazily at the next materialize, never racing
      // rAF-batched deltas and never undoing a compaction.
      llmPendingRef.current = { base: llmHistoryRef.current, uiLen: uiLenBeforeRound };
      setIsThinking(false);
      abortRef.current = null;
      sendBusyRef.current = false;
      setStatus(prev => (prev === "streaming" ? "complete" : prev));
    }

    if (!controller.signal.aborted && turnGenRef.current === genAtSchedule) {
      maybeContinueRef.current?.(streamContentRef.current, false);
    }
  }, [model, apiUrl, apiKey, handleEvent, flushPending, materializeLlmHistory]);

  /**
   * End-of-turn hook. A turn is "acting" when its content holds a valid
   * ```browser_api fence — the renderer executes every such fence. An
   * acting turn schedules the next bounded step; a turn that answered
   * without a fence (report / question / parked consent) ENDS the loop.
   */
  const maybeContinueBrowserLoop = useCallback((content: string, isRealUserTurn: boolean) => {
    const loop = browserLoopRef.current;
    let acted = false;
    const re = /```browser_api\s*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      if (extractBrowserApiFence("```browser_api\n" + m[1] + "\n```") !== null) { acted = true; break; }
    }

    if (isRealUserTurn) {
      loop.consumedWhen = lastBrowserApiOutcome()?.when ?? 0;
      if (!acted) return; // the user turn didn't touch the browser
    } else {
      loop.round += 1;
      if (!acted) return; // final report / question / park — the loop is over
      if (loop.round >= MAX_BROWSER_AGENT_STEPS) {
        setMessages(prev => [...prev, {
          id: uid("a_"),
          conversationId: "",
          role: "assistant",
          content: `⏹️ The browser agent reached its ${MAX_BROWSER_AGENT_STEPS}-step limit for this request without finishing. Send "continue" for a fresh budget, or restate what's left.`,
          reasoning: "",
          attachments: [],
          toolCalls: [],
          citations: [],
          createdAt: Date.now(),
          state: "complete",
          mode: "chat",
        }]);
        return;
      }
    }

    const gen = turnGenRef.current;
    const nextRound = loop.round + 1;
    browserLoopTimerRef.current = setTimeout(() => {
      browserLoopTimerRef.current = null;
      void runBrowserRoundRef.current?.(nextRound, gen);
    }, 900);
  }, []);

  runBrowserRoundRef.current = runBrowserRound;
  maybeContinueRef.current = maybeContinueBrowserLoop;

  const runRepairRounds = useCallback(async (
    assistantId: string,
    history: any[],
    effort: EffortLevel,
    controller: AbortController,
    decisionMode: RendererMode | null,
    locate: (content: string) => BrokenFence[],
    stopAfterFirstApply = false,
  ) => {
    for (let attempt = 0; attempt < MAX_FENCE_REPAIRS; attempt++) {
      if (controller.signal.aborted) return;
      const content = streamContentRef.current;
      const broken = locate(content);
      if (broken.length === 0) {
        setMessages(prev => prev.map(m => (m.id === assistantId && m.fenceRepair ? { ...m, fenceRepair: undefined } : m)));
        return;
      }

      const lang = broken[0].lang ?? "anatomy";
      if (lang !== "anatomy") {
        setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, fenceRepair: "🔄 Auto-repairing 3D/CAD model…" } : m)));
        // Real round count into the progress panel (auto-repair turns only).
        const t = progressRef.current;
        if (t && t.snapshot(Date.now()).state === "running") {
          t.setRepair(attempt + 1, MAX_FENCE_REPAIRS);
          setTurnProgress(t.snapshot(Date.now()));
        }
      }

      let reply = "";
      const client = new ChatClient(apiUrl, apiKey, model);
      try {
        await client.chat(
          {
            messages: [
              ...history,
              { role: "assistant", content },
              { role: "user", content: fenceRepairRequest(broken[0]) },
            ],
            model,
            stream: true,
            reasoning_effort: effort === "off" ? undefined : effort,
            decision_mode: decisionMode ?? undefined,
          },
          (ev) => { if (ev.content) reply += ev.content; },
          controller.signal,
        );
      } catch {
        return;
      }
      if (controller.signal.aborted) return;

      const corrected = extractFenceBody(reply, lang);
      if (!corrected) continue;
      const repaired = applyFenceRepair(content, broken[0], corrected);
      streamContentRef.current = repaired;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: repaired, fenceRepair: undefined } : m)));
      if (stopAfterFirstApply) return;
    }
  }, [model, apiUrl, apiKey]);

  const fenceRepairAttemptsRef = useRef(new Map<string, number>());

  const requestFenceRepair = useCallback((
    assistantId: string,
    info: { lang: string; body: string; error: string },
  ) => {
    const idx = messagesRef.current.findIndex(m => m.id === assistantId);
    if (idx < 0) return;
    const attempts = fenceRepairAttemptsRef.current;
    const used = attempts.get(assistantId) ?? 0;
    if (used >= MAX_FENCE_REPAIRS) return;
    attempts.set(assistantId, used + 1);

    const message = messagesRef.current[idx];
    if (message.decisionMode !== "3d_asset") return;
    const history = messagesRef.current.slice(0, idx);
    streamContentRef.current = message.content;
    const controller = new AbortController();
    void runRepairRounds(
      assistantId,
      history,
      effortRef.current,
      controller,
      message.decisionMode ?? null,
      content => {
        const fence = findFenceByLang(content, info.lang);
        if (!fence) return [];
        return [{ error: info.error, bodyStart: fence.bodyStart, bodyEnd: fence.bodyEnd, closed: fence.closed, lang: info.lang }];
      },
      true,
    );
  }, [runRepairRounds]);

  const send = useCallback(async (text: string, opts: { mode?: ChatMode; attachments?: any[] } = {}) => {
    if (!text.trim() || sendBusyRef.current) return;
    sendBusyRef.current = true;
    // Cancel any scheduled browser agent step; a fresh browser ask re-arms
    // the step budget (mid-task follow-ups keep it, so the cap holds).
    noteUserSend(text);
    // Fold the finished previous turn into the model-facing array before
    // this turn measures tokens or reads the history (the rebuild is lazy so
    // it never races rAF-batched stream deltas).
    materializeLlmHistory();
    // UI length BEFORE this turn's bubbles are pushed — used to place the
    // compaction divider and to rebuild the LLM array when the turn ends.
    const uiLenAtSend = messagesRef.current.length;
    let assistantId: string | null = null;
    try {
      const mode = opts.mode ?? "chat";
      const curEffort = effortRef.current;
      lastInputRef.current = { text, mode, attachments: opts.attachments ?? [] };

      const userMsg: Message = {
        id: uid("u_"),
        conversationId: "",
        role: "user",
        content: text,
        reasoning: "",
        reasoningMs: undefined,
        attachments: opts.attachments ?? [],
        toolCalls: [],
        citations: [],
        createdAt: Date.now(),
        state: "complete",
        mode,
      };
      const assistantMsg: Message = {
        id: uid("a_"),
        conversationId: "",
        role: "assistant",
        content: "",
        reasoning: "",
        reasoningMs: undefined,
        attachments: [],
        toolCalls: [],
        citations: [],
        createdAt: Date.now(),
        state: "streaming",
        mode,
      };

      assistantId = assistantMsg.id;
      setMessages(prev => [...prev, userMsg, assistantMsg]);
      setStatus("streaming");
      setError(null);
      setReasoningContent("");
      reasoningContentStateRef.current = "";
      reasoningStartRef.current = null;
      pendingContentRef.current = "";
      pendingReasoningRef.current = "";
      setIsThinking(!!curEffort && curEffort !== "off");
      assistantIdRef.current = assistantMsg.id;
      streamContentRef.current = "";
      decisionModeRef.current = null;

      // Fresh honest tracker seeded with THIS user's measured ETAs.
      progressRef.current = new TurnProgressTracker(computeBaselines(messagesRef.current));
      fenceOpenedRef.current = false;
      setTurnProgress(progressRef.current.snapshot(Date.now()));
      stopProgressTick();
      progressTimerRef.current = setInterval(flushProgress, 1000);

      const controller = new AbortController();
      abortRef.current = controller;

      const client = new ChatClient(apiUrl, apiKey, model);
      const tools = mode === "research" ? buildResearchToolDefs() : undefined;

      // ── Pre-send auto-compact gate ─────────────────────────────
      // Before the model ever sees this turn, check whether the active
      // LLM history has outgrown the user's threshold. One check per send
      // keeps a single oversized conversation to exactly one compaction.
      // Read the thresholds through the compactConfig cache — primed from
      // /api/settings on first use and refreshed by the Settings save. A
      // bare hook-mirror read could miss a setting saved mid-session.
      let thresholds: CompactThresholds;
      try {
        thresholds = await fetchCompactThresholds();
      } catch {
        thresholds = loadCompactThresholds();
      }
      compactThresholdsRef.current = thresholds;
      if (thresholds.auto === 1 && thresholds.tokens > 0) {
        // Count the tokens that the model would receive on this turn, which
        // is the active LLM history plus the incoming user message.
        const projectedTokens =
          estimateConversationTokens(llmHistoryRef.current) +
          estimateConversationTokens([userMsg]);
        if (projectedTokens >= thresholds.tokens && !compactingRef.current) {
          // Fold the oldest turns into a dense summary. The UI keeps the
          // full original conversation; only the model-facing array shrinks.
          // badgeAt = the UI length before this turn's bubbles: the divider
          // lands between the last old message and the new user bubble.
          await compact("auto", { badgeAt: uiLenAtSend });
        }
      }

      // The LLM history is what the model actually sees. Before compaction
      // this mirrors `messages`; after a compaction it is the reduced
      // [system?, compacted context, ...recent tail] array. The new user
      // message is appended to BOTH the UI history and the LLM history.
      const requestHistory = [...llmHistoryRef.current, userMsg];

      await client.chat(
        { messages: requestHistory, model, stream: true, reasoning_effort: curEffort === "off" ? undefined : curEffort, tools },
        (ev) => handleEvent(ev, controller),
        controller.signal,
        (headers) => {
          const hdrs = decodeSseHeaders(headers);
          const mode = hdrs.decisionMode;
          if (mode) {
            decisionModeRef.current = mode;
            // Streams without stage frames (mock servers, upstream direct)
            // still label the writing step + outputs honestly from the header.
            progressRef.current?.noteStage({ stage: "decision_done", mode });
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, decisionMode: mode } : m
            ));
          }
          if (hdrs.skill) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, usedSkill: hdrs.skill } : m
            ));
          }
          if (hdrs.webCitations) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, webCitations: hdrs.webCitations } : m
            ));
          }
          if (hdrs.searchGate) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, searchGate: hdrs.searchGate } : m
            ));
          }
        },
      );

      // Flush any pending rAF-batched deltas before finalizing.
      flushPending(true);

      if (!controller.signal.aborted) {
        const curMode = decisionModeRef.current;
        await runRepairRounds(
          assistantMsg.id,
          requestHistory,
          curEffort,
          controller,
          curMode,
          (content) => findBrokenRenderFences(content, curMode),
        );
        // The browser agent loop: if this turn executed a browser fence,
        // the act → see → act cycle continues automatically (bounded).
        maybeContinueRef.current?.(streamContentRef.current, true);
        // No mirror here — appending this turn to the model-facing base is
        // queued in `finally` and applied lazily by materializeLlmHistory.
        // Mirroring `messagesRef` would UNDO any compaction.
      }

      if (!controller.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now() } : m
        ));
        setStatus("complete");
        setReasoningContent("");
        reasoningContentStateRef.current = "";
        finishProgress("complete");
      } else {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id && m.state === "streaming"
            ? { ...m, state: "complete", finishedAt: Date.now() }
            : m
        ));
        setStatus("aborted");
        finishProgress("aborted");
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        const msg = e?.message ?? "Generation failed";
        setError(msg);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, state: "error", error: msg } : m
        ));
        setStatus("error");
        finishProgress("error");
      } else {
        finishProgress("aborted");
      }
      setReasoningContent("");
    } finally {
      // Queue the deferred rebuild for this turn. It also covers aborted and
      // failed turns: the slice is taken from messagesRef at the NEXT
      // materialize — after every stream, repair and final-state update has
      // committed — so the LLM array can never capture half-streamed text.
      llmPendingRef.current = { base: llmHistoryRef.current, uiLen: uiLenAtSend };
      setIsThinking(false);
      abortRef.current = null;
      sendBusyRef.current = false;
      stopProgressTick();
      setStatus(prev => (prev === "streaming" ? "complete" : prev));
    }
  }, [model, apiUrl, apiKey, handleEvent, runRepairRounds, flushPending,
      flushProgress, stopProgressTick, finishProgress, compact, materializeLlmHistory]);

  const stop = useCallback(() => {
    clearBrowserLoop();
    const id = assistantIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    flushPending(true);
    if (id) {
      setMessages(prev => prev.map(m =>
        m.id === id && m.state === "streaming"
          ? { ...m, state: "complete", finishedAt: Date.now() }
          : m
      ));
    }
    setStatus(prev => (prev === "streaming" ? "aborted" : prev));
    setError(null);
    setIsThinking(false);
    finishProgress("aborted");
  }, [flushPending, finishProgress, clearBrowserLoop]);

  const retry = useCallback(() => {
    if (lastInputRef.current) {
      const { text, mode, attachments } = lastInputRef.current;
      // Compute the filtered history synchronously from messagesRef (kept
      // current by the render-time sync) — the rewind below must see it
      // BEFORE send() starts, which an updater-form setMessages cannot
      // guarantee.
      const prev = messagesRef.current;
      const reversed = [...prev].reverse();
      const idx = reversed.findIndex(m => m.role === "assistant");
      if (idx >= 0) {
        const removeId = reversed[idx].id;
        const filtered = prev.filter(m => m.id !== removeId);
        messagesRef.current = filtered;
        setMessages(filtered);
        // Rewind the model-facing history in lockstep with the UI. Normally
        // the retried turn still lives inside a PENDING rebuild: rolling
        // back to that base drops BOTH the old reply and the user message
        // being re-sent — send() appends the fresh user message itself.
        const p = llmPendingRef.current;
        if (p) {
          llmPendingRef.current = null;
          llmHistoryRef.current = p.base;
        } else {
          // No rebuild pending (e.g. a manual /compact ran after that
          // turn): drop the retried reply by id. A compacted replacement
          // array carries synthetic ids, so it is left untouched by design.
          llmHistoryRef.current = llmHistoryRef.current.filter(m => m.id !== removeId);
        }
      }
      setError(null);
      send(text, { mode, attachments });
    }
  }, [send]);

  const edit = useCallback((id: string, newContent: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearBrowserLoop(); // an edit rewinds history — old agent steps are void

    const prev = messagesRef.current;
    const idx = prev.findIndex(m => m.id === id);
    if (idx < 0) return;
    const filtered = prev.slice(0, idx);
    messagesRef.current = filtered;
    llmHistoryRef.current = filtered; // an edit rewinds both histories
    // Discard any pending rebuild — its base/uiLen predate the edit and its
    // re-slice would re-append the truncated messages at the next send.
    llmPendingRef.current = null;
    lastInputRef.current = { text: newContent, mode: "chat", attachments: [] };
    setMessages(filtered);
    setStatus("complete");
    setTimeout(() => send(newContent), 0);
  }, [send]);

  return {
    messages, status, error, isThinking, reasoningContent,
    load, clear, send, stop, retry, edit,
    clearError: () => setError(null),
    setEffort, effort, requestFenceRepair,
    turnProgress, dismissProgress,
    // Auto-compact context
    compact,
    compactState,
    activeTokenCount,
    compactThresholds: compactThresholdsRef.current,
    setCompactThresholds: (t: CompactThresholds) => {
      compactThresholdsRef.current = t;
    },
  };
}
