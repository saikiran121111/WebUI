"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMode, Conversation, EffortLevel, Message, ToolCall, ToolDef, StreamEvent } from "../lib/types";
import { ChatClient, ChatClientError } from "../lib/chat/client";
import type { BrowserTool } from "../lib/browser/agentBrowser";
import { ResearchOrchestrator } from "../lib/research/orchestrator";

export type SendStatus = "streaming" | "submitted" | "complete" | "error" | "aborted";

export interface UseChatOptions {
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  onRequireResearch?: (query: string) => void;
}

export interface UseChatReturn {
  messages: Message[];
  status: SendStatus;
  error: string | null;
  isThinking: boolean;
  reasoningContent: string;
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

  const handleEvent = useCallback((ev: StreamEvent, abort: AbortController | null) => {
    if (abort?.signal.aborted) return;

    if (ev.reasoning) {
      setReasoningContent(prev => prev + ev.reasoning);
      setIsThinking(true);
    }
    if (ev.content) {
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
    setIsThinking(!!effort && effort !== "off");

    const controller = new AbortController();

    try {
      const client = new ChatClient(apiUrl, apiKey, model);
      const tools = mode === "research"
        ? buildResearchToolDefs()
        : undefined;

      await client.chat(
        {
          messages: [...messagesRef.current, userMsg],
          model,
          stream: true,
          reasoning_effort: effort === "off" ? undefined : effort,
          tools,
        },
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
        setError(e?.message ?? "Something went wrong");
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id ? { ...m, state: "error", error: e?.message } : m
        ));
        setStatus("error");
      }
    } finally {
      setIsThinking(false);
    }
  }, [model, apiUrl, apiKey, effort, handleEvent, status]);

  const stop = useCallback(() => {
    setStatus("aborted");
    setError(null);
    setIsThinking(false);
  }, []);

  const retry = useCallback(() => {
    if (lastInputRef.current) {
      const { text, mode, attachments } = lastInputRef.current;
      // Remove last assistant if failed/aborted
      setMessages(prev => {
        const reversed = [...prev].reverse();
        const idx = reversed.findIndex(m => m.role === "assistant");
        if (idx >= 0) {
          const removeId = reversed[idx].id;
          return prev.filter(m => m.id !== removeId);
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
      const updated = prev.map(m =>
        m.id === id ? { ...m, content: newContent } : m
      );
      messagesRef.current = updated;
      lastInputRef.current = { text: newContent, mode: "chat", attachments: [] };
      // Remove trailing assistant messages after this user message
      const after = updated.slice(idx + 1);
      const filtered = updated.filter((_, i) => !(i > idx && after[i - idx - 1]?.role === "assistant"));
      messagesRef.current = filtered;
      send(newContent);
      return filtered;
    });
  }, [send]);

  return {
    messages,
    status,
    error,
    isThinking,
    reasoningContent,
    send,
    stop,
    retry,
    edit,
    clearError: () => setError(null),
    setEffort,
    effort,
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
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_open",
        description: "Open a URL and return the rendered text content.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
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
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
  ];
}
