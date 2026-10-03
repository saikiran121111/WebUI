"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDown, AlertCircle, RefreshCw, Sparkles, Settings2, ChevronLeft, ChevronRight } from "lucide-react";
import ChatMessage from "../components/ChatMessage";
import ChatInput from "../components/ChatInput";
import Sidebar from "../components/ui/Sidebar";
import type { ChatMode, Conversation, ConversationMeta, EffortLevel, Message } from "../lib/types";
import { useChat } from "../hooks/useChat";
import { listConversations, getConversation, saveConversation, deleteConversation as deleteConv } from "../lib/persistence";
import { cn } from "../lib/utils";

function uid(prefix: string = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export default function HomePage() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(true);
  const [hasScrolledUp, setHasScrolledUp] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const {
    messages, status, error, isThinking, reasoningContent,
    send, stop, retry, edit, setEffort, effort,
  } = useChat({
    model: process.env.NEXT_PUBLIC_MODEL_ID ?? "",
  });

  // Load conversations on mount
  useEffect(() => {
    listConversations().then(setConversations);
  }, []);

  // Persist current messages when they change
  useEffect(() => {
    if (messages.length === 0) return;
    const convId = activeId ?? uid("c_");
    if (!activeId) setActiveId(convId);

    const title = messages[0]?.content?.slice(0, 40) || "New conversation";
    const meta: ConversationMeta = {
      id: convId,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      archived: false,
      mode: "chat",
      preview: messages[messages.length - 1]?.content?.slice(0, 80) ?? "",
      messageCount: messages.length,
    };
    const conv: Conversation = { meta, messages };
    saveConversation(conv).then(() => {
      listConversations().then(setConversations);
    });
  }, [messages, activeId]);

  // Auto-scroll
  useEffect(() => {
    if (!hasScrolledUp && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [messages, hasScrolledUp]);

  // Track scroll
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c) return;
    const onScroll = () => {
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      setHasScrolledUp(dist > 100);
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    return () => c.removeEventListener("scroll", onScroll);
  }, []);

  const handleSelect = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      // We need to swap messages - simplest: reset and re-send last user msg
      // For now: clear + import
      setActiveId(id);
      // This is a hack — the current useChat doesn't have load capability yet.
      // We'd add useChat.loadConversation in a follow-up.
    }
  }, []);

  const handleNew = useCallback(() => {
    setActiveId(null);
    setHasScrolledUp(false);
    window.location.reload();  // simplest reset
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await deleteConv(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  }, []);

  const handleTogglePin = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      conv.meta.pinned = !conv.meta.pinned;
      await saveConversation(conv);
      listConversations().then(setConversations);
    }
  }, []);

  const handleToggleArchive = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      conv.meta.archived = !conv.meta.archived;
      await saveConversation(conv);
      listConversations().then(setConversations);
    }
  }, []);

  const handleRename = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    const next = window.prompt("Rename conversation:", conv.meta.title);
    if (next && next.trim()) {
      conv.meta.title = next.trim();
      await saveConversation(conv);
      listConversations().then(setConversations);
    }
  }, []);

  const handleSearch = useCallback((q: string) => {
    // local search already handled in Sidebar
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
        onToggleArchive={handleToggleArchive}
        onRename={handleRename}
        onSearch={handleSearch}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <TopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          model=""
          effort={effort}
        />

        <div ref={messagesContainerRef}
          className="flex-1 overflow-y-auto"
        >
          <div className="max-w-3xl mx-auto px-4 py-6 pb-32">
            {messages.length === 0 ? (
              <EmptyState onSend={send} />
            ) : (
              <AnimatePresence>
                {messages.map(m => (
                  <ChatMessage
                    key={m.id}
                    message={m}
                    onEdit={edit}
                    onCopy={async (text) => {
                      try { await navigator.clipboard.writeText(text); } catch {}
                    }}
                  />
                ))}
              </AnimatePresence>
            )}

            {error && (
              <div className="mt-3 flex items-start gap-2.5 px-4 py-3 rounded-xl
                bg-red-500/[0.06] border border-red-500/15">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
                <button onClick={retry}
                  className="px-2.5 py-1 text-xs font-medium rounded-md
                    text-red-300 hover:text-white bg-red-500/[0.1] hover:bg-red-500/[0.2]
                    border border-red-500/20 transition-colors flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        <AnimatePresence>
          {hasScrolledUp && messages.length > 0 && (
            <motion.button
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              onClick={() => {
                setHasScrolledUp(false);
                messagesEndRef.current?.scrollIntoView({ block: "end" });
              }}
              className="absolute bottom-32 left-1/2 -translate-x-1/2 z-30
                flex items-center gap-1.5 px-3 py-1.5 rounded-full
                bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.12]
                backdrop-blur-xl text-white/80 text-xs font-medium
                shadow-lg shadow-black/40 transition-colors"
            >
              <ArrowDown className="w-3 h-3" />
              Jump to latest
            </motion.button>
          )}
        </AnimatePresence>

        <ChatInput
          onSend={(text) => send(text)}
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
      </main>
    </div>
  );
}

function TopBar({
  sidebarOpen, onToggleSidebar, model, effort,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  model: string;
  effort: EffortLevel;
}) {
  return (
    <header className="h-12 flex items-center justify-between px-3 border-b border-white/[0.06]">
      <div className="flex items-center gap-2">
        <button onClick={onToggleSidebar}
          className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors"
          aria-label="Toggle sidebar">
          {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-white/40" />
          <span className="text-sm text-white/70 font-medium">{model}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-white/30">
        <span>Reasoning: {effort === "off" ? "off" : effort}</span>
        <span className="w-1 h-1 rounded-full bg-emerald-400/60" />
        <span>Local</span>
      </div>
    </header>
  );
}

function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <h1 className="text-4xl font-serif text-white/90 mb-2 tracking-tight">
          Local Intelligence
        </h1>
        <p className="text-sm text-white/40 max-w-md">
          A private, on-device chat for thinking through code, ideas, and the web.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="w-full max-w-2xl space-y-2"
      >
        <div className="flex flex-col gap-1 px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.08]
          focus-within:border-white/20 focus-within:bg-white/[0.06] transition-colors">
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (value.trim()) onSend(value.trim());
              }
            }}
            placeholder="Ask anything — try ‘Explain async/await’ or ‘Compare Rust and Go’"
            className="w-full bg-transparent text-white placeholder-white/30 text-sm
              leading-relaxed outline-none resize-none min-h-[80px] max-h-[200px]"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            "Explain this concept as if I'm 12",
            "Help me debug a JavaScript error",
            "Summarize the latest on agentic AI",
            "Walk me through a binary search",
          ].map(suggestion => (
            <button key={suggestion} onClick={() => onSend(suggestion)}
              className="text-left text-xs text-white/50 hover:text-white/80 px-3 py-2.5 rounded-lg
                bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.05] hover:border-white/[0.1]
                transition-colors">
              {suggestion}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
