"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Paperclip, X, StopCircle, Settings2 } from "lucide-react";
import type { Attachment } from "../lib/types";
import type { EffortLevel } from "../lib/types";
import { validateAttachment } from "../lib/files";
import { cn } from "../lib/utils";

const EFFORT_LEVELS: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

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
  /** Render as centered hero input (empty state) or bottom bar (chat active) */
  variant?: "hero" | "bar";
}

export default function ChatInput({
  onSend, onStop, isLoading, isThinking, reasoningContent,
  effort, onEffortChange, isResearchMode, onModeToggle,
  onAttachmentsChange, variant = "bar",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, variant === "hero" ? 180 : 200) + "px";
  }, [value, variant]);

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
    addFiles(Array.from(e.dataTransfer.files));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const newAtt: Attachment[] = [];
    for (const f of files) {
      try { newAtt.push(validateAttachment(f)); }
      catch (err: any) { console.warn("Skipped:", err.message); }
    }
    if (newAtt.length) {
      setAttachments(prev => { const u = [...prev, ...newAtt]; onAttachmentsChange(u); return u; });
    }
  }, [onAttachmentsChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter(i => i.type.startsWith("image/"))
      .map(i => i.getAsFile()).filter(Boolean) as File[];
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  }, [addFiles]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue("");
    setAttachments([]);
    onAttachmentsChange([]);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [value, isLoading, onSend, onAttachmentsChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => { const u = prev.filter(a => a.id !== id); onAttachmentsChange(u); return u; });
  }, [onAttachmentsChange]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  const isHero = variant === "hero";

  return (
    <div
      onDragEnter={handleDragEnter} onDragOver={e => e.preventDefault()}
      onDragLeave={handleDragLeave} onDrop={handleDrop} onPaste={handlePaste}
    >
      {isDragging && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center">
          <div className="px-10 py-5 rounded-2xl bg-white/[0.04] border border-white/[0.12] text-white/90 text-base font-medium">
            Drop files to attach
          </div>
        </motion.div>
      )}

      <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json,.docx,.doc,.mp4,.webm,.mp3,.wav"
        onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) addFiles(files); e.target.value = ""; }}
        className="hidden" />

      {attachments.length > 0 && (
        <div className="max-w-3xl mx-auto mb-2 px-4">
          <div className="flex flex-wrap gap-2">
            {attachments.map(att => (
              <div key={att.id} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                bg-white/[0.06] border border-white/[0.08] text-xs">
                <span className="text-white/60 max-w-32 truncate">{att.name}</span>
                <span className="text-white/25 text-[10px]">{(att.size / 1024).toFixed(0)}K</span>
                <button onClick={() => removeAttachment(att.id)}
                  className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <motion.div layoutId="composer"
        className={cn("max-w-3xl mx-auto", isHero ? "px-0" : "px-4 pb-4")}>
        <div className={cn(
          "rounded-2xl border transition-all duration-200",
          isHero
            ? "border-white/[0.12] bg-white/[0.05] shadow-2xl shadow-black/40"
            : "border-white/[0.1] bg-white/[0.04] backdrop-blur-xl shadow-lg shadow-black/30",
          "focus-within:border-white/25 focus-within:bg-white/[0.06]",
        )}>
          {(isThinking || reasoningContent) && !isLoading && (
            <div className="px-3 pt-2.5 flex items-center gap-2 text-[11px] text-emerald-400/70">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 animate-pulse" />
              <span>Reasoning{reasoningContent ? "" : "…"}</span>
            </div>
          )}

          {reasoningContent && !isLoading && (
            <div className="px-3 pt-2">
              <div className="text-[10px] text-emerald-400/60 font-medium uppercase tracking-wider mb-0.5">Thinking</div>
              <div className="text-[11px] text-white/40 line-clamp-3 leading-relaxed max-h-16 overflow-hidden">
                {reasoningContent}
              </div>
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isHero ? "Ask anything — try 'Explain async/await'…" : "Message…"}
              disabled={isLoading}
              rows={1}
              className={cn(
                "flex-1 bg-transparent text-white placeholder-white/35 text-sm leading-relaxed outline-none resize-none",
                isHero ? "px-4 py-4 min-h-[52px] max-h-[180px]" : "px-3 py-3 min-h-[44px] max-h-[200px]",
              )}
            />

            <div className="flex items-center gap-0.5 pb-1.5 pr-1">
              <button onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
                aria-label="Attach file" title="Attach file">
                <Paperclip className="w-4 h-4" />
              </button>

              <div className="relative">
                <button onClick={() => setShowEffortMenu(!showEffortMenu)}
                  className={cn(
                    "p-2 rounded-lg transition-colors",
                    effort !== "off" ? "text-emerald-400/80" : "text-white/40 hover:text-white/70 hover:bg-white/[0.06]",
                  )}
                  aria-label="Reasoning effort" title={`Reasoning: ${EFFORT_LABEL[effort]}`}>
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

          {!isHero && (
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-[10px] text-white/20">Enter to send · Shift+Enter for newline</span>
              <button onClick={onModeToggle}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                  isResearchMode ? "border-amber-500/30 text-amber-400/70 bg-amber-500/[0.06]"
                               : "border-white/[0.08] text-white/30 hover:text-white/50",
                )}>
                {isResearchMode ? "Research" : "Chat"}
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function EffortMenu({ effort, onSelect }: { effort: EffortLevel; onSelect: (e: EffortLevel) => void }) {
  return (
    <div className="absolute bottom-10 right-0 z-30 w-36 py-1 rounded-xl bg-[#141416] border border-white/[0.1] shadow-xl">
      <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-widest font-medium">Reasoning effort</div>
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