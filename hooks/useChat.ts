"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import type { BrowserTool } from "../lib/browser/agentBrowser";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import { ResearchOrchestrator } from "../lib/research/orchestrator";
import {
  MAX_FENCE_REPAIRS,
  applyFenceRepair,
  extractAnatomyFenceBody,
  fenceRepairRequest,
  findBrokenAnatomyFences,
} from "../lib/render/fenceRepair";

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
    console.log("[handleEvent]", JSON.stringify(ev).slice(0, 200));

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
   * Silent anatomy fence repair. A broken ```anatomy fence is the model's
   * mistake and only the model can fix it: feed the exact validation error
   * back (the broken fence already sits in its history), splice the
   * corrected fence into the same bubble, and keep the repair turn out of
   * visible/persisted state — the user should never have to read a
   * validation error they cannot act on. After MAX_FENCE_REPAIRS rounds the
   * honest error fallback in AnatomyBlock remains as the last resort.
   */
  const repairAnatomyFences = useCallback(async (
    assistantId: string,
    history: any[],
    effort: EffortLevel,
    controller: AbortController,
  ) => {
    for (let attempt = 0; attempt < MAX_FENCE_REPAIRS; attempt++) {
      if (controller.signal.aborted) return;
      const content = streamContentRef.current;
      const broken = findBrokenAnatomyFences(content);
      if (broken.length === 0) return;

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
          },
          (ev) => { if (ev.content) reply += ev.content; },
          controller.signal,
        );
      } catch {
        return; // aborted or upstream failure: leave the fence for the fallback
      }
      if (controller.signal.aborted) return;

      const corrected = extractAnatomyFenceBody(reply);
      if (!corrected) continue; // model answered without a fence: ask again
      const repaired = applyFenceRepair(content, broken[0], corrected);
      streamContentRef.current = repaired;
      setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: repaired } : m)));
    }
  }, [model, apiUrl, apiKey]);

  const send = useCallback(async (text: string, opts: { mode?: ChatMode; attachments?: any[] } = {}) => {
    console.log("[send] called with:", text.slice(0, 30), "effort:", effortRef.current);
    // sendBusyRef is the real concurrency guard — `status` here would be a
    // stale closure value (it isn't a dep of this useCallback).
    if (!text.trim() || sendBusyRef.current) return;
    sendBusyRef.current = true;
    // Kept outside the try so the catch can still mark the right bubble.
    let assistantId: string | null = null;
    try {
      const mode = opts.mode ?? "chat";
      const curEffort = effortRef.current;
      console.log("[send] curEffort:", curEffort);
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

      const controller = new AbortController();
      abortRef.current = controller;

      const client = new ChatClient(apiUrl, apiKey, model);
      const tools = mode === "research" ? buildResearchToolDefs() : undefined;
      console.log("[send] calling client.chat with effort:", curEffort === "off" ? undefined : curEffort);

      // Snapshot the request history BEFORE the stream: a repair round must
      // replay the exact conversation the broken reply was generated from.
      const requestHistory = [...messagesRef.current, userMsg];

      await client.chat(
        { messages: requestHistory, model, stream: true, reasoning_effort: curEffort === "off" ? undefined : curEffort, tools },
        (ev) => handleEvent(ev, controller),
        controller.signal,
        // Skill engine metadata: the proxy names the fired skill via header.
        (headers) => {
          const skill = headers.get("X-Used-Skill");
          if (skill) {
            setMessages(prev => prev.map(m =>
              m.id === assistantMsg.id ? { ...m, usedSkill: skill } : m
            ));
          }
        },
      ).catch((e: any) => {
        console.log("[send] client.chat threw:", e?.message, e?.name);
        throw e;
      });

      // A broken anatomy fence gets silently repaired before the bubble is
      // finalized — the user sees the finished figure, not the error.
      if (!controller.signal.aborted) {
        await repairAnatomyFences(assistantMsg.id, requestHistory, curEffort, controller);
      }

      console.log("[send] after client.chat - was it aborted?", controller.signal.aborted);
      if (!controller.signal.aborted) {
        console.log("[send] stream completed normally");
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now() } : m
        ));
        setStatus("complete");
        setReasoningContent("");
      } else {
        console.log("[send] stream was aborted");
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
      console.log("[send] stream error:", e?.message);
      if (e?.name !== "AbortError") {
        const msg = e?.message ?? "Generation failed";
        setError(msg);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, state: "error", error: msg } : m
        ));
        setStatus("error");
      }
      setReasoningContent("");
    } finally {
      setIsThinking(false);
      abortRef.current = null;
      sendBusyRef.current = false;
    }
  }, [model, apiUrl, apiKey, handleEvent, repairAnatomyFences]);

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
    setStatus("aborted");
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
    setEffort, effort,
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