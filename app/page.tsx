"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDown, AlertCircle, RefreshCw, ChevronDown, Globe } from "lucide-react";
import ChatMessage from "../components/ChatMessage";
import ChatInput, { EffortControl } from "../components/ChatInput";
import SettingsMenu from "../components/SettingsMenu";
import TopBar from "../components/TopBar";
import ProgressChip from "../components/ProgressChip";
import RightBrowserPanel from "../components/RightBrowserPanel";
import { USER_NAME } from "../lib/user";
import Sidebar from "../components/ui/Sidebar";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import RecentsModal from "../components/ui/RecentsModal";
import CompactDividerBadge from "../components/ui/CompactDividerBadge";
import type { Attachment, ConversationMeta, EffortLevel } from "../lib/types";
import { useChat } from "../hooks/useChat";
import { useTokenMeter } from "../hooks/useTokenMeter";
import { listConversations, getConversation, saveConversation, deleteConversation as deleteConv, requestTitleGeneration } from "../lib/persistence";
import { buildDemoConversation } from "../lib/render/demoShowcase";
import { buildAnatomyDemoConversation } from "../lib/render/anatomyDemoShowcase";

function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export default function HomePage() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasScrolledUp, setHasScrolledUp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string } | null>(null);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  // Full-screen Recents browser (sidebar "View all" / browse icon).
  const [viewAllOpen, setViewAllOpen] = useState(false);
  // In-app login browser panel (Part 3): a right split beside <main>.
  // Null = closed; url = the login-walled page to aim the panel at
  // (set automatically when the pipeline reports web:auth_required).
  const [browserPanel, setBrowserPanel] = useState<{ url?: string } | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const {
    messages, status, error, isThinking, reasoningContent,
    send, stop, retry, edit, load, clear, setEffort, effort, requestFenceRepair,
    turnProgress, dismissProgress,
    compact, compactState, activeTokenCount,
  } = useChat({
    model: process.env.NEXT_PUBLIC_MODEL_ID ?? "",
    onAuthRequired: (info) =>
      setBrowserPanel((prev) => ({ url: info.url ?? prev?.url })),
  });

  // Live "Speed: … tk/s · Context: …/…" meter for the composer footer.
  const tokenMeter = useTokenMeter({ status, messages });

  // Manual compaction command: `/compact` in the composer (and a TopBar pill)
  // runs the sliding-window pipeline over the active LLM history right now,
  // instead of waiting for the auto threshold.
  const runCompact = useCallback(() => {
    if (compactState.isCompacting || status === "streaming") return;
    void compact("manual");
  }, [compact, compactState.isCompacting, status]);

  // Demo showcase: `?demo=ui` on load or the `/demo-ui` command injects a
  // deterministic interactive sample via load() — no model server needed.
  // `?demo=anatomy` / `/demo-anatomy` does the same for the Anatomy figures.
  const loadDemo = useCallback(() => {
    load(buildDemoConversation());
    setHasScrolledUp(false);
  }, [load]);
  const loadAnatomyDemo = useCallback(() => {
    load(buildAnatomyDemoConversation());
    setHasScrolledUp(false);
  }, [load]);
  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "ui") loadDemo();
    if (demo === "anatomy") loadAnatomyDemo();
  }, [loadDemo, loadAnatomyDemo]);
  const runSend = useCallback((text: string, attachments: Attachment[] = []) => {
    if (text.trim() === "/demo-ui") { loadDemo(); return; }
    if (text.trim() === "/demo-anatomy") { loadAnatomyDemo(); return; }
    send(text, { attachments });
  }, [send, loadDemo, loadAnatomyDemo]);

  // "Logged In — Continue AI Search" (Part 3): the panel did the cookie
  // hand-off; re-run the request through a normal chat turn so the extractor
  // reads the authenticated tab (its pool now rides the signed-in cookies).
  const handleLoggedIn = useCallback((url: string) => {
    setBrowserPanel(null);
    if (url) {
      runSend(
        `I signed in through the built-in Browser panel. Read ${url} with the ` +
        `signed-in browser profile and continue answering my previous request.`,
      );
    }
  }, [runSend]);
  const toggleBrowser = useCallback(
    () => setBrowserPanel((prev) => (prev ? null : {})),
    [],
  );

  // Ids deleted this session — a stale in-flight list refresh must never
  // resurrect them in the sidebar.
  const deletedRef = useRef<Set<string>>(new Set());
  const refreshList = useCallback(() => {
    listConversations().then(rows =>
      setConversations(rows.filter(c => !deletedRef.current.has(c.id))));
  }, []);

  // Load conversations from disk on mount.
  useEffect(() => { refreshList(); }, [refreshList]);

  // Mirror of `conversations` so the persist effect can read the latest
  // meta (title/pin/archive) without re-subscribing to it.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // Snapshot of the messages exactly as last loaded from / saved to disk for
  // the active conversation. Merely *opening* a chat must not count as an
  // update: without this guard the persist effect below re-saves on load,
  // bumping updatedAt and yanking the row to the top of the sidebar.
  const syncedMessagesRef = useRef<string>("");

  // Persist messages when they settle — NOT on every streamed token.
  // While a reply is streaming, `messages` changes on every SSE chunk; saving
  // there fired a POST /api/conversations + GET refresh per token (log flood +
  // disk thrash). Gating on `status` means exactly ONE save (and one list
  // refresh) per turn, written when the stream completes, errors, or aborts.
  // A tab closed mid-stream loses only the partial reply — same as before,
  // since the old per-token saves were racing the stream anyway.
  useEffect(() => {
    if (messages.length === 0) return;
    if (status === "streaming") return;
    const snapshot = JSON.stringify(messages);
    // Opened but not edited — skip the save so updatedAt (and the sidebar
    // row order, which sorts by it) stays untouched until a real change.
    if (snapshot === syncedMessagesRef.current) return;
    const convId = activeId ?? uid("c_");
    if (!activeId) setActiveId(convId);

    // Preserve user-set metadata (rename, pin, archive) across saves —
    // only fall back to defaults for a brand-new conversation.
    const existing = conversationsRef.current.find(c => c.id === convId);
    const meta: ConversationMeta = {
      id: convId,
      // Placeholder title for brand-new chats only — the server-side title
      // job replaces it with a full-conversation semantic title once a
      // meaningful reply exists. Title bookkeeping fields ride along so a
      // client save never erases the server's generation state.
      title: existing?.title ?? (messages[0]?.content?.slice(0, 40) || "New conversation"),
      titleSource: existing?.titleSource,
      titleGenCount: existing?.titleGenCount,
      titleGenAt: existing?.titleGenAt,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      pinned: existing?.pinned ?? false,
      archived: existing?.archived ?? false,
      // Group / unread are user-set like pin/archive — this rebuild would
      // silently erase them on the next save if not carried across.
      group: existing?.group,
      unread: existing?.unread,
      mode: existing?.mode ?? "chat",
      preview: messages[messages.length - 1]?.content?.slice(0, 80) ?? "",
      messageCount: messages.length,
    };
    syncedMessagesRef.current = snapshot;
    // One title nudge per settled turn, after the save lands. The SERVER
    // decides eligibility (debounced cadence, manual guard) and does the
    // generation from the full stored history through the shared model queue.
    // The POST response carries the title whenever the job actually wrote
    // one, so the sidebar row is patched locally — a second GET of the whole
    // list used to fire on EVERY turn even when the policy skipped the job
    // or it yielded to inference (no title ever changed). A title failure can
    // never affect the conversation itself.
    saveConversation({ id: convId, meta, messages })
      .then(() => {
        refreshList();
        return requestTitleGeneration(convId, process.env.NEXT_PUBLIC_MODEL_ID ?? "");
      })
      .then((t) => {
        if (t?.ok && t.title) {
          setConversations(prev => prev.map(c =>
            c.id === convId ? { ...c, title: t.title!, titleSource: "auto" } : c));
        }
      })
      .catch(() => {});
  }, [messages, activeId, status, refreshList]);

  // Follow the stream by pinning the container to the bottom. A smooth
  // scrollIntoView per chunk cancels the previous in-flight animation and
  // lags behind growing content (which used to flip hasScrolledUp and cause
  // top/bottom jitter). An instant scrollTop pin, coalesced to one rAF per
  // frame, tracks incremental growth smoothly.
  const stickToBottomRef = useRef(true);
  stickToBottomRef.current = !hasScrolledUp;
  const pinRafRef = useRef<number | null>(null);

  const pinToBottom = useCallback(() => {
    if (pinRafRef.current != null) return;
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = null;
      const c = messagesContainerRef.current;
      if (c && stickToBottomRef.current) c.scrollTop = c.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (!hasScrolledUp) {
      pinToBottom();
    } else if (pinRafRef.current != null) {
      cancelAnimationFrame(pinRafRef.current);
      pinRafRef.current = null;
    }
  }, [messages, hasScrolledUp, pinToBottom]);

  // Observe scroll position. Wheel-up unpins immediately so a pending pin
  // can't yank the user back down mid-generation.
  useEffect(() => {
    const c = messagesContainerRef.current;
    if (!c) return;
    // Direction-aware with hysteresis: any upward movement unpins, even a few
    // px from the bottom (the old 120px dead zone re-pinned small upward
    // scrolls, making free scrolling impossible mid-stream). Re-pin only once
    // the user is back within 8px of the bottom.
    let lastScrollTop = c.scrollTop;
    const onScroll = () => {
      const wentUp = c.scrollTop < lastScrollTop - 1;
      lastScrollTop = c.scrollTop;
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (wentUp && dist > 8) setHasScrolledUp(true);
      else if (dist <= 8) setHasScrolledUp(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // Synchronous: a rAF pin scheduled earlier this frame must not yank
        // the user back down before React flushes hasScrolledUp.
        stickToBottomRef.current = false;
        setHasScrolledUp(true);
      } else {
        onScroll();
      }
    };
    c.addEventListener("scroll", onScroll, { passive: true });
    c.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      c.removeEventListener("scroll", onScroll);
      c.removeEventListener("wheel", onWheel);
    };
  }, []);

  const handleNew = useCallback(() => {
    // Clear messages too — leaving them in state with a null activeId makes
    // the persist effect re-save them under a brand-new id (a phantom clone).
    clear();
    setActiveId(null);
    setHasScrolledUp(false);
  }, [clear]);

  // Cmd/Ctrl+Shift+N → new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); handleNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNew]);

  const handleSelect = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (conv) {
      // Mark the loaded messages as "in sync" so the persist effect doesn't
      // treat opening the chat as an edit (which would reorder the sidebar).
      syncedMessagesRef.current = JSON.stringify(conv.messages ?? []);
      load(conv);
      setActiveId(id);
      setHasScrolledUp(false);
      // Opening an unread chat clears the flag (Claude parity: the dot is a
      // user-set marker, so persist it; no updatedAt bump → no reorder).
      if (conv.meta.unread) {
        conv.meta.unread = false;
        saveConversation(conv).catch(() => {});
        setConversations(prev => prev.map(c =>
          c.id === id ? { ...c, unread: false } : c));
      }
    }
    // On small screens the sidebar is a drawer — close it after navigating.
    // On desktop (sm+) it's a permanent column; collapsing it on chat select
    // was jarring, so leave the user's layout choice untouched.
    if (window.matchMedia("(max-width: 639px)").matches) setSidebarOpen(false);
  }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setConfirmDelete({ id });
  }, []);

  const confirmDeleteConv = useCallback(async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    const ok = await deleteConv(id);
    if (!ok) return;
    deletedRef.current.add(id);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeId === id) {
      clear();
      setActiveId(null);
      setHasScrolledUp(false);
    }
  }, [confirmDelete, activeId, clear]);

  const handleDeleteSelected = useCallback((ids: string[]) => {
    if (ids.length > 0) setConfirmDeleteIds(ids);
  }, []);

  const confirmDeleteMany = useCallback(async () => {
    if (!confirmDeleteIds) return;
    const ids = confirmDeleteIds;
    setConfirmDeleteIds(null);
    const results = await Promise.all(ids.map(id => deleteConv(id)));
    const deleted = ids.filter((_, i) => results[i]);
    if (deleted.length === 0) return;
    deleted.forEach(id => deletedRef.current.add(id));
    setConversations(prev => prev.filter(c => !deleted.includes(c.id)));
    if (activeId && deleted.includes(activeId)) {
      clear();
      setActiveId(null);
      setHasScrolledUp(false);
    }
  }, [confirmDeleteIds, activeId, clear]);

  const handleTogglePin = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    conv.meta.pinned = !conv.meta.pinned;
    conv.meta.updatedAt = Date.now();
    await saveConversation(conv);
    refreshList();
  }, [refreshList]);

  const handleToggleArchive = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    conv.meta.archived = !conv.meta.archived;
    conv.meta.updatedAt = Date.now();
    await saveConversation(conv);
    listConversations().then(setConversations);
  }, []);

  const handleRename = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    const next = window.prompt("Rename:", conv.meta.title);
    if (next && next.trim()) {
      conv.meta.title = next.trim();
      // Manual ownership: the server's title job and merge rule both refuse
      // to overwrite a title the user renamed.
      conv.meta.titleSource = "manual";
      await saveConversation(conv);
      listConversations().then(setConversations);
    }
  }, []);

  // Bulk meta edits for the Recents modal: one GET→mutate→POST per chat,
  // then a SINGLE list refresh (mirrors confirmDeleteMany's batching).
  // bumpUpdatedAt=false keeps activity sorts stable for unread/group marks.
  const applyMetaBulk = useCallback(async (
    ids: string[], mutate: (m: ConversationMeta) => void, bumpUpdatedAt = true,
  ) => {
    for (const id of ids) {
      const conv = await getConversation(id);
      if (!conv) continue;
      mutate(conv.meta);
      if (bumpUpdatedAt) conv.meta.updatedAt = Date.now();
      await saveConversation(conv);
    }
    refreshList();
  }, [refreshList]);

  const handleBulkPin = useCallback((ids: string[], pinned: boolean) => {
    applyMetaBulk(ids, m => { m.pinned = pinned; });
  }, [applyMetaBulk]);

  const handleBulkArchive = useCallback((ids: string[], archived: boolean) => {
    applyMetaBulk(ids, m => { m.archived = archived; });
  }, [applyMetaBulk]);

  const handleBulkUnread = useCallback((ids: string[], unread: boolean) => {
    applyMetaBulk(ids, m => { m.unread = unread; }, false);
  }, [applyMetaBulk]);

  const handleBulkMoveGroup = useCallback((ids: string[], group: string | null) => {
    applyMetaBulk(ids, m => { if (group) m.group = group; else delete m.group; }, false);
  }, [applyMetaBulk]);

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)] text-[var(--foreground)] overflow-hidden">
      <TopBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
        settings={<SettingsMenu effort={effort} onEffortChange={setEffort} onCompactNow={runCompact} />}
        progress={<ProgressChip progress={turnProgress} onDismiss={dismissProgress} />}
        browser={
          <button
            onClick={toggleBrowser}
            aria-label="Browser"
            title={browserPanel ? "Close browser panel" : "Browser — sign in to locked sites"}
            className={
              "w-7 h-7 rounded-md flex items-center justify-center transition-colors duration-[120ms] " +
              (browserPanel
                ? "text-white/90 bg-white/[0.08]"
                : "text-white/55 hover:text-white/90 hover:bg-white/[0.05]")
            }
          >
            <Globe className="w-4 h-4" />
          </button>
        }
      />
      <div className="flex flex-1 min-h-0">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onDeleteSelected={handleDeleteSelected}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleToggleArchive}
        onRename={handleRename}
        onSearch={() => {}}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onViewAll={() => setViewAllOpen(true)}
      />

      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Scrollable message area */}
        <div ref={messagesContainerRef} data-testid="messages-scroll" className="chat-messages-scroll flex-1 overflow-y-auto">
          <div className={`max-w-3xl mx-auto px-4 py-8 ${messages.length === 0 ? "min-h-full flex flex-col pb-[14vh]" : "pb-40"}`}>
            {messages.length === 0 ? (
              <EmptyState
                onSend={(text, atts) => runSend(text, atts)}
                effort={effort}
                onEffortChange={setEffort}
                isLoading={status === "streaming"}
                onStop={stop}
              />
            ) : (
              <AnimatePresence mode="popLayout">
                {messages.map((m, i) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className={i > 0 ? "mt-6" : ""}
                  >
                    <ChatMessage
                      message={m}
                      onEdit={edit}
                      onSend={(text) => runSend(text)}
                      onFenceRuntimeError={(info) => requestFenceRepair(m.id, info)}
                    />
                    {/* Context-compaction divider: marks where the model-facing
                        history was folded into a summary. The original
                        messages above stay fully readable. */}
                    {compactState.badgeAt === i + 1 && (
                      <CompactDividerBadge
                        result={compactState.lastRun}
                        compacting={compactState.isCompacting}
                      />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            )}

            {error && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="mt-3 flex items-start gap-2.5 px-4 py-3 rounded-xl bg-white/[0.03] border border-[rgba(255,255,255,0.12)]">
                <AlertCircle className="w-4 h-4 text-white/60 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-[13px] text-white/70">{error}</p>
                </div>
                <button onClick={retry}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-md
                    text-white/80 hover:bg-white/[0.07]
                    border border-[rgba(255,255,255,0.12)] transition-colors duration-[120ms] flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </motion.div>
            )}

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
              onClick={() => { setHasScrolledUp(false); pinToBottom(); }}
              className="absolute bottom-[130px] left-1/2 -translate-x-1/2 z-30
                flex items-center gap-1.5 px-3 py-1.5 rounded-full
                surface-glass text-white/80 text-[11px] font-medium shadow-lg shadow-black/50
                transition-colors duration-[120ms] hover:bg-white/[0.08]">
              <ArrowDown className="w-3 h-3" /> Jump to latest
            </motion.button>
          )}
        </AnimatePresence>

        {/* Bottom composer bar — only visible when there are messages */}
        <AnimatePresence>
          {messages.length > 0 && (
            <motion.div
              key="composer-bar"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="pointer-events-none flex-shrink-0"
            >
              <div className="pointer-events-auto max-w-3xl mx-auto px-4 pb-4 pt-1">
                <ChatInput
                  onSend={(text, atts) => runSend(text, atts)}
                  onStop={stop}
                  isLoading={status === "streaming"}
                  isThinking={isThinking}
                  reasoningContent={reasoningContent}
                  effort={effort}
                  onEffortChange={setEffort}
                  isResearchMode={false}
                  onModeToggle={() => {}}
                  onAttachmentsChange={() => {}}
                  onCompactCommand={runCompact}
                  variant="bar"
                  tokenMeter={tokenMeter}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {browserPanel && (
        <RightBrowserPanel
          initialUrl={browserPanel.url}
          onClose={() => setBrowserPanel(null)}
          onLoggedIn={handleLoggedIn}
        />
      )}
      </div>
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete conversation?"
        message="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteConv}
        onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmDialog
        open={!!confirmDeleteIds}
        title={`Delete ${confirmDeleteIds?.length ?? 0} conversation${confirmDeleteIds?.length === 1 ? "" : "s"}?`}
        message="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteMany}
        onCancel={() => setConfirmDeleteIds(null)}
      />
      {viewAllOpen && (
        <RecentsModal
          conversations={conversations}
          activeId={activeId}
          onClose={() => setViewAllOpen(false)}
          onOpenChat={(id) => { setViewAllOpen(false); handleSelect(id); }}
          onNew={() => { setViewAllOpen(false); handleNew(); }}
          onDeleteSelected={handleDeleteSelected}
          onBulkPin={handleBulkPin}
          onBulkArchive={handleBulkArchive}
          onBulkUnread={handleBulkUnread}
          onBulkMoveGroup={handleBulkMoveGroup}
        />
      )}
    </div>
  );
}

/**
 * Landing (no active chat): the RUKE logo over a time-aware serif
 * greeting, the hero composer, and a Project / model / effort / mode
 * meta row. Project, model and Manual are inert placeholders kept for
 * features that will be wired up later.
 */
function EmptyState({
  onSend, effort, onEffortChange, isLoading, onStop,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  isLoading: boolean;
  onStop: () => void;
}) {
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => { requestAnimationFrame(() => setFadeIn(true)); }, []);

  const hour = new Date().getHours();
  const greeting = hour < 5 || hour >= 23
    ? `Up late, ${USER_NAME}?`
    : hour < 12
      ? `Good morning, ${USER_NAME}`
      : hour < 17
        ? `Good afternoon, ${USER_NAME}`
        : `Good evening, ${USER_NAME}`;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: fadeIn ? 1 : 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center my-auto select-none"
    >
      {/* Logo + greeting */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col items-center gap-4 mb-7"
      >
        <img src="/images/ruke-logo.svg" width="44" height="44" alt="Ruke logo"
          className="rounded-lg" draggable={false} />
        <h1 className="font-serif text-[34px] leading-tight tracking-tight
          text-[var(--foreground)] text-center">
          {greeting}
        </h1>
      </motion.div>

      {/* Composer + meta row */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.14, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[660px]"
      >
        <ChatInput
          onSend={onSend}
          onStop={onStop}
          isLoading={isLoading}
          isThinking={false}
          reasoningContent=""
          effort={effort}
          onEffortChange={onEffortChange}
          isResearchMode={false}
          onModeToggle={() => {}}
          onAttachmentsChange={() => {}}
          variant="hero"
        />

        {/* Meta row: Project picker (placeholder) left; model / effort / mode
            right. Only the effort control is live — the rest are future hooks. */}
        <div className="flex items-center justify-between mt-2 px-1">
          <button
            className="flex items-center gap-1 h-7 px-1.5 rounded text-[12px] text-white/50
              hover:text-white/80 transition-colors duration-[120ms]"
            title="Projects — coming soon"
          >
            Project
            <ChevronDown className="w-3 h-3 text-white/30" />
          </button>
          <div className="flex items-center gap-3">
            <button className="text-[12px] font-medium text-white/85
              hover:text-white transition-colors duration-[120ms]"
              title="Model selection — coming soon">
              Sonnet 5.5
            </button>
            <EffortControl effort={effort} onEffortChange={onEffortChange} variant="text" />
            <button className="text-[12px] font-medium text-white/85
              hover:text-white transition-colors duration-[120ms]"
              title="Interaction mode — coming soon">
              Manual
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
