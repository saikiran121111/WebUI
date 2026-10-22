"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Archive, ArchiveRestore, Check, ChevronDown, FolderInput, MailOpen,
  Pin, Plus, Search, SquareCheck, Trash2, X,
} from "lucide-react";
import type { ConversationMeta } from "../../lib/types";
import { cn } from "../../lib/utils";
import { formatActivityLabel, listGroups } from "../../lib/chat/recentsFilters";

/**
 * Centered ~60%-of-viewport popup over a dimmed backdrop (closes on backdrop
 * click; rows sit in a centered column): serif heading,
 * Active | Shared (placeholder) | Archived tabs, search, a Groups chip bar,
 * and a select mode whose toolbar bulk-pins / moves to group / marks unread /
 * archives / deletes. Escape or × closes; row click opens the chat.
 * z-[200] sits above the sidebar (whose popovers share z-50) while the page's
 * ConfirmDialog (z-[999]) stays on top of the delete confirmation.
 */
interface RecentsModalProps {
  conversations: ConversationMeta[];
  activeId: string | null;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onNew: () => void;
  /** Routes to the page's ConfirmDialog flow (bulk delete). */
  onDeleteSelected: (ids: string[]) => void;
  onBulkPin: (ids: string[], pinned: boolean) => void;
  onBulkArchive: (ids: string[], archived: boolean) => void;
  onBulkUnread: (ids: string[], unread: boolean) => void;
  /** group = null removes the chats from any group. */
  onBulkMoveGroup: (ids: string[], group: string | null) => void;
}

export default function RecentsModal({
  conversations, activeId, onClose, onOpenChat, onNew, onDeleteSelected,
  onBulkPin, onBulkArchive, onBulkUnread, onBulkMoveGroup,
}: RecentsModalProps) {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const moveRef = useRef<HTMLDivElement>(null);

  const groups = listGroups(conversations);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Bulk deletes elsewhere (ConfirmDialog) drop rows from `conversations` —
  // prune the selection so the "N selected" count never overstates.
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const alive = new Set(conversations.map(c => c.id));
      const next = new Set([...prev].filter(id => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [conversations]);

  useEffect(() => {
    if (!moveOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!moveRef.current?.contains(e.target as Node)) setMoveOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [moveOpen]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter(c => (tab === "active" ? !c.archived : c.archived))
      .filter(c => groupFilter === "all" || (c.group ?? "") === groupFilter)
      .filter(c => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, tab, query, groupFilter]);

  const selectedItems = rows.filter(c => selected.has(c.id));
  const allShown = rows.length > 0 && rows.every(c => selected.has(c.id));
  const ids = [...selected];

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () =>
    setSelected(allShown ? new Set() : new Set(rows.map(c => c.id)));
  const exitSelect = () => {
    setSelectMode(false); setSelected(new Set());
    setMoveOpen(false); setNewGroup("");
  };

  const saveGroup = () => {
    const name = newGroup.trim();
    if (!name || ids.length === 0) return;
    onBulkMoveGroup(ids, name);
    setNewGroup("");
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-8 bg-black/55"
    >
      <motion.div
        data-testid="recents-modal"
        initial={{ opacity: 0, scale: 0.97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)]
          bg-[var(--bg)] shadow-2xl shadow-black/60
          w-[min(60vw,1000px)] max-w-[calc(100vw-2rem)]
          h-[min(60vh,680px)] max-h-[calc(100vh-2rem)] min-h-[min(400px,calc(100vh-2rem))]"
      >
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-6 pt-5 pb-3 flex-shrink-0 flex-wrap">
        <h2 className="font-serif text-[22px] text-white/95 leading-none">Recents</h2>

        <div className="flex items-center gap-0.5 rounded-lg bg-white/[0.05] p-0.5" role="tablist" aria-label="Chat tabs">
          <TabButton testid="recents-tab-active" active={tab === "active"} onClick={() => setTab("active")}>
            Active
          </TabButton>
          {/* Placeholder per the Projects/Artifacts convention. */}
          <button
            disabled title="Shared — coming soon" aria-label="Shared (coming soon)"
            className="px-3 py-1 rounded-md text-[12px] font-medium text-white/35 cursor-not-allowed"
          >
            Shared
          </button>
          <TabButton testid="recents-tab-archived" active={tab === "archived"} onClick={() => setTab("archived")}>
            Archived
          </TabButton>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/45 pointer-events-none" />
            <input
              type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search" aria-label="Search all chats"
              data-testid="recents-modal-search"
              className="w-44 pl-8 pr-3 py-1.5 rounded-lg
                bg-white/[0.04] border border-[var(--border)]
                text-[13px] text-white/90 placeholder-white/45
                focus:outline-none focus:border-white/25 transition-colors duration-[120ms]"
            />
          </div>
          <button
            data-testid="recents-modal-select"
            onClick={() => { if (selectMode) exitSelect(); else setSelectMode(true); }}
            className="flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg
              text-white/75 hover:text-white/95 hover:bg-white/[0.06]
              border border-white/[0.06] transition-colors duration-[120ms]"
          >
            <SquareCheck className="w-3.5 h-3.5" />
            {selectMode ? "Cancel" : "Select"}
          </button>
          <button
            data-testid="recents-modal-new"
            onClick={onNew}
            className="flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg
              bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.06]
              text-white/90 transition-colors duration-[120ms]"
          >
            <Plus className="w-3.5 h-3.5" />
            New session
          </button>
          <button
            data-testid="recents-modal-close"
            onClick={onClose} aria-label="Close" title="Close"
            className="p-1.5 rounded-md text-white/50 hover:text-white/90 hover:bg-white/[0.06]
              transition-colors duration-[120ms]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Select-mode toolbar ─────────────────────────────────────── */}
      {selectMode && (
        <div className="flex items-center gap-3 px-6 pb-2 text-[12px] flex-shrink-0">
          <span className="text-white/55">{ids.length} selected</span>
          <button
            data-testid="recents-modal-select-all" onClick={toggleSelectAll}
            className="text-white/75 hover:text-white/95 transition-colors duration-[120ms]"
          >
            {allShown ? "Deselect all" : "Select all"}
          </button>
          <div className="ml-auto flex items-center gap-0.5 relative" ref={moveRef}>
            <ToolBtn testid="recents-modal-bulk-pin" label="Pin selected"
              onClick={() => onBulkPin(ids, !selectedItems.every(c => c.pinned))}>
              <Pin className="w-4 h-4" />
            </ToolBtn>
            <ToolBtn testid="recents-modal-bulk-group" label="Move to group"
              onClick={() => setMoveOpen(v => !v)}>
              <FolderInput className="w-4 h-4" />
            </ToolBtn>
            <ToolBtn testid="recents-modal-bulk-unread" label="Toggle unread"
              onClick={() => onBulkUnread(ids, !selectedItems.every(c => c.unread))}>
              <MailOpen className="w-4 h-4" />
            </ToolBtn>
            <ToolBtn testid="recents-modal-bulk-archive"
              label={tab === "active" ? "Archive selected" : "Unarchive selected"}
              onClick={() => onBulkArchive(ids, tab !== "active")}>
              {tab === "active" ? <Archive className="w-4 h-4" /> : <ArchiveRestore className="w-4 h-4" />}
            </ToolBtn>
            <ToolBtn testid="recents-modal-bulk-delete" label="Delete selected" danger
              onClick={() => onDeleteSelected(ids)}>
              <Trash2 className="w-4 h-4" />
            </ToolBtn>
            <ToolBtn testid="recents-modal-exit-select" label="Exit select mode" onClick={exitSelect}>
              <X className="w-4 h-4" />
            </ToolBtn>

            {moveOpen && (
              <div
                data-testid="recents-modal-move-panel"
                className="absolute right-0 top-9 z-10 w-56 py-1 rounded-lg
                  bg-[var(--bg-surface)] border border-[var(--border-strong)]
                  shadow-xl shadow-black/50 animate-in fade-in slide-in-from-top-1
                  duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
              >
                {groups.map(g => (
                  <button key={g} onClick={() => onBulkMoveGroup(ids, g)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70
                      hover:bg-white/[0.06] hover:text-white/90 truncate">
                    <FolderInput className="w-3 h-3 flex-shrink-0 text-white/45" />
                    <span className="truncate">{g}</span>
                  </button>
                ))}
                {groups.length > 0 && selectedItems.some(c => c.group) && (
                  <button
                    data-testid="recents-modal-move-remove"
                    onClick={() => onBulkMoveGroup(ids, null)}
                    className="w-full text-left px-3 py-1.5 text-xs text-white/55
                      hover:bg-white/[0.06] hover:text-white/85"
                  >
                    Remove from group
                  </button>
                )}
                {groups.length > 0 && <div className="h-px bg-white/[0.07] my-1" />}
                <div className="px-2 pt-1 pb-2">
                  <input
                    data-testid="recents-modal-group-name"
                    value={newGroup} onChange={e => setNewGroup(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveGroup(); }}
                    placeholder="Name your group" aria-label="Name your group"
                    className="w-full px-2 py-1.5 rounded-md text-[12px] text-white/90 placeholder-white/45
                      bg-white/[0.05] border border-[var(--border)] focus:outline-none focus:border-white/25"
                  />
                  <button
                    data-testid="recents-modal-group-save"
                    onClick={saveGroup}
                    className="mt-1.5 w-full text-[12px] font-medium px-2 py-1 rounded-md
                      bg-white/90 text-black hover:bg-white transition-colors duration-[120ms]"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Groups chip bar (only once groups exist) ────────────────── */}
      {groups.length > 0 && (
        <div className="flex items-center gap-1.5 px-6 pb-2 flex-shrink-0 overflow-x-auto">
          <span className="flex items-center gap-1 text-[11px] text-white/45 flex-shrink-0">
            Groups <ChevronDown className="w-3 h-3" />
          </span>
          <Chip active={groupFilter === "all"} onClick={() => setGroupFilter("all")}
            testid="recents-group-chip-all">All</Chip>
          {groups.map(g => (
            <Chip key={g} active={groupFilter === g} onClick={() => setGroupFilter(g)}
              testid={`recents-group-chip-${g}`}>{g}</Chip>
          ))}
        </div>
      )}

      {/* ── Rows (centered column, spaced below the header) ──────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-3 pb-6">
        <div className="max-w-2xl mx-auto">
          {rows.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-white/45">
              {query ? "No matches." : tab === "active" ? "No active chats." : "No archived chats."}
            </div>
          )}
          {rows.map(c => (
            <div
              key={c.id}
              data-testid="recents-modal-row"
              onClick={() => { if (selectMode) toggleSelect(c.id); else onOpenChat(c.id); }}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
                "transition-colors duration-[120ms]",
                selected.has(c.id)
                  ? "bg-white/[0.09] text-white/95"
                  : activeId === c.id
                    ? "bg-white/[0.05] text-white/90"
                    : "hover:bg-white/[0.04] text-white/80",
              )}
            >
              {selectMode && <Checkbox checked={selected.has(c.id)} />}
              {c.unread && (
                <span
                  data-testid="recents-modal-unread-dot" title="Unread"
                  className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0"
                />
              )}
              <span className="flex-1 min-w-0 text-[14px] truncate">{c.title}</span>
              {c.pinned && !selectMode && <Pin className="w-3 h-3 flex-shrink-0 text-white/45" />}
              <span className="text-[12px] text-white/40 flex-shrink-0 tabular-nums">
                {formatActivityLabel(c.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      </div>
      </motion.div>
    </motion.div>
  );
}

function TabButton({ testid, active, onClick, children }: {
  testid: string; active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      data-testid={testid} onClick={onClick} role="tab" aria-selected={active}
      className={cn(
        "px-3 py-1 rounded-md text-[12px] font-medium transition-colors duration-[120ms]",
        active ? "bg-white/[0.09] text-white/95" : "text-white/55 hover:text-white/85",
      )}
    >
      {children}
    </button>
  );
}

function Chip({ testid, active, onClick, children }: {
  testid: string; active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      data-testid={testid} onClick={onClick}
      className={cn(
        "flex-shrink-0 max-w-[160px] truncate px-2.5 py-1 rounded-full text-[11px] font-medium",
        "border transition-colors duration-[120ms]",
        active
          ? "bg-white/[0.11] border-white/25 text-white/95"
          : "bg-white/[0.04] border-white/[0.08] text-white/60 hover:text-white/85 hover:bg-white/[0.07]",
      )}
    >
      {children}
    </button>
  );
}

function ToolBtn({ testid, label, onClick, danger, children }: {
  testid: string; label: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      data-testid={testid} onClick={onClick} aria-label={label} title={label}
      className={cn(
        "p-1.5 rounded-md transition-colors duration-[120ms]",
        danger
          ? "text-red-400/85 hover:text-red-300 hover:bg-red-500/10"
          : "text-white/55 hover:text-white/90 hover:bg-white/[0.06]",
      )}
    >
      {children}
    </button>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0",
        "transition-colors duration-[120ms]",
        checked ? "bg-white/90 border-white/90" : "border-white/25",
      )}
    >
      {checked && <Check className="w-2.5 h-2.5 text-black" />}
    </span>
  );
}
