"use client";
import { useEffect, useState } from "react";
import {
  Search, Pin, Archive, MessageSquarePlus, Check,
  MoreHorizontal, ChevronRight,
} from "lucide-react";
import type { ConversationMeta } from "../../lib/types";
import { cn } from "../../lib/utils";

interface SidebarProps {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteSelected: (ids: string[]) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRename: (id: string) => void;
  onSearch: (q: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  conversations, activeId, onSelect, onNew, onDelete, onDeleteSelected,
  onTogglePin, onToggleArchive, onRename, onSearch, isOpen, onClose,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = query
    ? conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase()))
    : conversations;

  const pinned = filtered.filter(c => c.pinned && !c.archived);
  const unpinned = filtered.filter(c => !c.pinned && !c.archived);
  const archived = filtered.filter(c => c.archived);

  // Conversations deleted elsewhere (bulk confirm, single delete) vanish from
  // `conversations` — drop them from the selection so counts stay truthful.
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const alive = new Set(conversations.map(c => c.id));
      const next = new Set([...prev].filter(id => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [conversations]);

  const selectableIds = [...pinned, ...unpinned, ...(showArchived ? archived : [])]
    .map(c => c.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectableIds));

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/60 z-40 sm:hidden" onClick={onClose} />}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-[280px] z-50 flex flex-col",
          "bg-[#0b0b0d] border-r border-white/[0.06]",
          "transition-transform duration-200",
          isOpen ? "translate-x-0" : "-translate-x-full",
          "sm:relative sm:z-auto sm:translate-x-0",
        )}
      >
        <div className="p-3 space-y-2">
          <button
            onClick={onNew}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg
              bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08]
              text-sm font-medium text-white/90 transition-colors"
          >
            <MessageSquarePlus className="w-4 h-4 text-white/60" />
            New conversation
          </button>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg
                bg-white/[0.04] border border-white/[0.06]
                text-xs text-white/80 placeholder-white/30
                focus:outline-none focus:border-white/20"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <div className="flex items-center justify-between px-2 pt-1.5 min-h-[24px]">
            {selectMode && (
              <button
                onClick={toggleSelectAll}
                data-testid="select-all"
                className="flex items-center gap-1.5 text-[11px] font-medium
                  text-white/45 hover:text-white/75 transition-colors"
              >
                <SelectCheckbox checked={allSelected} />
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            )}
            <button
              data-testid="select-mode-toggle"
              onClick={() => {
                if (!selectMode) { setSelectMode(true); return; }
                if (selected.size === 0) { exitSelectMode(); return; }
                onDeleteSelected([...selected]);
              }}
              className={cn(
                "ml-auto text-[11px] font-medium px-2 py-1 rounded-md transition-colors",
                selectMode && selected.size > 0
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-white/45 hover:text-white/75",
              )}
            >
              {selectMode && selected.size > 0
                ? `Delete ${selected.size}`
                : selectMode ? "Cancel" : "Select"}
            </button>
          </div>
          {pinned.length > 0 && (
            <div className="px-2 py-1.5 mt-1 text-[10px] font-semibold text-white/30 uppercase tracking-widest">
              Pinned
            </div>
          )}
          {pinned.map(c => (
            <ConversationItem
              key={c.id}
              c={c}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onRename={onRename}
              menuOpen={openMenu}
              setMenuOpen={setOpenMenu}
              selectMode={selectMode}
              selected={selected.has(c.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
          {unpinned.length > 0 && (
            <div className="px-2 py-1.5 mt-3 text-[10px] font-semibold text-white/30 uppercase tracking-widest">
              {pinned.length > 0 ? "Recent" : "Conversations"}
            </div>
          )}
          {unpinned.map(c => (
            <ConversationItem
              key={c.id}
              c={c}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onRename={onRename}
              menuOpen={openMenu}
              setMenuOpen={setOpenMenu}
              selectMode={selectMode}
              selected={selected.has(c.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
          {archived.length > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              className="w-full flex items-center gap-1 px-2 py-1.5 mt-3 text-[10px]
                font-semibold text-white/30 uppercase tracking-widest hover:text-white/50 transition-colors"
              aria-expanded={showArchived}
            >
              <Archive className="w-3 h-3" />
              Archived · {archived.length}
              <ChevronRight className={cn("w-3 h-3 transition-transform", showArchived && "rotate-90")} />
            </button>
          )}
          {showArchived && archived.map(c => (
            <ConversationItem
              key={c.id}
              c={c}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onRename={onRename}
              menuOpen={openMenu}
              setMenuOpen={setOpenMenu}
              selectMode={selectMode}
              selected={selected.has(c.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-white/30">
              {query ? "No matches." : "No conversations yet."}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-white/[0.06]">
          <div className="text-[10px] text-white/20 text-center">
            Local-first — your data stays on this device
          </div>
        </div>
      </aside>
    </>
  );
}

function SelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors",
        checked ? "bg-red-500/80 border-red-500/80" : "border-white/25",
      )}
    >
      {checked && <Check className="w-2.5 h-2.5 text-white" />}
    </span>
  );
}

function ConversationItem({
  c, activeId, onSelect, onDelete, onTogglePin, onToggleArchive, onRename, menuOpen, setMenuOpen,
  selectMode, selected, onToggleSelect,
}: {
  c: ConversationMeta;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRename: (id: string) => void;
  menuOpen: string | null;
  setMenuOpen: (id: string | null) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const open = menuOpen === c.id;
  return (
    <div
      data-testid="conversation-item"
      data-conversation-id={c.id}
      onClick={() => selectMode ? onToggleSelect(c.id) : onSelect(c.id)}
      className={cn(
        "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer",
        "transition-colors duration-150",
        selected
          ? "bg-red-500/[0.08] text-white/95"
          : activeId === c.id
            ? "bg-white/[0.08] text-white/95"
            : "hover:bg-white/[0.04] text-white/60",
      )}
    >
      {selectMode
        ? <SelectCheckbox checked={selected} />
        : <MessageSquarePlus className="w-3.5 h-3.5 flex-shrink-0 opacity-40" />}
      <span className="flex-1 text-sm truncate">{c.title}</span>
      {c.pinned && !selectMode && <Pin className="w-3 h-3 flex-shrink-0 text-white/40" />}
      {!selectMode && <div className="relative">
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(open ? null : c.id); }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all"
          aria-label="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
        {open && (
          <div
            className="absolute right-0 top-5 z-50 w-36 py-1 rounded-lg
              bg-[#141416] border border-white/[0.1] shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { onRename(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/90">
              Rename
            </button>
            <button onClick={() => { onTogglePin(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/90">
              {c.pinned ? "Unpin" : "Pin"}
            </button>
            <button onClick={() => { onToggleArchive(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.05] hover:text-white/90">
              {c.archived ? "Unarchive" : "Archive"}
            </button>
            <button onClick={() => { onDelete(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-white/[0.05]">
              Delete
            </button>
          </div>
        )}
      </div>}
    </div>
  );
}
