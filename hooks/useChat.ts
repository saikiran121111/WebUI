"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message } from "../lib/types";
import type { BrowserTool } from "../lib/browser/agentBrowser";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import { ResearchOrchestrator } from "../lib/research/orchestrator";

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
  }, []);

  const handleEvent = useCallback((ev: any, abort: AbortController | null) => {
    if (abort?.signal.aborted) return;

    if (ev.reasoning) {
      setReasoningContent(prev => prev + ev.reasoning);
      setIsThinking(true);
    }
    if (ev.content) {
      streamContentRef.current += ev.content;
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

  const send = useCallback(async (text: string, opts: { mode?: ChatMode; attachments?: any[] } = {}) => {
    if (!text.trim() || status === "streaming") return;
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
      attachments: [],
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

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setStatus("streaming");
    setError(null);
    setReasoningContent("");
    setIsThinking(!!curEffort && curEffort !== "off");
    assistantIdRef.current = assistantMsg.id;
    streamContentRef.current = "";

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const client = new ChatClient(apiUrl, apiKey, model);
      const tools = mode === "research" ? buildResearchToolDefs() : undefined;

      await client.chat(
        { messages: [...messagesRef.current, userMsg], model, stream: true, reasoning_effort: curEffort === "off" ? undefined : curEffort, tools },
        (ev) => handleEvent(ev, controller),
        controller.signal,
      );

      if (!controller.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "complete", finishedAt: Date.now() } : m
        ));
        setStatus("complete");
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        // Show the real error from the network/parse layer so the user and
        // developer can actually diagnose what went wrong.
        const msg = e?.message ?? "Generation failed";
        setError(msg);
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "error", error: msg } : m
        ));
        setStatus("error");
      }
    } finally {
      setIsThinking(false);
      abortRef.current = null;
    }
  }, [model, apiUrl, apiKey, handleEvent]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === id);
      if (idx < 0) return prev;
      const updated = prev.map(m => m.id === id ? { ...m, content: newContent } : m);
      messagesRef.current = updated;
      lastInputRef.current = { text: newContent, mode: "chat", attachments: [] };
      // Strip trailing assistant messages after this user message.
      const afterUser = updated.slice(idx + 1);
      const trailingAssistantIdx = afterUser.findIndex(m => m.role === "assistant");
      const keepUpTo = trailingAssistantIdx < 0 ? updated.length : idx + 1 + trailingAssistantIdx;
      const filtered = updated.slice(0, keepUpTo);
      messagesRef.current = filtered;
      // Kick off send with updated content.
      setTimeout(() => send(newContent), 0);
      return filtered;
    });
  }, [send]);

  return {
    messages, status, error, isThinking, reasoningContent,
    load, send, stop, retry, edit,
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