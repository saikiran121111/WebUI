"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import type { BrowserTool } from "../lib/browser/agentBrowser";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import { ResearchOrchestrator } from "../lib/research/orchestrator";
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
  /** Swap the conversation entirely. */
  load: (conversation: Conversation) => void;
  /** Drop all messages (new chat / after deleting the active one). */
  clear: () => void;
  send: (text: string, opts?: { mode?: ChatMode; attachments?: any[] }) => void;
  stop: () => void;
  retry: () => void;
  edit: (id: string, newContent: string) => void;
  clearError: () => void;
  setEffort: (level: EffortLevel) => void;
  effort: EffortLevel;
  /** Repair a fence that only fails at runtime (```threejs code throws in the viewer). */
  requestFenceRepair: (assistantId: string, info: { lang: string; body: string; error: string }) => void;
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

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastInputRef = useRef<{ text: string; mode: ChatMode; attachments: any[] } | null>(null);
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const assistantIdRef = useRef<string | null>(null);
  const streamContentRef = useRef<string>("");
  /** Tracks when reasoning started so reasoningMs can be set on the message. */
  const reasoningStartRef = useRef<number | null>(null);
  /** Guards send() against double-fire from rapid calls (e.g. edit + save). */
  const sendBusyRef = useRef(false);
  /** Shared abort controller so `stop` can cancel an in-flight stream. */
  const abortRef = useRef<AbortController | null>(null);
  /** Decision Engine mode of the in-flight turn (x-decision-mode header). */
  const decisionModeRef = useRef<RendererMode | null>(null);

  const load = useCallback((conversation: Conversation) => {
    setMessages(conversation.messages ?? []);
    messagesRef.current = conversation.messages ?? [];
    lastInputRef.current = null;
    setStatus("complete");
    setError(null);
    setIsThinking(false);
    setReasoningContent("");
    reasoningStartRef.current = null;
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    lastInputRef.current = null;
    assistantIdRef.current = null;
    streamContentRef.current = "";
    setStatus("complete");
    setError(null);
    setIsThinking(false);
    setReasoningContent("");
    reasoningStartRef.current = null;
  }, []);

  const handleEvent = useCallback((ev: any, abort: AbortController | null) => {
    if (abort?.signal.aborted) return;

    if (ev.reasoning) {
      if (reasoningStartRef.current == null) reasoningStartRef.current = Date.now();
      setReasoningContent(prev => prev + ev.reasoning);
      setIsThinking(true);
      if (assistantIdRef.current) {
        setMessages(prev => prev.map(m =>
          m.id === assistantIdRef.current
            ? { ...m, reasoning: (m.reasoning as string) + ev.reasoning }
            : m
        ));
      }
    }
    if (ev.content) {
      streamContentRef.current += ev.content;
      // Close out the reasoningMs when the first content chunk arrives.
      if (reasoningStartRef.current != null && assistantIdRef.current) {
        const elapsed = Date.now() - reasoningStartRef.current;
        setMessages(prev => prev.map(m =>
          m.id === assistantIdRef.current && m.reasoningMs == null
            ? { ...m, reasoningMs: elapsed }
            : m
        ));
        reasoningStartRef.current = null;
      }
      setMessages(prev => prev.map(m =>
        m.id === (assistantIdRef.current ?? "")
          ? { ...m, content: (m.content as string) + ev.content }
          : m
      ));
      setIsThinking(false);
    }
    if (ev.finishReason === "abort" || ev.finishReason === "error") {
      setStatus(ev.finishReason === "abort" ? "aborted" : "error");
      setError(ev.finishReason === "error" ? "Generation failed" : null);
      setIsThinking(false);
    }
  }, []);

  /**
   * Fence repair for anatomy / scene3d / cad fences. A broken fence is the
   * model's mistake and only the model can fix it: feed the exact error back
   * (the broken fence already sits in its history), splice the corrected
   * fence into the same bubble. Anatomy repairs stay silent (existing
   * contract); 3D/CAD repairs show a visible "Auto-repairing…" note so the
   * user knows the model is retrying instead of a dead error panel. After
   * MAX_FENCE_REPAIRS rounds the honest error fallback stays as last resort.
   */
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
            // Pin the mode: the repair round belongs to the failed fence's
            // mode; re-deciding on an error message could misroute it.
            decision_mode: decisionMode ?? undefined,
          },
          (ev) => { if (ev.content) reply += ev.content; },
          controller.signal,
        );
      } catch {
        return; // aborted or upstream failure: leave the fence for the fallback
      }
      if (controller.signal.aborted) return;

      const corrected = extractFenceBody(reply, lang);
      if (!corrected) continue; // model answered without a fence: ask again
      const repaired = applyFenceRepair(content, broken[0], corrected);
      streamContentRef.current = repaired;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: repaired, fenceRepair: undefined } : m)));
      if (stopAfterFirstApply) return;
    }
  }, [model, apiUrl, apiKey]);

  // Manual "Fix with AI" / runtime-error repair cap, per message.
  const fenceRepairAttemptsRef = useRef(new Map<string, number>());

  /**
   * Repair a fence that only fails at RUNTIME (```threejs code that throws
   * inside the viewer) — it passed every static check, so the block itself
   * reports the exact error and we feed it straight back to the model.
   */
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
    // Zero-collision: runtime fence repair only runs when this message's
    // Decision Engine mode actually owns that fence family.
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

  /**
   * The post-answer claim audit (/api/verify-claims) was removed with the
   * web-verify ledger (2026-10-22). Nothing fetches from that endpoint
   * anymore; the type field `webVerification` stays for older stored
   * conversations only.
   */

  const send = useCallback(async (text: string, opts: { mode?: ChatMode; attachments?: any[] } = {}) => {
    // sendBusyRef is the real concurrency guard — `status` here would be a
    // stale closure value (it isn't a dep of this useCallback).
    if (!text.trim() || sendBusyRef.current) return;
    sendBusyRef.current = true;
    // Kept outside the try so the catch can still mark the right bubble.
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
        // Carried on the message itself so the request builder can inline each
        // file's content (text / image / frames / transcript) into the prompt.
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
      reasoningStartRef.current = null;
      setIsThinking(!!curEffort && curEffort !== "off");
      assistantIdRef.current = assistantMsg.id;
      streamContentRef.current = "";
      decisionModeRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;

      const client = new ChatClient(apiUrl, apiKey, model);
      const tools = mode === "research" ? buildResearchToolDefs() : undefined;

      // Snapshot the request history BEFORE the stream: a repair round must
      // replay the exact conversation the broken reply was generated from.
      const requestHistory = [...messagesRef.current, userMsg];

      await client.chat(
        { messages: requestHistory, model, stream: true, reasoning_effort: curEffort === "off" ? undefined : curEffort, tools },
        (ev) => handleEvent(ev, controller),
        controller.signal,
        // Metadata headers: user-tier skill pill + the Decision Engine's
        // active_mode, which gates every renderer/validator for this reply.
        (headers) => {
          const mode = headers.get("x-decision-mode");
          if (mode && isRendererMode(mode)) {
            decisionModeRef.current = mode;
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, decisionMode: mode } : m
            ));
          }
          const skill = headers.get("X-Used-Skill");
          if (skill) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, usedSkill: skill } : m
            ));
          }
          // Web-research citations: the [S#] map the main-model-gated
          // pipeline produces, used by ResearchTrailCard + the citation pills.
          const raw = headers.get("X-Web-Citations");
          if (raw) {
            try {
              const webCitations = JSON.parse(decodeURIComponent(raw));
              setMessages(prev => prev.map(m =>
                m.id === assistantMsg.id ? { ...m, webCitations } : m
              ));
            } catch {
              // Malformed header — the pills simply won't render, the
              // answer itself is unaffected.
            }
          }
          // LFM decision summary: shown collapsed in the Research Trail card.
          const rawLfm = headers.get("X-Research-Lfm");
          if (rawLfm) {
            try {
              const researchLfm = JSON.parse(decodeURIComponent(rawLfm));
              setMessages(prev => prev.map(m =>
                m.id === assistantMsg.id ? { ...m, researchLfm } : m
              ));
            } catch {
              /* ignore */
            }
          }
        },
      ).catch((e: any) => {
        throw e;
      });

      // Broken fences of the ACTIVE mode only get repaired before the bubble
      // is finalized — the user sees the finished visual, not the error.
      // Off-mode fences are never even scanned (zero-collision rule).
      if (!controller.signal.aborted) {
        const mode = decisionModeRef.current;
        await runRepairRounds(
          assistantMsg.id,
          requestHistory,
          curEffort,
          controller,
          mode,
          (content) => findBrokenRenderFences(content, mode),
        );
      }

      if (!controller.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now() } : m
        ));
        setStatus("complete");
        setReasoningContent("");
        // The post-answer claim audit (/api/verify-claims) was removed with
        // the web-verify ledger (2026-10-22): the answer carries [S#]
        // citations and the model's own honest wording, nothing more.
      } else {
        // Finalize the partial bubble: stop the blinking cursor and bring
        // back the actions row even though the stream never finished.
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id && m.state === "streaming"
            ? { ...m, state: "complete", finishedAt: Date.now() }
            : m
        ));
        setStatus("aborted");
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        const msg = e?.message ?? "Generation failed";
        setError(msg);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, state: "error", error: msg } : m
        ));
        setStatus("error");
      } else {
        // stop(): the abort branch above already set "aborted" — fall
        // through to finally's guard, which never re-sets "streaming".
      }
      setReasoningContent("");
    } finally {
      setIsThinking(false);
      abortRef.current = null;
      sendBusyRef.current = false;
      // Invariant: the composer's "Stop generating" button is tied to
      // status === "streaming". Every exit path (completed, aborted,
      // error, or repair round) must leave "streaming" behind — otherwise
      // the stop button stays on screen and the composer is locked until
      // the user happens to send another message.
      setStatus(prev => (prev === "streaming" ? "complete" : prev));
    }
  }, [model, apiUrl, apiKey, handleEvent, runRepairRounds]);

  const stop = useCallback(() => {
    const id = assistantIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    // Finalize the partial bubble so the cursor stops blinking and the
    // actions row appears; the stream's own finally cleans up the rest.
    if (id) {
      setMessages(prev => prev.map(m =>
        m.id === id && m.state === "streaming"
          ? { ...m, state: "complete", finishedAt: Date.now() }
          : m
      ));
    }
    // "aborted" only matters if the turn was actually streaming; once the
    // stream's finally has already flipped the status to "complete"/
    // "error", that later write must not clobber it.
    setStatus(prev => (prev === "streaming" ? "aborted" : prev));
    setError(null);
    setIsThinking(false);
  }, []);

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
    // Abort any in-flight generation FIRST. Without this the orphaned
    // stream keeps running (and its sendBusyRef blocks the replacement
    // send), while slicing away the streaming assistant bubble can empty
    // the screen back to the hero — the "edit redirects me home" bug.
    abortRef.current?.abort();
    abortRef.current = null;

    const prev = messagesRef.current;
    const idx = prev.findIndex(m => m.id === id);
    if (idx < 0) return;
    // Drop the edited user message AND everything after it — send() will
    // append exactly one fresh user + assistant pair, so we end up with a
    // single exchange on screen.
    const filtered = prev.slice(0, idx);
    messagesRef.current = filtered;
    lastInputRef.current = { text: newContent, mode: "chat", attachments: [] };
    setMessages(filtered);
    setStatus("complete");

    // One macrotask later: the aborted send's finally (pure microtasks by
    // then) has released sendBusyRef before the replacement send fires.
    setTimeout(() => send(newContent), 0);
  }, [send]);

  return {
    messages, status, error, isThinking, reasoningContent,
    load, clear, send, stop, retry, edit,
    clearError: () => setError(null),
    setEffort, effort, requestFenceRepair,
  };
}

function buildResearchToolDefs(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web via SearXNG and return ranked results.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_open",
        description: "Open a URL and return rendered text content.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browser_screenshot",
        description: "Take a screenshot of the current browser page.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];
}