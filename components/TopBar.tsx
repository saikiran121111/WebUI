"use client";
import type { ReactNode } from "react";
import {
  Menu, PanelLeft, ArrowLeft, ArrowRight, History, Code2,
} from "lucide-react";
import { cn } from "../lib/utils";

interface TopBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** The SettingsMenu trigger, hosted by the page and dropped in here. */
  settings: ReactNode;
  /** The turn progress chip (ProgressChip), hosted by the page. */
  progress?: ReactNode;
  /** The Browser (login panel) trigger, hosted by the page. */
  browser?: ReactNode;
}

const ghost =
  "w-7 h-7 rounded-md flex items-center justify-center text-white/55 " +
  "hover:text-white/90 hover:bg-white/[0.05] transition-colors duration-[120ms]";

/**
 * RUKE global top bar — full-width window chrome above the sidebar and the
 * main workspace: nav controls on the left, a pill group in the center,
 * settings on the right.
 *
 * Back/forward are inert placeholders (the browser owns that chrome today);
 * they exist so the desktop wrapper can wire them up later without a layout
 * change.
 */
export default function TopBar({ sidebarOpen, onToggleSidebar, settings, progress, browser }: TopBarProps) {
  return (
    <header
      data-testid="topbar"
      className="relative h-10 flex-shrink-0 flex items-center gap-0.5 px-2
        bg-[var(--bg-elevated)] border-b border-[var(--border)]"
    >
      {/* ── Left: navigation ─────────────────────────────────────────── */}
      <button
        onClick={onToggleSidebar}
        className={ghost}
        aria-label="Menu"
        title="Menu"
      >
        <Menu className="w-4 h-4" />
      </button>
      <button
        onClick={onToggleSidebar}
        className={cn(ghost, sidebarOpen && "text-white/75")}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      >
        <PanelLeft className="w-4 h-4" />
      </button>
      <button className={cn(ghost, "opacity-30 cursor-default")} aria-label="Go back" title="Back" disabled>
        <ArrowLeft className="w-4 h-4" />
      </button>
      <button className={cn(ghost, "opacity-30 cursor-default")} aria-label="Go forward" title="Forward" disabled>
        <ArrowRight className="w-4 h-4" />
      </button>

      {/* ── Center: history / plugins pill group ─────────────────────── */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center rounded-lg
        border border-[var(--border)] bg-white/[0.02] px-0.5 py-0.5">
        <button className={ghost} aria-label="Chats history" title="Chats history">
          <History className="w-3.5 h-3.5" />
        </button>
        <button className={ghost} aria-label="Plugins" title="Plugins — coming soon">
          <Code2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Right: browser / progress chip / settings ─────────────────── */}
      <div className="ml-auto flex items-center gap-1">
        {browser}
        {progress}
        {settings}
      </div>
    </header>
  );
}
