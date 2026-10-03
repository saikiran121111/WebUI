"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Search, Trash2, Pin, PinOff, Archive, MessageSquarePlus,
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
  onTogglePin: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onRename: (id: string) => void;
  onSearch: (q: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  conversations, activeId, onSelect, onNew, onDelete,
  onTogglePin, onToggleArchive, onRename, onSearch, isOpen, onClose,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const filtered = query
    ? conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase()))
    : conversations;

  const pinned = filtered.filter(c => c.pinned);
  const unpinned = filtered.filter(c => !c.pinned);

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

function ConversationItem({
  c, activeId, onSelect, onDelete, onTogglePin, onToggleArchive, onRename, menuOpen, setMenuOpen,
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
}) {
  const open = menuOpen === c.id;
  return (
    <div
      onClick={() => onSelect(c.id)}
      className={cn(
        "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer",
        "transition-colors duration-150",
        activeId === c.id
          ? "bg-white/[0.08] text-white/95"
          : "hover:bg-white/[0.04] text-white/60",
      )}
    >
      <MessageSquarePlus className="w-3.5 h-3.5 flex-shrink-0 opacity-40" />
      <span className="flex-1 text-sm truncate">{c.title}</span>
      {c.pinned && <Pin className="w-3 h-3 flex-shrink-0 text-white/40" />}
      <div className="relative">
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
      </div>
    </div>
  );
}
