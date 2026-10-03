"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Send, Paperclip, X, StopCircle, Settings2 } from "lucide-react";
import type { Attachment } from "../lib/types";
import type { EffortLevel } from "../lib/types";
import { validateAttachment } from "../lib/files";
import { cn } from "../lib/utils";

interface ChatInputProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isLoading: boolean;
  isThinking: boolean;
  reasoningContent: string;
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  isResearchMode: boolean;
  onModeToggle: () => void;
  onAttachmentsChange: (attachments: Attachment[]) => void;
  onToggleResearch?: () => void;
  placeholder?: string;
}

const EFFORT_LEVELS: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

export default function ChatInput({
  onSend, onStop, isLoading, isThinking, reasoningContent,
  effort, onEffortChange, isResearchMode, onModeToggle,
  onAttachmentsChange, onToggleResearch, placeholder = "Message…",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  // Drag and drop
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) { setIsDragging(false); dragCounter.current = 0; }
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const newAttachments: Attachment[] = [];
    for (const f of files) {
      try {
        const att = validateAttachment(f);
        newAttachments.push(att);
      } catch (err: any) {
        console.warn("Skipped attachment:", err.message);
      }
    }
    if (newAttachments.length) {
      setAttachments(prev => {
        const updated = [...prev, ...newAttachments];
        onAttachmentsChange(updated);
        return updated;
      });
    }
  }, [onAttachmentsChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }, [addFiles]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue("");
    setAttachments([]);
    onAttachmentsChange([]);
  }, [value, isLoading, onSend, onAttachmentsChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const updated = prev.filter(a => a.id !== id);
      onAttachmentsChange(updated);
      return updated;
    });
  }, [onAttachmentsChange]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={e => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {/* Drag overlay */}
      {isDragging && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 bg-indigo-950/80 flex items-center justify-center"
        >
          <div className="px-8 py-4 rounded-2xl bg-white/[0.06] border border-white/[0.12] text-white/90 text-lg font-medium">
            Drop files to attach
          </div>
        </motion.div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.md,.csv,.json,.docx,.doc,.mp4,.webm,.mp3,.wav"
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) addFiles(files);
          e.target.value = "";
        }}
        className="hidden"
      />

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="max-w-3xl mx-auto mb-2 px-4">
          <div className="flex flex-wrap gap-2">
            {attachments.map(att => (
              <AttachmentChip key={att.id} attachment={att} onRemove={() => removeAttachment(att.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Composer bar */}
      <motion.div
        className="px-4 pb-4 pt-1"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="max-w-3xl mx-auto">
          {/* Reasoning indicator */}
          {(isThinking || reasoningContent) && !isLoading && (
            <div className="mb-2 px-3 flex items-center gap-2 text-xs text-white/40">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 animate-pulse" />
              <span>Reasoning{reasoningContent ? "" : "…"}</span>
            </div>
          )}

          <div className="relative flex items-end gap-1.5 rounded-2xl border border-white/[0.1]
            bg-white/[0.04] backdrop-blur-xl shadow-lg shadow-black/30
            transition-all duration-200
            focus-within:border-white/20 focus-within:shadow-[0_0_0_1px_rgba(99,102,241,0.12),0_8px_32px_rgba(0,0,0,0.4)]">

            {/* Thinking display */}
            {reasoningContent && !isLoading && (
              <div className="px-3 pt-3 pb-1">
                <div className="text-[10px] text-emerald-400/70 font-medium uppercase tracking-wider mb-0.5">
                  Thinking
                </div>
                <div className="text-[11px] text-white/40 line-clamp-3 leading-relaxed max-h-16 overflow-hidden">
                  {reasoningContent}
                </div>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={isLoading}
              rows={1}
              className="flex-1 min-h-[44px] max-h-[200px] px-3 py-3 bg-transparent text-white
                placeholder-white/35 text-sm leading-relaxed outline-none resize-none"
            />

            <div className="flex items-center gap-1 pb-1.5 pr-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.06]
                  transition-colors"
                aria-label="Attach file"
                title="Attach file"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              <div className="relative">
                <button
                  onClick={() => setShowEffortMenu(!showEffortMenu)}
                  className={cn(
                    "p-2 rounded-lg transition-colors",
                    effort !== "off" ? "text-emerald-400/80" : "text-white/40 hover:text-white/70 hover:bg-white/[0.06]",
                  )}
                  aria-label="Reasoning effort"
                  title={`Reasoning: ${EFFORT_LABEL[effort]}`}
                >
                  <Settings2 className="w-4 h-4" />
                </button>
                {showEffortMenu && (
                  <EffortMenu effort={effort} onSelect={e => { onEffortChange(e); setShowEffortMenu(false); }} />
                )}
              </div>

              {isLoading ? (
                <button onClick={onStop}
                  className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors"
                  aria-label="Stop generating">
                  <StopCircle className="w-4 h-4" />
                </button>
              ) : (
                <button onClick={handleSend} disabled={!hasContent}
                  className={cn(
                    "p-2 rounded-lg transition-all",
                    hasContent
                      ? "bg-white text-black hover:bg-white/90"
                      : "bg-white/[0.08] text-white/30 cursor-not-allowed",
                  )}>
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[10px] text-white/20">
              Enter to send · Shift+Enter for newline
            </span>
            <button onClick={onModeToggle}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                isResearchMode
                  ? "border-amber-500/30 text-amber-400/70 bg-amber-500/[0.06]"
                  : "border-white/[0.08] text-white/30 hover:text-white/50",
              )}>
              {isResearchMode ? "Research" : "Chat"}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function EffortMenu({
  effort, onSelect,
}: {
  effort: EffortLevel;
  onSelect: (e: EffortLevel) => void;
}) {
  return (
    <div className="absolute bottom-10 right-0 z-30 w-36 py-1 rounded-xl
      bg-[#141416] border border-white/[0.1] shadow-xl">
      <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-widest font-medium">
        Reasoning effort
      </div>
      {EFFORT_LEVELS.map(e => (
        <button key={e} onClick={() => onSelect(e)}
          className={cn(
            "w-full text-left px-3 py-1.5 text-xs transition-colors",
            effort === e ? "text-indigo-400 bg-indigo-500/[0.1]" : "text-white/60 hover:bg-white/[0.04] hover:text-white/90",
          )}>
          {EFFORT_LABEL[e]}
        </button>
      ))}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const kindIcon: Record<string, string> = {
    image: "🖼", document: "📄", video: "🎬", other: "📎",
  };
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
      bg-white/[0.06] border border-white/[0.08] text-xs">
      <span>{kindIcon[attachment.kind] ?? "📎"}</span>
      <span className="text-white/70 max-w-32 truncate">{attachment.name}</span>
      <span className="text-white/25 text-[10px]">{(attachment.size / 1024).toFixed(0)}K</span>
      <button onClick={onRemove}
        className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
