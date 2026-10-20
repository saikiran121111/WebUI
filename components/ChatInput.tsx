"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Paperclip, X, StopCircle, Settings2, Loader2, AlertCircle, Check, Blocks } from "lucide-react";
import type { Attachment } from "../lib/types";
import type { EffortLevel } from "../lib/types";
import type { SkillRecord } from "../lib/skills/types";
import { fetchSkills } from "../lib/skills/client-cache";
import { validateAttachment, processAttachment, ACCEPT_EXTENSIONS } from "../lib/files";
import SkillsModal from "./SkillsModal";
import { cn } from "../lib/utils";

const EFFORT_LEVELS: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

interface ChatInputProps {
  onSend: (text: string, attachments: Attachment[]) => void;
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
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const effortMenuRef = useRef<HTMLDivElement>(null);

  // Shared cross-component cache with in-flight dedup: the hero + bar
  // instances (and their remounts on view swaps) used to fire 2–4 identical
  // GET /api/skills back-to-back per page load; concurrent callers now share
  // one request, and a later mount reuses its fresh result.
  const refreshSkills = useCallback((force = false) => {
    fetchSkills(force).then(setSkills);
  }, []);

  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  // The skills modal owns install/save/delete, which invalidate the shared
  // cache — re-read it when the modal closes so slash autocomplete stays
  // current without polling on every keystroke.
  const skillsModalWasOpen = useRef(false);
  useEffect(() => {
    if (skillsModalWasOpen.current && !showSkillsModal) refreshSkills(true);
    skillsModalWasOpen.current = showSkillsModal;
  }, [showSkillsModal, refreshSkills]);

  // Slash autocomplete: only while the whole value is one "/word" token.
  const slashCandidates = useMemo(() => {
    const partial = /^\/([a-z0-9._-]*)$/i.exec(value);
    if (!partial) return [];
    const query = partial[1].toLowerCase();
    return skills
      .filter(s => s.enabled && s.skillName.toLowerCase().startsWith(query))
      .slice(0, 8);
  }, [value, skills]);

  useEffect(() => { setSlashDismissed(false); setSlashIndex(0); }, [value]);

  const pickSlashSkill = useCallback((skillName: string) => {
    setValue("/" + skillName + " ");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, variant === "hero" ? 180 : 200) + "px";
  }, [value, variant]);

  // Dismiss the effort menu on any outside click / Escape so it never lingers
  // open while another menu is being used. The trigger button lives inside
  // effortMenuRef, so clicking it again still toggles through onClick.
  useEffect(() => {
    if (!showEffortMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!effortMenuRef.current?.contains(e.target as Node)) setShowEffortMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowEffortMenu(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showEffortMenu]);

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

  const updateAttachment = useCallback((id: string, next: Attachment) => {
    setAttachments(prev => {
      const u = prev.map(a => (a.id === id ? next : a));
      onAttachmentsChange(u);
      return u;
    });
  }, [onAttachmentsChange]);

  const addFiles = useCallback((files: File[]) => {
    const accepted: { att: Attachment; file: File }[] = [];
    for (const f of files) {
      try { accepted.push({ att: validateAttachment(f), file: f }); }
      catch (err: any) { console.warn("Skipped:", err.message); }
    }
    if (!accepted.length) return;

    setAttachments(prev => {
      const u = [...prev, ...accepted.map(a => a.att)];
      onAttachmentsChange(u);
      return u;
    });

    // Read each file into something the model can be shown — text, an image,
    // a transcript, sampled frames — and move its chip along as that lands.
    for (const { att, file } of accepted) {
      void processAttachment(file, att).then(next => updateAttachment(att.id, next));
    }
  }, [onAttachmentsChange, updateAttachment]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter(i => i.type.startsWith("image/"))
      .map(i => i.getAsFile()).filter(Boolean) as File[];
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  }, [addFiles]);

  const stillReading = attachments.some(a => a.status === "pending" || a.status === "processing");

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    // Attachments must finish being read first — sending early would ship a
    // file the model never got to see.
    if (!trimmed || isLoading || stillReading) return;
    onSend(trimmed, attachments.filter(a => a.status === "ready"));
    setValue("");
    // Failed attachments stay in the tray so the reason is still visible.
    setAttachments(prev => {
      const kept = prev.filter(a => a.status === "error");
      onAttachmentsChange(kept);
      return kept;
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [value, isLoading, stillReading, attachments, onSend, onAttachmentsChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const menuOpen = slashCandidates.length > 0 && !slashDismissed;
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % slashCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickSlashSkill(slashCandidates[Math.min(slashIndex, slashCandidates.length - 1)].skillName);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend, slashCandidates, slashDismissed, slashIndex, pickSlashSkill]);

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

      <input ref={fileInputRef} type="file" multiple data-testid="file-input" accept={ACCEPT_EXTENSIONS}
        onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) addFiles(files); e.target.value = ""; }}
        className="hidden" />

      {attachments.length > 0 && (
        <div className="max-w-3xl mx-auto mb-2 px-4">
          <div className="flex flex-wrap gap-2">
            {attachments.map(att => (
              <div key={att.id} data-testid="attachment-chip" data-status={att.status}
                title={att.error ?? att.name}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors",
                  att.status === "error"
                    ? "bg-red-500/[0.07] border-red-500/25"
                    : "bg-white/[0.06] border-white/[0.08]",
                )}>
                <AttachmentStatusIcon status={att.status} />
                <span className={cn("max-w-40 truncate", att.status === "error" ? "text-red-300/80" : "text-white/60")}>
                  {att.name}
                </span>
                <span className="text-white/25 text-[10px]">{(att.size / 1024).toFixed(0)}K</span>
                {att.indexed && (
                  <span data-testid="indexed-badge"
                    className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/25 text-emerald-300/80 text-[10px] whitespace-nowrap">
                    indexed · {att.chunkCount ?? 0} chunks
                  </span>
                )}
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
          "relative rounded-2xl border transition-all duration-200",
          isHero
            ? "border-white/[0.12] bg-white/[0.05] shadow-2xl shadow-black/40"
            : "border-white/[0.1] bg-white/[0.04] backdrop-blur-xl shadow-lg shadow-black/30",
          "focus-within:border-white/25 focus-within:bg-white/[0.06]",
        )}>
          {slashCandidates.length > 0 && !slashDismissed && (
            <div
              data-testid="slash-skill-menu"
              className="absolute bottom-full left-0 right-0 mb-2 z-30 py-1 rounded-xl
                bg-[#0d0d12] border border-white/[0.1] shadow-xl shadow-black/50"
            >
              <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-widest font-medium">
                Skills — Enter or Tab to insert
              </div>
              {slashCandidates.map((s, i) => (
                <button
                  key={s.skillName}
                  onClick={() => pickSlashSkill(s.skillName)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2",
                    i === Math.min(slashIndex, slashCandidates.length - 1)
                      ? "bg-white/[0.06] text-white/90"
                      : "text-white/60 hover:bg-white/[0.04]",
                  )}
                >
                  <span className="font-mono text-white/80">/{s.skillName}</span>
                  {s.autoUse && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/[0.12] text-amber-400/80">
                      auto
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {(isThinking || reasoningContent) && !isLoading && (
            <div className="px-3 pt-2.5 flex items-center gap-2 text-[11px] text-emerald-400/70">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 animate-pulse" />
              <span>Reasoning…</span>
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isHero ? "Ask anything — try 'Explain async/await'…" : "Message…"}
              rows={1}
              className={cn(
                "flex-1 bg-transparent text-white placeholder-white/35 text-sm leading-relaxed outline-none resize-none",
                isHero ? "px-4 py-4 min-h-[52px] max-h-[180px]" : "px-3 py-3 min-h-[44px] max-h-[200px]",
              )}
            />

            <div className="flex items-center gap-0.5 pb-1.5 pr-1">
              <button onClick={() => setShowSkillsModal(true)}
                className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
                aria-label="Skills" title="Skills">
                <Blocks className="w-4 h-4" />
              </button>

              <button onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
                aria-label="Attach file" title="Attach file">
                <Paperclip className="w-4 h-4" />
              </button>

              <div className="relative" ref={effortMenuRef}>
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
                <button onClick={handleSend} data-testid="send-button"
                  disabled={!hasContent || stillReading}
                  title={stillReading ? "Reading attached files…" : undefined}
                  className={cn(
                    "p-2 rounded-lg transition-all",
                    hasContent && !stillReading
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

      <SkillsModal
        open={showSkillsModal}
        onClose={() => { setShowSkillsModal(false); refreshSkills(); }}
      />
    </div>
  );
}

/** Spinner / check / bang showing where an attachment is in its read. */
function AttachmentStatusIcon({ status }: { status: Attachment["status"] }) {
  if (status === "processing" || status === "pending")
    return <Loader2 className="w-3 h-3 animate-spin text-white/45" />;
  if (status === "error") return <AlertCircle className="w-3 h-3 text-red-400" />;
  return <Check className="w-3 h-3 text-emerald-400/80" />;
}

function EffortMenu({ effort, onSelect }: { effort: EffortLevel; onSelect: (e: EffortLevel) => void }) {
  return (
    <div className="absolute bottom-10 right-0 z-30 w-36 py-1 rounded-xl bg-[#0d0d12] border border-white/[0.1] shadow-xl">
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