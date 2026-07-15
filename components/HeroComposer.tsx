"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";

interface HeroComposerProps {
  onSend: (message: string) => void;
  isLoading?: boolean;
  placeholder?: string;
}

export default function HeroComposer({
  onSend,
  isLoading = false,
  placeholder = "Ask anything…",
}: HeroComposerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [value, setValue] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expand on hover
  const handleMouseEnter = useCallback(() => {
    if (!isLoading) {
      setIsExpanded(true);
    }
  }, [isLoading]);

  // Auto-focus when expanded
  useEffect(() => {
    if (isExpanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isExpanded]);

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

  // Auto-grow textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [value]);

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <motion.div
        ref={containerRef}
        className="w-full max-w-xl mx-auto"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <motion.div
          className="relative flex items-end gap-3 rounded-full transition-all duration-300 ease-out"
          style={{
            background: isExpanded
              ? "rgba(255, 255, 255, 0.04)"
              : "rgba(255, 255, 255, 0.02)",
            border: `1px solid ${isExpanded ? "rgba(255, 255, 255, 0.12)" : "rgba(255, 255, 255, 0.08)"}`,
            boxShadow: isExpanded
              ? "0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)"
              : "0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
            padding: isExpanded ? "0.5rem 0.75rem" : "0.75rem 1rem",
            width: isExpanded ? "100%" : "56px",
            height: isExpanded ? "auto" : "56px",
          }}
          whileHover={{
            scale: 1.01,
            transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
          }}
          onMouseEnter={handleMouseEnter}
          role="button"
          tabIndex={0}
          aria-label="Chat input"
          onClick={() => {
            if (!isExpanded) {
              setIsExpanded(true);
              textareaRef.current?.focus();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isExpanded) {
              setIsExpanded(true);
              textareaRef.current?.focus();
            }
          }}
        >
          {isExpanded && (
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
          )}

          {/* Send button when expanded and has content */}
          {isExpanded && (
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                handleSend();
              }}
              disabled={isLoading || !value.trim()}
              className={`
                flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
                transition-all duration-200 ease-out
                ${value.trim() && !isLoading
                  ? "bg-white text-black hover:bg-white/90 scale-100 opacity-100"
                  : "bg-white/10 text-white/30 scale-90 opacity-60"
                }
              `}
              whileHover={value.trim() && !isLoading ? { scale: 1.05 } : {}}
              whileTap={value.trim() && !isLoading ? { scale: 0.95 } : {}}
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

          {/* Pulsing glow effect when not expanded */}
          {!isExpanded && (
            <motion.div
              className="absolute inset-0 rounded-full"
              style={{
                background: "radial-gradient(circle at center, rgba(99, 102, 241, 0.15) 0%, transparent 70%)",
              }}
              animate={{
                opacity: [0.5, 1, 0.5],
                scale: [0.95, 1.05, 0.95],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
