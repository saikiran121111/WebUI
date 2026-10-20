import { Search, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { Message } from "../../lib/types";

/**
 * Collapsible "Research Trail" card shown above the assistant reply when
 * the LFM-gated web-search pipeline ran. Displays:
 *   - LFM decision summary (search_required, depth, queries)
 *   - Clickable source cards (domain + title + URL)
 *
 * The card is collapsed by default to keep the message bubble compact;
 * clicking expands the full source list.
 */
export default function ResearchTrailCard({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const webCitations = message.webCitations;
  if (!webCitations) return null;

  const entries = Object.values(webCitations).sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId, undefined, { numeric: true }),
  );
  if (entries.length === 0) return null;

  const domains = new Set(entries.map((e) => e.domain));
  const hasLfmDecision = !!(message as any).researchLfm;

  return (
    <div
      className="mb-3 rounded-lg border border-[#38E8FF]/15 bg-[#38E8FF]/[0.03] overflow-hidden"
      data-testid="research-trail-card"
    >
      {/* Header row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left
          hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
        data-testid="research-trail-toggle"
      >
        <Search className="w-3.5 h-3.5 text-[#38E8FF] flex-shrink-0" />
        <span className="text-xs font-medium text-white/70 flex-1">
          Research Trail
          <span className="ml-2 text-white/30 font-normal">
            {entries.length} source{entries.length !== 1 ? "s" : ""} ·{" "}
            {domains.size} domain{domains.size !== 1 ? "s" : ""}
          </span>
        </span>
        {hasLfmDecision && (
          <span className="text-[10px] px-1.5 py-0.5 rounded
            bg-[#38E8FF]/10 text-[#38E8FF] font-medium">
            LFM-gated
          </span>
        )}
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-white/30" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-white/30" />
        )}
      </button>

      {/* LFM decision summary */}
      {expanded && hasLfmDecision && (
        <div className="px-3 py-2 border-t border-white/[0.04] text-[11px] text-white/40 space-y-0.5">
          {((message as any).researchLfm?.queries ?? []).map((q: any, i: number) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="text-white/25 font-mono flex-shrink-0 mt-px">
                Q{i + 1}
              </span>
              <span className="text-white/55">{q.query}</span>
              <span className="text-white/25 text-[10px] flex-shrink-0">
                ({q.intent})
              </span>
            </div>
          ))}
          {((message as any).researchLfm?.depth ?? null) && (
            <div className="text-white/30">
              depth: <span className="text-white/50">{(message as any).researchLfm.depth}</span>
              {" · "}freshness:{" "}
              <span className="text-white/50">{(message as any).researchLfm.freshness}</span>
            </div>
          )}
        </div>
      )}

      {/* Source cards */}
      {expanded && (
        <div className="px-3 py-2 border-t border-white/[0.04] space-y-1">
          {entries.map((entry) => (
            <a
              key={entry.sourceId}
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 p-1.5 rounded-md
                hover:bg-white/[0.03] transition-colors group/src"
            >
              {/* Domain favicon */}
              <span className="w-5 h-5 rounded bg-white/[0.06] flex items-center justify-center
                text-[10px] font-bold text-white/30 flex-shrink-0 group-hover/src:text-white/50">
                {entry.domain.slice(0, 2).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-white/70 group-hover/src:text-white/90 truncate">
                  {entry.title}
                </div>
                <div className="text-[10px] text-white/30 truncate">
                  {entry.domain}
                  {entry.publishedAt && (
                    <span className="ml-1.5 text-white/20">
                      {entry.publishedAt.slice(0, 10)}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-mono text-[#38E8FF]/50 flex-shrink-0 mt-0.5">
                [{entry.sourceId}]
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
