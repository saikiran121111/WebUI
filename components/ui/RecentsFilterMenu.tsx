"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, SlidersHorizontal, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  ACTIVITY_OPTIONS, GROUP_OPTIONS, SORT_OPTIONS, STATUS_OPTIONS, optionLabel,
} from "../../lib/chat/recentsFilters";
import type {
  FilterOption, RecentsFilters,
} from "../../lib/chat/recentsFilters";

type RowKey = "status" | "activity" | "group" | "sort" | "groups";

const ROWS: { key: RowKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "activity", label: "Last activity" },
  { key: "group", label: "Group by" },
  { key: "sort", label: "Sort by" },
];

/**
 * The Recents filter control (Claude-desktop parity): a popover with Status /
 * Last activity / Group by / Sort by rows, each opening a right-side flyout
 * of radio options. Follows the sidebar menu convention: plain buttons, no
 * ARIA roles, dismissed by outside click / Escape.
 */
export default function RecentsFilterMenu({ filters, onChange, groupNames, onStartSelect }: {
  filters: RecentsFilters;
  onChange: (f: RecentsFilters) => void;
  /** Existing group names; the Groups flyout row appears only when non-empty. */
  groupNames: string[];
  /** "Delete" action row: close the popover, enter the sidebar's select mode. */
  onStartSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<RowKey | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) { setOpen(false); setSub(null); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setSub(null); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => { setOpen(false); setSub(null); };

  const valueFor = (key: RowKey) =>
    key === "status" ? filters.status :
    key === "activity" ? filters.activity :
    key === "group" ? filters.group : filters.sort;

  const optionsFor = (key: RowKey): FilterOption<string>[] =>
    key === "status" ? STATUS_OPTIONS :
    key === "activity" ? ACTIVITY_OPTIONS :
    key === "group" ? GROUP_OPTIONS : SORT_OPTIONS;

  const pick = (key: RowKey, value: string) => {
    // "groups" is the free-form Groups flyout — it writes groupFilter, not a
    // typed enum key, so it cannot go through the generic [key] spread.
    onChange(key === "groups"
      ? { ...filters, groupFilter: value }
      : { ...filters, [key]: value } as RecentsFilters);
    setSub(null);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="recents-filter-toggle"
        onClick={() => setOpen(v => { if (!v) setSub(null); return !v; })}
        aria-label="Filter chats"
        title="Filter"
        className={cn(
          "p-1 rounded-md transition-colors duration-[120ms]",
          open ? "bg-white/[0.08] text-white/90" : "text-white/55 hover:text-white/85 hover:bg-white/[0.06]",
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          data-testid="recents-filter-menu"
          className="absolute right-0 top-7 z-50 w-48 py-1 rounded-lg
            bg-[var(--bg-surface)] border border-[var(--border-strong)]
            backdrop-blur-md shadow-xl shadow-black/50 animate-in fade-in slide-in-from-top-1
            duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        >
          {ROWS.map(row => (
            <div key={row.key} className="relative">
              <button
                data-testid={`recents-filter-row-${row.key}`}
                onClick={() => setSub(row.key)}
                onMouseEnter={() => setSub(row.key)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms]",
                  sub === row.key ? "bg-white/[0.06] text-white/90" : "text-white/70 hover:bg-white/[0.06] hover:text-white/90",
                )}
              >
                <span className="text-white/55">{row.label}</span>
                <span className="ml-auto text-white/75">{optionLabel(optionsFor(row.key), valueFor(row.key))}</span>
                <ChevronRight className="w-3 h-3 text-white/40" />
              </button>
              {/* Delete action sits directly below Status (Claude parity): it
                  is an action, not a flyout — it hands off to select mode. */}
              {row.key === "status" && (
                <>
                  <button
                    data-testid="recents-filter-delete"
                    onClick={() => { close(); onStartSelect(); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms] text-white/70 hover:bg-white/[0.06] hover:text-white/90"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400/85" />
                    Delete
                  </button>
                  <div className="h-px bg-white/[0.07] my-1" />
                </>
              )}
              {row.key === "activity" && <div className="h-px bg-white/[0.07] my-1" />}
              {sub === row.key && (
                <div
                  data-testid={`recents-filter-${row.key}`}
                  className="absolute left-full top-0 -mt-1 ml-1 w-40 py-1 rounded-lg
                    bg-[var(--bg-surface)] border border-[var(--border-strong)]
                    backdrop-blur-md shadow-xl shadow-black/50 animate-in fade-in slide-in-from-left-1
                    duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                >
                  {optionsFor(row.key).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => pick(row.key, opt.value)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms]",
                        valueFor(row.key) === opt.value
                          ? "text-white/95 bg-white/[0.07]"
                          : "text-white/65 hover:bg-white/[0.05] hover:text-white/90",
                      )}
                    >
                      <span className={cn("w-3 flex justify-center", valueFor(row.key) !== opt.value && "invisible")}>
                        <Check className="w-3 h-3" />
                      </span>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Groups filter: only meaningful once at least one chat has a
              group (assigned via the full-screen browser's move-to-group). */}
          {groupNames.length > 0 && (
            <div className="relative">
              <button
                data-testid="recents-filter-row-groups"
                onClick={() => setSub("groups")}
                onMouseEnter={() => setSub("groups")}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms]",
                  sub === "groups" ? "bg-white/[0.06] text-white/90" : "text-white/70 hover:bg-white/[0.06] hover:text-white/90",
                )}
              >
                <span className="text-white/55">Groups</span>
                <span className="ml-auto text-white/75 max-w-[84px] truncate">
                  {filters.groupFilter === "all" ? "All" : filters.groupFilter}
                </span>
                <ChevronRight className="w-3 h-3 text-white/40" />
              </button>
              {sub === "groups" && (
                <div
                  data-testid="recents-filter-groups"
                  className="absolute left-full top-0 -mt-1 ml-1 w-40 py-1 rounded-lg
                    bg-[var(--bg-surface)] border border-[var(--border-strong)]
                    backdrop-blur-md shadow-xl shadow-black/50 animate-in fade-in slide-in-from-left-1
                    duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                >
                  {[{ value: "all", label: "All" }, ...groupNames.map(g => ({ value: g, label: g }))].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => pick("groups", opt.value)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-[120ms]",
                        filters.groupFilter === opt.value
                          ? "text-white/95 bg-white/[0.07]"
                          : "text-white/65 hover:bg-white/[0.05] hover:text-white/90",
                      )}
                    >
                      <span className={cn("w-3 flex justify-center", filters.groupFilter !== opt.value && "invisible")}>
                        <Check className="w-3 h-3" />
                      </span>
                      <span className="truncate">{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
