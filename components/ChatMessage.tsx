"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Copy, Check, Pencil, X, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";
import MarkdownRenderer from "./MarkdownRenderer";
import type { Message } from "../lib/types";

interface ChatMessageProps {
  message: Message;
  onEdit: (newContent: string, messageId: string) => void;
  onCopy: (content: string) => void;
}

export default memo(function ChatMessage({ message, onEdit, onCopy }: ChatMessageProps) {
  const { role, content, reasoning, reasoningMs, state, toolCalls, attachments, citations, error } = message;
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.setSelectionRange(editRef.current.value.length, editRef.current.value.length);
    }
  }, [isEditing]);

  const handleCopy = useCallback(async () => {
    await onCopy(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content, onCopy]);

  const startEdit = useCallback(() => {
    setEditValue(content);
    setIsEditing(true);
  }, [content]);

  const confirmEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== content) {
      onEdit(trimmed, message.id);
    }
    setIsEditing(false);
  }, [editValue, content, message.id, onEdit]);

  const handleEditKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmEdit(); }
    else if (e.key === "Escape") setIsEditing(false);
  }, [confirmEdit]);

  // ── User message ──────────────────────────────────────────────────────
  if (isUser) {
    if (isEditing) {
      return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="flex justify-end mb-4">
          <div className="max-w-[85%] md:max-w-[75%]">
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#1a1a2e]/80
              border border-indigo-500/30 shadow-lg shadow-black/20">
              <textarea
                ref={editRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleEditKey}
                rows={2}
                className="w-full bg-transparent text-white placeholder-white/40 text-sm
                  leading-relaxed outline-none resize-none"
              />
              <div className="flex items-center justify-end gap-1.5 mt-2 pt-2 border-t border-white/10">
                <button onClick={() => setIsEditing(false)}
                  className="px-2 py-1 text-xs text-white/50 hover:text-white/80 transition-colors">
                  Cancel
                </button>
                <button onClick={confirmEdit} disabled={!editValue.trim()}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-all",
                    editValue.trim()
                      ? "bg-indigo-600 text-white hover:bg-indigo-500"
                      : "bg-white/10 text-white/30 cursor-not-allowed",
                  )}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      );
    }
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="flex justify-end mb-4 group/user">
        <div className="max-w-[85%] md:max-w-[75%]">
          <div className="px-4 py-2.5 rounded-2xl rounded-br-sm relative
            bg-white/[0.07] border border-white/[0.1] shadow-sm shadow-black/20">
            <p className="text-sm leading-relaxed text-white/85 whitespace-pre-wrap pr-6">
              {content}
            </p>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {attachments.map(att => (
                  <span key={att.id} className="text-[10px] px-1.5 py-0.5 rounded
                    bg-white/[0.06] text-white/50 border border-white/[0.08]">
                    {att.name}
                  </span>
                ))}
              </div>
            )}
            {state !== "streaming" && (
              <button onClick={startEdit}
                className="absolute top-2 right-2 opacity-0 group-hover/user:opacity-100
                  transition-opacity p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80"
                aria-label="Edit message">
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Assistant message ─────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="mb-5"
      id={"msg-" + message.id}
    >
      {/* Thinking indicator */}
      {reasoning && !state?.startsWith("streaming") && (
        <div className="flex items-center gap-2 py-1.5 mb-1.5">
          <CheckCircle2 className="w-3 h-3 text-emerald-500/70" />
          <span className="text-xs text-white/40 font-medium">
            {reasoningMs ? `Thought for ${reasoningMs}s` : "Reasoned"}
          </span>
          {reasoningMs && (
            <span className="text-[10px] text-white/25 ml-1">{"(" + formatDuration(reasoningMs) + ")"}</span>
          )}
        </div>
      )}

      {/* Reasoning block */}
      {reasoning && (
        <ReasoningBlock text={reasoning} messageId={message.id} />
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl mb-3
          bg-red-500/[0.06] border border-red-500/15">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      )}

      {/* Tool calls */}
      {toolCalls.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {toolCalls.map(tc => (
            <div key={tc.id} className="flex items-start gap-2 px-3 py-2 rounded-lg
              bg-white/[0.03] border border-white/[0.07] text-xs">
              <div className="flex-1">
                <span className="text-white/50 font-mono">{tc.name}</span>
                {tc.args && (
                  <span className="ml-2 text-white/30 font-mono text-[10px]">
                    {tc.args.slice(0, 100)}
                  </span>
                )}
              </div>
              {tc.status === "error" && <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" />}
              {tc.status === "ok" && <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />}
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      {content && (
        <div className="msg-content">
          <MarkdownRenderer content={content} />
          {citations.length > 0 && (
            <CitationsBlock citations={citations} />
          )}
        </div>
      )}

      {/* Streaming cursor */}
      {state === "streaming" && content && (
        <span className="inline-block w-[2px] h-4 ml-0.5 bg-white/80 animate-pulse" />
      )}

      {/* Loading dots when waiting for first token */}
      {state === "streaming" && !content && !reasoning && (
        <div className="flex items-center gap-1.5 py-4">
          {[0, 1, 2].map(i => (
            <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-white/40"
              animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.8, 0.3] }}
              transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />
          ))}
        </div>
      )}

      {/* Actions */}
      {state !== "streaming" && state !== "error" && (
        <div className="flex items-center gap-1 mt-2">
          {content && (
            <button onClick={handleCopy}
              className="msg-copy-btn flex items-center gap-1.5">
              {copied ? <><Check className="w-3 h-3 text-emerald-500" /><span className="text-emerald-500 text-xs">Copied</span></>
                : <><Copy className="w-3 h-3" /><span className="text-xs">Copy</span></>}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
});

function ReasoningBlock({ text, messageId }: { text: string; messageId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="thinking-trigger inline-flex items-center gap-1.5"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <span className="text-xs">{expanded ? "Hide reasoning" : "View reasoning"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={cn("transition-transform duration-200", expanded && "rotate-180")}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.2 }}
          className="thinking-expanded"
        >
          <div className="text-xs leading-relaxed text-white/50 whitespace-pre-wrap font-mono">
            {text}
          </div>
        </motion.div>
      )}
    </div>
  );
}

function CitationsBlock({ citations }: { citations: any[] }) {
  return (
    <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-1.5">
      <div className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">
        Sources
      </div>
      {citations.map(c => (
        <a key={c.n} href={c.url} target="_blank" rel="noopener noreferrer"
          className="flex items-start gap-2 group/cite p-2 rounded-lg
            hover:bg-white/[0.03] transition-colors">
          <span className="text-xs font-medium text-white/40 flex-shrink-0">[{c.n}]</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-white/70 group-hover/cite:text-white/90 truncate">
              {c.title}
            </div>
            <div className="text-[10px] text-white/30 truncate">{c.domain}</div>
          </div>
          <svg className="w-3 h-3 text-white/20 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M7 7h10v10" />
          </svg>
        </a>
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m + "m " + rs + "s";
}
