"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import { ChatClient, ChatClientError } from "../lib/chat/client";
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
import { buildResearchToolDefs, decodeSseHeaders } from "../lib/chat/streamHelpers";
import {
  computeBaselines,
  TurnProgressTracker,
  type TurnProgressSnapshot,
} from "../lib/progress/turnProgress";

export type SendStatus = "streaming" | "submitted" | "complete" | "error" | "aborted";

export interface UseChatOptions {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
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
}

function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export function useChat({
  model = "",
  apiUrl,
  apiKey,
}: UseChatOptions = {}): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus]   = useState<SendStatus>("complete");
  const [error, setError]     = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [reasoningContent, setReasoningContent] = useState("");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [turnProgress, setTurnProgress] = useState<TurnProgressSnapshot | null>(null);

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
    setMessages([]);
    messagesRef.current = [];
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
        if (id && (ev.stage.webCitations || ev.stage.researchLfm)) {
          setMessages(prev => prev.map(m => m.id === id ? {
            ...m,
            ...(ev.stage.webCitations ? { webCitations: ev.stage.webCitations } : {}),
            ...(ev.stage.researchLfm ? { researchLfm: ev.stage.researchLfm } : {}),
          } : m));
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
      const requestHistory = [...messagesRef.current, userMsg];

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
          if (hdrs.researchLfm) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, researchLfm: hdrs.researchLfm } : m
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
      setIsThinking(false);
      abortRef.current = null;
      sendBusyRef.current = false;
      stopProgressTick();
      setStatus(prev => (prev === "streaming" ? "complete" : prev));
    }
  }, [model, apiUrl, apiKey, handleEvent, runRepairRounds, flushPending,
      flushProgress, stopProgressTick, finishProgress]);

  const stop = useCallback(() => {
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
  }, [flushPending, finishProgress]);

  const retry = useCallback(() => {
    if (lastInputRef.current) {
      const { text, mode, attachments } = lastInputRef.current;
      setMessages(prev => {
        const reversed = [...prev].reverse();
        const idx = reversed.findIndex(m => m.role === "assistant");
        if (idx >= 0) {
          const removeId = reversed[idx].id;
          const filtered = prev.filter(m => m.id !== removeId);
          messagesRef.current = filtered;
          return filtered;
        }
        return prev;
      });
      setError(null);
      send(text, { mode, attachments });
    }
  }, [send]);

  const edit = useCallback((id: string, newContent: string) => {
    abortRef.current?.abort();
    abortRef.current = null;

    const prev = messagesRef.current;
    const idx = prev.findIndex(m => m.id === id);
    if (idx < 0) return;
    const filtered = prev.slice(0, idx);
    messagesRef.current = filtered;
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
  };
}
