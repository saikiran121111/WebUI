"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import { acceptsTurn, acceptsEdit } from "../lib/chat/composerGate";
import { handleBrowserStage } from "../lib/browser-client/browserStore";
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
  type BrokenFence,
} from "../lib/render/fenceRepair";
import { isRendererMode, type RendererMode } from "../lib/decision/types";
import { buildResearchToolDefs, closeOpenActivityEntries, decodeSseHeaders } from "../lib/chat/streamHelpers";
import { sanitizeRichResult, type RichResult } from "../lib/web-search/rich-results";
import {
  computeBaselines,
  TurnProgressTracker,
  type TurnProgressSnapshot,
} from "../lib/progress/turnProgress";
import { createTurnFence, type TurnFence, type TurnRef } from "../lib/progress/turnFence";

export type SendStatus = "streaming" | "submitted" | "complete" | "error" | "aborted";

export interface UseChatOptions {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  /**
   * Browser Use (brief #2 + user rescope 2026-11-07):
   * `getBrowserSession` returns the ACTIVE conversation id — it rides
   * EVERY chat send as research-journal/panel identity, never as a
   * routing switch. `getBrowserArmed` returns true ONLY while the
   * Browser Panel is OPEN at send time — the human's explicit "open
   * browser" action; the SERVER combines it with the task-scope fold and
   * the turn's words (task_scope::browser_activates) before the engine
   * may run. Consulted at SEND time through refs — the caller wires them
   * non-reactively (page.tsx) so panel state never re-renders the chat.
   */
  getBrowserSession?: () => string | undefined;
  getBrowserArmed?: () => boolean;
}

export interface UseChatReturn {
  messages: Message[];
  status: SendStatus;
  error: string | null;
  isThinking: boolean;
  reasoningContent: string;
  load: (conversation: Conversation) => void;
  clear: () => void;
  /** Returns ACCEPTANCE: true = the turn started; false = refused (busy, or
   *  no text AND no ready evidence — composerGate.acceptsTurn). The composer
   *  clears the draft/tray only on true (F153). */
  send: (text: string, opts?: { mode?: ChatMode; attachments?: any[] }) => Promise<boolean>;
  stop: () => void;
  retry: () => void;
  edit: (id: string, newContent: string) => void;
  clearError: () => void;
  setEffort: (level: EffortLevel) => void;
  effort: EffortLevel;
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

/**
 * F153 (2026-11-24): the retry rewind, as ONE operation. Retry reuses the
 * original user turn and its attachments EXACTLY ONCE — in the UI, in the
 * saved history and in the model request — so the rewind removes the last
 * assistant reply AND the user message that prompted it (send() appends the
 * fresh user bubble itself). Removing only the reply (the previous behavior)
 * left the original user bubble behind: after a retry the UI and the saved
 * history carried the same user turn twice, and the no-pending llm rewind,
 * which dropped only the reply by id, repeated the duplicate in the model
 * request.
 */
export function retryRewind(prev: Message[]): { filtered: Message[]; removedIds: string[] } {
  const reversed = [...prev].reverse();
  const idx = reversed.findIndex(m => m.role === "assistant");
  if (idx < 0) return { filtered: prev, removedIds: [] };
  const assistant = reversed[idx];
  const aPos = prev.findIndex(m => m.id === assistant.id);
  const user = aPos > 0 && prev[aPos - 1].role === "user" ? prev[aPos - 1] : null;
  const removedIds = user ? [user.id, assistant.id] : [assistant.id];
  const kill = new Set(removedIds);
  return { filtered: prev.filter(m => !kill.has(m.id)), removedIds };
}

function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export function useChat({
  model = "",
  apiUrl,
  apiKey,
  getBrowserSession,
  getBrowserArmed,
}: UseChatOptions = {}): UseChatReturn {
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
  // ── Compaction ownership (I28) ───────────────────────────────────────
  // `llmHistoryRef` belongs to ONE conversation at a time. Every history
  // transition (load/clear/edit/retry) bumps `historyGenRef` and aborts any
  // in-flight compaction; when a compaction resolves it must check that its
  // captured generation is still current — otherwise a slow summary from the
  // PREVIOUS chat would overwrite the NEW chat's model-facing history.
  const historyGenRef = useRef(0);
  const compactCtrlRef = useRef<AbortController | null>(null);
  const releaseCompactOwnership = useCallback(() => {
    historyGenRef.current++;
    if (compactCtrlRef.current) {
      compactCtrlRef.current.abort();
      compactCtrlRef.current = null;
    }
    compactingRef.current = false;
  }, []);
  // Latest getters without re-render coupling (Phase 10 browser markers).
  const getBrowserSessionRef = useRef(getBrowserSession);
  getBrowserSessionRef.current = getBrowserSession;
  const getBrowserArmedRef = useRef(getBrowserArmed);
  getBrowserArmedRef.current = getBrowserArmed;

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
    // I28: bind this run to the history generation it was started against.
    const gen = historyGenRef.current;
    const ctrl = new AbortController();
    compactCtrlRef.current = ctrl;

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
        { model, apiUrl, apiKey, mode, signal: ctrl.signal },
      );

      // I28: the conversation was swapped mid-flight (load/clear/edit/retry
      // bumped the generation) — this result belongs to a dead history.
      // Discard it and publish NOTHING against the new chat.
      if (gen !== historyGenRef.current) return null;

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
          // I04: the pipeline hands back structured attachment stubs (slim
          // indexed refs on the compacted message, full-text stubs on the
          // tail) so evidence re-enters the prompt on the next send.
          attachments: (lm.attachments as Attachment[] | undefined) ?? [],
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
      if (gen !== historyGenRef.current) return null;
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
      // Only the CURRENT run may clear the flag: a superseded one already
      // had its ownership released by the transition that bumped the gen.
      if (compactCtrlRef.current === ctrl) {
        compactingRef.current = false;
        compactCtrlRef.current = null;
        setCompactState((s) => ({ ...s, isCompacting: false }));
      }
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
  // F18 (brief 2026-11-15) — TURN OWNERSHIP. Every stream frame is tagged with
  // the turn that created it and applied only while that turn is current, so a
  // late frame from an abandoned/superseded turn can never write citations,
  // activity entries, revisions or usage onto the newest assistant bubble.
  // The fence itself is a pure module (lib/progress/turnFence.ts).
  const fenceRef = useRef<TurnFence | null>(null);
  if (!fenceRef.current) fenceRef.current = createTurnFence();
  const fence = fenceRef.current;
  const streamContentRef = useRef<string>("");
  const reasoningStartRef = useRef<number | null>(null);
  /** §3 (2026-11-13): accumulated reasoning INTERVAL ms for the turn. */
  const reasoningMsAccumRef = useRef(0);
  /** Start of the currently-open reasoning interval; null = not reasoning now. */
  const reasoningIntervalStartRef = useRef<number | null>(null);
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
      // §3 (2026-11-13): reasoningMs = TOTAL across the ACTUAL reasoning
      // intervals (thinking→tool→thinking cycles accumulate; closed
      // intervals stay closed). Replaces the old first-flush latency stamp,
      // which read as a fake "Thought for 0.0s" and poisoned the ETA baseline.
      if (reasoning && reasoningStartRef.current != null) {
        const elapsed = reasoningMsAccumRef.current
          + (reasoningIntervalStartRef.current != null ? Date.now() - reasoningIntervalStartRef.current : 0);
        if (elapsed > 0) next.reasoningMs = elapsed;
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

  // §3 (2026-11-13 brief): thinking DURATION spans the ACTUAL intervals. An
  // interval opens with the first reasoning delta after a gap and closes when
  // the turn moves on — content starts, a web action starts (the model paused
  // reasoning to act), or the turn finalizes. Tool rounds and writing are
  // never billed as thinking.
  const closeReasoningInterval = useCallback(() => {
    const start = reasoningIntervalStartRef.current;
    if (start == null) return;
    reasoningMsAccumRef.current += Date.now() - start;
    reasoningIntervalStartRef.current = null;
  }, []);

  // §3 closure law: an activity opened by a "started" frame must not outlive
  // its turn. Engines close per-action; this stamps any entry still open when
  // the TURN ends (user cancel → "cancelled"; stream error / unresolved
  // action → "interrupted"). Pure logic lives in the lib helper (testable).
  const closeOpenActivities = useCallback((id: string, status: "cancelled" | "interrupted") => {
    setMessages(prev => prev.map(m => m.id === id
      ? { ...m, webActivity: closeOpenActivityEntries(m.webActivity, status) }
      : m));
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
    releaseCompactOwnership(); // I28: an in-flight compact must not survive the swap
    // F18/F21 ownership: SWITCHING CONVERSATIONS ends the previous turn. Its
    // frames are fenced off, its transport is actually cancelled (so the
    // server can release the single shared upstream permit instead of a
    // hidden background turn), and its per-turn accumulators are cleared
    // rather than leaking into the conversation the user just opened.
    fence.invalidate();
    abortRef.current?.abort();
    abortRef.current = null;
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
    reasoningMsAccumRef.current = 0;
    reasoningIntervalStartRef.current = null;
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    stopProgressTick();
    progressRef.current = null;
    fenceOpenedRef.current = false;
    setTurnProgress(null);
  }, [stopProgressTick, releaseCompactOwnership, fence]);

  const clear = useCallback(() => {
    releaseCompactOwnership(); // I28
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    llmHistoryRef.current = [];
    llmPendingRef.current = null;
    compactThresholdsRef.current = null;
    setCompactState({ lastRun: null, isCompacting: false, badgeAt: -1 });
    lastInputRef.current = null;
    assistantIdRef.current = null;
    fence.invalidate();
    streamContentRef.current = "";
    pendingContentRef.current = "";
    pendingReasoningRef.current = "";
    setStatus("complete");
    setError(null);
    setIsThinking(false);
    setReasoningContent("");
    reasoningContentStateRef.current = "";
    reasoningStartRef.current = null;
    reasoningMsAccumRef.current = 0;
    reasoningIntervalStartRef.current = null;
    stopProgressTick();
    progressRef.current = null;
    fenceOpenedRef.current = false;
    setTurnProgress(null);
  }, [stopProgressTick, releaseCompactOwnership, fence]);

  const handleEvent = useCallback((
    ev: any,
    abort: AbortController | null,
    turn: TurnRef | null,
  ) => {
    // F18 ownership gate (checked BEFORE the abort signal): a frame is applied
    // only while the turn THAT PRODUCED IT is still current. Abandoning a turn
    // by switching chats never fired its abort signal, so without this fence a
    // late frame from the old turn used to land on the newest assistant bubble
    // — writing citations, activity entries or usage onto the wrong turn and
    // making evidence history look like current work.
    if (!fence.owns(turn)) return;
    if (abort?.signal.aborted) return;
    const id = turn.id; // the message this frame belongs to, never "whatever is current now"

    // Server phase frames (ruke_stage): real counts into the tracker, plus
    // web metadata that streamed turns deliver in-band instead of headers.
    if (ev.stage) {
      // Browser Use (Phase 3 seam): browser:* frames steer the Browser
      // Panel store (open/active/idle). The progress tracker still sees
      // the frame below — we do not swallow stage events.
      if (typeof ev.stage.stage === "string" && ev.stage.stage.startsWith("browser:")) {
        // Audit #10: working_tab frames carry the SESSION+TURN+TAB
        // qualifiers too (wire `tabId`/`turn` ⇔ Rust `tab_id`/`turn`); the
        // store refuses cross-session and stale-turn frames with them.
        handleBrowserStage(ev.stage.stage, ev.stage.session, ev.stage.tabId, ev.stage.turn);
      }
      if (ev.stage.stage === "web_meta") {
        const gateMeta = ev.stage.searchGate ?? ev.stage.researchLfm;
        // P5 rich-results transport: the frame carries the PresentationPlan
        // and the full validated surface set (OVERWRITE law — every re-emit
        // ships the FULL set, never a delta). The frame also fires with a
        // surfaces-only payload (no citation packets, e.g. news items from
        // ranked results alone), so the store condition covers all four
        // payloads. Defense in depth (§60): the client re-runs the canonical
        // sanitizer on every envelope even though the server already
        // sanitized — tamper/old-server drift drops a surface gracefully,
        // never the response (one broken widget law, §59).
        const rawSurfaces: unknown[] | null = Array.isArray(ev.stage.richResults)
          ? (ev.stage.richResults as unknown[])
          : null;
        const surfaces: RichResult[] | null = rawSurfaces
          ? rawSurfaces
              .map(sanitizeRichResult)
              .filter((r): r is RichResult => r !== null)
          : null;
        if (id && (ev.stage.webCitations || gateMeta || surfaces || ev.stage.presentation)) {
          setMessages(prev => prev.map(m => m.id === id ? {
            ...m,
            ...(ev.stage.webCitations ? { webCitations: ev.stage.webCitations } : {}),
            ...(gateMeta ? { searchGate: gateMeta } : {}),
            ...(ev.stage.presentation ? { presentation: ev.stage.presentation } : {}),
            ...(surfaces && surfaces.length > 0 ? { richResults: surfaces } : {}),
            // P3b: the server-issued action record stamps straight
            // through — display/audit metadata, never re-sent upstream.
            ...(ev.stage.researchLedger ? { webResearchLedger: ev.stage.researchLedger } : {}),
          } : m));
        }
      }
      // Streaming reliability law (2026-11-12): content already streamed
      // LIVE can still be revised/retracted by the server-side audit. The
      // frame is a whole-round replace (cut = turn-wide UTF-16 offset);
      // flush queued delta appends FIRST, then rewrite the message AND the
      // stream accumulator together so a later rAF flush can never
      // resurrect retracted bytes.
      if (ev.stage.stage === "web:content_revise") {
        flushPending(true);
        {
          const rawCut = ev.stage.contentCutTo;
          const repl = typeof ev.stage.contentText === "string" ? ev.stage.contentText : "";
          const applyCut = (base: string): string => {
            const cut = Number.isFinite(rawCut) ? Math.max(0, Math.trunc(rawCut)) : base.length;
            return base.slice(0, Math.min(cut, base.length)) + repl;
          };
          streamContentRef.current = applyCut(streamContentRef.current);
          setMessages(prev => prev.map(m =>
            m.id === id ? { ...m, content: applyCut(typeof m.content === "string" ? m.content : "") } : m
          ));
        }
      }
      // §D law: per-action activity frames feed the ONE authoritative
      // activity list on the streaming message — started frames open an
      // entry, terminal frames close it (matched on the most recent open
      // entry with the same kind+round, ⇔ the engine's pairing).
      if (ev.stage.stage === "web:activity") {
        closeReasoningInterval(); // the engine is acting — thinking is on hold (§3 interval law)
        if (id) {
          const entry = {
            kind: String(ev.stage.activity ?? "unknown"),
            status: String(ev.stage.activityStatus ?? "started"),
            ...(typeof ev.stage.detail === "string" && ev.stage.detail ? { detail: ev.stage.detail } : {}),
            ...(Number.isFinite(ev.stage.done) ? { done: Number(ev.stage.done) } : {}),
            ...(Number.isFinite(ev.stage.total) ? { total: Number(ev.stage.total) } : {}),
            ...(Number.isFinite(ev.stage.round) ? { round: Number(ev.stage.round) } : {}),
          };
          setMessages(prev => prev.map(m => {
            if (m.id !== id) return m;
            const list = m.webActivity ?? [];
            let at = -1;
            if (entry.status !== "started") {
              for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].kind === entry.kind && list[i].round === entry.round && list[i].status === "started") {
                  at = i;
                  break;
                }
              }
            }
            const next = at >= 0 ? list.map((a, i) => (i === at ? entry : a)) : [...list, entry];
            return { ...m, webActivity: next.slice(-40) }; // no unbounded per-action flooding
          }));
        }
      }
      const t = progressRef.current;
      if (t) {
        t.noteStage(ev.stage);
        setTurnProgress(t.snapshot(Date.now()));
      }
      return;
    }

    if (ev.reasoning) {
      if (reasoningStartRef.current == null) reasoningStartRef.current = Date.now();
      // One interval + tracker beat per reasoning RESUMPTION, so a
      // thinking→tool→thinking cycle reopens the "Thinking…" step instead of
      // leaving the panel stuck on the previous phase (§3 cycle law).
      if (reasoningIntervalStartRef.current == null) {
        reasoningIntervalStartRef.current = Date.now();
        progressRef.current?.noteReasoningStart();
      }
      pendingReasoningRef.current += ev.reasoning;
      setIsThinking(true);
      scheduleFlush();
    }
    if (ev.content) {
      closeReasoningInterval(); // writing has begun: the thinking interval ends
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
      if (id) {
        setMessages(prev => prev.map(m => m.id === id ? { ...m, usage: ev.usage } : m));
      }
    }
    if (ev.finishReason === "abort" || ev.finishReason === "error") {
      setStatus(ev.finishReason === "abort" ? "aborted" : "error");
      // The server's real failure detail when it has one; the generic label
      // only survives when the wire carried nothing truthful (brief
      // 2026-11-13 §2: never bury the actual reason behind a fixed string).
      setError(ev.finishReason === "error" ? ev.errorMessage || "Generation failed" : null);
      setIsThinking(false);
    }
  }, [scheduleFlush, flushPending, closeReasoningInterval, fence]);

  const runRepairRounds = useCallback(async (
    assistantId: string,
    history: any[],
    effort: EffortLevel,
    controller: AbortController,
    decisionMode: RendererMode | null,
    locate: (content: string) => BrokenFence[],
    stopAfterFirstApply = false,
  ): Promise<"clean" | "repaired" | "aborted" | "unrepaired"> => {
    // F153 (2026-11-24): the TERMINAL-OUTCOME law. Every exit of a repair
    // round resolves the "Auto-repairing…" badge: clean, applied, aborted,
    // or — rounds exhausted with fences still broken — an honest terminal
    // notice. The badge must never keep spinning on a finished turn.
    const settleBadge = (badge: string | undefined) =>
      setMessages(prev => prev.map(m =>
        (m.id === assistantId && (m.fenceRepair !== undefined || badge !== undefined))
          ? { ...m, fenceRepair: badge } : m));
    for (let attempt = 0; attempt < MAX_FENCE_REPAIRS; attempt++) {
      if (controller.signal.aborted) { settleBadge(undefined); return "aborted"; }
      const content = streamContentRef.current;
      const broken = locate(content);
      if (broken.length === 0) {
        settleBadge(undefined);
        return "clean";
      }

      const lang = broken[0].lang;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, fenceRepair: "🔄 Auto-repairing the output…" } : m)));
      // Real round count into the progress panel (auto-repair turns only).
      const t = progressRef.current;
      if (t && t.snapshot(Date.now()).state === "running") {
        t.setRepair(attempt + 1, MAX_FENCE_REPAIRS);
        setTurnProgress(t.snapshot(Date.now()));
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
        settleBadge(undefined); // the turn is already ending on its own error
        return "aborted";
      }
      if (controller.signal.aborted) { settleBadge(undefined); return "aborted"; }

      const corrected = extractFenceBody(reply, lang);
      if (!corrected) continue;
      const repaired = applyFenceRepair(content, broken[0], corrected);
      streamContentRef.current = repaired;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: repaired, fenceRepair: undefined } : m)));
      if (stopAfterFirstApply) return "repaired";
    }
    // Rounds exhausted and a fence is still broken: the badge resolves to
    // an honest terminal notice — the viewer card keeps the exact error.
    settleBadge("Auto-repair did not produce a valid fence — the viewer shows the exact error.");
    return "unrepaired";
  }, [model, apiUrl, apiKey]);

  // The 3D/CAD runtime-error repair path (requestFenceRepair) was removed
  // 2026-11-06 when the Three.js/CAD viewers retired (Ruke plan Phase 4);
  // anatomy auto-repair fell with the anatomy mode on 2026-11-07 (user
  // directive). Streaming-completion auto-repair (runRepairRounds) stays
  // for document fences.

  const send = useCallback(async (text: string, opts: { mode?: ChatMode; attachments?: any[] } = {}): Promise<boolean> => {
    // F153 (2026-11-24): the composerGate acceptance law — a turn exists with
    // text OR ready evidence. A ready file with no typed text is a complete
    // request (the model's task is to read it). A REFUSED send (busy, nothing
    // sendable) answers false and the composer leaves the draft and tray
    // untouched: previously this guard silently returned on an attachment-only
    // send while ChatInput had already emptied the tray — the ready file was
    // destroyed and no request was ever made.
    if (sendBusyRef.current) return false;
    if (!acceptsTurn({ text, attachments: opts.attachments ?? [] })) return false;
    sendBusyRef.current = true;
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
      reasoningMsAccumRef.current = 0;
      reasoningIntervalStartRef.current = null;
      pendingContentRef.current = "";
      pendingReasoningRef.current = "";
      setIsThinking(!!curEffort && curEffort !== "off");
      assistantIdRef.current = assistantMsg.id;
      streamContentRef.current = "";
      decisionModeRef.current = null;
      // F18: this turn becomes the single current turn. Anything captured from
      // an earlier turn is now stale and its frames are dropped.
      const turn = fence.begin(assistantMsg.id);

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

      // F16 (2026-11-15): `chat()` resolving is NOT proof the turn succeeded.
      // The stream now settles with an explicit terminal outcome, and this hook
      // — the owner of persistence, repair and status — must honour it.
      const settlement = await client.chat(
        {
          messages: requestHistory,
          model,
          stream: true,
          reasoning_effort: curEffort === "off" ? undefined : curEffort,
          tools,
          // Browser routing law (brief #2 + user rescope 2026-11-07):
          // `browser_session` rides on EVERY chat send as conversation
          // identity ONLY; `browser_armed` rides as true solely while the
          // Browser Panel is open (the human's explicit "open browser"
          // action). The SERVER arms the engine via
          // task_scope::browser_activates (Operate fold ∧ armed-or-words)
          // — plain web search never opens the panel. Still never set on
          // compaction/fence-repair calls (their own paths).
          browser_session: getBrowserSessionRef.current?.(),
          browser_armed: getBrowserArmedRef.current?.() ? true : undefined,
          // P1 clock grounding: the zone the user experiences "now" in.
          // The route answers time/date questions from the server clock
          // converted to this zone (never its own machine zone).
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        (ev) => handleEvent(ev, controller, turn),
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

      // Flush any pending rAF-batched deltas before finalizing. Close the
      // reasoning interval FIRST so the final reasoningMs excludes the
      // finalize bookkeeping itself.
      closeReasoningInterval();
      flushPending(true);

      // F16: never run a repair/continuation round on a turn that failed, was
      // cancelled or ended mid-tool-round — those turns need a retry, not an
      // extra model call that "fixes" an answer the human never accepted.
      if (!controller.signal.aborted && settlement.outcome === "success") {
        const curMode = decisionModeRef.current;
        await runRepairRounds(
          assistantMsg.id,
          requestHistory,
          curEffort,
          controller,
          curMode,
          (content) => findBrokenRenderFences(content, curMode),
        );
        // No mirror here — appending this turn to the model-facing base is
        // queued in `finally` and applied lazily by materializeLlmHistory.
        // Mirroring `messagesRef` would UNDO any compaction.
      }

      const turnOutcome = settlement.outcome;
      if (turnOutcome === "cancelled" || controller.signal.aborted) {
        closeOpenActivities(assistantMsg.id, "cancelled");
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id && m.state === "streaming"
            ? { ...m, state: "complete", finishedAt: Date.now() }
            : m
        ));
        setStatus("aborted");
        finishProgress("aborted");
      } else if (turnOutcome === "error" || turnOutcome === "incomplete_tool_round") {
        // F16 law: an errored or orphaned-tool-round turn MUST NOT be recorded
        // as complete. The partial text the human already saw stays on the
        // bubble (never erased), but the turn is flagged and its actions close
        // as interrupted.
        const reason = settlement.errorMessage
          || (turnOutcome === "incomplete_tool_round"
            ? "The model asked to use a tool, but the turn ended before the tool ran."
            : "Generation failed");
        closeOpenActivities(assistantMsg.id, "interrupted");
        setError(reason);
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "error", error: reason, finishedAt: Date.now() } : m
        ));
        setStatus("error");
        setReasoningContent("");
        reasoningContentStateRef.current = "";
        finishProgress("error");
      } else {
        // success, or a truncated answer: partial text is REAL content, so the
        // bubble stays complete and readable — but a truncation is named, never
        // presented as a finished answer.
        // §3 closure safety net: engines close every action, so an entry
        // still open here means its terminal frame never arrived.
        closeOpenActivities(assistantMsg.id, "interrupted");
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now() } : m
        ));
        if (turnOutcome === "truncated") {
          setError("The model stopped before finishing the answer. The text above is what it managed to write.");
          setStatus("error");
          finishProgress("error");
        } else {
          setStatus("complete");
          finishProgress("complete");
        }
        setReasoningContent("");
        reasoningContentStateRef.current = "";
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        const msg = e?.message ?? "Generation failed";
        setError(msg);
        closeReasoningInterval();
        if (assistantId) closeOpenActivities(assistantId, "interrupted");
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, state: "error", error: msg } : m
        ));
        setStatus("error");
        finishProgress("error");
      } else {
        closeReasoningInterval();
        if (assistantId) closeOpenActivities(assistantId, "cancelled");
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
    // The turn was ACCEPTED and ran (its outcome is carried by status/error;
    // false is returned only for a refusal, where nothing happened).
    return true;
  }, [model, apiUrl, apiKey, handleEvent, runRepairRounds, flushPending,
      flushProgress, stopProgressTick, finishProgress, compact, materializeLlmHistory,
      closeReasoningInterval, closeOpenActivities]);

  const stop = useCallback(() => {
    const id = assistantIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    closeReasoningInterval();
    flushPending(true);
    if (id) {
      closeOpenActivities(id, "cancelled");
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
  }, [flushPending, finishProgress, closeReasoningInterval, closeOpenActivities]);

  const retry = useCallback(() => {
    if (!lastInputRef.current) return;
    // F153: rewind + accepted resend is ONE operation. If the send owner
    // would refuse — a turn is generating, or nothing is sendable — retry
    // does NOTHING: the histories stay exactly as they were. (Previously
    // the rewind ran first and the silent send rejection left the
    // conversation rewound with nothing re-sent.)
    if (sendBusyRef.current) return;
    const { text, mode, attachments } = lastInputRef.current;
    if (!acceptsTurn({ text, attachments: attachments as Attachment[] })) return;
    releaseCompactOwnership(); // I28: the rewind invalidates any in-flight fold
    // Compute the filtered history synchronously from messagesRef (kept
    // current by the render-time sync) — the rewind below must see it
    // BEFORE send() starts, which an updater-form setMessages cannot
    // guarantee.
    const { filtered, removedIds } = retryRewind(messagesRef.current);
    if (removedIds.length) {
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
        // turn): drop the retried reply AND its user prompt by id — the
        // F153 single-use law; send() appends the fresh user message. A
        // compacted replacement array carries synthetic ids, so it is
        // left untouched by design.
        const kill = new Set(removedIds);
        llmHistoryRef.current = llmHistoryRef.current.filter(m => !kill.has(m.id));
      }
    }
    setError(null);
    send(text, { mode, attachments });
  }, [send, releaseCompactOwnership]);

  const edit = useCallback((id: string, newContent: string) => {
    // F153: validate BEFORE touching history. An empty edit is not an edit
    // (acceptsEdit), and an edit while a turn is generating is refused -
    // previously both truncated the histories, and the refused resend
    // destroyed the conversation with nothing sent in its place.
    if (!acceptsEdit(newContent) || sendBusyRef.current) return;
    releaseCompactOwnership(); // I28: rewinding invalidates an in-flight fold
    // Capture the generation AFTER this edit-s bump: a chat switch
    // (load/clear) between now and the deferred resend bumps it again, and
    // the resend belongs to the chat that ASKED for the edit - never to
    // whatever chat is open when the timeout fires.
    const gen = historyGenRef.current;
    abortRef.current?.abort();
    abortRef.current = null;

    const prev = messagesRef.current;
    const idx = prev.findIndex(m => m.id === id);
    if (idx < 0) return;
    const orig = prev[idx];
    const filtered = prev.slice(0, idx);
    messagesRef.current = filtered;
    llmHistoryRef.current = filtered; // an edit rewinds both histories
    // Discard any pending rebuild — its base/uiLen predate the edit and its
    // re-slice would re-append the truncated messages at the next send.
    llmPendingRef.current = null;
    // I27: re-sending an edited message must keep its evidence — the
    // original attachments and mode ride along (previously they were
    // dropped: an edited "summarize this PDF" went out bare).
    const resend = { mode: orig.mode ?? "chat", attachments: orig.attachments ?? [] };
    lastInputRef.current = { text: newContent, mode: resend.mode, attachments: resend.attachments };
    setMessages(filtered);
    setStatus("complete");
    setTimeout(() => {
      // F153: a chat switch (load/clear) between the edit and its deferred
      // resend bumps the generation - the resend belongs to the chat that
      // asked for the edit, never to whatever chat is open now.
      if (historyGenRef.current === gen) send(newContent, resend);
    }, 0);
  }, [send, releaseCompactOwnership]);

  return {
    messages, status, error, isThinking, reasoningContent,
    load, clear, send, stop, retry, edit,
    clearError: () => setError(null),
    setEffort, effort,
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
