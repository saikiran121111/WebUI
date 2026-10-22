"use client";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Search, Plus, Pin, Archive, Check, ListFilter,
  MoreHorizontal, ChevronRight, ChevronDown, Grid3x3,
  Folder, Boxes, Settings2,
} from "lucide-react";
import type { ConversationMeta } from "../../lib/types";
import { cn } from "../../lib/utils";
import { USER_NAME } from "../../lib/user";
import { useSidebarResize } from "../../hooks/useSidebarResize";

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
  onOpen: () => void;
}

/**
 * RUKE sidebar — search, new chat, placeholder nav (Projects / Artifacts /
 * Customize), the Recents list, and the account row. Opaque elevated
 * surface (no blur on a full-height container: the recents list scrolls
 * independently). Projects/Artifacts/Customize and the apps button are inert
 * placeholders kept for future features. Desktop: the right border is a drag
 * handle (resize up to 1/4 of the screen, past the minimum collapses it); a
 * collapsed rail can be dragged back open from the left screen edge.
 */
export default function Sidebar({
  conversations, activeId, onSelect, onNew, onDelete, onDeleteSelected,
  onTogglePin, onToggleArchive, onRename, onSearch, isOpen, onClose, onOpen,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const { width, isDragging, beginDrag } = useSidebarResize({ onClose, onOpen });
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

  const itemProps = {
    onDelete, onTogglePin, onToggleArchive, onRename,
    menuOpen: openMenu, setMenuOpen: setOpenMenu,
  };

  return (
    <>
      {/* Mobile: the sidebar is an overlay drawer. Desktop (sm+): fixed column. */}
      {isOpen && <div className="fixed inset-0 bg-black/60 z-40 sm:hidden" onClick={onClose} />}
      {/* Collapsed (desktop): invisible strip at the left screen edge — dragging
          it right reopens the rail, width tracking the pointer. */}
      {!isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to show sidebar"
          title="Drag to show sidebar"
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); beginDrag(e.clientX, "reveal"); }}
          className="hidden sm:block fixed left-0 top-10 bottom-0 w-2 z-40 cursor-ew-resize
            hover:bg-white/[0.05] active:bg-white/[0.08] transition-colors duration-[120ms]"
        />
      )}
      {/* Open (desktop) resize handle straddling the rail's right border: drag
          to resize (ceiling 1/4 of the viewport); pushed past the minimum it
          collapses the rail. It is a fixed sibling rather than an absolute
          child because the static aside cannot anchor absolute children. */}
      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to resize sidebar"
          title="Drag to resize"
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); beginDrag(e.clientX, "edge"); }}
          style={{ left: `${width - 4}px` }}
          className={cn(
            "hidden sm:block fixed top-10 bottom-0 w-2 z-40 cursor-ew-resize duration-200",
            "hover:bg-white/[0.05] active:bg-white/[0.08]",
            isDragging ? "transition-[background-color]" : "transition-[left,background-color]",
          )}
        />
      )}
      <aside
        data-testid="sidebar"
        style={{ "--sb-w": `${width}px` } as CSSProperties}
        className={cn(
          "fixed top-10 left-0 h-[calc(100%-2.5rem)] z-50 flex flex-col",
          "bg-[var(--bg-elevated)] border-r border-[var(--border)]",
          "transition-[transform,margin-left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          isDragging && "transition-none",
          // Mobile: slide the fixed drawer off-canvas. Desktop: negative margin
          // (equal to the dragged width via --sb-w) pulls the static column out
          // of the flex row so main reclaims the space; the transform still
          // slides it visually off-screen.
          isOpen ? "translate-x-0 sm:ml-0" : "-translate-x-full sm:-ml-[var(--sb-w)]",
          "sm:static sm:z-auto sm:h-auto sm:flex-shrink-0",
          // CSS min/max mirror the hook's clamp so a window resize can never
          // push the rail past a quarter of the viewport (min wins on very
          // narrow desktops, same as before).
          "w-[316px] max-w-[85vw] sm:w-[var(--sb-w)] sm:min-w-[280px] sm:max-w-[25vw]",
        )}
        aria-label="Navigation"
      >
        {/* ── Search + New + nav ─────────────────────────────────────── */}
        {/* relative anchors the mobile close button (the aside itself is
            fixed on mobile / static on desktop). */}
        <div className="relative flex flex-col gap-2 px-3 pt-3 pb-1.5 flex-shrink-0">
          <button
            onClick={onClose}
            className="absolute top-2 right-2 p-1.5 rounded-lg text-white/35 hover:text-white/70 hover:bg-white/[0.06] transition-colors sm:hidden"
            aria-label="Close sidebar"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
          </button>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search chats"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg
                bg-white/[0.04] border border-[var(--border)]
                text-[13px] text-white/85 placeholder-white/30
                focus:outline-none focus:border-white/25 transition-colors duration-[120ms]"
            />
          </div>

          <button
            onClick={onNew}
            aria-label="New conversation"
            data-testid="sidebar-new-chat"
            className="flex items-center gap-2 px-3 py-2 rounded-lg w-full
              bg-white/[0.07] hover:bg-white/[0.1] border border-white/[0.06]
              text-[13px] font-medium text-white/90 transition-colors duration-[120ms]"
          >
            <Plus className="w-4 h-4 text-white/60" />
            New
          </button>

          {/* Placeholder navigation — these features are not implemented yet;
              the entries are kept so the destinations can be wired up later. */}
          <nav className="flex flex-col gap-0.5 -mx-1 px-1 mt-1" aria-label="Primary">
            <NavItem icon={<Folder className="w-4 h-4" />} label="Projects" title="Projects — coming soon" />
            <NavItem icon={<Boxes className="w-4 h-4" />} label="Artifacts" title="Artifacts — coming soon" />
            <NavItem icon={<Settings2 className="w-4 h-4" />} label="Customize" title="Customize — coming soon" />
          </nav>
        </div>

        {/* ── Recents header (houses the select/sort control) ────────── */}
        <div className="flex items-center justify-between px-4 pt-2.5 pb-1 flex-shrink-0">
          <span className="text-[11px] font-medium text-white/35">Recents</span>
          <button
            data-testid="select-mode-toggle"
            onClick={() => {
              if (!selectMode) { setSelectMode(true); return; }
              if (selected.size === 0) { exitSelectMode(); return; }
              onDeleteSelected([...selected]);
            }}
            className={cn(
              "flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md transition-colors duration-[120ms]",
              selectMode && selected.size > 0
                ? "text-white/80 hover:bg-white/[0.06]"
                : "text-white/40 hover:text-white/75",
            )}
            aria-label={selectMode ? (selected.size > 0 ? `Delete ${selected.size}` : "Cancel select mode") : "Select chats"}
          >
            <ListFilter className="w-3.5 h-3.5" />
            {/* Label is present for text contracts; visually hidden until
                select mode actually needs the word. */}
            <span className={cn(!selectMode && "sr-only")}>
              {selectMode && selected.size > 0
                ? `Delete ${selected.size}`
                : selectMode ? "Cancel" : "Select"}
            </span>
          </button>
        </div>

        {/* ── Select mode strip ─────────────────────────────────────── */}
        {selectMode && (
          <div className="flex items-center px-4 pb-1 min-h-[22px] flex-shrink-0">
            <button
              onClick={toggleSelectAll}
              data-testid="select-all"
              className={"flex items-center gap-1.5 text-[11px] font-medium " +
                "text-white/45 hover:text-white/75 transition-colors duration-[120ms]"}
            >
              <SelectCheckbox checked={allSelected} />
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
        )}

        {/* ── Recent conversations (independently scrollable) ───────── */}
        <div data-testid="conversation-list" className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 min-h-0">
          {pinned.length > 0 && (
            <div className="px-2 py-1.5 mt-1 text-[10px] font-semibold text-white/30 uppercase tracking-widest">
              Pinned
            </div>
          )}
          {pinned.map(c => (
            <ConversationItem key={c.id} c={c} activeId={activeId} onSelect={onSelect}
              selectMode={selectMode} selected={selected.has(c.id)} onToggleSelect={toggleSelect} {...itemProps} />
          ))}
          {unpinned.length > 0 && (
            <div className="px-2 py-1.5 mt-2 text-[10px] font-semibold text-white/30 uppercase tracking-widest">
              {pinned.length > 0 ? "Recent" : "Chats"}
            </div>
          )}
          {unpinned.map(c => (
            <ConversationItem key={c.id} c={c} activeId={activeId} onSelect={onSelect}
              selectMode={selectMode} selected={selected.has(c.id)} onToggleSelect={toggleSelect} {...itemProps} />
          ))}
          {archived.length > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-2 text-[10px]
                font-semibold text-white/30 uppercase tracking-widest hover:text-white/50 transition-colors duration-[120ms]"
              aria-expanded={showArchived}
            >
              <Archive className="w-3 h-3" />
              Archived · {archived.length}
              <ChevronRight className={cn("w-3 h-3 transition-transform duration-200", showArchived && "rotate-90")} />
            </button>
          )}
          {showArchived && archived.map(c => (
            <ConversationItem key={c.id} c={c} activeId={activeId} onSelect={onSelect}
              selectMode={selectMode} selected={selected.has(c.id)} onToggleSelect={toggleSelect} {...itemProps} />
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-white/30">
              {query ? "No matches." : "No chats yet."}
            </div>
          )}
        </div>

        {/* ── Account row (anchored, does not scroll) ───────────────── */}
        <div className="px-3 py-2.5 border-t border-[var(--border)] flex items-center gap-2.5 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-white/[0.08] border border-white/[0.1]
            flex items-center justify-center text-[11px] font-semibold text-white/70">
            {USER_NAME.charAt(0).toUpperCase()}
          </div>
          <button
            className="min-w-0 flex items-center gap-1.5 flex-1 text-left rounded-md py-1 px-1 -mx-1
              hover:bg-white/[0.04] transition-colors duration-[120ms]"
            aria-label="Account"
            title="Account — coming soon"
          >
            <span className="text-[13px] font-medium text-white/85 truncate">{USER_NAME}</span>
            <span className="text-[12px] text-white/35">· Free</span>
            <ChevronDown className="w-3.5 h-3.5 text-white/30" />
          </button>
          <button
            className="w-7 h-7 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/[0.06]
              flex items-center justify-center transition-colors duration-[120ms]"
            aria-label="Apps"
            title="Apps — coming soon"
          >
            <Grid3x3 className="w-4 h-4" />
          </button>
        </div>
      </aside>
    </>
  );
}

function NavItem({ icon, label, onClick, active, disabled, title }: {
  icon: React.ReactNode; label: string; onClick?: () => void;
  active?: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors duration-[120ms]",
        active
          ? "bg-white/[0.06] text-white/95"
          : disabled
            ? "text-white/35"
            : "text-white/65 hover:text-white/95 hover:bg-white/[0.05]",
      )}
    >
      <span className="text-white/40">{icon}</span>
      {label}
    </button>
  );
}

function SelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0 transition-colors duration-[120ms]",
        checked ? "bg-white/90 border-white/90" : "border-white/25",
      )}
    >
      {checked && <Check className="w-2.5 h-2.5 text-black" />}
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
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on any outside click / Escape so this menu and the composer's
  // effort menu can never be open at the same time. The trigger button lives
  // inside menuRef, so clicking it again still toggles through onClick.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(null); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setMenuOpen]);

  return (
    <div
      data-testid="conversation-item"
      data-conversation-id={c.id}
      onClick={() => selectMode ? onToggleSelect(c.id) : onSelect(c.id)}
      className={cn(
        "group flex items-center gap-2 px-3 py-[7px] rounded-lg cursor-pointer",
        "transition-colors duration-[120ms]",
        selected
          ? "bg-white/[0.09] text-white/95"
          : activeId === c.id
            ? "bg-white/[0.07] text-white/95"
            : "hover:bg-white/[0.04] text-white/55",
      )}
    >
      {selectMode && <SelectCheckbox checked={selected} />}
      <span className="flex-1 text-[13px] truncate">{c.title}</span>
      {c.pinned && !selectMode && <Pin className="w-3 h-3 flex-shrink-0 text-white/40" />}
      {!selectMode && <div className="relative" ref={menuRef}>
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(open ? null : c.id); }}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all duration-[120ms]"
          aria-label="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
        {open && (
          <div
            className="absolute right-0 top-6 z-50 w-36 py-1 rounded-lg
              bg-[var(--bg-surface)] border border-[var(--border-strong)]
              backdrop-blur-md shadow-xl shadow-black/50 animate-in fade-in slide-in-from-top-1
              duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { onRename(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] hover:text-white/90">
              Rename
            </button>
            <button onClick={() => { onTogglePin(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] hover:text-white/90">
              {c.pinned ? "Unpin" : "Pin"}
            </button>
            <button onClick={() => { onToggleArchive(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] hover:text-white/90">
              {c.archived ? "Unarchive" : "Archive"}
            </button>
            <div className="h-px bg-white/[0.07] my-1" />
            <button onClick={() => { onDelete(c.id); setMenuOpen(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.06]">
              Delete
            </button>
          </div>
        )}
      </div>}
    </div>
  );
}
