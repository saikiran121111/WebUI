"use client";
import { memo } from "react";
import { GitMerge, Loader2 } from "lucide-react";
import type { CompactResult } from "../../lib/chat/compact";

interface CompactDividerBadgeProps {
  /** The last successful compaction (null = nothing to show). */
  result: CompactResult | null;
  /** True while a compaction call is in flight. */
  compacting: boolean;
  /** Human label override; defaults to `result.label`. */
  label?: string;
}

/**
 * The small "Context compacted (128.4k -> 5.2k tokens)" divider that sits
 * between the folded history and the recent tail. It is purely a UI marker —
 * the full original messages are still in the conversation (the user can
 * scroll back and read them); this badge just tells the reader that the
 * model-facing context was summarised here.
 */
export default memo(function CompactDividerBadge({ result, compacting, label }: CompactDividerBadgeProps) {
  if (compacting) {
    return (
      <div
        data-testid="compact-divider"
        data-state="compacting"
        className="flex items-center gap-2 my-5"
      >
        <div className="flex-1 h-px bg-[rgba(255,255,255,0.12)]" />
        <span className="flex items-center gap-1.5 text-[11px] text-white/50 px-3">
          <Loader2 className="w-3 h-3 animate-spin text-white/40" />
          Compacting context…
        </span>
        <div className="flex-1 h-px bg-[rgba(255,255,255,0.12)]" />
      </div>
    );
  }

  if (!result || !result.compacted) return null;

  const text = label ?? result.label;
  return (
    <div
      data-testid="compact-divider"
      data-state="done"
      className="flex items-center gap-2 my-5"
      title={result.context}
    >
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.12)]" />
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-white/55 px-3">
        <GitMerge className="w-3 h-3 text-white/45" />
        {text}
      </span>
      <div className="flex-1 h-px bg-[rgba(255,255,255,0.12)]" />
    </div>
  );
});
