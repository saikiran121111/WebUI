"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import MarkdownRenderer from "./MarkdownRenderer";

interface ChatMessageProps {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinkingContent?: string;
  thinkingDuration?: number;
  isStreaming?: boolean;
  isThinking?: boolean;
}

export default function ChatMessage({
  id,
  role,
  content,
  thinkingContent = "",
  thinkingDuration,
  isStreaming = false,
  isThinking = false,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex justify-end mb-6"
      >
        <div className="max-w-[85%] md:max-w-[75%]">
          <motion.div
            className="bg-[var(--user-bubble)] text-[var(--foreground)] px-4 py-2.5 rounded-2xl rounded-bl-md border border-[var(--border)]"
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <p className="text-[0.9375rem] leading-relaxed whitespace-pre-wrap">
              {content}
            </p>
          </motion.div>
        </div>
      </motion.div>
    );
  }

  // Assistant message
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mb-6"
      id={`message-${id}`}
    >
      {/* Thinking indicator — simple animated text with pulsing dots */}
      {(isThinking || (isStreaming && !content && !thinkingContent)) && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2.5 py-2 mb-2"
        >
          {/* Pulsing dot */}
          <motion.div
            className="w-2 h-2 rounded-full bg-purple-500"
            animate={{
              scale: [1, 1.4, 1],
              opacity: [0.6, 1, 0.6],
            }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />

          {/* Animated "thinking..." text */}
          <span className="text-sm text-[var(--muted)] font-medium">
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              thinking
            </motion.span>
            <span className="inline-flex gap-0.5 ml-0.5">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="w-1 h-1 rounded-full bg-[var(--muted)]"
                  animate={{
                    opacity: [0.3, 1, 0.3],
                    y: [0, -2, 0],
                  }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: i * 0.15,
                  }}
                />
              ))}
            </span>
          </span>
        </motion.div>
      )}

      {/* Thinking duration after completion */}
      {thinkingContent && !isThinking && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="flex items-center gap-2 py-1.5 mb-2 text-xs text-[var(--muted-foreground)]"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
          <span className="font-medium">Thought for {thinkingDuration ?? "?"}s</span>
        </motion.div>
      )}

      {/* Main content */}
      {content && <MarkdownRenderer content={content} />}

      {/* Streaming cursor */}
      {isStreaming && content && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity }}
          className="inline-block w-0.5 h-4 bg-[var(--foreground)] ml-0.5"
        />
      )}

      {/* Loading dots when waiting for first token */}
      {!content && !thinkingContent && isStreaming && !isThinking && (
        <div className="flex items-center gap-1.5 py-4">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-2 h-2 rounded-full bg-[var(--muted)]"
              animate={{
                scale: [1, 1.3, 1],
                opacity: [0.4, 1, 0.4],
              }}
              transition={{
                duration: 1,
                repeat: Infinity,
                ease: "easeInOut",
                delay: i * 0.15,
              }}
            />
          ))}
        </div>
      )}

      {/* Copy button for completed response */}
      {content && !isStreaming && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="mt-2"
        >
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleCopy}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium",
              "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              "border border-[var(--border)] hover:border-[var(--muted)]",
              "transition-all duration-200"
            )}
            aria-label={copied ? "Copied!" : "Copy response"}
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-500" />
                <span className="text-emerald-500">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </motion.button>
        </motion.div>
      )}
    </motion.div>
  );
}
