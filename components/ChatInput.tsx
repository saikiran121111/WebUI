"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Paperclip, X, StopCircle, SlidersHorizontal, Loader2, AlertCircle, Check, Blocks, ChevronDown, Plus, Mic, AudioWaveform, Sparkles, CornerDownLeft } from "lucide-react";
import type { Attachment } from "../lib/types";
import type { EffortLevel } from "../lib/types";
import type { SkillRecord } from "../lib/skills/types";
import { meterText, meterTooltip, type TokenMeterSnapshot } from "../lib/chat/tokenMeter";
import { fetchSkills } from "../lib/skills/client-cache";
import { validateAttachment, processAttachment, ACCEPT_EXTENSIONS } from "../lib/files";
import SkillsModal from "./SkillsModal";
import { cn } from "../lib/utils";
import { RUKE_OPEN_ANNOTATION_EVENT } from "../lib/browser-client/browserClient";

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
  /**
   * Fired when the user types `/compact` (the manual context-compaction
   * command). Absent = the command is not offered in this surface.
   */
  onCompactCommand?: () => void;
  /** Render as centered hero input (empty state) or bottom bar (chat active) */
  variant?: "hero" | "bar";
  /**
   * Live token stats (speed + context filled / max) shown in the bar's meta
   * row. All values come from /api/model-stats and the stream's own server
   * usage frames — never fabricated. Absent = meter hidden.
   */
  tokenMeter?: TokenMeterSnapshot;
}

/**
 * RUKE composer — one elevated glass surface. All control slots keep a fixed
 * footprint so the layout never shifts while typing / streaming / loading;
 * the input grows with content up to a max height, then scrolls internally.
 */
export default function ChatInput({
  onSend, onStop, isLoading, isThinking, reasoningContent,
  effort, onEffortChange, isResearchMode, onModeToggle,
  onAttachmentsChange, onCompactCommand, variant = "bar", tokenMeter,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

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

  // Hero "+" popover dismissal (outside click / Escape), same contract as the
  // other popovers so two menus can never be open at once.
  useEffect(() => {
    if (!plusOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!plusRef.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlusOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  const pickSlashSkill = useCallback((skillName: string) => {
    setValue("/" + skillName + " ");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  // Browser Use (Phase 12): the Browser Panel hands a parked comment to
  // the composer through this event. The text arrives fully assembled
  // (grammar pinned in lib/browser-client/annotationPrompt) and already
  // ends on "## My request:" — the block is PREPENDED so the human's
  // typed request stays the governing instruction and every page-derived
  // detail above it sits under the untrusted-evidence marker.
  useEffect(() => {
    const onAnnotation = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { text?: unknown } | undefined;
      const text = detail?.text;
      if (typeof text !== "string" || !text) return;
      setValue((prev) => (prev.trim() ? `${text}\n${prev}` : text));
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    document.addEventListener(RUKE_OPEN_ANNOTATION_EVENT, onAnnotation);
    return () => document.removeEventListener(RUKE_OPEN_ANNOTATION_EVENT, onAnnotation);
  }, []);

  const isHero = variant === "hero";

  // Grow the textarea with content, capped — then it scrolls internally so
  // the composer's footprint (and the app) never gets pushed out of place.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, isHero ? 180 : 160) + "px";
  }, [value, isHero]);

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
    // `/compact` is a local command, not a prompt for the model.
    if (/^\/compact\s*$/i.test(trimmed)) {
      onCompactCommand?.();
      setValue("");
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    onSend(trimmed, attachments.filter(a => a.status === "ready"));
    setValue("");
    // Failed attachments stay in the tray so the reason is still visible.
    setAttachments(prev => {
      const kept = prev.filter(a => a.status === "error");
      onAttachmentsChange(kept);
      return kept;
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [value, isLoading, stillReading, attachments, onSend, onAttachmentsChange, onCompactCommand]);

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

  const canSend = hasContent && !stillReading && !isLoading;

  // Shared "+" popover (hero and bar): files, skills, plugins (inert).
  const renderPlusMenu = () => (
    <div role="menu" onClick={e => e.stopPropagation()}
      className="absolute bottom-11 left-0 z-30 w-48 py-1 rounded-xl
        bg-[#1d1d1d] border border-[rgba(255,255,255,0.15)]
        backdrop-blur-md shadow-xl shadow-black/40"
    >
      <button role="menuitem"
        onClick={() => { setPlusOpen(false); fileInputRef.current?.click(); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/95">
        <Paperclip className="w-3.5 h-3.5 text-white/40" /> Add files or photos
      </button>
      <button role="menuitem"
        onClick={() => { setPlusOpen(false); setShowSkillsModal(true); }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/95">
        <Blocks className="w-3.5 h-3.5 text-white/40" /> Skills
      </button>
      {/* Placeholder — Plugins are not implemented yet. */}
      <button role="menuitem" disabled title="Plugins — coming soon"
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-white/30 cursor-default">
        <Sparkles className="w-3.5 h-3.5 text-white/30" /> Plugins
      </button>
    </div>
  );

  return (
    <div
      onDragEnter={handleDragEnter} onDragOver={e => e.preventDefault()}
      onDragLeave={handleDragLeave} onDrop={handleDrop} onPaste={handlePaste}
      data-composer-variant={variant}
    >
      {isDragging && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center">
          <div className="px-10 py-5 rounded-2xl bg-[#1d1d1d] border border-[rgba(255,255,255,0.15)] text-white/90 text-base font-medium">
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
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors duration-[120ms]",
                  att.status === "error"
                    ? "bg-white/[0.04] border-[rgba(255,255,255,0.15)]"
                    : "bg-white/[0.05] border-[rgba(255,255,255,0.09)]",
                )}>
                <AttachmentStatusIcon status={att.status} />
                <span className={cn("max-w-40 truncate", att.status === "error" ? "text-white/70" : "text-white/60")}>
                  {att.name}
                </span>
                <span className="text-white/25 text-[10px]">{(att.size / 1024).toFixed(0)}K</span>
                {att.indexed && (
                  <span data-testid="indexed-badge"
                    className="px-1.5 py-0.5 rounded bg-white/[0.07] border border-[rgba(255,255,255,0.12)] text-white/50 text-[10px] whitespace-nowrap">
                    indexed · {att.chunkCount ?? 0} chunks
                  </span>
                )}
                <button onClick={() => removeAttachment(att.id)}
                  className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors duration-[120ms]"
                  aria-label={`Remove ${att.name}`}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={cn("max-w-3xl mx-auto", isHero ? "px-0" : "px-4 pb-4")}>
        <div className={cn(
          "surface-glass relative rounded-2xl transition-[border-color,background-color] duration-[150ms]",
          isHero ? "shadow-lg shadow-black/30" : "shadow-md shadow-black/25",
          "focus-within:border-[rgba(255,255,255,0.2)]",
        )}>
          {slashCandidates.length > 0 && !slashDismissed && (
            <div
              data-testid="slash-skill-menu"
              className="absolute bottom-full left-0 right-0 mb-2 z-30 py-1 rounded-xl
                bg-[#1d1d1d] border border-[rgba(255,255,255,0.15)]
                backdrop-blur-md shadow-xl shadow-black/40"
            >
              <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-widest font-medium">
                Skills — Enter or Tab to insert
              </div>
              {slashCandidates.map((s, i) => (
                <button
                  key={s.skillName}
                  onClick={() => pickSlashSkill(s.skillName)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs transition-colors duration-[120ms] flex items-center gap-2",
                    i === Math.min(slashIndex, slashCandidates.length - 1)
                      ? "bg-white/[0.08] text-white/90"
                      : "text-white/55 hover:bg-white/[0.04]",
                  )}
                >
                  <span className="font-mono text-white/80">/{s.skillName}</span>
                  {s.autoUse && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.09] text-white/50">
                      auto
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {(isThinking || reasoningContent) && (
            <div className="px-3.5 pt-2.5 flex items-center gap-2 text-[11px] text-white/45">
              <div className="w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse" />
              <span>Reasoning…</span>
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isHero ? "How can I help you today?" : "Reply"}
              rows={1}
              aria-label="Message Ruke"
              className={cn(
                "flex-1 bg-transparent text-white/90 placeholder-white/30 text-[15px] leading-relaxed outline-none resize-none",
                isHero ? "px-4 py-4 min-h-[52px] max-h-[180px]" : "px-3.5 py-3 min-h-[44px] max-h-[160px]",
              )}
            />

            {/* Bar variant: single send affordance — the return-arrow glyph
                doubles as the send button (Enter sends too). Stable footprint. */}
            {!isHero && (
            <div className="pb-2 pr-2">
              {isLoading ? (
                <button onClick={onStop}
                  className="w-7 h-7 rounded-md text-white/70 hover:text-white hover:bg-white/[0.06] transition-colors duration-[120ms] flex items-center justify-center"
                  aria-label="Stop generating">
                  <StopCircle className="w-4 h-4" />
                </button>
              ) : (
                <button onClick={handleSend} data-testid="send-button"
                  disabled={!canSend}
                  title={stillReading ? "Reading attached files…" : "Send (Enter)"}
                  className={cn(
                    "w-7 h-7 rounded-md transition-colors duration-[120ms] flex items-center justify-center",
                    canSend
                      ? "text-white/90 hover:text-white hover:bg-white/[0.06]"
                      : "text-white/55 cursor-default",
                  )}
                  aria-label="Send message">
                  <CornerDownLeft className="w-[18px] h-[18px]" />
                </button>
              )}
            </div>
            )}
          </div>

          {/* Hero variant bottom row: "+" popover on the left, send/stop and
              inert voice placeholders on the right. */}
          {isHero && (
            <div className="flex items-center justify-between px-3 pb-3">
              <div className="relative" ref={plusRef}>
                <button
                  onClick={() => setPlusOpen(v => !v)}
                  className={cn(
                    "w-8 h-8 rounded-full border flex items-center justify-center transition-colors duration-[120ms]",
                    plusOpen
                      ? "border-white/30 bg-white/[0.08] text-white/90"
                      : "border-[rgba(255,255,255,0.18)] text-white/55 hover:text-white/90 hover:bg-white/[0.05]",
                  )}
                  aria-label="Add" aria-haspopup="menu" aria-expanded={plusOpen}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {plusOpen && renderPlusMenu()}
              </div>

              <div className="flex items-center gap-1">
                {isLoading ? (
                  <button onClick={onStop}
                    className="w-8 h-8 rounded-lg text-white/70 hover:text-white hover:bg-white/[0.06] transition-colors duration-[120ms] flex items-center justify-center"
                    aria-label="Stop generating">
                    <StopCircle className="w-4 h-4" />
                  </button>
                ) : hasContent ? (
                  <button onClick={handleSend} data-testid="send-button"
                    disabled={!canSend}
                    title={stillReading ? "Reading attached files…" : "Send"}
                    className={cn(
                      "w-8 h-8 rounded-lg transition-all duration-[120ms] flex items-center justify-center",
                      canSend
                        ? "bg-white text-black hover:bg-white/90"
                        : "bg-white/[0.07] text-white/25 cursor-default",
                    )}
                    aria-label="Send message">
                    <Send className="w-4 h-4" />
                  </button>
                ) : null}

                {/* Voice controls — inert placeholders until a speech backend
                    is wired up; kept visible to match the target layout. */}
                <button disabled
                  className="flex items-center h-8 px-1.5 rounded-lg text-white/30 cursor-default"
                  aria-label="Voice input" title="Voice input — coming soon">
                  <Mic className="w-4 h-4" />
                  <ChevronDown className="w-3 h-3 ml-0.5" />
                </button>
                <button disabled
                  className="w-8 h-8 rounded-lg text-white/30 flex items-center justify-center cursor-default"
                  aria-label="Voice settings" title="Dictation — coming soon">
                  <AudioWaveform className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Bar meta row (outside the glass surface): add/voice cluster on the
            left, safety note centered, model / effort / mode on the right.
            Model and mode are inert placeholders until wired up. */}
        {!isHero && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-1 pt-2">
            <div className="relative flex items-center gap-0.5 justify-self-start" ref={plusRef}>
              <button
                onClick={() => setPlusOpen(v => !v)}
                className="w-8 h-8 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/[0.06] transition-colors duration-[120ms] flex items-center justify-center"
                aria-label="Add" aria-haspopup="menu" aria-expanded={plusOpen}
              >
                <Plus className="w-4 h-4" />
              </button>
              {plusOpen && renderPlusMenu()}
              {/* Voice controls — inert placeholders until a speech backend
                  is wired up; kept visible to match the target layout. */}
              <button disabled
                className="w-8 h-8 rounded-lg text-white/30 flex items-center justify-center cursor-default"
                aria-label="Voice input" title="Voice input — coming soon">
                <Mic className="w-4 h-4" />
              </button>
              <button disabled
                className="flex items-center h-8 px-1 rounded-lg text-white/30 cursor-default"
                aria-label="Voice settings" title="Dictation — coming soon">
                <AudioWaveform className="w-4 h-4" />
                <ChevronDown className="w-3 h-3 ml-0.5" />
              </button>
            </div>

            {/* Live token meter (replaces the old static safety note). Fixed
                footprint + tabular digits so the meta row never jitters while
                numbers tick. */}
            <span
              data-testid="token-meter"
              title={tokenMeter ? meterTooltip(tokenMeter) : undefined}
              className="text-[11px] text-white/35 select-none text-center tabular-nums whitespace-nowrap min-w-[15rem]"
            >
              {tokenMeter ? meterText(tokenMeter) : ""}
            </span>

            <div className="flex items-center gap-3 justify-self-end">
              <button className="text-[12px] font-medium text-white/85
                hover:text-white transition-colors duration-[120ms]"
                title="Model selection — coming soon">
                Local model
              </button>
              <EffortControl effort={effort} onEffortChange={onEffortChange} variant="text" />
              <button onClick={onModeToggle}
                aria-pressed={isResearchMode}
                title="Interaction mode — coming soon"
                className="text-[12px] font-medium text-white/85
                  hover:text-white transition-colors duration-[120ms]">
                {isResearchMode ? "Research" : "Manual"}
              </button>
            </div>
          </div>
        )}
      </div>

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
  if (status === "error")
    return <AlertCircle className="w-3 h-3 text-white/60" />;
  return <Check className="w-3 h-3 text-white/60" />;
}

/**
 * Reasoning-effort selector: compact pill + popover. The pill keeps a stable
 * width (tabular, min-width) so the row never reflows when the label changes.
 */
export function EffortControl({ effort, onEffortChange, variant = "pill" }: {
  effort: EffortLevel;
  onEffortChange: (e: EffortLevel) => void;
  /** "pill" = composer control row; "text" = bare label for the landing row. */
  variant?: "pill" | "text";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onEffortChange(EFFORT_LEVELS[Math.min(EFFORT_LEVELS.indexOf(effort) + 1, EFFORT_LEVELS.length - 1)]);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onEffortChange(EFFORT_LEVELS[Math.max(EFFORT_LEVELS.indexOf(effort) - 1, 0)]);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, effort, onEffortChange]);

  const active = effort !== "off";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        data-testid="effort-toggle"
        className={cn(
          "flex items-center justify-center gap-1 font-medium transition-colors duration-[120ms]",
          variant === "pill"
            ? cn(
                "h-8 min-w-[4.5rem] px-2 rounded-lg text-[11px]",
                active
                  ? "bg-white/[0.1] text-white/85"
                  : "text-white/40 hover:text-white/80 hover:bg-white/[0.06]",
              )
            : cn(
                "h-6 px-1 rounded text-[12px]",
                active
                  ? "text-white/85 hover:text-white"
                  : "text-white/40 hover:text-white/70",
              ),
        )}
        aria-label={`Reasoning effort: ${EFFORT_LABEL[effort]}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {variant === "pill" && <SlidersHorizontal className="w-3 h-3" />}
        <span className="tabular-nums">{EFFORT_LABEL[effort]}</span>
        {variant === "pill" && (
          <ChevronDown className={cn("w-2.5 h-2.5 text-white/30 transition-transform duration-[150ms]", open && "rotate-180")} />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-9 right-0 z-30 w-36 py-1 rounded-xl
              bg-[#1d1d1d] border border-[rgba(255,255,255,0.15)]
              backdrop-blur-md shadow-xl shadow-black/40"
            role="menu"
          >
            <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-widest font-medium">
              Reasoning effort
            </div>
            {EFFORT_LEVELS.map(e => (
              <button
                key={e}
                role="menuitemradio"
                aria-checked={effort === e}
                onClick={() => { onEffortChange(e); setOpen(false); }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs transition-colors duration-[120ms] flex items-center gap-2",
                  effort === e ? "text-white/95 bg-white/[0.07]" : "text-white/55 hover:bg-white/[0.05]",
                )}>
                {effort === e && <span className="w-1 h-1 rounded-full bg-white/80" />}
                {EFFORT_LABEL[e]}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
