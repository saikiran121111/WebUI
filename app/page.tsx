"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDown } from "lucide-react";
import HeroComposer from "@/components/HeroComposer";
import ChatInput from "@/components/ChatInput";
import ChatMessage from "@/components/ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

const SYSTEM_PROMPT: string = `You are VibeThinker, an expert competitive programmer and mathematician specializing in LeetCode problems, coding interviews, and mathematical reasoning. For every problem, think step-by-step before writing any code. First, restate the problem and identify inputs, outputs, and constraints. Then analyze multiple approaches, evaluating time and space complexity for each, and select the optimal one. Before coding, enumerate edge cases including empty inputs, single elements, boundary values, negatives, zeros, duplicates, and overflow scenarios. Mentally trace your solution through at least one normal case and one edge case. Before finalizing, validate for off-by-one errors, incorrect loop bounds, integer overflow, division by zero, null references, and logical flaws. If you find any issue during validation, explicitly state what went wrong, revise your approach, and re-validate before presenting corrected code. When writing code, use meaningful variable names, proper edge-case handling, and comments only for non-obvious logic. After the code, provide a brief complexity analysis. For math problems, show step-by-step derivations. Use markdown for readability with code blocks and bullet points. Never present code you have not mentally traced through at least one test case. Prioritize correctness over speed.`;

export default function HomePage() {
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingContent, setThinkingContent] = useState("");
  const [hasScrolledUp, setHasScrolledUp] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const streamingMsgIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({
          behavior: smooth ? "smooth" : "auto",
          block: "end",
        });
      }
    },
    []
  );

  useEffect(() => {
    if (!hasScrolledUp && messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, hasScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      setHasScrolledUp(scrollHeight - scrollTop - clientHeight >= 100);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const parseSSE = (text: string) => {
    const lines = text.split("\n");
    const events: Record<string, unknown>[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;

      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6).trim();
        if (data === "[DONE]") {
          events.push({ done: true });
          continue;
        }

        try {
          events.push(JSON.parse(data));
        } catch {
          // Skip invalid JSON
        }
      }
    }

    return events;
  };

  const streamChat = async (
    userMessage: string,
    userMessageId: string,
    signal: AbortSignal
  ) => {
    setIsLoading(true);
    setError(null);
    setIsThinking(false);
    setThinkingContent("");

    const assistantMsgId = `assistant-${Date.now()}`;
    streamingMsgIdRef.current = assistantMsgId;

    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        thinkingContent: "",
        createdAt: Date.now(),
      },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: userMessage },
          ],
          stream: true,
          temperature: 0.7,
        }),
        signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${response.status}`);
      }

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentThinking = "";
      let currentContent = "";
      let thinkingStarted = false;
      let thinkingStart = 0;

      while (true) {
        if (signal.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        for (const event of parseSSE(buffer)) {
          if (event.done) {
            const duration = thinkingStarted
              ? Math.round((Date.now() - thinkingStart) / 1000)
              : undefined;

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      content: currentContent,
                      thinkingContent: currentThinking,
                      thinkingDuration: duration,
                      isStreaming: false,
                    }
                  : m
              )
            );
            setIsThinking(false);
            continue;
          }

          const delta = (event as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> })
            .choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.reasoning_content) {
            if (!thinkingStarted) {
              thinkingStarted = true;
              thinkingStart = Date.now();
            }
            currentThinking += delta.reasoning_content;
            setThinkingContent(currentThinking);
            setIsThinking(true);
          }

          if (delta.content) {
            if (thinkingStarted) {
              setIsThinking(false);
            }
            currentContent += delta.content;
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: currentContent,
                    thinkingContent: currentThinking,
                    isStreaming: true,
                  }
                : m
            )
          );

          if (!hasScrolledUp) scrollToBottom(false);
        }

        const lastNewline = buffer.lastIndexOf("\n");
        buffer = lastNewline === -1 ? "" : buffer.slice(lastNewline + 1);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
      setIsThinking(false);
      setThinkingContent("");
      streamingMsgIdRef.current = null;
      abortControllerRef.current = null;
    }
  };

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: ChatMessageType = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setHasScrolledUp(false);

    abortControllerRef.current = new AbortController();
    await streamChat(text, userMessage.id, abortControllerRef.current.signal);
  };

  const handleRetry = () => {
    setError(null);
    if (messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (lastUserMsg) {
        setMessages((prev) => prev.filter((m) => m.id !== messages[messages.length - 1].id));
        handleSend(lastUserMsg.content);
      }
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Messages container */}
      <motion.div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto scroll-smooth"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        <AnimatePresence mode="wait">
          {isEmpty ? (
            /* Hero state: centered orb */
            <motion.div
              key="hero"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center justify-center h-full px-4"
            >
              <HeroComposer onSend={handleSend} isLoading={isLoading} placeholder="Ask anything…" />
            </motion.div>
          ) : (
            /* Chat state: messages + docked input */
            <motion.div
              key="chat"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="max-w-3xl mx-auto px-4 py-8 pb-32"
            >
              {messages.map((msg, i) => {
                if (msg.id === streamingMsgIdRef.current && isLoading) {
                  return null;
                }

                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1], delay: i * 0.05 }}
                  >
                    <ChatMessage
                      id={msg.id}
                      role={msg.role}
                      content={msg.content}
                      thinkingContent={msg.thinkingContent}
                      thinkingDuration={msg.thinkingDuration}
                      isStreaming={false}
                    />
                  </motion.div>
                );
              })}

              {isLoading && messages.length > 0 && messages[messages.length - 1].role === "assistant" && (
                <motion.div
                  key="streaming"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="mb-6"
                >
                  <ChatMessage
                    id={streamingMsgIdRef.current || `streaming-${Date.now()}`}
                    role="assistant"
                    content=""
                    isStreaming={true}
                    isThinking={isThinking}
                    thinkingContent={thinkingContent}
                  />
                </motion.div>
              )}

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: 8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className="error-toast"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <p className="text-sm text-red-500">{error}</p>
                        <button
                          onClick={handleRetry}
                          className="mt-2 text-xs font-medium text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
                        >
                          Retry
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div ref={messagesEndRef} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Scroll to bottom button */}
      <AnimatePresence>
        {hasScrolledUp && messages.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.9 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            onClick={() => {
              setHasScrolledUp(false);
              scrollToBottom(true);
            }}
            className="scroll-bottom-btn"
          >
            <motion.div
              animate={{ y: [0, 3, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </motion.div>
            Scroll to bottom
          </motion.button>
        )}
      </AnimatePresence>

      {/* Input area — only shown in chat state */}
      {!isEmpty && (
        <ChatInput
          onSend={handleSend}
          isLoading={isLoading}
          placeholder="Ask anything…"
        />
      )}
    </div>
  );
}
