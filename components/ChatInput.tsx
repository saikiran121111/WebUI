"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export default function ChatInput({
  onSend,
  isLoading = false,
  placeholder = "Ask anything…",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus when component mounts or expands
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  // Auto-grow textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [value]);

  // Handle send
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue("");
  }, [value, isLoading, onSend]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const hasContent = value.trim().length > 0;

  return (
    <motion.div
      className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-6 pt-2"
      style={{
        background: "linear-gradient(to top, rgba(5, 5, 5, 1) 0%, rgba(5, 5, 5, 0.95) 60%, transparent 100%)",
      }}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <div className="max-w-3xl mx-auto">
        <motion.div
          ref={containerRef}
          className="relative flex items-end gap-2 rounded-full border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-lg shadow-black/30 transition-all duration-300 ease-out focus-within:border-white/16 focus-within:shadow-[0_0_0_1px_rgba(99,102,241,0.15),0_8px_32px_rgba(0,0,0,0.4)]"
          style={{
            padding: "0.375rem 0.625rem",
          }}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isLoading}
            rows={1}
            className="flex-1 min-h-[40px] max-h-[160px] px-3 py-2 bg-transparent text-white placeholder-white/40 text-[0.9375rem] leading-relaxed outline-none resize-none"
          />

          {/* Send button when has content */}
          {hasContent && !isLoading && (
            <motion.button
              onClick={handleSend}
              className="flex-shrink-0 w-8 h-8 rounded-full bg-white text-black hover:bg-white/90 flex items-center justify-center transition-all duration-200 ease-out"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              aria-label="Send message"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m22 2-7 20-4-9-9-4z" />
                <path d="M22 2 11 13" />
              </svg>
            </motion.button>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}
