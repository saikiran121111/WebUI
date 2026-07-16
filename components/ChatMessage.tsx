"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Copy, Check, Pencil, X } from "lucide-react";
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
  onEdit?: (newContent: string) => void;
}

export default function ChatMessage({
  id,
  role,
  content,
  thinkingContent = "",
  thinkingDuration,
  isStreaming = false,
  isThinking = false,
  onEdit,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [firstRenderTime, setFirstRenderTime] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const messageRef = useRef<HTMLDivElement>(null);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);

  // Focus edit area when entering edit mode
  useEffect(() => {
    if (isEditing && editAreaRef.current) {
      editAreaRef.current.focus();
      editAreaRef.current.setSelectionRange(editAreaRef.current.value.length, editAreaRef.current.value.length);
    }
  }, [isEditing]);

  // Track first render time
  useEffect(() => {
    if (!firstRenderTime) {
      setFirstRenderTime(Date.now());
    }
  }, [firstRenderTime]);

  // Show copy button after initial fade-in
  useEffect(() => {
    if (content && !isStreaming && role === "assistant") {
      const delay = firstRenderTime
        ? Math.max(0, 400 - (Date.now() - firstRenderTime))
        : 400;
      const timer = setTimeout(() => setShowCopy(true), delay);
      return () => clearTimeout(timer);
    } else {
      setShowCopy(false);
    }
  }, [content, isStreaming, role, firstRenderTime]);

  // Intersection observer for scroll-triggered animations
  useEffect(() => {
    if (!messageRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isStreaming) {
          messageRef.current?.classList.add("opacity-100", "translate-y-0");
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(messageRef.current);
    return () => observer.disconnect();
  }, [isStreaming]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [content]);

  // Edit handlers
  const startEdit = useCallback(() => {
    setEditValue(content);
    setIsEditing(true);
  }, [content]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue("");
  }, []);

  const confirmEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed) {
      setIsEditing(false);
      onEdit?.(trimmed);
    }
  }, [editValue, onEdit]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        confirmEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [confirmEdit, cancelEdit]
  );

  // User message
  if (role === "user") {
    if (isEditing) {
      return (
        <motion.div
          ref={messageRef}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="flex justify-end mb-6"
        >
          <div className="max-w-[85%] md:max-w-[75%]">
            <motion.div
              className="px-4 py-2.5 rounded-2xl rounded-bl-md"
              style={{
                background: "rgba(99, 102, 241, 0.15)",
                border: "1px solid rgba(99, 102, 241, 0.4)",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(99, 102, 241, 0.2)",
              }}
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            >
              <textarea
                ref={editAreaRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleEditKeyDown}
                rows={2}
                className="w-full bg-transparent text-white placeholder-white/40 text-[0.9375rem] leading-relaxed outline-none resize-none"
                placeholder="Edit your message…"
              />
              <div className="flex items-center justify-end gap-1.5 mt-2 pt-2 border-t border-white/10">
                <button
                  onClick={cancelEdit}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-white/50 hover:text-white/80 transition-colors rounded"
                  aria-label="Cancel edit"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
                <button
                  onClick={confirmEdit}
                  disabled={!editValue.trim()}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-all",
                    editValue.trim()
                      ? "bg-indigo-600 text-white hover:bg-indigo-500"
                      : "bg-white/10 text-white/30 cursor-not-allowed"
                  )}
                  aria-label="Save edit"
                >
                  <Check className="w-3 h-3" />
                  Save
                </button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      );
    }

    return (
      <motion.div
        ref={messageRef}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="flex justify-end mb-6 group/user"
      >
        <div className="max-w-[85%] md:max-w-[75%]">
          <motion.div
            className="px-4 py-2.5 rounded-2xl rounded-bl-md relative"
            style={{
              background: "rgba(255, 255, 255, 0.08)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
            }}
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <p className="text-[0.9375rem] leading-relaxed text-white whitespace-pre-wrap pr-6">
              {content}
            </p>
            {onEdit && (
              <button
                onClick={startEdit}
                className="absolute top-2 right-2 opacity-0 group-hover/user:opacity-100 transition-opacity duration-150 p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80"
                aria-label="Edit message"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </motion.div>
        </div>
      </motion.div>
    );
  }

  // Assistant message
  return (
    <motion.div
      ref={messageRef}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
      className="mb-6"
      id={`message-${id}`}
    >
      {/* Thinking indicator */}
      {(isThinking || (isStreaming && !content && !thinkingContent)) && role === "assistant" && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2.5 py-2 mb-2"
        >
          <motion.div
            className="w-2 h-2 rounded-full"
            style={{ background: "#8b5cf6" }}
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
          <span className="text-sm font-medium text-white/62">
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
                  className="w-1 h-1 rounded-full"
                  style={{ background: "rgba(255, 255, 255, 0.62)" }}
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
      {thinkingContent && !isThinking && role === "assistant" && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="flex items-center gap-2 py-1.5 mb-2 text-xs text-white/44"
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#10b981" }} />
          <span className="font-medium">Thought for {thinkingDuration ?? "?"}s</span>
        </motion.div>
      )}

      {/* Thinking block (collapsible) */}
      {thinkingContent && !isThinking && role === "assistant" && (
        <div>
          <button
            onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
            className="thinking-trigger"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            <span>
              {isThinkingExpanded
                ? "Hide reasoning"
                : thinkingDuration
                ? `Thought for ${thinkingDuration}s`
                : "View reasoning"}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn("transition-transform", isThinkingExpanded && "rotate-180")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {isThinkingExpanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="thinking-expanded"
            >
              <div className="prose max-w-none">
                <MarkdownRenderer content={thinkingContent} />
              </div>
            </motion.div>
          )}
        </div>
      )}

      {/* Main content */}
      {content && (
        <div className="prose max-w-none">
          <MarkdownRenderer content={content} />
        </div>
      )}

      {/* Streaming cursor */}
      {isStreaming && content && (
        <span className="inline-block w-0.5 h-4 ml-0.5 bg-white/96 animate-pulse" />
      )}

      {/* Loading dots when waiting for first token */}
      {!content && !thinkingContent && isStreaming && !isThinking && (
        <div className="flex items-center gap-1.5 py-4">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-2 h-2 rounded-full"
              style={{ background: "rgba(255, 255, 255, 0.62)" }}
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

      {/* Copy button */}
      {showCopy && content && !isStreaming && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="mt-2"
        >
          <button onClick={handleCopy} className="msg-copy-btn" aria-label={copied ? "Copied!" : "Copy response"}>
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
          </button>
        </motion.div>
      )}
    </motion.div>
  );
}
