"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDown, AlertCircle, RefreshCw, MessageSquarePlus, ChevronLeft, ChevronRight } from "lucide-react";
import ChatMessage from "../components/ChatMessage";
import ChatInput from "../components/ChatInput";
import Sidebar from "../components/ui/Sidebar";
import type { ChatMode, Conversation, ConversationMeta, EffortLevel, Message } from "../lib/types";
import { useChat } from "../hooks/useChat";
import { listConversations, getConversation, saveConversation, deleteConversation as deleteConv } from "../lib/persistence";

function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export default function HomePage() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasScrolledUp, setHasScrolledUp] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const {
    messages, status, error, isThinking, reasoningContent,
    send, stop, retry, edit, load, setEffort, effort,
  } = useChat({ model: process.env.NEXT_PUBLIC_MODEL_ID ?? "" });

  // Load conversations from disk on mount.
  useEffect(() => { listConversations().then(setConversations); }, []);

  // Persist current messages on every change.
  useEffect(() => {
    if (messages.length === 0) return;
    const convId = activeId ?? uid("c_");
    if (!activeId) setActiveId(convId);

    const meta: ConversationMeta = {
      id: convId,
      title: messages[0]?.content?.slice(0, 40) || "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false, archived: false,
      mode: "chat",
      preview: messages[messages.length - 1]?.content?.slice(0, 80) ?? "",
      messageCount: messages.length,
    };
    saveConversation({ id: convId, meta, messages }).then(() =>
      listConversations().then(setConversations));
  }, [messages, activeId]);

  // Auto-scroll when new messages appear, unless user scrolled up.
  useEffect(() => {
    if (!hasScrolledUp && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [messages, hasScrolledUp]);

  // Observe scroll position.
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c) return;
    const onScroll = () => {
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      setHasScrolledUp(dist > 120);
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => c.removeEventListener("scroll", onScroll);
  }, []);

  // Cmd/Ctrl+Shift+N → new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") { e.preventDefault(); handleNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleNew = useCallback(() => {
    setActiveId(null);
    setHasScrolledUp(false);
  }, []);

  const handleSelect = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      load(conv);
      setActiveId(id);
      setHasScrolledUp(false);
    }
    setSidebarOpen(false);
  }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    await deleteConv(id);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeId === id) { setActiveId(null); setHasScrolledUp(false); }
  }, [activeId]);

  const handleTogglePin = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    conv.meta.pinned = !conv.meta.pinned;
    await saveConversation(conv);
    listConversations().then(setConversations);
  }, []);

  const handleRename = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    const next = window.prompt("Rename:", conv.meta.title);
    if (next && next.trim()) {
      conv.meta.title = next.trim();
      await saveConversation(conv);
      listConversations().then(setConversations);
    }
  }, []);

  return (
    <div className="flex h-screen bg-[#0a0a0c] text-white overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onTogglePin={handleTogglePin}
        onToggleArchive={() => {}}
        onRename={handleRename}
        onSearch={() => {}}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Top bar — no logo, no AI branding */}
        <header className="h-12 flex items-center justify-between px-3 border-b border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 rounded-lg text-white/35 hover:text-white/70 hover:bg-white/[0.04] transition-colors"
              aria-label="Toggle sidebar">
              {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            <button onClick={handleNew}
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs
                text-white/40 hover:text-white/80 hover:bg-white/[0.04] transition-colors"
              aria-label="New conversation">
              <MessageSquarePlus className="w-3.5 h-3.5" />
              New
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-white/25">
            <span className="hidden sm:inline">Reasoning: {effort === "off" ? "off" : effort}</span>
            <span className="w-1 h-1 rounded-full bg-emerald-400/50" />
            <span>Local</span>
          </div>
        </header>

        {/* Scrollable message area */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 pb-36">
            {messages.length === 0 ? (
              <EmptyState onSend={send} conversations={conversations} onSelect={handleSelect} />
            ) : (
              <AnimatePresence mode="popLayout">
                {messages.map((m, i) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className={i > 0 ? "mt-5" : ""}
                  >
                    <ChatMessage
                      message={m}
                      onEdit={edit}
                      onCopy={async (text) => { try { await navigator.clipboard.writeText(text); } catch {} }}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}

            {error && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="mt-3 flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-500/[0.06] border border-red-500/15">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-[13px] text-red-400">{error}</p>
                </div>
                <button onClick={retry}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md
                    text-red-300 hover:text-white bg-red-500/[0.1] hover:bg-red-500/[0.2]
                    border border-red-500/20 transition-colors flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </motion.div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Jump-to-latest pill */}
        <AnimatePresence>
          {hasScrolledUp && messages.length > 0 && (
            <motion.button
              initial={{ opacity: 0, y: 14, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.95 }}
              transition={{ duration: 0.18 }}
              onClick={() => { setHasScrolledUp(false); messagesEndRef.current?.scrollIntoView({ block: "end" }); }}
              className="absolute bottom-[130px] left-1/2 -translate-x-1/2 z-30
                flex items-center gap-1.5 px-3 py-1.5 rounded-full
                bg-white/[0.07] hover:bg-white/[0.12] border border-white/[0.1]
                backdrop-blur-xl text-white/80 text-[11px] font-medium shadow-lg shadow-black/50
                transition-colors">
              <ArrowDown className="w-3 h-3" /> Jump to latest
            </motion.button>
          )}
        </AnimatePresence>

        {/* Single composer, always docked */}
        <div className="pointer-events-none flex-shrink-0">
          <div className="pointer-events-auto max-w-3xl mx-auto px-4 pb-4 pt-1">
            <motion.div layoutId="composer-wrapper">
              <ChatInput
                onSend={send}
                onStop={stop}
                isLoading={status === "streaming"}
                isThinking={isThinking}
                reasoningContent={reasoningContent}
                effort={effort}
                onEffortChange={setEffort}
                isResearchMode={false}
                onModeToggle={() => {}}
                onAttachmentsChange={() => {}}
              />
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}

function EmptyState({
  onSend, conversations, onSelect,
}: {
  onSend: (text: string) => void;
  conversations: ConversationMeta[];
  onSelect: (id: string) => void;
}) {
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => { requestAnimationFrame(() => setFadeIn(true)); }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: fadeIn ? 1 : 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center justify-center min-h-[62vh] gap-8 select-none"
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="text-center"
      >
        <h1 className="text-[2.8rem] font-serif text-white/90 mb-2 tracking-tight leading-[1.05]">
          Local Intelligence
        </h1>
        <p className="text-[13px] text-white/35 max-w-sm leading-relaxed">
          Private, on-device chat. Your conversations never leave this machine.
        </p>
      </motion.div>

      {/* Recent history strip */}
      {conversations.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.22 }}
          className="w-full max-w-2xl">
          <p className="text-[10px] text-white/20 uppercase tracking-widest mb-2 text-left">Recent</p>
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
            {conversations.slice(0, 6).map(conv => (
              <button key={conv.id} onClick={() => onSelect(conv.id)}
                className="flex-shrink-0 text-left text-[11px] px-3 py-2 rounded-lg
                  bg-white/[0.025] hover:bg-white/[0.06] border border-white/[0.06]
                  hover:border-white/12 transition-colors max-w-[180px] group">
                <span className="text-white/60 group-hover:text-white/90 truncate block">
                  {conv.title || "Untitled"}
                </span>
                <span className="text-white/20">
                  {new Date(conv.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </button>
            ))}
          </div>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.16, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-2xl"
      >
        {/* Single ChatInput, centered as hero input */}
        <div className="mb-4">
          <ChatInput
            onSend={onSend}
            onStop={() => {}}
            isLoading={false}
            isThinking={false}
            reasoningContent=""
            effort="medium"
            onEffortChange={() => {}}
            isResearchMode={false}
            onModeToggle={() => {}}
            onAttachmentsChange={() => {}}
            variant="hero"
          />
        </div>

        {/* Suggestion chips */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {[
            "Explain this concept as if I'm 12",
            "Help me debug a JavaScript error",
            "Summarize the latest on agentic AI",
            "Walk me through a binary search",
          ].map(suggestion => (
            <button key={suggestion} onClick={() => onSend(suggestion)}
              className="text-left text-[11px] text-white/45 hover:text-white/80 px-3 py-2.5 rounded-lg
                bg-white/[0.015] hover:bg-white/[0.04] border border-white/[0.05] hover:border-white/[0.1]
                transition-all hover:-translate-y-px">
              {suggestion}
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}