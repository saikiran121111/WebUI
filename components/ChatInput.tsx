"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, isLoading, onSend]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="sticky bottom-0 left-0 right-0 z-10 pt-4 pb-6 px-4"
    >
      <div className="max-w-[768px] mx-auto">
        <motion.div
          className={cn(
            "relative flex items-end gap-2 rounded-2xl border",
            "bg-[var(--accent)]/80 glass-input",
            "shadow-lg shadow-black/5 dark:shadow-black/20",
            "transition-all duration-300",
            "hover:border-[var(--muted)]",
            "focus-within:border-[var(--ring)] focus-within:shadow-md focus-within:shadow-purple-500/5"
          )}
          whileFocus={{ scale: 1.005 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isLoading}
            rows={1}
            className={cn(
              "flex-1 min-h-[44px] max-h-[200px] px-4 py-3 bg-transparent",
              "text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]",
              "text-[0.9375rem] leading-relaxed",
              "outline-none resize-none",
              "disabled:opacity-50"
            )}
          />
          <motion.button
            onClick={handleSend}
            disabled={isLoading || !hasContent}
            className={cn(
              "mr-2 mb-2 p-2.5 rounded-xl transition-all duration-200",
              "bg-[var(--foreground)] text-[var(--background)]",
              "hover:shadow-lg",
              "disabled:opacity-30 disabled:shadow-none"
            )}
            whileHover={{ scale: hasContent ? 1.08 : 1 }}
            whileTap={{ scale: hasContent ? 0.92 : 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 25 }}
            aria-label="Send message"
          >
            <motion.div
              animate={hasContent && !isLoading ? { rotate: [0, -10, 10, 0] } : {}}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Send className="w-4 h-4" />
            </motion.div>
          </motion.button>
        </motion.div>
      </div>
    </motion.div>
  );
}
