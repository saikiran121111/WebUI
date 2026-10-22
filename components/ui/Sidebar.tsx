"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Search, Plus, Pin, Archive, Check, SquareCheck,
  MoreHorizontal, ChevronRight, ChevronDown, Grid3x3,
  Folder, Boxes, Settings2, Maximize2, Trash2,
} from "lucide-react";
import type { ConversationMeta } from "../../lib/types";
import { cn } from "../../lib/utils";
import { USER_NAME } from "../../lib/user";
import { useSidebarResize } from "../../hooks/useSidebarResize";
import RecentsFilterMenu from "./RecentsFilterMenu";
import {
  DEFAULT_RECENTS_FILTERS, filterConversations, groupConversations, listGroups,
  loadRecentsCollapsed, loadRecentsFilters,
  saveRecentsCollapsed, saveRecentsFilters,
} from "../../lib/chat/recentsFilters";
import type { RecentsFilters } from "../../lib/chat/recentsFilters";

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
  /** Open the full-screen Recents browser modal (View all / browse icon). */
  onViewAll: () => void;
}

/**
 * RUKE sidebar — search, new chat, placeholder nav (Projects / Artifacts /
 * Customize), the Recents list, and the account row. Opaque elevated
 * surface (no blur on a full-height container: the recents list scrolls
 * independently). Projects/Artifacts/Customize and the apps button are inert
 * placeholders kept for future features. Desktop: the right border is a drag
 * handle (resize between the minimum and 1/4 of the viewport — it never
 * closes the rail); open/close belongs to the top-bar toggle.
 */
export default function Sidebar({
  conversations, activeId, onSelect, onNew, onDelete, onDeleteSelected,
  onTogglePin, onToggleArchive, onRename, onSearch, isOpen, onClose, onViewAll,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const { width, isDragging, beginDrag } = useSidebarResize();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Recents controls (Claude-desktop parity): collapse/expand and the
  // Status / Last activity / Group by / Sort by filters. Persisted per user.
  const [filters, setFilters] = useState<RecentsFilters>(DEFAULT_RECENTS_FILTERS);
  const [recentsOpen, setRecentsOpen] = useState(true);
  useEffect(() => {
    setFilters(loadRecentsFilters());
    setRecentsOpen(!loadRecentsCollapsed());
  }, []);
  useEffect(() => { saveRecentsFilters(filters); }, [filters]);
  useEffect(() => { saveRecentsCollapsed(!recentsOpen); }, [recentsOpen]);

  const filteredAll = filterConversations(conversations, filters, query);
  // status="archived" flips the main list to the archived pool and hides the
  // bottom Archived disclosure; status="all" keeps the legacy disclosure.
  const activePool = filteredAll.filter(c => filters.status === "archived" ? c.archived : !c.archived);
  const archivedPool = filters.status === "all" ? filteredAll.filter(c => c.archived) : [];
  const sections = groupConversations(activePool, filters.group);
  const groupNames = listGroups(conversations);

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

  const selectableIds = [
    ...sections.flatMap(s => s.items),
    ...(showArchived ? archivedPool : []),
  ].map(c => c.id);
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
      {/* Open (desktop) resize handle straddling the rail's right border:
          left/right dragging resizes between the minimum and 1/4 of the
          viewport — it never closes the rail. It is a fixed sibling rather
          than an absolute child because the static aside cannot anchor
          absolute children. */}
      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to resize sidebar"
          title="Drag to resize"
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); beginDrag(e.clientX); }}
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
          // z-50 is kept on desktop on purpose: the translate-* classes make
          // the aside a stacking context (static + z-auto would trap its
          // z-50 popovers under the positioned <main> subtree that follows it
          // in the DOM, silently swallowing clicks on any flyout that spills
          // past the sidebar's right edge).
          "sm:static sm:h-auto sm:flex-shrink-0",
          // CSS min/max mirror the hook's clamp so a window resize can never
          // push the rail past a quarter of the viewport (min wins on very
          // narrow desktops, same as before).
          "w-[316px] max-w-[85vw] sm:w-[var(--sb-w)] sm:min-w-[232px] sm:max-w-[25vw]",
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
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/45 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search chats"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg
                bg-white/[0.04] border border-[var(--border)]
                text-[13px] text-white/90 placeholder-white/45
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
            <Plus className="w-4 h-4 text-white/75" />
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

        {/* ── Recents header (collapse/expand, View all, select, filter) ── */}
        <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1 flex-shrink-0">
          {recentsOpen ? (
            <button
              data-testid="recents-toggle"
              onClick={() => setRecentsOpen(false)}
              aria-expanded={true}
              title="Collapse recents"
              className="flex items-center gap-1 text-[11px] font-medium text-white/55
                hover:text-white/85 transition-colors duration-[120ms]"
            >
              Recents
              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
            </button>
          ) : (
            // Collapsed: the pill opens the full-screen browser (Claude
            // parity); a separate chevron just expands the inline list.
            <div className="flex items-center gap-1">
              <button
                data-testid="recents-view-all"
                onClick={onViewAll}
                title="Browse all chats"
                className="text-[13px] font-medium px-3 py-1.5 rounded-lg
                  bg-white/[0.07] hover:bg-white/[0.11] border border-white/[0.06]
                  text-white/90 transition-colors duration-[120ms]"
              >
                View all
              </button>
              <button
                data-testid="recents-expand"
                onClick={() => setRecentsOpen(true)}
                aria-label="Expand recents"
                title="Expand recents"
                className="p-1 rounded-md text-white/45 hover:text-white/85
                  hover:bg-white/[0.06] transition-colors duration-[120ms]"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-0.5">
            {recentsOpen && (
              <button
                data-testid="recents-browse"
                onClick={onViewAll}
                aria-label="Browse all chats"
                title="Browse all chats"
                className="p-1 rounded-md text-white/55 hover:text-white/85
                  hover:bg-white/[0.06] transition-colors duration-[120ms]"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              data-testid="select-mode-toggle"
              onClick={() => {
                if (!selectMode) { setRecentsOpen(true); setSelectMode(true); return; }
                if (selected.size === 0) { exitSelectMode(); return; }
                onDeleteSelected([...selected]);
              }}
              className={cn(
                "flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md transition-colors duration-[120ms]",
                selectMode && selected.size > 0
                  ? "text-white/85 hover:bg-white/[0.06]"
                  : "text-white/55 hover:text-white/85 hover:bg-white/[0.06]",
              )}
              aria-label={selectMode ? (selected.size > 0 ? `Delete ${selected.size}` : "Cancel select mode") : "Select chats"}
            >
              {/* Claude parity: while deleting (selection non-empty) the
                  Select icon is replaced by a red trash glyph. */}
              {selectMode && selected.size > 0
                ? <Trash2 className="w-3.5 h-3.5 text-red-400" />
                : <SquareCheck className="w-3.5 h-3.5" />}
              {/* Label is present for text contracts; visually hidden until
                  select mode actually needs the word. */}
              <span className={cn(!selectMode && "sr-only")}>
                {selectMode && selected.size > 0
                  ? `Delete ${selected.size}`
                  : selectMode ? "Cancel" : "Select"}
              </span>
            </button>
            <RecentsFilterMenu
              filters={filters} onChange={setFilters} groupNames={groupNames}
              onStartSelect={() => { setRecentsOpen(true); setSelectMode(true); }}
            />
          </div>
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
        {recentsOpen ? (
        <div data-testid="conversation-list" className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 min-h-0">
          {sections.map(section => (
            <Fragment key={section.key}>
              {section.label && (
                <div className="px-2 py-1.5 mt-1 text-[10px] font-semibold text-white/40 uppercase tracking-widest">
                  {section.label}
                </div>
              )}
              {section.items.map(c => (
                <ConversationItem key={c.id} c={c} activeId={activeId} onSelect={onSelect}
                  selectMode={selectMode} selected={selected.has(c.id)} onToggleSelect={toggleSelect} {...itemProps} />
              ))}
            </Fragment>
          ))}
          {archivedPool.length > 0 && (
            <button
              onClick={() => setShowArchived(v => !v)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-2 text-[10px]
                font-semibold text-white/40 uppercase tracking-widest hover:text-white/60 transition-colors duration-[120ms]"
              aria-expanded={showArchived}
            >
              <Archive className="w-3 h-3" />
              Archived · {archivedPool.length}
              <ChevronRight className={cn("w-3 h-3 transition-transform duration-200", showArchived && "rotate-90")} />
            </button>
          )}
          {showArchived && (
            <div data-testid="archived-items">
              {archivedPool.map(c => (
                <ConversationItem key={c.id} c={c} activeId={activeId} onSelect={onSelect}
                  selectMode={selectMode} selected={selected.has(c.id)} onToggleSelect={toggleSelect} {...itemProps} />
              ))}
            </div>
          )}
          {filteredAll.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-white/45">
              {query ? "No matches." : "No chats yet."}
            </div>
          )}
        </div>
        ) : (
          <div className="flex-1 min-h-0" aria-hidden="true" />
        )}

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
            <ChevronDown className="w-3.5 h-3.5 text-white/45" />
          </button>
          <button
            className="w-7 h-7 rounded-lg text-white/50 hover:text-white/85 hover:bg-white/[0.06]
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
            ? "text-white/60"
            : "text-white/75 hover:text-white/95 hover:bg-white/[0.05]",
      )}
    >
      <span className="text-white/60">{icon}</span>
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
            : "hover:bg-white/[0.04] text-white/75",
      )}
    >
      {selectMode && <SelectCheckbox checked={selected} />}
      {c.unread && (
        <span
          data-testid="unread-dot" title="Unread"
          className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0"
        />
      )}
      <span className="flex-1 text-[13px] truncate">{c.title}</span>
      {c.pinned && !selectMode && <Pin className="w-3 h-3 flex-shrink-0 text-white/55" />}
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
