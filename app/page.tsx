"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Moon, Sun, ArrowDown, AlertCircle, Bot } from "lucide-react";
import { useTheme } from "./theme-provider";
import ChatInput from "@/components/ChatInput";
import ChatMessage from "@/components/ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

const SYSTEM_PROMPT =
  "You are a helpful, concise, and precise AI assistant. Format your responses clearly with markdown. Use code blocks with language tags when showing code. Be thorough but avoid unnecessary verbosity.";

const EXAMPLE_PROMPTS = [
  "Explain quantum computing in simple terms",
  "Write a Python function to sort a list",
  "What's the difference between REST and GraphQL?",
];

export default function HomePage() {
  const { theme, toggleTheme } = useTheme();
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
          /* skip */
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
    const assistantMsgId = `msg-${Date.now()}`;
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
      let thinkingEndTime = 0;
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
                  ? { ...m, content: currentContent, thinkingContent: currentThinking, thinkingDuration: duration, isStreaming: false }
                  : m
              )
            );
            setIsThinking(false);
            continue;
          }

          const delta = (event as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> }).choices?.[0]?.delta;
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
              thinkingEndTime = Date.now();
              setIsThinking(false);
            }
            currentContent += delta.content;
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: currentContent, thinkingContent: currentThinking, isStreaming: true }
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
      id: `msg-${Date.now()}`,
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

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Theme toggle */}
      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.3, duration: 0.3 }}
        onClick={toggleTheme}
        className="fixed top-4 right-4 z-50 p-2.5 rounded-full border border-[var(--border)] bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--muted)] transition-all duration-300 hover:rotate-90"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </motion.button>

      {/* Messages container */}
      <motion.div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto scroll-smooth"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        <div className="max-w-[768px] mx-auto px-4 py-8">
          <AnimatePresence mode="wait">
            {messages.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="flex flex-col items-center justify-center min-h-[60vh] text-center"
              >
                {/* Floating particle background */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  {[...Array(6)].map((_, i) => (
                    <motion.div
                      key={i}
                      className="absolute w-1 h-1 rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/30"
                      style={{
                        left: `${15 + i * 15}%`,
                        top: `${20 + (i % 3) * 20}%`,
                      }}
                      animate={{
                        y: [0, -20, 0],
                        opacity: [0.3, 0.8, 0.3],
                        scale: [1, 1.5, 1],
                      }}
                      transition={{
                        duration: 3 + i * 0.5,
                        repeat: Infinity,
                        ease: "easeInOut",
                        delay: i * 0.3,
                      }}
                    />
                  ))}
                </div>

                {/* Bot icon with pulse */}
                <motion.div
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15, delay: 0.1 }}
                  className="w-14 h-14 rounded-2xl bg-[var(--accent)] border border-[var(--border)] flex items-center justify-center mb-6 shadow-lg shadow-purple-500/5 dark:shadow-purple-500/10"
                >
                  <Bot className="w-6 h-6 text-[var(--muted-foreground)]" />
                </motion.div>

                {/* Title with staggered word animation */}
                <h1 className="text-3xl font-semibold mb-3">
                  <motion.span
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                    className="bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 bg-clip-text text-transparent"
                  >
                    How can I help you today?
                  </motion.span>
                </h1>

                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="text-[var(--muted-foreground)] text-sm mb-10 max-w-md"
                >
                  Ask me anything — I&apos;m powered by a local LLM running on your machine.
                </motion.p>

                {/* Example prompts with staggered entrance */}
                <motion.div
                  className="flex flex-wrap gap-2.5 justify-center"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.6 }}
                >
                  {EXAMPLE_PROMPTS.map((prompt, i) => (
                    <motion.button
                      key={i}
                      initial={{ opacity: 0, scale: 0.9, y: 10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{
                        duration: 0.3,
                        delay: 0.7 + i * 0.1,
                        ease: "easeOut",
                      }}
                      whileHover={{ scale: 1.03, y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => handleSend(prompt)}
                      className="px-4 py-2.5 rounded-full text-sm text-[var(--muted-foreground)] border border-[var(--border)] bg-[var(--accent)] hover:border-[var(--muted)] hover:text-[var(--foreground)] transition-all duration-200 hover:shadow-md"
                    >
                      {prompt}
                    </motion.button>
                  ))}
                </motion.div>
              </motion.div>
            ) : (
              <motion.div
                key="messages"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                {/* Render all messages except the currently streaming one */}
                {messages.map((msg, i) => {
                  if (msg.id === streamingMsgIdRef.current && isLoading) {
                    return null; // Skip — will be rendered in streaming section below
                  }
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, ease: "easeOut", delay: i * 0.05 }}
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

                {/* Streaming indicator — single source of truth */}
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

                {/* Error message */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.98 }}
                      transition={{ duration: 0.2 }}
                      className="mb-6 mx-auto max-w-[768px] p-4 rounded-xl border border-red-500/20 bg-red-500/5"
                    >
                      <div className="flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
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
        </div>
      </motion.div>

      {/* Scroll to bottom button */}
      <AnimatePresence>
        {hasScrolledUp && messages.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.9 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={() => {
              setHasScrolledUp(false);
              scrollToBottom(true);
            }}
            className="fixed bottom-28 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full border border-[var(--border)] bg-[var(--accent)] text-[var(--muted)] text-xs font-medium shadow-lg hover:border-[var(--muted)] hover:text-[var(--foreground)] transition-all duration-200 flex items-center gap-1.5"
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

      {/* Input area */}
      <ChatInput
        onSend={handleSend}
        isLoading={isLoading}
        placeholder="Ask anything…"
      />
    </div>
  );
}
